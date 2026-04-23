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
Compression: 243.90 MB -> 107.66 MB (44.1%) / 18.70 MB after gzip
Value mismatch at .threads[0].markers.data[15].cause.time: 4418498.449792 vs 4418498.45
```

A `Value mismatch` line means `checkLossless` found a difference between the original
(normalized) profile and the recovered one. Exit code 1. No mismatch = success.

### Profile the JSON output to find where bytes live

```sh
cp /tmp/big-markers-profile-compressed.json ~/Downloads/
../json-size-profiler/target/release/json-size-profiler ~/Downloads/big-markers-profile-compressed.json
pq load ~/Downloads/big-markers-profile-compressed.json-size-profile.json
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
arrays.

**`phase` sparse-encoded.** Default value is 0 (Instant, the majority). Only non-zero
phases are stored as `phaseNonZeroIndexDeltas` + `phaseNonZeroValues`.

**`innerWindowID` and `cause` handled with dedicated arrays.** Rather than storing
arbitrary extra-data objects with schema deduplication, two common overflow fields get
dedicated treatment in `fieldBits` (bits 1 and 2). `innerWindowID` is stored as a page
index into `profile.pages` (small integer) rather than the raw large ID. `cause` is split
into `allCauseStacks`, `allCauseTimes` (µs delta), and `allCauseTids`. Remaining overflow
goes to `extraObjects` as verbatim JSON objects (now rare — ~1.7 MB).

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

## Remaining large targets

Approximate sizes from the last size-profiler run (at 107.66 MB total):

| Target | Size | Notes |
|---|---|---|
| `shared.stackTable` | ~17 MB | `prefix[]` and `frame[]` — delta or varint encoding |
| `allOtherFieldValues` | ~10 MB | Mixed-type numeric fields; see Binary Format section |
| `startTimeDeltaMicros` | ~9 MB | Already µs-encoded; need binary to go further |
| `name` column | ~7.5 MB | Could use per-schema default (same idea as category) |
| `shared.stringArray` | ~7 MB | Would need changes in index.ts |
| `fieldStringTable` strings | ~7 MB | Content is irreducible; string encoding overhead only |
| `allStringFieldValues` | ~5 MB | Raw indices; per-(schema,field) delta states would help |
| `counters[i].samples.time` | ~5 MB | Same µs delta idea as startTime |
| `endTimeDeltaMicros` | ~4 MB | Already µs-encoded; need binary to go further |
| `fieldBits` | ~4 MB | Raw integers; RLE of (schemaIndex, fieldBits) pairs might help |
| `extraObjects` | ~2 MB | Inspect remaining key patterns; consider more special-casing |

### `name` per-schema default

For most markers, `name[i]` is the string-table index of the schema type name (the same
string as `schema.name`). Storing one default name index per schema — looked up from the
shared string table at compression time — and using sparse overrides would eliminate the
`name` column almost entirely, just as the per-schema category did for `category`.

### RLE of `(schemaIndex, fieldBits)` pairs

Many consecutive markers share the exact same (schemaIndex, fieldBits) pair. Run-length
encoding this pair as `[value, count]` tuples would shrink both columns significantly and
is a natural complement to the per-schema-default idea for `name`.

## Binary format

### Would it help?

Yes, substantially. The dominant cost in the current format is JSON integers: a typical
µs-range delta (3–6 digits) costs 4–7 bytes including the comma. LEB128 encodes the same
value in 1–3 bytes. The ~50 MB of integer array content in the file would shrink 2–3×,
putting uncompressed size around 70–80 MB. Gzip gains would be smaller since gzip already
exploits the repetitive structure of delta-encoded streams.

### What makes it hard right now

**`allOtherFieldValues` is the main blocker.** It holds numbers, booleans, and other
values mixed together with no type tags — JSON is self-describing so this works for free.
In binary, the decoder must know every value's type statically. The fix is to extend the
format split we already did for `"time"` fields to cover every other schema format:
`"integer"`, `"bytes"`, `"boolean"`, `"percentage"`, `"unique-string"`, `"number"`,
and `"list"`. Each gets its own typed array with appropriate binary encoding. The `"list"`
format is the hard case and could stay as embedded JSON.

**`extraObjects` is the other holdout.** These are arbitrary JavaScript objects stored
verbatim. Binary encoding requires knowing every value's shape statically. At ~2 MB and
shrinking, the pragmatic path is to special-case more patterns (more bits in `fieldBits`)
until this is negligible, or accept embedded JSON for these rare objects.

**`startTimeDeltaMicros` contains nulls.** The `(number | null)[]` type exists because
IntervalEnd markers (phase 3) can have `startTime = null`. In binary, nulls need either
a sentinel value or a presence bitfield. Since the phase array is available, nullity is
derivable — it just needs a decision on encoding.

### What would need to change

1. **Complete the format split on `allOtherFieldValues`**: give every schema format its
   own typed array. This is the prerequisite for everything else.
2. **Drive `extraObjects` to near-zero**: audit what's still in there and add more
   special-cased bits, or accept those objects as an embedded JSON island.
3. **Eliminate nulls from `startTimeDeltaMicros`**: derive from `phase` at decode time.
4. **Design the binary container**: a small JSON header (schema metadata, string tables)
   followed by binary sections for each typed array keeps the human-readable parts
   readable and the hot data compact.

## Key numbers for this profile

Profile: `big-markers-profile.json` (2 threads, ~1.5M markers total)

| Metric | Value |
|---|---|
| Original size | 243.90 MB / 25.10 MB gzip |
| After all current optimizations | 107.66 MB / 18.70 MB gzip |
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
3. **Skip timestamp compression** and invest effort in a binary format instead.
