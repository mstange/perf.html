# JsonSlabs

Generic "JSON with binary slabs" serialization for JavaScript objects that contain TypedArrays.

## What it does

Any object tree is serialized to a single binary blob. TypedArrays anywhere in the tree are
lifted out into raw typed binary slabs and replaced with `{ "$bin": N }` placeholders in the
JSON skeleton. On parse, placeholders are substituted back with zero-copy views into the
original buffer.

The result is a `Uint8Array` with a fixed header, a slab table, and aligned slab data.
See [FORMAT.md](FORMAT.md) for the full binary layout.

## High-level API

```ts
import { JsonSlabs } from 'firefox-profiler/profile-logic/compress/json-slabs';

// Serialize: object (may contain TypedArrays anywhere) → binary blob
const blob = JsonSlabs.slabify(myObject);

// Deserialize: binary blob → original object, TypedArrays restored as zero-copy views
const obj = JsonSlabs.parse(blob) as MyType;
```

## Low-level API (Builder)

Use `Builder` when you need finer control — for example, when your encode step adds codec
metadata alongside each slab, or when you want zero-copy streaming chunks instead of one
concatenated buffer:

```ts
const builder = JsonSlabs.builder();

// Register TypedArrays; get back { "$bin": N } placeholder objects
const p1 = builder.addSlabI32(myInt32Array);
const p2 = builder.addSlabF64(myFloat64Array);

// Build a JSON skeleton using the placeholders
const skeleton = { values: p1, weights: p2, label: 'example' };
const jsonBytes = new TextEncoder().encode(JSON.stringify(skeleton));

// Finish: appends JSON as the root slab, returns zero-copy Uint8Array chunks
const chunks = builder.finish(jsonBytes);
```

## Exported symbols

| Symbol | Description |
|--------|-------------|
| `JsonSlabs` | High-level namespace: `slabify`, `parse`, `builder` |
| `Builder` | Low-level builder for manual slab construction |
| `decode` | Low-level: parse a blob into `{ jsonBytes, slabs, rootJsonSlabIndex }` |
| `SlabPlaceholder` | Type for `{ "$bin": N }` placeholder objects |
| `DecodedContainer` | Return type of `decode` |
| `TYPE_*` constants | Type-byte values for each TypedArray kind |

## Format

The binary container format is documented in [FORMAT.md](FORMAT.md).

The `$arr` array codec used by the profiler's column-encoding layer (one level above
JsonSlabs) is documented in [../CODEC.md](../CODEC.md).
