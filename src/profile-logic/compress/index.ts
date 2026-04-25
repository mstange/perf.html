/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile } from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import type { CompressedProfile } from './markers';
import { Builder, decode as containerDecode } from './binary-container';
import { ByteWriter, ByteReader } from './byte-io';

// ── Array descriptor types ──────────────────────────────────────────────────

type ArrDescriptor =
  | { $arr: 'uleb128' }
  | { $arr: 'sleb128' }
  | { $arr: 'uleb128-delta'; $scale?: number } // prefix-sum then ×$scale; encode: round(delta/$scale)
  | { $arr: 'sleb128-null-sentinel'; $sentinel: number }; // replace $sentinel value with null

type ArrWrapped = ArrDescriptor & { $values: Uint8Array };

// ── LEB128 primitives ───────────────────────────────────────────────────────

function encodeULEB128(values: number[]): Uint8Array {
  const w = new ByteWriter(values.length * 2);
  for (const v of values) w.writeULEB128(v);
  return w.finish();
}

function encodeSLEB128(values: number[]): Uint8Array {
  const w = new ByteWriter(values.length * 2);
  for (const v of values) w.writeSLEB128(v);
  return w.finish();
}

function decodeLEB128(bytes: Uint8Array, signed: boolean): number[] {
  const r = new ByteReader(bytes);
  const out: number[] = [];
  while (r.offset < r.length) {
    out.push(signed ? r.readSLEB128() : r.readULEB128());
  }
  return out;
}

// ── Generic encode / decode ─────────────────────────────────────────────────

function encodeArr(values: number[], desc: ArrDescriptor): ArrWrapped;
function encodeArr(
  values: (number | null)[],
  desc: { $arr: 'sleb128-null-sentinel'; $sentinel: number }
): ArrWrapped;
function encodeArr(
  values: number[] | (number | null)[],
  desc: ArrDescriptor
): ArrWrapped {
  switch (desc.$arr) {
    case 'uleb128':
      return { ...desc, $values: encodeULEB128(values as number[]) };
    case 'sleb128':
      return { ...desc, $values: encodeSLEB128(values as number[]) };
    case 'uleb128-delta': {
      const scale = desc.$scale ?? 1;
      const deltas: number[] = [];
      let prev = 0;
      for (const v of values as number[]) {
        deltas.push(Math.round((v - prev) / scale));
        prev = v;
      }
      return { ...desc, $values: encodeULEB128(deltas) };
    }
    case 'sleb128-null-sentinel': {
      const sentinel = desc.$sentinel;
      const mapped = (values as (number | null)[]).map((v) =>
        v === null ? sentinel : v
      );
      return { ...desc, $values: encodeSLEB128(mapped) };
    }
  }
}

function decodeArr(w: ArrWrapped): number[] | (number | null)[] {
  switch (w.$arr) {
    case 'uleb128':
      return decodeLEB128(w.$values, false);
    case 'sleb128':
      return decodeLEB128(w.$values, true);
    case 'uleb128-delta': {
      const scale = w.$scale ?? 1;
      const deltas = decodeLEB128(w.$values, false);
      const out: number[] = [];
      let acc = 0;
      for (const d of deltas) {
        acc += d;
        out.push(acc * scale);
      }
      return out;
    }
    case 'sleb128-null-sentinel': {
      const sentinel = w.$sentinel;
      const vals = decodeLEB128(w.$values, true);
      return vals.map((v) => (v === sentinel ? null : v));
    }
  }
}

function isArrWrapped(v: unknown): v is ArrWrapped {
  return v !== null && typeof v === 'object' && '$arr' in (v as object);
}

// ── Phase 1: profile-aware transformations ──────────────────────────────────

const MARKER_ARRAY_ENCODINGS: Record<string, ArrDescriptor> = {
  startTimeDeltaMicros:        { $arr: 'uleb128' },
  endTimeDeltaMicros:          { $arr: 'uleb128' },
  allStringFieldValues:        { $arr: 'uleb128' },
  fieldBits:                   { $arr: 'uleb128' },
  allTimeFieldValues:          { $arr: 'uleb128' },
  phaseNonZeroIndexDeltas:     { $arr: 'uleb128' },
  phaseNonZeroValues:          { $arr: 'uleb128' },
  categoryOverrideIndexDeltas: { $arr: 'uleb128' },
  categoryOverrideValues:      { $arr: 'uleb128' },
  allCauseStacks:              { $arr: 'uleb128' },
  allCauseTimes:               { $arr: 'uleb128' },
  allCauseTids:                { $arr: 'uleb128' },
  nameDeltaValues:             { $arr: 'sleb128' },
  schemaIndexDeltaValues:      { $arr: 'sleb128' },
  allPageIndexDeltas:          { $arr: 'sleb128' },
};

const MS_DELTA_DESC: ArrDescriptor = { $arr: 'uleb128-delta', $scale: 0.001 };

function phase1(p: unknown): unknown {
  const cp = p as CompressedProfile;

  // Marker arrays.
  for (const thread of cp.threads) {
    const m = thread.markers as Record<string, unknown>;
    for (const [key, desc] of Object.entries(MARKER_ARRAY_ENCODINGS)) {
      m[key] = encodeArr(m[key] as number[], desc);
    }
  }

  // shared.stackTable.frame and .prefix.
  // Create a new stackTable (and new shared) to avoid mutating the original profile.
  const cpa = cp as unknown as Record<string, unknown>;
  const shared = cpa.shared as Record<string, unknown>;
  const origSt = shared.stackTable as { frame: number[]; prefix: (number | null)[]; length: number };
  cpa.shared = {
    ...shared,
    stackTable: {
      ...origSt,
      frame: encodeArr(origSt.frame, { $arr: 'uleb128' }),
      prefix: encodeArr(origSt.prefix, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
    },
  };

  // samples.time per thread (thread objects are new from compressMarkers, safe to mutate).
  for (const thread of cp.threads) {
    if (thread.samples.time) {
      (thread as unknown as Record<string, unknown>).samples = {
        ...thread.samples,
        time: encodeArr(thread.samples.time, MS_DELTA_DESC),
      };
    }
  }

  // counters[i].samples.time.
  // Create new counter+samples objects to avoid mutating the original profile.
  const counters = (cpa.counters ?? []) as Array<{ samples: { time?: number[] } }>;
  if (cpa.counters !== undefined) {
    cpa.counters = counters.map((counter) => {
      if (!counter.samples.time) return counter;
      return {
        ...counter,
        samples: { ...counter.samples, time: encodeArr(counter.samples.time, MS_DELTA_DESC) },
      };
    });
  }

  return cp;
}

function phase1Decode(p: unknown): unknown {
  const cp = p as { threads: Array<{ markers: Record<string, unknown>; samples: Record<string, unknown> }>; shared: { stackTable: Record<string, unknown> }; counters?: Array<{ samples: Record<string, unknown> }> };

  // Marker arrays.
  for (const thread of cp.threads) {
    const m = thread.markers;
    for (const key of Object.keys(MARKER_ARRAY_ENCODINGS)) {
      m[key] = decodeArr(m[key] as ArrWrapped);
    }
  }

  // shared.stackTable.frame and .prefix.
  const st = cp.shared.stackTable;
  st.frame = decodeArr(st.frame as ArrWrapped);
  st.prefix = decodeArr(st.prefix as ArrWrapped);

  // samples.time per thread.
  for (const thread of cp.threads) {
    if (isArrWrapped(thread.samples.time)) {
      thread.samples.time = decodeArr(thread.samples.time);
    }
  }

  // counters[i].samples.time.
  for (const counter of cp.counters ?? []) {
    if (isArrWrapped(counter.samples.time)) {
      counter.samples.time = decodeArr(counter.samples.time);
    }
  }

  return cp;
}

// ── Phase 2: TypedArray ↔ { $bin: N } ──────────────────────────────────────

function makeReplacer(builder: Builder) {
  return function (_key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return builder.addSlabU8(value);
    if (value instanceof Int32Array) return builder.addSlabI32(value);
    if (value instanceof Float64Array) return builder.addSlabF64(value);
    return value;
  };
}

function makeReviver(slabs: Array<Uint8Array | Int32Array | Float64Array>) {
  return function (_key: string, value: unknown): unknown {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      '$bin' in (value as Record<string, unknown>)
    ) {
      return slabs[(value as { $bin: number }).$bin];
    }
    return value;
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p: unknown = compressMarkers(profile) as unknown;
  p = phase1(p);

  const builder = new Builder();
  const jsonStr = JSON.stringify(p, makeReplacer(builder));
  const jsonBytes = new TextEncoder().encode(jsonStr);
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
  let p: unknown = JSON.parse(
    new TextDecoder().decode(jsonBytes),
    makeReviver(slabs)
  );
  p = phase1Decode(p);
  return uncompressMarkers(p as any) as unknown as Profile;
}
