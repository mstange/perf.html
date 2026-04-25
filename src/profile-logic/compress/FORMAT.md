# PFCB — Binary Profile Container Format

Version 3.

## Overview

A compressed profile object consists mostly of large numeric arrays embedded
inside a JSON object.  The PFCB format separates two independent concerns:

**Binary container** — strips numeric arrays out of the JSON and stores them as
compact typed-byte slabs, leaving all other content as plain UTF-8 JSON.  The
container has no knowledge of how bytes become numbers; it only knows the
primitive storage type of each slab (`U8` byte blob, `I32` array, or `F64` float
array).

**Array codec** — knows how to encode a semantic array (floats, signed integers,
nullable sequences) into raw bytes and how to decode it back.  Encoding choices
(LEB128 compression, zigzag for signed integers, delta encoding, float scaling,
null bitfields) are recorded in `$arr` descriptor objects embedded in the JSON,
so the same descriptor works whether the backing values are a binary slab or an
inline JSON number array.

---

## Binary Container

### Overall Layout

```
Offset   Size         Description
------   ----         -----------
0        4            Magic bytes: 0x50 0x46 0x43 0x42  ("PFCB")
4        4            Version: uint32LE = 3
8        4            Slab count: uint32LE
12       4            Root JSON slab index: uint32LE
16       5 × count    Slab table (see below)
16+5N    P            Zero padding to next 8-byte boundary
16+5N+P  …            Slab data (each slab at its natural alignment)
```

**Slab table** — one 5-byte entry per slab, in order:

```
Offset  Size   Description
------  ----   -----------
0       1      Type byte  (see below)
1       4      Slab byte length: uint32LE
```

**Slab data** — slabs are emitted in table order.  Before each slab, zero
padding is inserted so the slab starts at a multiple of its natural alignment
(1, 2, 4, or 8 bytes depending on type; see Type Byte table).

The JSON skeleton is stored as a slab at index `rootJsonSlabIndex` (always the
last slab).  All other slabs are data slabs.

### JSON Skeleton Slab

The JSON slab is the profile object serialized with `JSON.stringify`, with every
numeric array replaced by an `$arr` wrapper:

```json
{ "$arr": { … }, "$values": <inner> }
```

`<inner>` is either `{ "$bin": N }` (slab N in this container) or a plain JSON
number array (inline).  All other content — strings, nested objects, mixed-type
arrays — remains verbatim.  The `$arr` descriptor is described in the Array
Codec section below.

### Type Byte

The container only records the primitive storage type of each slab's bytes.
All interpretation of those bytes is the array codec's responsibility.

One type byte per JavaScript TypedArray type, in width order:

| Value | TypedArray      | Element size | Alignment | Notes                        |
|-------|-----------------|--------------|-----------|------------------------------|
| 0x00  | Int8Array       | 1 byte       | 1         |                              |
| 0x01  | Uint8Array      | 1 byte       | 1         | Used for LEB128 byte streams |
| 0x02  | Int16Array      | 2 bytes LE   | 2         |                              |
| 0x03  | Uint16Array     | 2 bytes LE   | 2         |                              |
| 0x04  | Int32Array      | 4 bytes LE   | 4         | Used for integer arrays      |
| 0x05  | Uint32Array     | 4 bytes LE   | 4         |                              |
| 0x06  | Float32Array    | 4 bytes LE   | 4         |                              |
| 0x07  | Float64Array    | 8 bytes LE   | 8         | Used for float arrays        |
| 0x08  | BigInt64Array   | 8 bytes LE   | 8         |                              |
| 0x09  | BigUint64Array  | 8 bytes LE   | 8         |                              |

### Container Encode / Decode (outline)

**Encode:**
1. Walk the profile tree; for every numeric array, call `encodeArray()` →
   receive back a `Uint8Array` (LEB128), `Int32Array`, or `Float64Array`.  Add
   it to the `Builder` via `addSlabU8` / `addSlabI32` / `addSlabF64`; get back a
   `{ "$bin": N }` placeholder.
2. Replace the array in the skeleton with `{ "$arr": descriptor, "$values": { "$bin": N } }`.
3. JSON-stringify the skeleton into a `Uint8Array`; pass it to `builder.finish()`.
4. `finish()` appends the JSON as the final slab, then emits:
   - fixed header (magic + version + slab count + root JSON slab index),
   - slab table (type byte + byte length per slab),
   - zero padding to 8-byte boundary,
   - slab data (each slab preceded by alignment padding as needed).
   Returns an array of zero-copy `Uint8Array` chunks.

**Decode:**
1. Verify magic and version.
2. Read fixed header: slab count and root JSON slab index.
3. Read slab table: type byte + byte length per slab.
4. Reconstruct typed-array views into the buffer (zero-copy, with alignment).
5. Decode the JSON slab (`slabs[rootJsonSlabIndex]`) with `TextDecoder`.
6. Walk the skeleton; for every `{ "$arr": descriptor, "$values": { "$bin": N } }`,
   call `decodeArray(slabs[N], descriptor)` and substitute the result.

---

## Array Codec

### `$arr` Descriptor Object

| Field    | Type      | Default | Meaning                                              |
|----------|-----------|---------|------------------------------------------------------|
| `signed` | boolean   | false   | LEB128 byte blobs use zigzag (signed) encoding       |
| `delta`  | boolean   | false   | Cumulative-sum (undelta) the integer sequence        |
| `scale`  | number    | 1       | Multiply every value by this constant                |
| `nulls`  | number[]  | absent  | Presence bitfield; see Null Handling below           |
| `count`  | number    | absent  | Total element count including null positions (required when `nulls` is set) |

All fields are optional.  An empty `{}` is valid (raw values pass through
unchanged).

### Null Handling

When `nulls` is present it is a byte array (each element 0–255) forming a packed
bitfield.  Bit i (the bit at position `i % 8` counting from the LSB of byte
`i >> 3`) is **1** if element i is non-null, **0** if null.  The `$values` source
stores only the non-null elements in order; null slots are re-inserted at the end
of the decode pipeline.

### LEB128 Integer Encoding

Integer arrays are LEB128-encoded to a byte blob, stored as a `Uint8Array` slab.

#### Unsigned LEB128

Each value is split into 7-bit groups from least-significant to most-significant.
Each group becomes one byte; the high bit is set on all bytes except the last.

```
value = 300 = 0b10_0101100
  byte 0: (300 & 0x7F) | 0x80 = 0xAC  (continuation)
  byte 1: (300 >> 7)   & 0x7F = 0x02  (final)
```

#### Signed (Zigzag) LEB128  (`$arr.signed = true`)

Signed values are first zigzag-encoded to a non-negative integer, then
unsigned-LEB128-encoded:

```
zigzag(n) = n >= 0 ? 2*n : -2*n - 1
```

Examples: `0 → 0`, `1 → 2`, `-1 → 1`, `2 → 4`, `-2 → 3`.

Decode: `z % 2 === 0 ? z / 2 : -(z + 1) / 2`

#### Large-integer note

JavaScript's bitwise operators truncate to 32 bits.  The encoder uses
`Math.floor(v / 128)` instead of `v >>> 7`, and the decoder uses
`multiplier *= 128` instead of `<< shift`, so values up to 2^53 (the JavaScript
safe-integer limit) round-trip correctly.  In practice the largest values are
absolute µs timestamps (~4 × 10^9 for a profile started after ~70 minutes of
system uptime), which exceed 2^32.

### Float64 Encoding

Float arrays are stored as a `Float64Array` slab: each element is 8 bytes, IEEE 754
double-precision, little-endian, written via `DataView.setFloat64(..., true)` and
read via `DataView.getFloat64(..., true)`.

### Decode Pipeline

```
1. raw = read values from $values
       (LEB128-decode Uint8Array slab, or read Float64Array slab, or use inline array)
2. if delta: raw[i] += raw[i-1]   for i = 1 … len-1
3. if scale: raw[i] *= scale       for all i
4. if nulls: expand, inserting null at every zero-bit position
→ final array
```

---

## Size Characteristics (big-markers-profile.json, ~1.5 M markers)

| Component        | Size     |
|------------------|----------|
| JSON skeleton    | 29.61 MB |
| Binary slabs     | 33.59 MB |
| **Total**        | **63.20 MB** |
| After gzip       | 16.79 MB |

Compared to the JSON-only optimized baseline (all marker optimizations, no binary
encoding): 107.66 MB / 18.70 MB gzip.
