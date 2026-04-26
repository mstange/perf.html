# JsonSlabs

Generic "JSON with binary slabs" serialization for JavaScript objects that contain TypedArrays.

## What it does

Any object tree is serialized to a single binary blob. TypedArrays anywhere in the tree are
lifted out into raw typed binary slabs and replaced with `{ "$s": N }` placeholders in the
JSON skeleton. On parse, placeholders are substituted back with zero-copy views into the
original buffer.

The result is a `Uint8Array` (or `Blob`) with a fixed header, a slab table, and aligned slab
data. See [FORMAT.md](FORMAT.md) for the full binary layout.

## High-level API

```ts
import { JsonSlabs } from 'firefox-profiler/profile-logic/compress/json-slabs';

// Serialize: object (may contain TypedArrays anywhere) → binary blob
const blob = JsonSlabs.slabify(myObject);           // → Uint8Array
const blob = JsonSlabs.slabifyToBlob(myObject);     // → Blob (no single-buffer alloc)

// Deserialize: binary blob → original object, TypedArrays restored as zero-copy views
const obj = JsonSlabs.parse(blob) as MyType;
```

`slabifyToBlob` is useful when piping to a `CompressionStream` or passing to `fetch()` /
`new Response()`: it avoids allocating one large contiguous buffer by wrapping the internal
chunk list directly in a `Blob`.

### Splitting nested values into their own JSON slabs

Both `slabify` and `slabifyToBlob` accept an optional second argument: a list of nested
values that should each be lifted out of the root JSON into their own TYPE_JSON sub-slab.
Matching is by reference identity.

```ts
const data = { libs: [], shared: { stringArray: ['hello', 'world'] } };
const blob = JsonSlabs.slabify(data, [data.shared.stringArray]);

// Two JSON slabs in the container:
//   slab 0 (TYPE_JSON): ["hello","world"]
//   slab 1 (TYPE_JSON, root): {"libs":[],"shared":{"stringArray":{"$s":0}}}
//
// JsonSlabs.parse(blob) reconstructs the original object — sub-slab JSON is
// recursively parsed and inlined where the placeholder appeared.
```

This is useful for keeping large or independently-cacheable sub-documents in their own
slabs without dropping to the low-level Builder API.

## Low-level API (Builder)

Use `Builder` when you need finer control — for example, when your encode step adds codec
metadata alongside each slab, or when you want zero-copy streaming chunks instead of one
concatenated buffer:

```ts
const builder = JsonSlabs.builder();

// Register TypedArrays; get back { "$s": N } placeholder objects
const p1 = builder.addSlabI32(myInt32Array);
const p2 = builder.addSlabF64(myFloat64Array);

// Build a JSON skeleton using the placeholders
const skeleton = { values: p1, weights: p2, label: 'example' };
const jsonBytes = new TextEncoder().encode(JSON.stringify(skeleton));

// Finish: appends JSON as the root slab, returns zero-copy Uint8Array chunks
const chunks = builder.finish(jsonBytes);
```

Builder methods for all supported types:

| Method | TypedArray |
|--------|-----------|
| `addSlabI8(slab)` | Int8Array |
| `addSlabU8(slab)` | Uint8Array |
| `addSlabI16(slab)` | Int16Array |
| `addSlabU16(slab)` | Uint16Array |
| `addSlabI32(slab)` | Int32Array |
| `addSlabU32(slab)` | Uint32Array |
| `addSlabF32(slab)` | Float32Array |
| `addSlabF64(slab)` | Float64Array |
| `addSlabBigI64(slab)` | BigInt64Array |
| `addSlabBigU64(slab)` | BigUint64Array |
| `addSlabJson(jsonBytes)` | UTF-8 JSON (TYPE_JSON) |

`addSlabJson` registers a nested JSON document (UTF-8 bytes) as a TYPE_JSON slab. On parse,
`{ "$s": N }` placeholders pointing to TYPE_JSON slabs are recursively JSON-parsed (sharing
the same slab index space), enabling lazy or sub-document nesting.

## Exported symbols

| Symbol | Description |
|--------|-------------|
| `JsonSlabs` | High-level namespace: `slabify`, `slabifyToBlob`, `parse`, `builder` |
| `Builder` | Low-level builder for manual slab construction |
| `decode` | Low-level: parse a blob into `{ jsonBytes, slabs, slabTypes, rootJsonSlabIndex }` |
| `AnySlab` | Union of all supported TypedArray types |
| `SlabPlaceholder` | Type for `{ "$s": N }` placeholder objects |
| `DecodedContainer` | Return type of `decode` |
| `TYPE_*` constants | Type values for each slab kind (TYPE_INT8 … TYPE_JSON) |

## Format

The binary container format is documented in [FORMAT.md](FORMAT.md).

The `$arr` array codec used by the profiler's column-encoding layer (one level above
JsonSlabs) is documented in [../CODEC.md](../CODEC.md).
