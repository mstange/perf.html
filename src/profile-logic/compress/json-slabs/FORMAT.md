# PFCB — Binary Container Format

Version 4.

## Overview

The PFCB container strips typed numeric arrays out of a JSON skeleton and stores
them as compact raw-byte slabs.  It has no knowledge of how bytes become numbers;
that is the array codec's concern (see `../CODEC.md`).

---

## Layout

```
Offset    Size          Description
------    ----          -----------
0         4             Magic bytes: 0x50 0x46 0x43 0x42  ("PFCB")
4         4             Version: uint32LE = 4
8         4             Slab count: uint32LE
12        4             Root JSON slab index: uint32LE
16        12 × count    Slab table (see below)
16+12N    P             Zero padding to next 8-byte boundary
16+12N+P  …             Slab data (each slab at its natural alignment)
```

**Slab table** — one 12-byte entry per slab, in order.  All fields are uint32LE:

```
Offset  Size   Description
------  ----   -----------
0       4      Type (see below)
4       4      Slab byte length
8       4      Start offset of slab data from the container's byte 0
```

Storing the start offset allows O(1) random access to any slab without iterating
the table.  The decoder computes `buffer.byteOffset + startOffset` to get the
absolute position within the underlying `ArrayBuffer`.

**Slab data** — slabs are emitted in table order.  Before each slab, zero
padding is inserted so the slab starts at a multiple of its natural alignment
(1, 2, 4, or 8 bytes depending on type).  The start offset in the slab table
already accounts for this padding.

The JSON skeleton is stored as a TYPE_JSON slab at index `rootJsonSlabIndex`
(always the last slab).  All other slabs are data slabs.

---

## Type

| Value | TypedArray / Content | Element size | Alignment |
|-------|----------------------|--------------|-----------|
| 0x00  | Int8Array            | 1 byte       | 1         |
| 0x01  | Uint8Array           | 1 byte       | 1         |
| 0x02  | Int16Array           | 2 bytes LE   | 2         |
| 0x03  | Uint16Array          | 2 bytes LE   | 2         |
| 0x04  | Int32Array           | 4 bytes LE   | 4         |
| 0x05  | Uint32Array          | 4 bytes LE   | 4         |
| 0x06  | Float32Array         | 4 bytes LE   | 4         |
| 0x07  | Float64Array         | 8 bytes LE   | 8         |
| 0x08  | BigInt64Array        | 8 bytes LE   | 8         |
| 0x09  | BigUint64Array       | 8 bytes LE   | 8         |
| 0x0a  | UTF-8 JSON bytes     | —            | 1         |

TYPE_JSON slabs contain UTF-8–encoded JSON text.  They may themselves include
`{ "$bin": N }` placeholders referencing other slabs in the same container,
enabling nested sub-documents without a separate container.

---

## JSON Skeleton

The skeleton is `JSON.stringify` output where TypedArrays have been replaced by
`{ "$bin": N }` objects.  `N` is the index of the corresponding data slab.
All other content — strings, nested objects, mixed-type arrays — remains verbatim.

The column-encoding layer above JsonSlabs wraps arrays as
`{ "$arr": <descriptor>, "$values": { "$bin": N } }` (see `../CODEC.md`), but
that is above this layer.

---

## Encode / Decode (outline)

**Encode:**
1. Walk the object tree; for every TypedArray call the appropriate `Builder`
   method (`addSlabI32`, `addSlabF64`, etc.) to get a `{ "$bin": N }` placeholder.
2. `JSON.stringify` the skeleton into a `Uint8Array`; pass it to `builder.finish()`.
3. `finish()` appends the JSON as the final TYPE_JSON slab, then emits:
   - fixed header (magic + version + slab count + root JSON slab index),
   - slab table (type + byte length + start offset per slab),
   - zero padding to 8-byte boundary,
   - slab data (each slab preceded by natural-alignment padding).
   Returns an array of zero-copy `Uint8Array` chunks.

**Decode:**
1. Verify magic and version.
2. Read slab count and root JSON slab index from fixed header.
3. Read slab table: type + byte length + start offset per slab.
4. Reconstruct typed-array views into the buffer (zero-copy) using stored offsets.
5. Decode the root JSON slab with `TextDecoder`.
6. Walk the skeleton; substitute every `{ "$bin": N }` with `slabs[N]`.
   If `slabTypes[N] === TYPE_JSON`, recursively JSON-parse the slab's bytes
   (applying the same substitution) rather than returning it raw.
7. Walk the skeleton; for every `{ "$arr": descriptor, "$values": TypedArray }`,
   decode the TypedArray using the descriptor (see `../CODEC.md`).
