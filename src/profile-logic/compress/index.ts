/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile } from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import {
  Builder,
  decode as containerDecode,
  ByteWriter,
  ByteReader,
} from './binary-container';
import type { SlabPlaceholder } from './binary-container';

// ── Array codec ────────────────────────────────────────────────────────────

// $arr descriptors live in the JSON skeleton and tell the decoder how to
// reconstruct the original array from a slab.
type ArrDescriptor = {
  // signed: LEB128 byte blob uses zigzag (signed) encoding.
  signed?: boolean;
  // delta: cumulative-sum (undelta) the sequence after decoding.
  delta?: boolean;
  // scale: multiply every value by this constant after undelta.
  scale?: number;
  // nulls + count: presence bitfield; $values holds only non-null elements.
  nulls?: number[];
  count?: number;
};

type ArrWrapper = {
  $arr: ArrDescriptor;
  $values: SlabPlaceholder | number[];
};

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

function encodeArray(values: (number | null)[], builder: Builder): ArrWrapper {
  const count = values.length;
  const descriptor: ArrDescriptor = {};

  let hasNulls = false;
  let hasNegatives = false;
  let isFloat = false;
  for (const v of values) {
    if (v === null) {
      hasNulls = true;
      continue;
    }
    if (v < 0) hasNegatives = true;
    if (!Number.isInteger(v)) isFloat = true;
  }

  let nonNullValues: number[];
  if (hasNulls) {
    const bitfield = new Uint8Array(Math.ceil(count / 8));
    nonNullValues = [];
    for (let i = 0; i < count; i++) {
      if (values[i] !== null) {
        bitfield[i >> 3] |= 1 << (i & 7);
        nonNullValues.push(values[i] as number);
      }
    }
    descriptor.nulls = Array.from(bitfield);
    descriptor.count = count;
  } else {
    nonNullValues = values as number[];
  }

  let slabRef: SlabPlaceholder;
  if (isFloat) {
    slabRef = builder.addSlabF64(new Float64Array(nonNullValues));
  } else {
    const signed = hasNegatives;
    if (signed) descriptor.signed = true;
    const w = new ByteWriter(nonNullValues.length * 4);
    for (const v of nonNullValues) {
      // zigzag encode: non-negative n → 2n, negative n → -2n - 1
      const zigzag = v >= 0 ? 2 * v : -2 * v - 1;
      w.writeULEB128(signed ? zigzag : v);
    }
    slabRef = builder.addSlabU8(w.finish());
  }

  return { $arr: descriptor, $values: slabRef };
}

function replaceArrays(node: unknown, builder: Builder): unknown {
  if (Array.isArray(node)) {
    if (isNumericArray(node)) {
      return encodeArray(node, builder);
    }
    return (node as unknown[]).map((item) => replaceArrays(item, builder));
  }
  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      result[k] = replaceArrays(v, builder);
    }
    return result;
  }
  return node;
}

function decodeArray(
  slab: Uint8Array | Int32Array | Float64Array,
  descriptor: ArrDescriptor
): number[] {
  let raw: number[];

  if (slab instanceof Float64Array) {
    raw = Array.from(slab);
  } else {
    // U8 slab: LEB128-encoded stream; read until exhausted.
    const r = new ByteReader(slab as Uint8Array);
    const signed = descriptor.signed ?? false;
    raw = [];
    while (r.offset < r.length) {
      const z = r.readULEB128();
      // zigzag decode: even → z/2, odd → -(z+1)/2
      const decoded = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      raw.push(signed ? decoded : z);
    }
  }

  let values: number[] = raw;

  if (descriptor.delta) {
    values = values.slice();
    for (let i = 1; i < values.length; i++) values[i] += values[i - 1];
  }

  if (descriptor.scale !== undefined) {
    if (values === raw) values = values.slice();
    const s = descriptor.scale;
    for (let i = 0; i < values.length; i++) values[i] *= s;
  }

  return values;
}

function restoreArrays(
  node: unknown,
  slabs: Array<Uint8Array | Int32Array | Float64Array>
): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    if ('$arr' in obj && '$values' in obj) {
      const descriptor = obj.$arr as ArrDescriptor;
      const valuesSource = obj.$values;

      let values: number[];
      if (Array.isArray(valuesSource)) {
        values = decodeArray(new Uint8Array(0), { ...descriptor });
        // inline number array — no slab involved
        values = valuesSource as number[];
        if (descriptor.delta) {
          values = values.slice();
          for (let i = 1; i < values.length; i++) values[i] += values[i - 1];
        }
        if (descriptor.scale !== undefined) {
          values = values.map((v) => v * descriptor.scale!);
        }
      } else if (
        valuesSource !== null &&
        typeof valuesSource === 'object' &&
        '$bin' in (valuesSource as Record<string, unknown>)
      ) {
        const binIdx = (valuesSource as { $bin: number }).$bin;
        values = decodeArray(slabs[binIdx], descriptor);
      } else {
        throw new Error('$arr.$values must be a number array or { $bin: N }');
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
      result[k] = restoreArrays(v, slabs);
    }
    return result;
  }
  if (Array.isArray(node)) {
    return (node as unknown[]).map((item) => restoreArrays(item, slabs));
  }
  return node;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p = profile;
  p = compressMarkers(p) as unknown as Profile;

  const builder = new Builder();
  const skeleton = replaceArrays(p, builder);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(skeleton));
  const chunks = builder.finish(jsonBytes);
  const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out as Uint8Array<ArrayBuffer>;
}

export function uncompressProfile(buffer: Uint8Array): Profile {
  const { jsonBytes, slabs } = containerDecode(buffer);
  const skeleton = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown;
  let p = restoreArrays(skeleton, slabs) as any;
  p = uncompressMarkers(p);
  return p as any;
}
