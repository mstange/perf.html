# Profile Compression Playground — Notes

## Overview

This directory is a sandbox for experimenting with compact in-memory profile representations.
The goal is a smaller JSON payload that can be sent over the wire and held in memory.

`index.ts` is the entry point (`compressProfile` / `uncompressProfile`).
`markers.ts` has the marker-specific compression, which is currently the richest area.
`byte-io.ts` has `ByteWriter` / `ByteReader` with ULEB128 and SLEB128 support.

## Workflow

### Build & run the compression tool

```sh
yarn build-node-tools
node node-tools-dist/profile-compress.js \
  --input /Users/mstange/Downloads/big-markers-profile.json \
  --output /tmp/big-markers-profile-compressed.pfcb 2>&1
```

Output looks like:
```
Compression: 243.90 MB -> 84.55 MB (34.7%) / 17.31 MB after gzip
```

A `Value mismatch` line means `checkLossless` found a difference between the original
(normalized) profile and the recovered one. Exit code 1. No mismatch = success.

The known mismatch (`cause.time`) is from pre-existing µs precision loss — see
Float precision gotchas below. It is not caused by the binary encoding.

The output is a binary PFCB file (not JSON). See `FORMAT.md` for the container spec
and `CODEC.md` for the `$arr` array codec.

### Get a size breakdown

```sh
node node-tools-dist/profile-compress.js \
  --input /Users/mstange/Downloads/big-markers-profile.json \
  --analyze 2>&1
```

This prints the size of every binary section alongside its JSON path, plus JSON
skeleton / binary sections / total totals.

### Run json-size-profiler on the JSON skeleton

Numeric arrays that have been moved to binary slabs are replaced by `{"$bin":N}`
in the skeleton, so they don't show up here — only what's still in JSON.

```sh
node node-tools-dist/profile-compress.js \
  --input /Users/mstange/Downloads/big-markers-profile.json \
  --output-skeleton /tmp/skeleton.json
cp /tmp/skeleton.json ~/Downloads/
../json-size-profiler/target/release/json-size-profiler ~/Downloads/skeleton.json
pq load ~/Downloads/skeleton.json-size-profile.json
pq thread samples   # shows byte cost ranked by path
pq guide            # full command reference
```

`json-size-profiler` produces a Firefox profile where each "sample" is a JSON path and
"time" values are byte counts. The "total time" for a node is the sum of its entire
subtree — a cumulative measure, not just the node's own bytes.

### Validate types

```sh
yarn ts    # type-check the whole repo
```

## What the tool does internally

`profile-compress.js --input foo.json` calls `unserializeProfileOfArbitraryFormat` to
**normalize** the profile before compressing. The normalized profile can differ from the
raw JSON — some timestamps are computed by arithmetic during normalization, resulting in
sub-microsecond float values not present in the source file.

`checkLossless(profile, recoveredProfile)` compares the **normalized** original to the
round-tripped version. It does bit-exact float64 comparison.

### Compression pipeline (index.ts)

Compression runs in two phases:

**Phase 1** (`phase1`) is profile-aware. It walks specific known paths in the profile and
replaces arrays with `{ $arr: <descriptor>, $values: Uint8Array }` wrappers, where
`$values` is a LEB128-encoded byte stream. `phase1Decode` is the inverse.

**Phase 2** is mechanical. `JSON.stringify` is called with a replacer that intercepts any
`Uint8Array | Int32Array | Float64Array` anywhere in the tree and registers it as a binary
slab in the `Builder`, substituting `{ $bin: N }` in the JSON skeleton.

Decompression is the reverse: `JSON.parse` with a reviver substitutes `{ $bin: N }` back
to the TypedArray from the slab table, then Phase 1 decode reconstructs the original arrays.

### Adding a Phase 1 handler (the iterative workflow)

1. Run `--output-skeleton` and feed the skeleton JSON to `json-size-profiler` to find the
   largest arrays still in the JSON.
2. Choose the appropriate `ArrDescriptor` for the array (see `$arr` encoding system above).
3. In `phase1`, replace the array with `encodeArr(arr, desc)`. If the array lives in an
   object that is shared with the original profile (e.g. `shared.frameTable`, `counters[i]`),
   create a new containing object rather than mutating in place.
4. In `phase1Decode`, call `decodeArr(w as ArrWrapped)` at the same path.
5. For **marker table arrays**: add the key + descriptor to `MARKER_ARRAY_ENCODINGS` in
   `index.ts`; the loop handles encode and decode automatically. No explicit phase1/decode
   code needed.
6. Re-run the tool to confirm the slab appears in `--analyze` output and size improved.

## Optimizations implemented (markers.ts)

**String interning for marker field values.** String-format schema fields (`"string"`,
`"url"`, `"sanitized-string"`, `"file-path"`) are deduplicated into `fieldStringTable`;
`allStringFieldValues` stores indices. Non-string, non-time values go to
`allOtherFieldValues`; `"time"`-format values go to `allTimeFieldValues` (see below).
`unique-string` fields are already indices and go to `allOtherFieldValues`.

**µs delta-encoding for timestamps (lossy).** `startTime` and `endTime` are stored as
integer-microsecond deltas (`startTimeDeltaMicros`, `endTimeDeltaMicros`). Known precision
loss: `Math.round(t * 1000) / 1000 ≠ t` for sub-µs timestamps produced by arithmetic
during normalization. Invisible in the UI; `checkLossless` will report these mismatches.

**`endTime` encoded densely using `phase`.** Instant markers (phase 0) have `endTime = 0`
(sentinel) and IntervalStart markers (phase 2) have `endTime = null`. Rather than storing
these specially, we encode the startTime value for Instant markers (keeps deltas small)
and a zero delta for IntervalStart, then recover the sentinels at decode time using the
`phase` array. Result: `endTimeDeltaMicros` is a plain `number[]` with no nulls or index
arrays. Similarly, `startTimeDeltaMicros` is also null-free: IntervalEnd markers (phase 3)
encode endTime there instead; nullity is recovered from `phase` at decode time.

**`phase` sparse-encoded.** Default value is 0 (Instant, the majority). Only non-zero
phases are stored as `phaseNonZeroIndexDeltas` + `phaseNonZeroValues`.

**`innerWindowID` and `cause` handled with dedicated arrays.** Rather than storing
arbitrary extra-data objects with schema deduplication, two common overflow fields get
dedicated treatment in `fieldBits` (bits 1 and 2). `innerWindowID` is stored as a page
index into `profile.pages` (small integer) rather than the raw large ID. `cause` is split
into `allCauseStacks`, `allCauseTimes`, and `allCauseTids`. Remaining overflow
goes to `extraObjects` as verbatim JSON objects (now rare — ~1.8 MB).

**Category per schema.** `schemaDefaultCategories` stores the most common category for
each schema type; `categoryOverrideIndexDeltas` / `categoryOverrideValues` records the
rare exceptions. The dense per-marker `category[]` column is dropped entirely.

**Delta-encoding of integer columns.** `nameDeltaValues`, `schemaIndexDeltaValues`, and
`allPageIndexDeltas` store differences from the previous value. Consecutive markers of
the same type share name and schema index, so deltas are often 0. `fieldBits` and
`allStringFieldValues` were tried as delta-encoded but reverted — their values jump
unpredictably across schema boundaries, producing negative deltas that hurt both raw size
and gzip compressibility.

**Time-format field values in a separate array.** Schema fields with `format: "time"` are
separated from `allOtherFieldValues` into `allTimeFieldValues` and µs delta-encoded, the
same way as `startTime`.

## Optimizations implemented (Phase 1 binary encoding, index.ts)

### `$arr` encoding system

All Phase 1 arrays are encoded using a self-describing `ArrDescriptor` type (a string
enum) stored alongside the data as `{ $arr: '...', $values: Uint8Array, ...params }`.
The generic `encodeArr(values, desc)` and `decodeArr(w)` functions in `index.ts` handle
all variants:

| `$arr` value | Description | Extra fields |
|---|---|---|
| `'uleb128'` | Unsigned LEB128, no transform | — |
| `'sleb128'` | Signed LEB128, no transform | — |
| `'uleb128-delta'` | ULEB128 deltas; decode: prefix-sum then ×`$scale` | `$scale?: number` (default 1) |
| `'sleb128-null-sentinel'` | SLEB128; `$sentinel` value decodes as `null` | `$sentinel: number` |

For ms timestamps: `{ $arr: 'uleb128-delta', $scale: 0.001 }` — encodes deltas as integer
µs (divide by 0.001 = multiply by 1000) and restores ms by multiplying by 0.001.

### Encoded arrays

The following arrays are LEB128-encoded into `Uint8Array` slabs in `phase1`,
reducing the JSON skeleton from 107.66 MB → 42.25 MB:

**`CompressedMarkerTable` arrays** (via `MARKER_ARRAY_ENCODINGS` map in `index.ts`):

| Array | Encoding |
|---|---|
| `startTimeDeltaMicros` | `uleb128` |
| `endTimeDeltaMicros` | `uleb128` |
| `allStringFieldValues` | `uleb128` |
| `fieldBits` | `uleb128` |
| `allTimeFieldValues` | `uleb128` |
| `phaseNonZeroIndexDeltas` | `uleb128` |
| `phaseNonZeroValues` | `uleb128` |
| `categoryOverrideIndexDeltas` | `uleb128` |
| `categoryOverrideValues` | `uleb128` |
| `allCauseStacks` | `uleb128` |
| `allCauseTimes` | `uleb128` |
| `allCauseTids` | `uleb128` |
| `nameDeltaValues` | `sleb128` |
| `schemaIndexDeltaValues` | `sleb128` |
| `allPageIndexDeltas` | `sleb128` |

**Additional arrays** (handled explicitly in `phase1`, not via the map):

| Path | Encoding | Notes |
|---|---|---|
| `shared.stackTable.frame` | `uleb128` | plain non-negative indices |
| `shared.stackTable.prefix` | `sleb128-null-sentinel` ($sentinel=-1) | only index 0 is null |
| `threads[i].samples.time` | `uleb128-delta` ($scale=0.001) | lossy µs |
| `counters[i].samples.time` | `uleb128-delta` ($scale=0.001) | lossy µs |

### `fieldBits` layout change

The `fieldBits` bitmask in `CompressedMarkerTable` was extended to encode cause sub-field
presence. Schema fields shifted from bit k+3 to **bit k+6**:

```
bit 0:   has extraObjects
bit 1:   has innerWindowID
bit 2:   has cause
bit 3:   cause.stack is non-null   (only when bit 2 set)
bit 4:   cause.time is defined     (only when bit 2 set)
bit 5:   cause.tid is defined      (only when bit 2 set)
bit k+6: schema field k present
```

`allCauseStacks`, `allCauseTimes`, `allCauseTids` are now `number[]` (never null);
only non-null/defined values are stored, with bits 3–5 indicating presence at decode.

### Important: avoid mutating the original profile in `phase1`

`compressMarkers` spreads the original profile, so `shared` and `counters[i]` in the
`CompressedProfile` are the **same object references** as in the original. `phase1` must
create new objects (not mutate in place) for these paths — otherwise `checkLossless`
will compare the already-mutated original against the recovered profile and report
spurious mismatches. Thread objects in `cp.threads` are new (created by compressMarkers's
`{ ...thread, markers: newMarkers }` spread) and can be mutated safely.

## Remaining JSON skeleton targets

Sizes from `json-size-profiler` on the current 42.25 MB skeleton (self time = bytes
belonging directly to that node, excluding children).

| Target | Self size | Notes |
|---|---|---|
| `allOtherFieldValues[j]` | 10.8 MB | Mixed-type numbers; see blocker below |
| `fieldStringTable[j]` | 7.5 MB | String content; limited room for improvement |
| `stringArray[i]` | 6.8 MB | String content; limited room for improvement |
| `allOtherFieldValues` (array overhead) | 1.6 MB | Eliminated once values move to typed arrays |
| `counters[i].samples.count[j]` | 1.3 MB | Plain integers |
| `samples.eventDelay[j]` | 1.1 MB | Nullable floats |
| `frameTable.address[i]` | 0.9 MB | Integers; -1 means "no address" |
| `frameTable.func[i]` | 0.7 MB | Plain non-negative indices |
| `samples.stack[j]` | 0.65 MB | Nullable indices (mostly non-null) |
| `frameTable.column[i]` | 0.6 MB | Mostly null |
| `frameTable.innerWindowID[i]` | 0.5 MB | Plain non-negative integers |
| `frameTable.category[i]` | 0.46 MB | Mostly null |
| `frameTable.subcategory[i]` | 0.46 MB | Mostly null |
| `counters[i].samples.number[j]` | 0.37 MB | Plain integers (optional field) |
| `samples.threadCPUDelta[j]` | 0.36 MB | Nullable integers |
| `frameTable.line[i]` | 0.34 MB | Nullable integers (mostly non-null) |
| `frameTable.nativeSymbol[i]` | 0.4 MB | Nullable indices (mostly non-null) |

### Next easy wins

**`counters[i].samples.count` and `counters[i].samples.number` (~1.6 MB combined).**
Both are plain non-negative integer arrays in `RawCounterSamplesTable`. `number` is
optional. Handle in `phase1` as `uleb128` the same way as `shared.stackTable.frame`.
Be careful to create new `samples` objects (don't mutate the originals, which are
shared with the input profile).

**`frameTable.address`, `frameTable.func`, `frameTable.innerWindowID` (~2.1 MB combined).**
All in `profile.shared.frameTable`. `address` values can be -1 (unknown address), so use
`sleb128`. `func` and `innerWindowID` are non-negative, so `uleb128`. Encode in `phase1`
by replacing `shared.frameTable` with a new object (same aliasing concern as `shared.stackTable`).

**`samples.stack`, `samples.threadCPUDelta` (~1 MB combined).**
`stack` is `Array<IndexIntoStackTable | null>` but mostly non-null; use
`sleb128-null-sentinel` with -1. `threadCPUDelta` is nullable integers; same approach.
Create a new `samples` object on each thread (threads are new objects from `compressMarkers`,
so assigning `thread.samples = {...}` is safe; the inner mutation pattern still needs a new object).

**`frameTable.column`, `frameTable.category`, `frameTable.subcategory` (~1.5 MB combined).**
These are mostly null. A null-heavy array is best encoded sparsely: store only non-null
values plus a parallel index array. This could reuse `sleb128-null-sentinel` with a
special sentinel, but a dedicated `'uleb128-sparse'` descriptor (non-null values +
their indices) may compress better. Alternatively, skip these for now since the total
is modest vs. the complexity.

**`frameTable.line` and `frameTable.nativeSymbol` (~0.74 MB combined).**
Nullable integers, mostly non-null. `sleb128-null-sentinel` with -1 (since -1 is not a
valid line number or nativeSymbol index).

### Blocker: `allOtherFieldValues` (10.8 MB numbers + 1.6 MB array overhead)

Holds numbers, booleans, and other values mixed together — JSON is self-describing
so this works for free. In binary, the decoder must know every value's type.
The fix is to extend the format split already done for `"time"` fields to cover
every other schema format: `"integer"`, `"bytes"`, `"boolean"`, `"percentage"`,
`"unique-string"`, `"number"`. Each gets its own typed array in `CompressedMarkerTable`
(markers.ts change) and a Phase 1 binary handler. The `"list"` format is the hard
case and could stay as embedded JSON.

### `name` per-schema default (part of remaining ~0.3 MB after binary encoding)

For most markers, `name[i]` is the string-table index of the schema type name (the same
string as `schema.name`). Storing one default name index per schema — looked up from the
shared string table at compression time — and using sparse overrides would eliminate the
`name` column almost entirely, just as the per-schema category did for `category`.

### RLE of `(schemaIndex, fieldBits)` pairs

Many consecutive markers share the exact same (schemaIndex, fieldBits) pair. Run-length
encoding this pair as `[value, count]` tuples would shrink both columns significantly and
is a natural complement to the per-schema-default idea for `name`.

## Key numbers for this profile

Profile: `big-markers-profile.json` (2 threads, ~1.5M markers total)

| Metric | Value |
|---|---|
| Original size | 243.90 MB / 25.10 MB gzip |
| After markers.ts optimizations only (no binary) | 107.66 MB / 18.70 MB gzip |
| After Phase 1 marker arrays only | 84.55 MB / 17.31 MB gzip |
| After Phase 1 stackTable + timestamps + cause arrays (current) | 67.98 MB / 15.34 MB gzip |
| JSON skeleton size (current) | 42.25 MB |
| Binary slabs size (current) | 25.73 MB (38 slabs) |
| After generic binary encoding (old approach, removed) | 63.20 MB / 16.79 MB gzip |
| String field values (total / unique) | 1.18M / 126K |
| Instant markers (endTime = 0) | 443K / 755K (59%) |

## Float precision gotchas

Some normalized timestamps (e.g. `4418498.666067375`) are produced by arithmetic inside
`unserializeProfileOfArbitraryFormat` and have sub-microsecond precision. No integer
multiplier (×1000, ×1e6, ×1e9) round-trips them exactly, so µs encoding is always lossy.
Options:

1. **Accept lossy µs compression.** Sub-µs is invisible in the UI; `checkLossless` will
   report failures but the data is usable. This is the current approach.
2. **ULP delta encoding.** Float64 bit patterns for sorted timestamps increase
   monotonically. The ULP delta is typically ~2000–200000 (4–6 chars) vs 14 chars for the
   absolute value. Lossless, but requires DataView bit manipulation.
3. **Skip timestamp compression** and invest effort in binary slabs instead.
