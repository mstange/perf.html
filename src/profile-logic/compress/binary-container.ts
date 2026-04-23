/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Generic binary container for JSON objects that contain large numeric arrays.
 *
 * Every numeric array in the object is replaced by an $arr wrapper:
 *
 *   { "$arr": { …descriptor… }, "$values": <source> }
 *
 * where <source> is either { "$bin": N } (binary section) or a plain JSON
 * number array (inline). The $arr descriptor carries all semantic information
 * needed to reconstruct the original array (null positions, delta decoding,
 * float scaling). Binary sections carry only raw typed bytes — they know
 * nothing about those transforms.
 *
 * Container layout:
 *   [0..3]   Magic bytes "PFCB"
 *   [4..7]   uint32LE version = 2
 *   [8..11]  uint32LE JSON section byte length
 *   [12..]   JSON bytes — original object with numeric arrays replaced by
 *              { "$arr": descriptor, "$values": { "$bin": N } } wrappers
 *   [..]     uint32LE section count
 *   For each binary section:
 *     uint32LE  byte length of the section data that follows
 *     uint8     type byte: storage format (TYPE_U8 = LEB128 stream, TYPE_F64 = float64 array)
 *     uint32LE  element count (number of decoded values)
 *     values    LEB128 stream or float64 array
 *
 * $arr descriptor fields (all optional):
 *   delta   boolean  — cumulative-sum (undelta) the value sequence
 *   scale   number   — multiply every value by this constant
 *   signed  boolean  — for TYPE_U8 sections: use zigzag (signed) LEB128 decoding
 *   nulls   number[] — presence bitfield bytes; bit i = 1 → element i is not null
 *   count   number   — total element count including null positions (required with nulls)
 */

// ── Constants ──────────────────────────────────────────────────────────────

const MAGIC = new Uint8Array([0x50, 0x46, 0x43, 0x42]); // "PFCB"
const VERSION = 2;

// Flat type enum — the only thing binary sections know about.
// Whether a u8 blob uses zigzag (signed) LEB128 is stated in $arr.signed,
// not here. 0x01–0x06 reserved for future fixed-width integer and f32 types.
const TYPE_U8 = 0x00; // Raw byte blob (LEB128 stream)
const TYPE_F64 = 0x07; // IEEE 754 double-precision, little-endian

// ── ByteWriter ─────────────────────────────────────────────────────────────

class ByteWriter {
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
    this.grow(8); // ceil(53/7) = 8 bytes suffices for any safe integer
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

class ByteReader {
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
}

// ── Section encode / decode ────────────────────────────────────────────────

// Encodes a non-null numeric array into a binary section. Callers are
// responsible for stripping nulls (storing the bitfield in $arr.nulls) and
// for passing signed=true when the values may be negative (so the caller can
// also set $arr.signed=true, telling the decoder to zigzag-decode).
function encodeSection(values: number[], signed: boolean): Uint8Array {
  let isFloat64 = false;
  for (const v of values) {
    if (!Number.isInteger(v)) {
      isFloat64 = true;
      break;
    }
  }

  const typeByte = isFloat64 ? TYPE_F64 : TYPE_U8;
  const w = new ByteWriter();
  w.writeUint8(typeByte);
  w.writeUint32LE(values.length);

  if (isFloat64) {
    const tmp = new Uint8Array(8);
    const tmpView = new DataView(tmp.buffer);
    for (const v of values) {
      tmpView.setFloat64(0, v, /* littleEndian */ true);
      w.writeBytes(tmp);
    }
  } else if (signed) {
    for (const v of values) {
      // zigzag encode: non-negative n → 2n, negative n → -2n - 1
      w.writeULEB128(v >= 0 ? 2 * v : -2 * v - 1);
    }
  } else {
    for (const v of values) {
      w.writeULEB128(v);
    }
  }

  return w.finish();
}

// Decodes a binary section to a plain number[]. Null expansion is handled
// separately by the $arr descriptor. `signed` comes from $arr.signed and
// controls zigzag decoding for TYPE_U8 (LEB128) sections.
function decodeSection(data: Uint8Array, signed: boolean): number[] {
  const r = new ByteReader(data);
  const typeByte = r.readUint8();
  const count = r.readUint32LE();
  const values: number[] = new Array(count);

  if (typeByte === TYPE_F64) {
    const floatBytes = r.readBytes(count * 8);
    const dv = new DataView(
      floatBytes.buffer,
      floatBytes.byteOffset,
      count * 8
    );
    for (let i = 0; i < count; i++) {
      values[i] = dv.getFloat64(i * 8, /* littleEndian */ true);
    }
  } else if (signed) {
    // TYPE_U8, zigzag LEB128
    for (let i = 0; i < count; i++) {
      const z = r.readULEB128();
      // zigzag decode: use division to stay in float range
      values[i] = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    }
  } else {
    // TYPE_U8, unsigned LEB128 (also the fallback for any unrecognised type)
    for (let i = 0; i < count; i++) {
      values[i] = r.readULEB128();
    }
  }

  return values;
}

// ── Array classification ───────────────────────────────────────────────────

// Returns true when every element is a number (or null), with at least one
// actual number, so the array can be encoded as a binary section.
function isNumericArray(arr: unknown[]): arr is (number | null)[] {
  if (arr.length === 0) return false;
  let hasNumber = false;
  for (const v of arr) {
    if (v === null) continue;
    if (typeof v !== 'number') return false;
    hasNumber = true;
  }
  return hasNumber;
}

// ── $arr wrapper types ─────────────────────────────────────────────────────

type ArrDescriptor = {
  delta?: boolean;
  scale?: number;
  // For TYPE_U8 (LEB128) binary sections: true means zigzag (signed) decoding.
  // Omitted when false (unsigned) or when $values is a float section / inline array.
  signed?: boolean;
  // Presence bitfield bytes (bit i = 1 → element i is not null). When set,
  // $values contains only the non-null elements and `count` gives the total
  // element count (including null positions).
  nulls?: number[];
  count?: number;
};

type ArrWrapper = {
  $arr: ArrDescriptor;
  $values: { $bin: number } | number[];
};

// ── Object tree walk ───────────────────────────────────────────────────────

function replaceArrays(node: unknown, sections: Uint8Array[]): unknown {
  if (Array.isArray(node)) {
    if (isNumericArray(node)) {
      const arr = node as (number | null)[];
      const count = arr.length;

      const descriptor: ArrDescriptor = {};
      let nonNullValues: number[];

      // Check for nulls in a single pass; also detect negatives and floats so
      // we can set $arr.signed without a second scan in encodeSection.
      let hasNulls = false;
      let hasNegatives = false;
      let isFloat64 = false;
      for (const v of arr) {
        if (v === null) { hasNulls = true; continue; }
        if (v < 0) hasNegatives = true;
        if (!Number.isInteger(v)) isFloat64 = true;
      }

      if (hasNulls) {
        const bitfieldLen = Math.ceil(count / 8);
        const bitfield = new Uint8Array(bitfieldLen);
        nonNullValues = [];
        for (let i = 0; i < count; i++) {
          if (arr[i] !== null) {
            bitfield[i >> 3] |= 1 << (i & 7);
            nonNullValues.push(arr[i] as number);
          }
        }
        descriptor.nulls = Array.from(bitfield);
        descriptor.count = count;
      } else {
        nonNullValues = arr as number[];
      }

      const signed = hasNegatives && !isFloat64;
      if (signed) descriptor.signed = true;

      const idx = sections.length;
      sections.push(encodeSection(nonNullValues, signed));

      const wrapper: ArrWrapper = {
        $arr: descriptor,
        $values: { $bin: idx },
      };
      return wrapper;
    }
    // Non-numeric array: recurse into elements (e.g. extraObjects, data columns)
    return (node as unknown[]).map((item) => replaceArrays(item, sections));
  }
  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      result[k] = replaceArrays(v, sections);
    }
    return result;
  }
  return node;
}

// rawSections holds the undecoded bytes of each binary section. Decoding is
// deferred until each $arr wrapper is encountered so that $arr.signed is
// available at decode time.
function restoreArrays(node: unknown, rawSections: Uint8Array[]): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    // Detect $arr wrapper: presence of both $arr and $values keys.
    if ('$arr' in obj && '$values' in obj) {
      const descriptor = obj.$arr as ArrDescriptor;
      const valuesSource = obj.$values;

      // Resolve $values to a number[], decoding the binary section now that
      // we have the $arr descriptor (needed for $arr.signed).
      let raw: number[];
      if (Array.isArray(valuesSource)) {
        raw = valuesSource as number[];
      } else if (
        valuesSource !== null &&
        typeof valuesSource === 'object' &&
        '$bin' in (valuesSource as Record<string, unknown>)
      ) {
        const binIdx = (valuesSource as { $bin: number }).$bin;
        raw = decodeSection(rawSections[binIdx], descriptor.signed ?? false);
      } else {
        throw new Error('$arr.$values must be a number array or { $bin: N }');
      }

      // Apply decode pipeline: delta → scale → null expansion.
      let values: number[] = raw;

      if (descriptor.delta) {
        values = values.slice();
        for (let i = 1; i < values.length; i++) {
          values[i] += values[i - 1];
        }
      }

      if (descriptor.scale !== undefined) {
        if (values === raw) values = values.slice();
        const s = descriptor.scale;
        for (let i = 0; i < values.length; i++) {
          values[i] *= s;
        }
      }

      if (descriptor.nulls !== undefined) {
        if (descriptor.count === undefined) {
          throw new Error('$arr with nulls must include count');
        }
        const bitfield = descriptor.nulls;
        const totalCount = descriptor.count;
        const result: (number | null)[] = new Array(totalCount);
        let nonNullIdx = 0;
        for (let i = 0; i < totalCount; i++) {
          result[i] =
            (bitfield[i >> 3] >> (i & 7)) & 1 ? values[nonNullIdx++] : null;
        }
        return result;
      }

      return values;
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = restoreArrays(v, rawSections);
    }
    return result;
  }
  if (Array.isArray(node)) {
    return (node as unknown[]).map((item) => restoreArrays(item, rawSections));
  }
  return node;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function encode(obj: unknown): Uint8Array {
  const sections: Uint8Array[] = [];
  const skeleton = replaceArrays(obj, sections);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(skeleton));

  const sectionBytesTotal = sections.reduce((sum, s) => sum + 4 + s.length, 0);
  const total = 4 + 4 + 4 + jsonBytes.length + 4 + sectionBytesTotal;

  const w = new ByteWriter(total);
  w.writeBytes(MAGIC);
  w.writeUint32LE(VERSION);
  w.writeUint32LE(jsonBytes.length);
  w.writeBytes(jsonBytes);
  w.writeUint32LE(sections.length);
  for (const s of sections) {
    w.writeUint32LE(s.length);
    w.writeBytes(s);
  }
  return w.finish();
}

// Returns the raw UTF-8 bytes of the JSON skeleton section so callers can
// write it to disk for inspection with tools like json-size-profiler.
export function extractJsonSkeleton(buffer: Uint8Array): Uint8Array {
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x46 ||
    buffer[2] !== 0x43 ||
    buffer[3] !== 0x42
  ) {
    throw new Error('Not a binary profile: bad magic bytes');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const jsonLen = view.getUint32(8, /* littleEndian */ true);
  return buffer.subarray(12, 12 + jsonLen);
}

export function decode(buffer: Uint8Array): unknown {
  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x46 ||
    buffer[2] !== 0x43 ||
    buffer[3] !== 0x42
  ) {
    throw new Error('Not a binary profile: bad magic bytes');
  }

  const r = new ByteReader(buffer, 4);
  const version = r.readUint32LE();
  if (version !== VERSION) {
    throw new Error(`Unsupported binary profile version ${version}`);
  }

  const jsonLen = r.readUint32LE();
  const jsonStr = new TextDecoder().decode(r.readBytes(jsonLen));

  const sectionCount = r.readUint32LE();
  const rawSections: Uint8Array[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const sectionLen = r.readUint32LE();
    rawSections.push(r.readBytes(sectionLen));
  }

  return restoreArrays(JSON.parse(jsonStr) as unknown, rawSections);
}
