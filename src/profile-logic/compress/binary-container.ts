/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Generic binary container for typed-array slabs.
 *
 * Callers encode their data into TypedArrays and add them as named slabs. The
 * container stores raw typed bytes and knows nothing about encoding schemes
 * (LEB128, delta, etc.). Slab references are { "$bin": N } placeholders,
 * intended for embedding in the JSON skeleton.
 *
 * Container layout:
 *   [0..3]   Magic "PFCB"
 *   [4..7]   uint32LE version = 3
 *   [8..11]  uint32LE slab count
 *   [12..15] uint32LE root JSON slab index
 *   [16..]   Slab table: for each slab, 1 type byte + uint32LE byte length
 *   [..]     Padding to 8-byte alignment
 *   [..]     Slab data, each padded to its natural alignment
 */

// ── Constants ──────────────────────────────────────────────────────────────

const MAGIC = new Uint8Array([0x50, 0x46, 0x43, 0x42]); // "PFCB"
const VERSION = 3;

const FIXED_HEADER_SIZE = 16; // magic(4) + version(4) + slabCount(4) + rootIndex(4)
const SLAB_TABLE_ENTRY_SIZE = 5; // type(1) + byteLength(4)

export const TYPE_INT8 = 0x00; // Int8Array
export const TYPE_UINT8 = 0x01; // Uint8Array
export const TYPE_INT16 = 0x02; // Int16Array
export const TYPE_UINT16 = 0x03; // Uint16Array
export const TYPE_INT32 = 0x04; // Int32Array
export const TYPE_UINT32 = 0x05; // Uint32Array
export const TYPE_FLOAT32 = 0x06; // Float32Array
export const TYPE_FLOAT64 = 0x07; // Float64Array
export const TYPE_BIGINT64 = 0x08; // BigInt64Array
export const TYPE_BIGUINT64 = 0x09; // BigUint64Array

// ── Helpers ────────────────────────────────────────────────────────────────

function alignUp(pos: number, alignment: number): number {
  return (pos + alignment - 1) & ~(alignment - 1);
}

function typeByteForSlab(slab: Uint8Array | Int32Array | Float64Array): number {
  if (slab instanceof Float64Array) return TYPE_FLOAT64;
  if (slab instanceof Int32Array) return TYPE_INT32;
  return TYPE_UINT8;
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

export type SlabPlaceholder = { '$bin': number };

export type DecodedContainer = {
  jsonBytes: Uint8Array;
  /** All slabs in order; data slabs precede the JSON slab (rootJsonSlabIndex). */
  slabs: Array<Uint8Array | Int32Array | Float64Array>;
  rootJsonSlabIndex: number;
};

// ── Builder ────────────────────────────────────────────────────────────────

export class Builder {
  private readonly _slabs: Array<Uint8Array | Int32Array | Float64Array> = [];

  addSlabU8(slab: Uint8Array): SlabPlaceholder {
    return this._push(slab);
  }

  addSlabI32(slab: Int32Array): SlabPlaceholder {
    return this._push(slab);
  }

  addSlabF64(slab: Float64Array): SlabPlaceholder {
    return this._push(slab);
  }

  private _push(slab: Uint8Array | Int32Array | Float64Array): SlabPlaceholder {
    const bin = this._slabs.length;
    this._slabs.push(slab);
    return { '$bin': bin };
  }

  /**
   * Appends the JSON slab and returns the container as a list of chunks.
   * Slab data is returned as zero-copy views; only the header is newly
   * allocated. Callers can stream the chunks or concatenate as needed.
   * The Builder must not be used after this call.
   */
  finish(jsonBytes: Uint8Array): Uint8Array[] {
    const rootJsonSlabIndex = this._slabs.length;
    this._slabs.push(jsonBytes);

    const slabCount = this._slabs.length;
    const slabTableEnd = FIXED_HEADER_SIZE + slabCount * SLAB_TABLE_ENTRY_SIZE;
    const slabDataStart = alignUp(slabTableEnd, 8);

    // Header buffer: fixed header + slab table + alignment padding (zero-filled).
    const header = new Uint8Array(slabDataStart);
    const view = new DataView(header.buffer);

    header.set(MAGIC, 0);
    view.setUint32(4, VERSION, true);
    view.setUint32(8, slabCount, true);
    view.setUint32(12, rootJsonSlabIndex, true);

    let tablePos = FIXED_HEADER_SIZE;
    for (const slab of this._slabs) {
      header[tablePos] = typeByteForSlab(slab);
      view.setUint32(tablePos + 1, slab.byteLength, true);
      tablePos += SLAB_TABLE_ENTRY_SIZE;
    }

    // Emit header, then slabs with alignment padding between them.
    const chunks: Uint8Array[] = [header];
    const zeroPad = new Uint8Array(8); // max alignment is 8; reused for all gaps
    let pos = 0;

    for (const slab of this._slabs) {
      const aligned = alignUp(pos, alignmentForTypeByte(typeByteForSlab(slab)));
      if (aligned > pos) {
        chunks.push(zeroPad.subarray(0, aligned - pos));
      }
      chunks.push(new Uint8Array(slab.buffer, slab.byteOffset, slab.byteLength));
      pos = aligned + slab.byteLength;
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

  const slabTableEnd = FIXED_HEADER_SIZE + slabCount * SLAB_TABLE_ENTRY_SIZE;
  const slabDataStart = alignUp(slabTableEnd, 8);

  // Read slab table.
  const slabTypes: number[] = [];
  const slabByteLengths: number[] = [];
  let tablePos = FIXED_HEADER_SIZE;
  for (let i = 0; i < slabCount; i++) {
    slabTypes.push(buffer[tablePos]);
    slabByteLengths.push(view.getUint32(tablePos + 1, true));
    tablePos += SLAB_TABLE_ENTRY_SIZE;
  }

  // Reconstruct typed array views into the buffer (zero-copy).
  const slabs: Array<Uint8Array | Int32Array | Float64Array> = [];
  let pos = 0;
  for (let i = 0; i < slabCount; i++) {
    const typeByte = slabTypes[i];
    const byteLength = slabByteLengths[i];
    pos = alignUp(pos, alignmentForTypeByte(typeByte));
    const absOffset = buffer.byteOffset + slabDataStart + pos;
    slabs.push(slabView(buffer.buffer, absOffset, typeByte, byteLength));
    pos += byteLength;
  }

  return {
    jsonBytes: slabs[rootJsonSlabIndex] as Uint8Array,
    slabs,
    rootJsonSlabIndex,
  };
}

function slabView(
  ab: ArrayBufferLike,
  offset: number,
  typeByte: number,
  byteLength: number
): Uint8Array | Int32Array | Float64Array {
  switch (typeByte) {
    case TYPE_INT32:
      return new Int32Array(ab, offset, byteLength / 4);
    case TYPE_FLOAT64:
      return new Float64Array(ab, offset, byteLength / 8);
    default:
      return new Uint8Array(ab, offset, byteLength);
  }
}

// ── ByteWriter ─────────────────────────────────────────────────────────────

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private grow(needed: number): void {
    if (this.pos + needed <= this.buf.length) return;
    let cap = this.buf.length;
    do {
      cap *= 2;
    } while (this.pos + needed > cap);
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeUint8(v: number): void {
    this.grow(1);
    this.buf[this.pos++] = v;
  }

  writeUint32LE(v: number): void {
    this.grow(4);
    this.view.setUint32(this.pos, v >>> 0, /* littleEndian */ true);
    this.pos += 4;
  }

  writeBytes(src: Uint8Array): void {
    this.grow(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  // Safe for any 53-bit non-negative integer; uses division instead of >>> to
  // avoid 32-bit truncation for values above 2^32.
  writeULEB128(v: number): void {
    this.grow(8); // ceil(53/7) = 8 bytes max
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ── ByteReader ─────────────────────────────────────────────────────────────

export class ByteReader {
  private pos: number;
  private view: DataView;

  constructor(
    private readonly buf: Uint8Array,
    offset = 0
  ) {
    this.pos = offset;
    // DataView coordinates are relative to buf's own byteOffset within the
    // underlying ArrayBuffer, so reads at this.pos map correctly to buf[this.pos].
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readUint8(): number {
    return this.buf[this.pos++];
  }

  readUint32LE(): number {
    const v = this.view.getUint32(this.pos, /* littleEndian */ true);
    this.pos += 4;
    return v;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  // Safe for any 53-bit integer; uses multiplication to reconstruct high bits
  // without relying on bit-shift operators that truncate to 32 bits.
  readULEB128(): number {
    let result = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return result;
  }

  get offset(): number {
    return this.pos;
  }

  get length(): number {
    return this.buf.length;
  }
}
