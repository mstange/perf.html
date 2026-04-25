# PFCB — Binary Container Format

Version 3.

## Overview

The PFCB container strips typed numeric arrays out of a JSON skeleton and stores
them as compact raw-byte slabs.  It has no knowledge of how bytes become numbers;
that is the array codec's concern (see `../CODEC.md`).

---

## Layout

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
(1, 2, 4, or 8 bytes depending on type).

The JSON skeleton is stored as a slab at index `rootJsonSlabIndex` (always the
last slab).  All other slabs are data slabs.

---

## Type Byte

| Value | TypedArray      | Element size | Alignment |
|-------|-----------------|--------------|-----------|
| 0x00  | Int8Array       | 1 byte       | 1         |
| 0x01  | Uint8Array      | 1 byte       | 1         |
| 0x02  | Int16Array      | 2 bytes LE   | 2         |
| 0x03  | Uint16Array     | 2 bytes LE   | 2         |
| 0x04  | Int32Array      | 4 bytes LE   | 4         |
| 0x05  | Uint32Array     | 4 bytes LE   | 4         |
| 0x06  | Float32Array    | 4 bytes LE   | 4         |
| 0x07  | Float64Array    | 8 bytes LE   | 8         |
| 0x08  | BigInt64Array   | 8 bytes LE   | 8         |
| 0x09  | BigUint64Array  | 8 bytes LE   | 8         |

---

## JSON Skeleton

The skeleton is `JSON.stringify` output where numeric arrays have been replaced
by `{ "$arr": <descriptor>, "$values": { "$bin": N } }` objects.  `N` is the
index of the corresponding data slab.  See `../CODEC.md` for the `$arr` descriptor
format.  All other content — strings, nested objects, mixed-type arrays —
remains verbatim.

---

## Encode / Decode (outline)

**Encode:**
1. Walk the object tree; for every TypedArray, add it to the `Builder` via
   `addSlabU8 / addSlabI32 / addSlabF64` to get a `{ "$bin": N }` placeholder.
2. Replace the TypedArray in the object with `{ "$bin": N }`.
   (The column-encoding layer uses `{ "$arr": descriptor, "$values": { "$bin": N } }`
   for additional codec metadata, but that is above this layer.)
3. `JSON.stringify` the skeleton into a `Uint8Array`; pass it to
   `builder.finish()`.
4. `finish()` appends the JSON as the final slab, then emits:
   - fixed header (magic + version + slab count + root JSON slab index),
   - slab table (type byte + byte length per slab),
   - zero padding to 8-byte boundary,
   - slab data (each slab preceded by natural-alignment padding).
   Returns an array of zero-copy `Uint8Array` chunks.

**Decode:**
1. Verify magic and version.
2. Read slab count and root JSON slab index from fixed header.
3. Read slab table: type byte + byte length per slab.
4. Reconstruct typed-array views into the buffer (zero-copy).
5. Decode the JSON slab with `TextDecoder`.
6. Walk the skeleton; substitute every `{ "$bin": N }` with `slabs[N]`.
7. Walk the skeleton; for every `{ "$arr": descriptor, "$values": TypedArray }`,
   decode the TypedArray using the descriptor (see `../CODEC.md`).
