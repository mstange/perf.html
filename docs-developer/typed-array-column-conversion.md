# Typed-Array Column Conversion Plan

This document is a working plan for converting more raw-profile columns from plain JS arrays to typed arrays (`Int32Array`, `Float64Array`, `Uint8Array`).

The motivation: profiles loaded from [JsonSlabs](https://github.com/mstange/json-slabs/) files (`.jslb`, `.jslb.gz`) can store typed-array columns as binary blobs, which saves both space and load time. Widening a column's type in the raw profile format lets us store it as a typed array in those files while still accepting the regular-array form for other loaders and older files. Where a nullable column is in the way, we remove the in-band `null` (typically by adding a bit to a `flags` column) so the column can hold plain numbers.

Recent work you can grep for as a reference:

- Version 65 – 68: single-column widenings (`stackTable.frame`, `stackTable.prefixOffset`, various sample/marker time columns).
- Version 71: FrameTable — the first table to gain a `flags` column and be split into `RawFrameTable` / `FrameTable`.
- Version 72: NativeSymbolTable — same pattern, without the flags bitfield (the only nullable column is `functionSize`, which uses a `-1` sentinel in typed-array form).
- Version 73: FuncTable — same pattern as FrameTable (removed `isJS`/`relevantForJS` booleans and all nullable columns via a flags column).
- Version 74: SourceLocationTable — raw/derived split, pure widening (no nullable columns).
- Version 75: RawMarkerTable — widened `name`, `phase`, `category` (no derived split; marker table is consumed as-is).
- Version 76: SourceTable — widened the three non-nullable numeric columns (`filename`, `startLine`, `startColumn`).
- Version 77: ResourceTable — same pattern as FrameTable (the nullable `host` column removed via a flags column with `HasHost`).
- Version 78: `RawSamplesTable.stack` (and the derived samples / allocation tables' stack) widened to accept `Int32Array` with `-1` as the "no stack" sentinel. Derived `SamplesTable`, `SamplesLikeTable`, `JsAllocationsTable`, and `UnbalancedNativeAllocationsTable` now use `Int32Array` for `stack`. `finishRawSamplesTableBuilder` produces `Int32Array` from the builder's plain-array stack; the compute functions convert raw allocation stacks to `Int32Array`.
- Version 79: `RawSamplesTable.{responsiveness, eventDelay, threadCPUDelta, weight}` widened to accept `Float64Array`. The three failable columns use `NaN` as the "measurement failed" sentinel in typed-array form (nullable-array form still uses `null`). `weight` has no per-element sentinel — the column-level `null` still means "unweighted". Derived `SamplesTable` uses `Float64Array` for all four columns.

See [`CHANGELOG-formats.md`](./CHANGELOG-formats.md) and [`processed-profile-versioning.ts`](../src/profile-logic/processed-profile-versioning.ts) for the exact changes.

## Principles

1. **Widen at the boundary.** In [`profile.ts`](../src/types/profile.ts), each column type becomes `T[] | TypedArray`. In-memory this is what the loader hands back and what we serialize.
2. **Keep runtime uniform.** In [`profile-derived.ts`](../src/types/profile-derived.ts), the derived type uses only typed arrays. Consumers that go through the derived path (via a selector) do not need to branch on `Array` vs `TypedArray`.
3. **No nullable columns in typed-array form.** Typed arrays cannot store `null`. Where a column was nullable, either:
   - Add a bit in a `flags` column (preferred when the meaning is "is this cell meaningful?"), or
   - Pick a sentinel value like `-1` (only when the value is a natural number domain and `-1` is impossible; document it in the type comment).
     The raw form keeps accepting the array-with-null shape too, so existing files still load — the upgrader normalizes them.
4. **Push mutation through a builder.** Any code path that currently `.push()`es to a column, or that assigns to an index past the current end, must switch to a builder that uses plain JS arrays. `finish...Builder()` returns the raw form. See `RawFrameTableBuilder` etc.
5. **One consistent bit order in the flags column.** Bit 0, 1, 2, ... in declaration order. Do not reuse bits across versions.
6. **Upgrader must fill placeholders.** Anywhere the flag bit is unset, write `0` (or the sentinel) into the value column. Downstream code is entitled to assume the column is a plain number, not `null`/`undefined`.

## Code patterns

### 1. Types

In [`src/types/profile.ts`](../src/types/profile.ts):

```ts
export const FooFlag = {
  IsBar: 1 << 0,
  HasBaz: 1 << 1,
  // ...
} as const;
export type FooFlags = number;

export type RawFooTable = {
  flags: number[] | Uint8Array<ArrayBuffer>;
  bar: X[] | Int32Array<ArrayBuffer>;
  // Only meaningful when HasBaz is set.
  baz: Y[] | Int32Array<ArrayBuffer>;
  length: number;
};
```

The union `T[] | TypedArray` is what makes both storage shapes acceptable at the boundary.

In [`src/types/profile-derived.ts`](../src/types/profile-derived.ts):

```ts
export type FooTable = {
  flags: Uint8Array<ArrayBuffer>;
  bar: Int32Array<ArrayBuffer>;
  baz: Int32Array<ArrayBuffer>;
  length: number;
};
```

### 2. Builder + finisher + empty

In [`src/profile-logic/data-structures.ts`](../src/profile-logic/data-structures.ts):

```ts
export type RawFooTableBuilder = {
  flags: number[];
  bar: X[];
  baz: Y[];
  length: number;
};

export function getRawFooTableBuilder(): RawFooTableBuilder { ... }

export function getRawFooTableBuilderWithExistingContents(
  table: RawFooTable
): RawFooTableBuilder {
  return {
    flags: Array.from(table.flags),
    bar: Array.from(table.bar),
    baz: Array.from(table.baz),
    length: table.length,
  };
}

export function finishRawFooTableBuilder(
  builder: RawFooTableBuilder
): RawFooTable {
  return { ...builder };
}

export function getEmptyRawFooTable(): RawFooTable {
  return finishRawFooTableBuilder(getRawFooTableBuilder());
}
```

`Array.from(typedArray)` is the safe way to convert any typed array to a plain array. Doing `.slice()` on a typed array returns another typed array, which defeats the point of the builder.

### 3. Derivation function

In [`src/profile-logic/profile-data.ts`](../src/profile-logic/profile-data.ts):

```ts
export function computeFooTableFromRawFooTable(raw: RawFooTable): FooTable {
  return {
    flags: toUint8Array(raw.flags),
    bar: toInt32Array(raw.bar),
    baz: toInt32Array(raw.baz),
    length: raw.length,
  };
}
```

The `to*Array` helpers live in [`src/utils/typed-arrays.ts`](../src/utils/typed-arrays.ts); they are no-ops when the input is already the right typed array and construct a fresh one otherwise. For columns that are nullable in the raw form but sentinel-encoded in the derived form, use one of the sentinel variants:

- `toInt32ArraySetNullToNegOne` — for integer-index columns, `-1` means "no value" (see NativeSymbolTable's `functionSize`, `RawSamplesTable.stack`).
- `toFloat64ArraySetNullToNaN` — for measurement-like columns, `NaN` means "measurement failed" (see `RawSamplesTable.{responsiveness, eventDelay, threadCPUDelta}`).
- `toFloat64ArraySetNullToZero` — for columns where `0` is a natural placeholder (see `RawMarkerTable.{startTime, endTime}`).

### 4. Selector

In [`src/selectors/profile.ts`](../src/selectors/profile.ts):

```ts
export const getFooTable: Selector<FooTable> = createSelector(
  (state: State) => getRawProfileSharedData(state).fooTable,
  computeFooTableFromRawFooTable
);
```

If the table is per-thread rather than shared, wire it in through the thread selector chain (see how `nativeSymbols` flows through `getThread`).

### 5. Upgrader

In [`src/profile-logic/processed-profile-versioning.ts`](../src/profile-logic/processed-profile-versioning.ts), add a new `[N]` step that turns the old shape into the new shape. If you removed a nullable column, this is where you build the `flags` column and zero out the placeholder values so the invariant holds:

```ts
[NN]: (profile: any) => {
  const { fooTable } = profile.shared;
  const { oldNullableCol, length } = fooTable;
  const flags = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    let f = 0;
    if (oldNullableCol[i] !== null && oldNullableCol[i] !== undefined) {
      f |= 1 << 0; // HasFoo
    }
    flags[i] = f;
    if ((f & (1 << 0)) === 0) {
      oldNullableCol[i] = 0;
    }
  }
  fooTable.flags = flags;
  // If you renamed or removed columns, do the deletion here:
  // delete fooTable.oldName;
},
```

Then bump `PROCESSED_PROFILE_VERSION` in [`src/app-logic/constants.ts`](../src/app-logic/constants.ts) and add a CHANGELOG entry.

If the table is only widening column types (no shape change), the upgrader is a `_profile: any` no-op with an explanatory comment (see v65, v67, v68, v72).

### 6. Consumers

For every place that reads the nullable / boolean column, replace the `foo === null` check with a flag check, and read the column only when the flag is set. Common patterns:

```ts
// Boolean columns:
- if (funcTable.isJS[i]) { ... }
+ if ((funcTable.flags[i] & FuncFlag.IsJS) !== 0) { ... }

// Nullable index column:
- const src = funcTable.source[i];
- if (src !== null) { use(src); }
+ if ((funcTable.flags[i] & FuncFlag.HasSource) !== 0) {
+   const src = funcTable.source[i];
+   use(src);
+ }

// -1 sentinel:
- if (funcTable.resource[i] !== -1) { ... }
+ if ((funcTable.flags[i] & FuncFlag.HasResource) !== 0) { ... }
```

Everywhere the code was `.push()`ing new rows or extending the table by index, switch to `getRawXBuilderWithExistingContents(existing)` at the top of the function and `finishRawXBuilder(builder)` at the bottom. See how symbolication and merge-compare were refactored for the FuncTable change.

For test fixtures that write to a raw column directly, also set the corresponding flag bit — the raw form's invariant is "if a Has-flag is unset, the column value is ignored," so consumers that respect the flag will not see writes that didn't also set the flag.

### 7. Test snapshots

Whenever `PROCESSED_PROFILE_VERSION` is bumped, snapshots that serialize the profile need updating (`yarn test -u`). If any snapshot diff shows more than the version bump alone, that's a real change worth reviewing.

## Checklist for each conversion

- [ ] Add `Raw{Name}Table` + `{Name}Table` types (or update the existing raw type to widen columns).
- [ ] Add `Raw{Name}TableBuilder`, `getRaw{Name}TableBuilder`, `getRaw{Name}TableBuilderWithExistingContents`, `finishRaw{Name}TableBuilder`, `getEmptyRaw{Name}Table`.
- [ ] Add `compute{Name}TableFromRaw{Name}Table` in `profile-data.ts`.
- [ ] Add a selector in `selectors/profile.ts` (or wire into the thread selector).
- [ ] Update every consumer that reads removed/renamed columns.
- [ ] Update every producer/mutator to use the builder.
- [ ] Bump `PROCESSED_PROFILE_VERSION`, add an upgrader, add a CHANGELOG entry.
- [ ] Update the relevant `convert…EligibleColumns` helper in [`process-profile.ts`](../src/profile-logic/process-profile.ts) to also convert the new columns to their typed-array form — `convertSharedTablesEligibleColumns` for shared tables (frame, func, resource, native symbols, sources, source locations, stack), `convertSamplesTimesToTypedArrays` for samples, `convertMarkersEligibleColumnsToTypedArrays` for markers.
- [ ] Update the `TableDescription` for this table in [`profile-compacting.ts`](../src/profile-logic/profile-compacting.ts) to match the new column types (e.g. switch `indexRef` → `indexRefInt32`, or `indexRefOrNull` → `indexRefInt32GatedByFlag`).
- [ ] Update the "Recent work" list at the top of this document with a one-line summary of the change.
- [ ] `yarn ts`, `yarn test`, then `yarn test -u` to refresh snapshots if only versions changed. Run `yarn test-all` at the end (it also runs lint + fmt).

## Remaining candidates

Ordered by expected size / impact.

### 1. `argumentValues` in `RawSamplesTable`

- `argumentValues?: Array<number | null>` → `Float64Array` with `NaN` sentinel (matching the v78 pattern). The reader in `stack-timing.ts` already has a `sampleArgs = -1` "no args" fallback for null, so it needs to switch to a NaN check. Any place that reads `argumentValues[i]` and expects `null` for "no arg" would need updating to check NaN instead.

### 2. Remaining `RawMarkerTable` columns

- `threadId?: Array<Tid | null>` — trickier: `Tid` is `number | string`. Restrict to number-typed thread IDs in typed-array form; keep the array form for string tids. Consumers already have to branch on the type of `Tid`.
- `name`, `phase`, `category`, `startTime`, `endTime` already accept typed arrays.

### 3. Allocation tables (`RawJsAllocationsTable`, `RawUnbalancedNativeAllocationsTable`, `RawBalancedNativeAllocationsTable`)

- `stack: Array<IndexIntoStackTable | null>` → `Int32Array` with `-1` sentinel (the derived allocation tables already use this form; the raw form still stores plain arrays). Follow the samples-table v78 approach: widen the raw column type, update `finishRaw…AllocationsTableBuilder` to convert to `Int32Array`, and let the compute function normalize on the way to derived.
- `weight: Bytes[]` → `Float64Array`.
- `inNursery: boolean[]` (JS only) → `Uint8Array`.
- `memoryAddress: number[]` (balanced only) → `Float64Array` (addresses can exceed 2^31).
- `threadId: number[]` (balanced only) → `Int32Array`.
- `className`, `typeName`, `coarseType` are `string[]`. To keep them as typed arrays we would need to intern them in the shared string table and store `IndexIntoStringTable[] | Int32Array`. Worth doing but a bigger change; consider it a separate step.

### 4. Remaining `SourceTable` columns

- `sourceMapURL: Array<IndexIntoStringTable | null>`: needs a flag or sentinel.
- `id: Array<string | null>`, `content: Array<string | null>`: strings, no clean way to typed-array-ize. Leave as plain arrays.
- Could add a `flags` column with `HasSourceMapURL`, or keep the nullable-string column as-is. `filename`, `startLine`, and `startColumn` already accept typed arrays.

## Non-candidates / caveats

- `ProfileMeta` and other top-level structs are one-off objects, not columnar. Skip.
- `RawProfileSharedData.stringArray` is `string[]`; leave as-is.
- `Page[]`, `Lib[]`, `Category[]`: array-of-object shapes, not columnar; skip.
- `sources.content` and `sources.id` stay `string[]` for the same reason.

## Known technical debt

- **Test utilities cast raw tables to builders.** [`addSourceToTable`](../src/test/fixtures/utils.ts) declares its parameter as `SourceTable` and internally does `sources as SourceTableBuilder` before pushing. The same pattern shows up in a few test files for `resourceTable` and `thread.sources`. This is safe today because every caller passes a freshly-created empty table (which is really a builder underneath), but it's a landmine: passing a real typed-array-backed table would silently fail at runtime. Proper fix: propagate the `Builder` type through the signatures and switch tests to build up a builder explicitly, finalizing at setup end.
- **Enum-typed columns lose runtime validation on widening.** When a column like `MarkerPhase[]` becomes `MarkerPhase[] | Uint8Array`, index access returns `number` and needs an `as MarkerPhase` cast at the read site. A malformed profile with an out-of-range value would slip through. No validation pass on load today; noted here for anyone who needs it.
- **After the raw/derived split, mutating a raw shared table does not propagate to derived selectors.** Before the split, derived aliased raw. This is the intended runtime model, but be aware when writing tests: if you build a call tree (or any derived selector output), later mutations to `profile.shared.resourceTable` etc. will not be visible. Rebuild derived state after the mutation.

## When in doubt

- Read the FrameTable v71 upgrader in [`processed-profile-versioning.ts`](../src/profile-logic/processed-profile-versioning.ts) — it's the canonical example that touches both flags and nullable-column removal.
- Read the FuncTable v73 upgrader — same shape, applied to a more sprawling set of consumers.
- Read the ResourceTable v77 upgrader — a smaller flags-column example, useful when the whole table needs a raw/derived split but only one column is nullable.
- Read the NativeSymbolTable v72 changes — the simplest raw/derived split, and the one that shows how to handle a single nullable column with a `-1` sentinel.
- Read the v78 changes (`RawSamplesTable.stack`) — pure-widening example (no new table split) with an `Int32Array` sentinel; also propagates the sentinel through the derived `SamplesLikeTable` and allocation tables.
- Read the v79 changes (`RawSamplesTable.{responsiveness, eventDelay, threadCPUDelta, weight}`) — pure-widening example with `Float64Array`, `NaN` as the failure sentinel for measurement-like columns, and no sentinel for `weight` (whose column-level `null` still means "unweighted").
