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
- Version 80: `RawSamplesTable.argumentValues` (JS Execution Tracing) widened to accept `Int32Array`. The v80 upgrader shifts Firefox's raw encoding by 1 so that `-1` becomes the "no data" sentinel (matching every other widened integer column); the shift is applied to counter, JS-allocations, and native-allocations `argumentValues` too for consistency. Downstream consumers translate `-2` / `-3` back to Firefox's `-1` / `-2` before calling `devtools-reps`'s `getArgumentSummaries`.

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

Populated by Firefox when the JS Execution Tracing feature is enabled (`tools/profiler/core/ProfileBufferEntry.cpp` → `WriteSample`, and the JS engine's `JS::ExecutionTrace` in `js/public/Debug.h`). Each element corresponds to one sample and comes from `event.functionEvent.values`, a plain `int32_t`. The full value regime as emitted by Firefox:

| Value                         | Meaning                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`                        | The sample is not a `FunctionEnter` event (it's a `LabelEnter` / `LabelLeave` / `FunctionLeave`, or a plain sampled stack). Most entries fall in this bucket even when tracing is on. Firefox writes this as `Maybe<int32_t>::Nothing`. |
| `>= 0`                        | Index into the thread's `tracedValuesBuffer` (a base64-encoded blob), where the argument value summaries for this function-enter live.                                                                                                  |
| `-1` (`EXPIRED_VALUES_MAGIC`) | The function-enter was recorded, but its argument values were overwritten in Firefox's value ring buffer before serialization.                                                                                                          |
| `-2` (`ZERO_ARGUMENTS_MAGIC`) | The function-enter had zero arguments.                                                                                                                                                                                                  |

The magic constants live in `js/public/Debug.h` (`JS::ExecutionTrace::{ZERO_ARGUMENTS_MAGIC, EXPIRED_VALUES_MAGIC, FUNCTION_LEAVE_VALUES}`). The consuming library is `devtools-reps`'s [`getArgumentSummaries`](../node_modules/devtools-reps/reps/value-summary-reader.mjs): it handles both magics natively (`-2` → `[]`, `-1` → `"<missing>"`) and reads the buffer at the given offset for non-negative indices.

Values are `int32_t` at the source, so `Int32Array` is the natural typed-array form (not `Float64Array`).

**Pre-existing quirk (on `main`, not introduced locally):** consumers currently conflate `null` with `-1`.

- [`stack-timing.ts:175-181`](../src/profile-logic/stack-timing.ts#L175-L181) initializes `sampleArgs = -1` when the raw value is `null`, funneling both "not a FunctionEnter sample" and "expired" into the same value.
- [`Canvas.tsx:648`](../src/components/stack-chart/Canvas.tsx#L648) short-circuits on `argumentValuesIndex !== -1`, so `-1` never actually reaches `getArgumentSummaries`. It also lets `-2` through (which is correct — `getArgumentSummaries` returns `[]` for it, rendering as an em dash).

Net effect today: "expired" and "not a FunctionEnter sample" produce identical UI ("no arguments displayed"). Nothing shows "`<missing>`" to the user, even though the library would produce it. If this becomes a UI feature later, decide the encoding now so it's not lossy.

**Sentinel choice.** We need to represent four states in an `Int32Array`. Constraints on picking sentinels:

- Small integers only. Values need to stay SMI-tagged in V8 (safe on 64-bit: ±2³¹; safe on 32-bit: ±2³⁰) and stay compact in JSON — profiles that don't produce JSLB write these values as decimal digits, and every extra character times "millions of samples" adds up.
- `-1` and `-2` in the derived form must remain what `devtools-reps`'s `getArgumentSummaries` expects (`EXPIRED_VALUES_MAGIC`, `ZERO_ARGUMENTS_MAGIC`) — or we translate at the call boundary.

Three viable options:

- **Preferred: shift by 1, use `-1` for the null-replacement.** Encoding in the `Int32Array`:
  - `>= 0` → buffer index (unchanged).
  - `-1` → "no data for this sample" (was `null`).
  - `-2` → `EXPIRED_VALUES_MAGIC` (was `-1` from Firefox).
  - `-3` → `ZERO_ARGUMENTS_MAGIC` (was `-2` from Firefox).

  Upgrader (v80) walks the column: `null → -1`, then `-1 → -2`, then `-2 → -3` (apply in that order, or with a temporary array to avoid clobbering). Derived form uses the existing `toInt32ArraySetNullToNegOne` helper — no new helper needed. At the `getArgumentSummaries` call site, translate back: `libraryIndex = storageIndex + 1` for `storageIndex ∈ {-2, -3}` (or gate on `storageIndex !== -1` and pass `storageIndex + 1` when negative). The extra ±1 arithmetic is a small price for tiny JSON and a clean "null → -1" convention that matches every other widened column.

- **Alternative A: flags column on `RawSamplesTable`.** Add `flags: Uint8Array` with `HasArgumentValues` bit; keep Firefox's `-1`/`-2` verbatim in `argumentValues` (a placeholder like `0` when the flag is unset). No translation at the library boundary.

  Answering "do we have other uses for flags on the samples table?": not really — the other nullable columns (`responsiveness`, `eventDelay`, `stack`, `threadCPUDelta`) already use in-band sentinels (`NaN`, `-1`) and their upgraders have shipped. `weight` uses column-level `null`, not per-row. So `HasArgumentValues` would be the lone bit today, which makes the +1-byte-per-sample overhead hard to justify — especially since it'd be paid on every profile even though JS Execution Tracing is a rare opt-in. If we anticipated another per-sample nullable field soon (nothing obvious in-flight), this would look better.

- **Alternative B: collapse `null` and `-1` via the upgrader.** Map both to `-1` in the derived form, keep Firefox's `-2` as-is. Reuses `toInt32ArraySetNullToNegOne`, no translation at the library call site, no shift. Simplest by far, but destroys the "expired vs no-FunctionEnter" distinction irrevocably. Only pick this if we're confident we'll never want a distinct "arguments expired" UI.

Recommendation: shift by 1. Best JSON size, SMI-safe, information-preserving, avoids adding a flags column just for one bit.

**Consumer fixes to bundle with the widening** (latent bugs worth cleaning up in the same commit — see the "pre-existing quirk" note above):

- [`stack-timing.ts:175-181`](../src/profile-logic/stack-timing.ts#L175-L181): change the null-check to a `val !== -1` check (in shift-by-1 encoding, `-1` is the "no data" sentinel). Then `-2` and `-3` flow through as-is; the stack-chart consumer decides how to render them.
- [`Canvas.tsx:648`](../src/components/stack-chart/Canvas.tsx#L648): the current `argumentValuesIndex !== -1` gate happens to hide `EXPIRED_VALUES_MAGIC` from the library, which is likely unintended (the library returns `"<missing>"` for `-1`, which the outer code already treats specially via `typeof argSummaries !== 'string'`). With shift-by-1 encoding, replace the gate with `argumentValuesIndex !== -1` (i.e., "we have some arg-info state for this sample") and translate `-2`/`-3` back to Firefox's `-1`/`-2` before calling the library. That lets `getArgumentSummaries` legitimately produce `"<missing>"` for expired frames, so a future UI can surface it.

Copiers ([`profile-data.ts:2202-2203`](../src/profile-logic/profile-data.ts#L2202-L2203), [`:2328-2329`](../src/profile-logic/profile-data.ts#L2328-L2329), [`:2434-2435`](../src/profile-logic/profile-data.ts#L2434-L2435)) currently do `.slice()` on the raw array; keep them working for both plain-array and typed-array inputs (typed-array `.slice()` returns a same-typed typed array, which is fine).

### 2. Remaining `RawMarkerTable` columns

- `threadId?: Array<Tid | null>` — trickier: `Tid` is `number | string`. Restrict to number-typed thread IDs in typed-array form; keep the array form for string tids. Consumers already have to branch on the type of `Tid`.
- `name`, `phase`, `category`, `startTime`, `endTime` already accept typed arrays.

### 2. Allocation tables (`RawJsAllocationsTable`, `RawUnbalancedNativeAllocationsTable`, `RawBalancedNativeAllocationsTable`)

- `stack: Array<IndexIntoStackTable | null>` → `Int32Array` with `-1` sentinel (the derived allocation tables already use this form; the raw form still stores plain arrays). Follow the samples-table v78 approach: widen the raw column type, update `finishRaw…AllocationsTableBuilder` to convert to `Int32Array`, and let the compute function normalize on the way to derived.
- `weight: Bytes[]` → `Float64Array`.
- `inNursery: boolean[]` (JS only) → `Uint8Array`.
- `memoryAddress: number[]` (balanced only) → `Float64Array` (addresses can exceed 2^31).
- `threadId: number[]` (balanced only) → `Int32Array`.
- `className`, `typeName`, `coarseType` are `string[]`. To keep them as typed arrays we would need to intern them in the shared string table and store `IndexIntoStringTable[] | Int32Array`. Worth doing but a bigger change; consider it a separate step.

### 3. Remaining `SourceTable` columns

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
- Read the v80 changes (`RawSamplesTable.argumentValues`) — pure-widening example where the incoming Firefox encoding already used two magic values (`-1` / `-2`), so the upgrader shifts everything by 1 to reserve `-1` for the "no data" case and consumers translate back before calling the downstream library.
