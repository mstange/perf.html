# PFCB — Binary Profile Container Format

Version 2.

## Overview

A compressed profile object consists mostly of large numeric arrays embedded
inside a JSON object.  The PFCB format separates two independent concerns:

**Binary container** — strips numeric arrays out of the JSON and stores them as
compact typed-byte sections, leaving all other content as plain UTF-8 JSON.  The
container has no knowledge of how bytes become numbers; it only knows the
primitive storage type of each section (`U8` byte blob or `F64` float array).

**Array codec** — knows how to encode a semantic array (floats, signed integers,
nullable sequences) into raw bytes and how to decode it back.  Encoding choices
(LEB128 compression, zigzag for signed integers, delta encoding, float scaling,
null bitfields) are recorded in `$arr` descriptor objects embedded in the JSON,
so the same descriptor works whether the backing values are a binary section or
an inline JSON number array.

---

## Binary Container

### Overall Layout

```
Offset  Size   Description
------  ----   -----------
0       4      Magic bytes: 0x50 0x46 0x43 0x42  ("PFCB")
4       4      Version: uint32LE = 2
8       4      JSON section byte length: uint32LE
12      N      JSON section (UTF-8, N = value from offset 8)
12+N    4      Section count: uint32LE
```

Immediately following, repeated `section count` times:

```
Offset  Size   Description
------  ----   -----------
0       4      Section byte length: uint32LE  (covers everything below)
4       1      Type byte  (see below)
5       4      Element count: uint32LE
9       V      Raw bytes
```

### JSON Section

The JSON section is the `CompressedProfile` object serialized with
`JSON.stringify`, with every numeric array replaced by an `$arr` wrapper:

```json
{ "$arr": { … }, "$values": <inner> }
```

`<inner>` is either `{ "$bin": N }` (binary section N) or a plain JSON number
array (inline).  All other content — strings, nested objects, mixed-type arrays
— remains verbatim.  The `$arr` descriptor is described in the Array Codec
section below.

### Type Byte

The container only records the primitive storage type of each section's bytes.
All interpretation of those bytes is the array codec's responsibility.

| Value     | Name | Description                                  |
|-----------|------|----------------------------------------------|
| 0x00      | U8   | Raw byte blob                                |
| 0x01–0x06 | —    | Reserved for future fixed-width types        |
| 0x07      | F64  | IEEE 754 double-precision, little-endian     |

For `U8`, `element count` is the number of values the codec encoded into the
blob (needed by the codec to know when to stop decoding).  For `F64`, element
count equals the byte length divided by 8.  The section byte length field allows
decoders to skip sections with unrecognised type bytes.

### Container Encode / Decode (outline)

**Encode:**
1. Walk the object tree; for every numeric array, ask the array codec to encode
   it: receive a type byte, an element count, and raw bytes.
2. Replace the array with `{ "$arr": descriptor, "$values": { "$bin": N } }`.
3. JSON-stringify the skeleton.
4. Emit: magic + version + JSON length + JSON + section count + sections.

**Decode:**
1. Verify magic and version.
2. Read and parse the JSON skeleton.
3. Read raw section bytes (do not decode yet — the codec needs the `$arr`
   descriptor, which lives in the JSON, before it can decode).
4. Walk the skeleton; for every `$arr` wrapper, hand the raw bytes and
   descriptor to the array codec and replace the wrapper with the result.

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

Integer arrays are LEB128-encoded to a byte blob, stored as a `U8` section.

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

Float arrays are stored as a `F64` section: each element is 8 bytes, IEEE 754
double-precision, little-endian, written via `DataView.setFloat64(..., true)` and
read via `DataView.getFloat64(..., true)`.

### Decode Pipeline

```
1. raw = read values from $values
       (LEB128-decode U8 section, or read F64 section, or use inline array)
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
| Binary sections  | 33.59 MB |
| **Total**        | **63.20 MB** |
| After gzip       | 16.79 MB |

Compared to the plain-JSON compressed baseline of 107.66 MB / 18.70 MB gzip.
