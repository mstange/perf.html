# Profile Compression Playground — Notes

## Overview

This directory is a sandbox for experimenting with compact in-memory profile representations.
The goal is a smaller JSON payload that can be sent over the wire and held in memory.

`index.ts` is the entry point (`compressProfile` / `uncompressProfile`).
`markers.ts` has the marker-specific compression, which is currently the richest area.

## Workflow

### Build & run the compression tool

```sh
yarn build-node-tools
node node-tools-dist/profile-compress.js \
  --input /Users/mstange/Downloads/big-markers-profile.json \
  --output /tmp/big-markers-profile-compressed.json 2>&1 | head -80
```

Output looks like:
```
Compression: 243.90 MB -> 130.02 MB (53.3%) / 20.26 MB after gzip
Value mismatch at .threads[0].markers.startTime[0]: 4418497.949708 vs 4418497.95
```

A `Value mismatch` line means `checkLossless` found a difference between the original
(normalized) profile and the recovered one. Exit code 1. No mismatch = success.

### Profile the JSON output to find where bytes live

```sh
../json-size-profiler/target/release/json-size-profiler /tmp/big-markers-profile-compressed.json
pq load /tmp/big-markers-profile-compressed.json-size-profile.json
pq thread samples   # shows byte cost ranked by path
pq guide            # full command reference
```

`json-size-profiler` produces a Firefox profile where each "sample" is a JSON path and
"time" values are byte counts. `pq` (profiler-cli) queries it. The "total time" for a node
is the sum of its entire subtree — it's a cumulative measure, not just the node's own bytes.

### Validate types

```sh
yarn ts    # type-check the whole repo
```

## What the tool does internally

`profile-compress.js --input foo.json` calls `unserializeProfileOfArbitraryFormat` to
**normalize** the profile before compressing. This matters: the normalized profile can
differ from the raw JSON — e.g., some timestamps are computed by arithmetic during
normalization, resulting in sub-microsecond float values not present in the source file.

`checkLossless(profile, recoveredProfile)` compares the **normalized** original to the
round-tripped version. It does bit-exact float64 comparison.

## Optimizations implemented (as of this session)

### 1. String interning for marker field values (`allFieldValues` → split arrays)

**Where:** `markers.ts`

**Idea:** String-typed schema fields (format `"string"`, `"url"`, `"sanitized-string"`,
`"file-path"`) were stored verbatim in a mixed `allFieldValues` array. Across 2 threads,
1.18M string values with only 126K unique → huge duplication.

**Implementation:** Split into:
- `fieldStringTable`: deduplicated string pool
- `allStringFieldValues`: indices into that pool (integers)
- `allOtherFieldValues`: all non-string field values

`isStringFormat(field.format)` in the hot loop decides which array to use. The schema's
`format` field is the source of truth (checked identically on decompress).

**Saving:** 243.90 → 170.10 MB (−21.7 MB)

**Watch out for:** `unique-string` format fields already store string-table indices
(integers), so they correctly end up in `allOtherFieldValues`, not the string intern pool.

### 2. Microsecond delta-encoding for `startTime` (lossy)

**Where:** `markers.ts`

**Idea:** Timestamps like `4418497.949708` are 14 JSON chars. Delta-encoding as integer
microseconds gives compact deltas like `181` (3 chars).

**Implementation:** `startTimeDeltaMicros`: first value is `Math.round(t * 1000)` (absolute
µs), subsequent values are deltas. On decode: cumulative sum → divide by 1000.

**Saving:** 170.10 → 148.62 MB (−21.5 MB)

**Known precision loss:** `Math.round(t * 1000) / 1000 ≠ t` for timestamps with more than
3 decimal places in ms (e.g. `4418498.666067375` decoded as `4418498.666`). This is
sub-microsecond precision loss, negligible for display, but `checkLossless` fails.

**Things tried that didn't work:**
- Float delta encoding: `a - b` in float64 produces long decimals like `0.18112500000465661`
  (21 chars) — WORSE than the original 14-char absolute value.
- Nanosecond integers (`* 1e6`): larger first values (13 chars) + larger deltas (6 chars),
  net result is bigger than microseconds. Also still lossy.
- Picoseconds (`* 1e9`): even larger numbers, worse compression.
- The root problem: some normalized timestamps are float64 values computed by arithmetic
  (e.g. `startTime + offset`) and don't round-trip through any integer multiplier exactly.

### 3. Schema-based extra data objects

**Where:** `markers.ts`

**Idea:** Markers with unknown types or schema-overflow fields go into `allExtraDataObjects`.
In this profile, 98.6% of 570K extra objects follow 3 key patterns:
- `{innerWindowID}` — 413K objects (72%)
- `{cause, innerWindowID}` — 120K objects (21%)
- `{cause}` — 29K objects (5%)

Storing `{"innerWindowID": N}` 413K times wastes 413K × `"innerWindowID":` = 5.8 MB in
key names alone.

**Implementation:** Replace `allExtraDataObjects: unknown[]` with:
- `extraSchemas: string[][]` — list of unique key-arrays (schemas)
- `extraSchemaIndices: number[]` — which schema each extra object uses
- `extraFlatValues: unknown[]` — values in schema-key order, all objects flattened

`pushExtraObject(obj)` interns the key-set and appends values. `popExtraObject()` looks up
the schema index, reads the keys, reads values from `extraFlatValues`.

**Saving:** 148.62 → 138.09 MB (−10.5 MB)

**Watch out for:** The schema is keyed by insertion order of `Object.keys(obj)`. Two
objects with the same keys in different orders → different schemas. In practice, Firefox
marker payloads have consistent key ordering, so schemas are well-shared.

**Future work:** Nested objects (like `cause: {time: T, stack: S}`) are stored verbatim in
`extraFlatValues` — 8.5 MB. Recursive schema compression would save ~2.2 MB in key names
plus ~2 MB if `cause.time` is also µs-encoded. The challenge is tracking which `extraFlatValues`
entries are objects vs primitives without an expensive per-value type tag.

### 4. `endTime` sparse encoding

**Where:** `markers.ts`

**Idea:** 59% of markers (443K out of 755K in thread 0) have `endTime = 0` — a sentinel
for point markers. Delta-encoding a mixed stream of zeros and large timestamp values creates
expensive sign-flipping transitions. Sparse encoding skips the zeros entirely.

**Implementation:**
- `endTimeNullIndexDeltas`: delta-encoded indices of markers with `null` endTime (rare)
- `endTimeNonZeroIndexDeltas`: delta-encoded indices of markers with non-zero endTime
- `endTimeNonZeroDeltaMicros`: delta-encoded µs values for those positions

Decode: fill array with zeros, then scatter nulls and non-zero values by their indices.

**Saving:** 131.31 → 130.02 MB (−1.3 MB), gzip 21.05 → 20.26 MB

**Watch out for:** `endTime = 0` is treated as a sentinel (not a real timestamp). If a
profile legitimately records a marker ending at exactly t=0ms, it would be lost. This is
safe in practice — markers start well past t=0 after normalization.

## Remaining large targets (not yet implemented)

| Target | Size | Notes |
|---|---|---|
| `shared.stackTable` | 16.7 MB | prefix[] and frame[] integer arrays — delta/varint encoding |
| `extraFlatValues` objects | 8.5 MB | `cause: {time, stack}` — recursive schema compression |
| `allOtherFieldValues` numbers | 10.8 MB | mixed numeric fields — hard without per-value type info |
| `counters[i].samples.time` | 4.9 MB | same µs delta idea as startTime |
| `shared.stringArray` | 7.0 MB | would need changes in index.ts |

## Key numbers for this profile

Profile: `big-markers-profile.json` (2 threads, ~1.5M markers total)

| Metric | Value |
|---|---|
| Original size | 243.90 MB |
| After all current optimizations | 130.02 MB (53.3% of original) |
| After gzip | 20.26 MB (vs 25.10 MB original gzip) |
| String field values (total / unique) | 1.18M / 126K |
| Markers with zero endTime | 443K / 755K (59%) |
| Extra object key patterns (top 3 cover) | 98.6% |

## Float precision gotchas

The normalized profile can contain timestamps like `4418498.666067375` that aren't in the
source JSON — they're produced by arithmetic inside `unserializeProfileOfArbitraryFormat`.
These values have sub-microsecond precision. No integer multiplier (1e3, 1e6, 1e9) reliably
round-trips all such values. Options:

1. **Accept lossy µs compression.** Sub-µs is invisible in the profiler UI. `checkLossless`
   will report failures, but the data is usable.
2. **ULP (unit in last place) delta encoding.** Float64 bit patterns for sorted timestamps
   are monotonically increasing. The ULP delta between consecutive timestamps is typically
   ~2000–200000 (4–6 chars), vs 14 chars for the absolute value. Lossless, but requires
   DataView bit manipulation and careful handling of unsorted sequences.
3. **Skip timestamp compression** and invest effort elsewhere (binary format, etc.).
