/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JsonSlabs — generic "JSON with binary slabs" serialization.
 *
 * Any JavaScript object that contains TypedArrays can be serialized to a
 * compact binary blob and restored losslessly. TypedArrays anywhere in the
 * object tree are lifted out into raw binary slabs; their positions in the
 * JSON are replaced by { "$bin": N } placeholders.
 *
 * High-level API:
 *   JsonSlabs.slabify(obj)       — object → Uint8Array binary blob
 *   JsonSlabs.slabifyToBlob(obj) — object → Blob (no single-buffer allocation)
 *   JsonSlabs.parse(buffer)      — Uint8Array binary blob → object
 *   JsonSlabs.builder()          — low-level Builder for manual slab construction
 *
 * Container layout:
 *   [0..3]   Magic "PFCB"
 *   [4..7]   uint32LE version = 4
 *   [8..11]  uint32LE slab count
 *   [12..15] uint32LE root JSON slab index
 *   [16..]   Slab table: for each slab, type(u32LE) + byteLength(u32LE) + startOffset(u32LE)
 *   [..]     Padding to 8-byte alignment
 *   [..]     Slab data, each at the alignment stored in its slab table entry
 */

// ── Constants ──────────────────────────────────────────────────────────────

const MAGIC = new Uint8Array([0x50, 0x46, 0x43, 0x42]); // "PFCB"
const VERSION = 4;

const FIXED_HEADER_SIZE = 16; // magic(4) + version(4) + slabCount(4) + rootIndex(4)
const SLAB_TABLE_ENTRY_SIZE = 12; // type(4) + byteLength(4) + startOffset(4)

export const TYPE_INT8     = 0x00; // Int8Array
export const TYPE_UINT8    = 0x01; // Uint8Array
export const TYPE_INT16    = 0x02; // Int16Array
export const TYPE_UINT16   = 0x03; // Uint16Array
export const TYPE_INT32    = 0x04; // Int32Array
export const TYPE_UINT32   = 0x05; // Uint32Array
export const TYPE_FLOAT32  = 0x06; // Float32Array
export const TYPE_FLOAT64  = 0x07; // Float64Array
export const TYPE_BIGINT64  = 0x08; // BigInt64Array
export const TYPE_BIGUINT64 = 0x09; // BigUint64Array
export const TYPE_JSON     = 0x0a; // UTF-8 JSON bytes

// ── Helpers ────────────────────────────────────────────────────────────────

function alignUp(pos: number, alignment: number): number {
  return (pos + alignment - 1) & ~(alignment - 1);
}

function alignmentForTypeByte(typeByte: number): number {
  switch (typeByte) {
    case TYPE_INT16:
    case TYPE_UINT16:
      return 2;
    case TYPE_INT32:
    case TYPE_UINT32:
    case TYPE_FLOAT32:
      return 4;
    case TYPE_FLOAT64:
    case TYPE_BIGINT64:
    case TYPE_BIGUINT64:
      return 8;
    default:
      return 1;
  }
}

// ── Public types ───────────────────────────────────────────────────────────

export type AnySlab =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

export type SlabPlaceholder = { '$bin': number };

export type DecodedContainer = {
  jsonBytes: Uint8Array;
  /** All slabs in order; TYPE_JSON slabs are returned as Uint8Array (raw UTF-8 bytes). */
  slabs: AnySlab[];
  /** Parallel to slabs: the TYPE_* constant for each slab. */
  slabTypes: number[];
  rootJsonSlabIndex: number;
};

// ── Builder ────────────────────────────────────────────────────────────────

export class Builder {
  private readonly _entries: Array<{ typeByte: number; view: ArrayBufferView }> = [];

  addSlabI8(slab: Int8Array): SlabPlaceholder      { return this._push(TYPE_INT8, slab); }
  addSlabU8(slab: Uint8Array): SlabPlaceholder     { return this._push(TYPE_UINT8, slab); }
  addSlabI16(slab: Int16Array): SlabPlaceholder    { return this._push(TYPE_INT16, slab); }
  addSlabU16(slab: Uint16Array): SlabPlaceholder   { return this._push(TYPE_UINT16, slab); }
  addSlabI32(slab: Int32Array): SlabPlaceholder    { return this._push(TYPE_INT32, slab); }
  addSlabU32(slab: Uint32Array): SlabPlaceholder   { return this._push(TYPE_UINT32, slab); }
  addSlabF32(slab: Float32Array): SlabPlaceholder  { return this._push(TYPE_FLOAT32, slab); }
  addSlabF64(slab: Float64Array): SlabPlaceholder  { return this._push(TYPE_FLOAT64, slab); }
  addSlabBigI64(slab: BigInt64Array): SlabPlaceholder  { return this._push(TYPE_BIGINT64, slab); }
  addSlabBigU64(slab: BigUint64Array): SlabPlaceholder { return this._push(TYPE_BIGUINT64, slab); }
  /** Register a nested JSON document (UTF-8 bytes) as a slab. */
  addSlabJson(jsonBytes: Uint8Array): SlabPlaceholder  { return this._push(TYPE_JSON, jsonBytes); }

  private _push(typeByte: number, view: ArrayBufferView): SlabPlaceholder {
    const bin = this._entries.length;
    this._entries.push({ typeByte, view });
    return { '$bin': bin };
  }

  /**
   * Appends the JSON slab and returns the container as a list of chunks.
   * Slab data is returned as zero-copy views; only the header is newly
   * allocated. Callers can stream the chunks or concatenate as needed.
   * The Builder must not be used after this call.
   */
  finish(jsonBytes: Uint8Array): Uint8Array[] {
    const rootJsonSlabIndex = this._entries.length;
    this._entries.push({ typeByte: TYPE_JSON, view: jsonBytes });

    const slabCount = this._entries.length;
    const slabTableEnd = FIXED_HEADER_SIZE + slabCount * SLAB_TABLE_ENTRY_SIZE;
    const slabDataStart = alignUp(slabTableEnd, 8);

    // First pass: compute absolute start offset for each slab.
    const startOffsets: number[] = [];
    let pos = 0;
    for (const { typeByte, view } of this._entries) {
      pos = alignUp(pos, alignmentForTypeByte(typeByte));
      startOffsets.push(slabDataStart + pos);
      pos += view.byteLength;
    }

    // Header buffer: fixed header + slab table + alignment padding (zero-filled).
    const header = new Uint8Array(slabDataStart);
    const dv = new DataView(header.buffer);

    header.set(MAGIC, 0);
    dv.setUint32(4, VERSION, true);
    dv.setUint32(8, slabCount, true);
    dv.setUint32(12, rootJsonSlabIndex, true);

    let tablePos = FIXED_HEADER_SIZE;
    for (let i = 0; i < slabCount; i++) {
      const { typeByte, view } = this._entries[i];
      dv.setUint32(tablePos,      typeByte,         true);
      dv.setUint32(tablePos + 4,  view.byteLength,  true);
      dv.setUint32(tablePos + 8,  startOffsets[i],  true);
      tablePos += SLAB_TABLE_ENTRY_SIZE;
    }

    // Emit header, then slabs with alignment padding between them.
    const chunks: Uint8Array[] = [header];
    const zeroPad = new Uint8Array(8); // max alignment is 8; reused for all gaps
    let dataPos = 0;

    for (let i = 0; i < slabCount; i++) {
      const { typeByte, view } = this._entries[i];
      const aligned = alignUp(dataPos, alignmentForTypeByte(typeByte));
      if (aligned > dataPos) chunks.push(zeroPad.subarray(0, aligned - dataPos));
      chunks.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      dataPos = aligned + view.byteLength;
    }

    return chunks;
  }
}

// ── decode ─────────────────────────────────────────────────────────────────

export function decode(buffer: Uint8Array): DecodedContainer {
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x46 ||
    buffer[2] !== 0x43 ||
    buffer[3] !== 0x42
  ) {
    throw new Error('Not a PFCB container: bad magic bytes');
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported PFCB version ${version}`);
  }

  const slabCount = view.getUint32(8, true);
  const rootJsonSlabIndex = view.getUint32(12, true);

  // Read slab table.
  const slabTypes: number[] = [];
  const slabByteLengths: number[] = [];
  const slabStartOffsets: number[] = [];
  let tablePos = FIXED_HEADER_SIZE;
  for (let i = 0; i < slabCount; i++) {
    slabTypes.push(view.getUint32(tablePos,     true));
    slabByteLengths.push(view.getUint32(tablePos + 4, true));
    slabStartOffsets.push(view.getUint32(tablePos + 8, true));
    tablePos += SLAB_TABLE_ENTRY_SIZE;
  }

  // Reconstruct typed array views into the buffer (zero-copy).
  // startOffset is relative to the container start; add buffer.byteOffset for the
  // absolute position within the underlying ArrayBuffer.
  const slabs: AnySlab[] = [];
  for (let i = 0; i < slabCount; i++) {
    const absOffset = buffer.byteOffset + slabStartOffsets[i];
    slabs.push(slabView(buffer.buffer, absOffset, slabTypes[i], slabByteLengths[i]));
  }

  return {
    jsonBytes: slabs[rootJsonSlabIndex] as Uint8Array,
    slabs,
    slabTypes,
    rootJsonSlabIndex,
  };
}

function slabView(
  ab: ArrayBufferLike,
  offset: number,
  typeByte: number,
  byteLength: number
): AnySlab {
  switch (typeByte) {
    case TYPE_INT8:      return new Int8Array(ab, offset, byteLength);
    case TYPE_INT16:     return new Int16Array(ab, offset, byteLength / 2);
    case TYPE_UINT16:    return new Uint16Array(ab, offset, byteLength / 2);
    case TYPE_INT32:     return new Int32Array(ab, offset, byteLength / 4);
    case TYPE_UINT32:    return new Uint32Array(ab, offset, byteLength / 4);
    case TYPE_FLOAT32:   return new Float32Array(ab, offset, byteLength / 4);
    case TYPE_FLOAT64:   return new Float64Array(ab, offset, byteLength / 8);
    case TYPE_BIGINT64:  return new BigInt64Array(ab, offset, byteLength / 8);
    case TYPE_BIGUINT64: return new BigUint64Array(ab, offset, byteLength / 8);
    default:             return new Uint8Array(ab, offset, byteLength); // TYPE_UINT8, TYPE_JSON
  }
}

// ── JsonSlabs high-level API ───────────────────────────────────────────────

function _buildChunks(obj: unknown): Uint8Array[] {
  const builder = new Builder();
  const jsonStr = JSON.stringify(obj, (_key, value) => {
    if (value instanceof Int8Array)      return builder.addSlabI8(value);
    if (value instanceof Uint8Array)     return builder.addSlabU8(value);
    if (value instanceof Int16Array)     return builder.addSlabI16(value);
    if (value instanceof Uint16Array)    return builder.addSlabU16(value);
    if (value instanceof Int32Array)     return builder.addSlabI32(value);
    if (value instanceof Uint32Array)    return builder.addSlabU32(value);
    if (value instanceof Float32Array)   return builder.addSlabF32(value);
    if (value instanceof Float64Array)   return builder.addSlabF64(value);
    if (value instanceof BigInt64Array)  return builder.addSlabBigI64(value);
    if (value instanceof BigUint64Array) return builder.addSlabBigU64(value);
    return value;
  });
  const jsonBytes = new TextEncoder().encode(jsonStr);
  return builder.finish(jsonBytes);
}

export const JsonSlabs = {
  /**
   * Serialize any object to a binary blob.
   * TypedArrays anywhere in the tree are extracted as binary slabs and
   * replaced by { "$bin": N } placeholders in the JSON skeleton.
   */
  slabify(obj: unknown): Uint8Array<ArrayBuffer> {
    const chunks = _buildChunks(obj);
    const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(totalSize);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out as Uint8Array<ArrayBuffer>;
  },

  /**
   * Serialize any object to a Blob, avoiding allocation of a single
   * concatenated buffer. Suitable for piping through a CompressionStream
   * or passing to fetch() / Response without extra copies.
   */
  slabifyToBlob(obj: unknown): Blob {
    return new Blob(_buildChunks(obj) as BlobPart[]);
  },

  /**
   * Deserialize a binary blob back to an object.
   * { "$bin": N } placeholders are replaced with TypedArray views, or for
   * TYPE_JSON slabs, with recursively parsed JSON objects (sharing the same
   * slab index space).
   */
  parse(buffer: Uint8Array): unknown {
    const { jsonBytes, slabs, slabTypes } = decode(buffer);
    const decoder = new TextDecoder();
    const reviver = (_key: string, value: unknown): unknown => {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        '$bin' in (value as Record<string, unknown>)
      ) {
        const idx = (value as SlabPlaceholder).$bin;
        if (slabTypes[idx] === TYPE_JSON) {
          return JSON.parse(decoder.decode(slabs[idx] as Uint8Array), reviver);
        }
        return slabs[idx];
      }
      return value;
    };
    return JSON.parse(decoder.decode(jsonBytes), reviver);
  },

  /** Low-level Builder for manual slab construction. */
  builder(): Builder {
    return new Builder();
  },
};
