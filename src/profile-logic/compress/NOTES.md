# Profile Compression Playground — Notes

## Overview

This directory is a sandbox for experimenting with compact in-memory profile representations.
The goal is a smaller JSON payload that can be sent over the wire and held in memory.

`index.ts` is the entry point (`compressProfile` / `uncompressProfile`).
`markers.ts` has the marker-specific compression, which is currently the richest area.
`json-slabs/index.ts` implements the generic "JSON with binary slabs" container (`JsonSlabs.slabify` / `JsonSlabs.parse`).
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

The output is a binary PFCB file (not JSON). See `json-slabs/FORMAT.md` for the container spec
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

Numeric arrays that have been moved to binary slabs are replaced by `{"$s":N}`
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

Compression has two encoding layers applied inner-to-outer, and decoding unwraps them outer-to-inner.

**Column encoding** (`encodeColumns` / `decodeColumns`) is the inner layer. It is
profile-aware: it walks specific known paths in the profile and replaces arrays with
`{ $arr: <descriptor>, $values: Uint8Array }` wrappers, where `$values` is a
LEB128-encoded byte stream.

**Slab encoding** (`JsonSlabs.slabify` / `JsonSlabs.parse`) is the outer layer. It is mechanical:
`JSON.stringify` is called with a replacer that intercepts any `Uint8Array | Int32Array |
Float64Array` anywhere in the tree and registers it as a binary slab in the `Builder`,
substituting `{ $s: N }` in the JSON skeleton. Decoding uses `JSON.parse` with a reviver
that substitutes `{ $s: N }` back to the TypedArray from the slab table.

Decompression applies the layers in reverse order: slab decoding first (via
`JSON.parse` reviver), then column decoding.

### Adding a column encoding handler (the iterative workflow)

1. Run `--output-skeleton` and feed the skeleton JSON to `json-size-profiler` to find the
   largest arrays still in the JSON.
2. Choose the appropriate `ArrDescriptor` for the array (see `$arr` encoding system above).
3. In `encodeColumns`, replace the array with `encodeArr(arr, desc)`. If the array lives in
   an object that is shared with the original profile (e.g. `shared.frameTable`,
   `counters[i]`), create a new containing object rather than mutating in place.
4. In `decodeColumns`, call `decodeArr(w as ArrWrapped)` at the same path.
5. For **marker table arrays**: add the key + descriptor to `MARKER_ARRAY_ENCODINGS` in
   `index.ts`; the loop handles encode and decode automatically. No explicit
   encodeColumns/decodeColumns code needed.
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

## Optimizations implemented (column encoding, index.ts)

### `$arr` encoding system

All column-encoded arrays use a self-describing `ArrWrapped` type stored as
`{ $arr: '...', $length: number, $values: Uint8Array, ...params }`.
The generic `decodeArr(w)` function in `index.ts` handles all variants:

| `$arr` value | Description | Extra fields |
|---|---|---|
| `'leb128'` | LEB128 integers; optional `$signed`, `$delta`, `$scale` | `$length` (required); `$signed?`, `$delta?`, `$scale?` |
| `'sleb128-null-sentinel'` | SLEB128; `$sentinel` value decodes as `null` | `$length`, `$sentinel: number` |
| `'sleb128-slide-prefix'` | SLEB128; `$nullSentinel`→null, `$slideSentinel`→`i-1`, else value | `$length`, `$nullSentinel`, `$slideSentinel: number` |
| `'constant-null'` | All values are null; no `$values` field needed | `$length: number` |

For ms timestamps: `{ $arr: 'leb128', $scale: 0.001 }` — encodes as integer µs, restores ms by ×0.001.
For delta-encoded ms timestamps: `{ $arr: 'leb128', $delta: true, $scale: 0.001 }`.

`'sleb128-slide-prefix'` is used for `stackTable.prefix`. Stack tables have many
consecutive "slides" (prefix[i] = i-1) when the profiler appends stacks in order for a
growing call chain. Encoding those as a 1-byte sentinel instead of the actual (large)
index value saves ~2–4 bytes per slide entry. On `big-stacktable-profile.json` this
reduced the prefix slab from 64.54 MB → 21.22 MB (67% reduction).

### Encoded arrays

The following arrays are LEB128-encoded into `Uint8Array` slabs in `encodeColumns`,
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
| `allIntegerFieldValues` | `uleb128` | formats: `integer`, `bytes`, `unique-string`, `flow-id`, `terminating-flow-id` |

**Additional arrays** (handled explicitly in `encodeColumns`, not via the map):

| Path | Encoding | Notes |
|---|---|---|
| `shared.stackTable.frame` | `uleb128` | plain non-negative indices |
| `shared.stackTable.prefix` | `sleb128-slide-prefix` ($nullSentinel=-1, $slideSentinel=-2) | slide opt cuts 64→21 MB |
| `shared.frameTable.address` | `sleb128` | -1 = unknown address |
| `shared.frameTable.inlineDepth` | `uleb128` | |
| `shared.frameTable.category` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.frameTable.subcategory` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.frameTable.func` | `uleb128` | |
| `shared.frameTable.nativeSymbol` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.frameTable.innerWindowID` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.frameTable.line` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.frameTable.column` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.funcTable.name` | `uleb128` | |
| `shared.funcTable.isJS` | `uleb128` (0/1 from bool) | booleans restored at decode |
| `shared.funcTable.relevantForJS` | `uleb128` (0/1 from bool) | booleans restored at decode |
| `shared.funcTable.resource` | `sleb128` | -1 = no resource |
| `shared.funcTable.source` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.funcTable.lineNumber` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.funcTable.columnNumber` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.nativeSymbols.libIndex` | `uleb128` | |
| `shared.nativeSymbols.address` | `uleb128` | library-relative, non-negative |
| `shared.nativeSymbols.name` | `uleb128` | |
| `shared.nativeSymbols.functionSize` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.resourceTable.lib` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.resourceTable.name` | `uleb128` | |
| `shared.resourceTable.host` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.resourceTable.type` | `uleb128` | ResourceType enum (0–5) |
| `shared.sources.filename` | `uleb128` | IndexIntoStringTable |
| `shared.sources.startLine` | `uleb128` | |
| `shared.sources.startColumn` | `uleb128` | |
| `shared.sources.sourceMapURL` | `constant-null` if all-null, else `sleb128-null-sentinel` ($sentinel=-1) | |
| `shared.sources.id` | `constant-null` if all-null, else left as raw `string\|null[]` | UUID strings |
| `threads[i].markers.allFloatFieldValues` | `Float64Array` slab (via slab encoding) | formats: `duration`, `seconds`, `milliseconds`, `microseconds`, `nanoseconds`, `percentage`, `decimal` |
| `shared.stringArray` | custom `{ $strBytes, $strLens }` | UTF-8 concat + uleb128 lengths; see below |
| `threads[i].markers.fieldStringTable` | custom `{ $strBytes, $strLens }` | same encoding as stringArray |

**`{ $strBytes, $strLens }` string array encoding.** Used for both `shared.stringArray` and
`threads[i].markers.fieldStringTable`. Two `Uint8Array` slabs: `$strBytes` — all strings
concatenated as raw UTF-8 bytes; `$strLens` — each string's byte length uleb128-encoded.
Helpers `encodeStringArray` / `decodeStringArray` / `isEncodedStringArray` in `index.ts`
implement the pattern. This sits outside the `$arr` system because values are strings, not
numbers. `walkForBinPaths` in `binary-analysis.ts` was updated to label direct `{ $s: N }`
property values (not just those inside `$arr` wrappers).
| `threads[i].samples.time` | `uleb128-delta` ($scale=0.001) | lossy µs |
| `threads[i].samples.timeDeltas` | `uleb128-ms` | lossy µs |
| `threads[i].samples.stack` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `threads[i].samples.threadCPUDelta` | `sleb128-null-sentinel` ($sentinel=-1) | |
| `threads[i].samples.weight` | `sleb128` | can be negative in diff profiles |
| `counters[i].samples.time` | `uleb128-delta` ($scale=0.001) | lossy µs |
| `counters[i].samples.count` | `uleb128` | |
| `counters[i].samples.number` | `uleb128` | |

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

### Important: avoid mutating the original profile in `encodeColumns`

`compressMarkers` spreads the original profile, so `shared` and `counters[i]` in the
`CompressedProfile` are the **same object references** as in the original. `encodeColumns` must
create new objects (not mutate in place) for these paths — otherwise `checkLossless`
will compare the already-mutated original against the recovered profile and report
spurious mismatches. Thread objects in `cp.threads` are new (created by compressMarkers's
`{ ...thread, markers: newMarkers }` spread) and can be mutated safely.

## Remaining JSON skeleton targets (big-markers-profile.json)

Sizes from `json-size-profiler` on the current skeleton (self time = bytes
belonging directly to that node, excluding children).

| Target | Self size | Notes |
|---|---|---|
| `samples.eventDelay[j]` | 1.1 MB | Nullable floats |

### `name` per-schema default (part of remaining ~0.3 MB after binary encoding)

For most markers, `name[i]` is the string-table index of the schema type name (the same
string as `schema.name`). Storing one default name index per schema — looked up from the
shared string table at compression time — and using sparse overrides would eliminate the
`name` column almost entirely, just as the per-schema category did for `category`.

### RLE of `(schemaIndex, fieldBits)` pairs

Many consecutive markers share the exact same (schemaIndex, fieldBits) pair. Run-length
encoding this pair as `[value, count]` tuples would shrink both columns significantly and
is a natural complement to the per-schema-default idea for `name`.

## Key numbers

### `big-markers-profile.json` (2 threads, ~1.5M markers total)

| Metric | Value |
|---|---|
| Original size | 243.90 MB / 25.10 MB gzip |
| After markers.ts optimizations only (no binary) | 107.66 MB / 18.70 MB gzip |
| After column encoding marker arrays only | 84.55 MB / 17.31 MB gzip |
| After column encoding stackTable + timestamps + cause arrays | 67.98 MB / 15.34 MB gzip |
| After column encoding all arrays (before stringArray) | 58.05 MB / 12.55 MB gzip |
| After stringArray binary encoding | 57.68 MB / 12.52 MB gzip |
| After fieldStringTable binary encoding | 57.26 MB / 12.50 MB gzip |
| **After allIntegerFieldValues + allFloatFieldValues (current)** | **50.93 MB / 12.19 MB gzip** |
| JSON skeleton size (current) | ~3.4 MB |
| Binary slabs size (current) | ~47.5 MB (78 arrays) |
| After generic binary encoding (old approach, removed) | 63.20 MB / 16.79 MB gzip |
| String field values (total / unique) | 1.18M / 126K |
| Instant markers (endTime = 0) | 443K / 755K (59%) |

### `big-stacktable-profile.json` (~15M stacks)

| Metric | Value |
|---|---|
| Original size | 463.60 MB / ~114 MB gzip |
| After column encoding stackTable only (old) | 322.98 MB / 114.82 MB gzip |
| After column encoding all arrays (before stringArray) | 176.09 MB / 74.37 MB gzip |
| After stringArray binary encoding | 174.18 MB / 74.54 MB gzip |
| After fieldStringTable binary encoding | 174.18 MB / 74.54 MB gzip |
| **After allIntegerFieldValues + allFloatFieldValues (current)** | **173.75 MB / 74.53 MB gzip** |
| JSON skeleton size (current) | 0.28 MB |
| Binary slabs size (current) | 173.47 MB (875 arrays) |
| `stackTable.prefix` slab: before / after slide opt | 64.54 MB → 21.22 MB |

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
