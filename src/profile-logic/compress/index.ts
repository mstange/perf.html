/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  Profile,
  FrameTable,
  FuncTable,
  NativeSymbolTable,
  RawSamplesTable,
} from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import type { CompressedProfile } from './markers';
import { Builder, decode as containerDecode } from './binary-container';
import { ByteWriter, ByteReader } from './byte-io';

// ── Array descriptor types ──────────────────────────────────────────────────

type ArrDescriptor =
  | { $arr: 'uleb128' }
  | { $arr: 'sleb128' }
  | { $arr: 'uleb128-ms' } // ms float → µs integer (lossy for sub-µs)
  | { $arr: 'uleb128-delta'; $scale?: number } // prefix-sum then ×$scale; encode: round(delta/$scale)
  | { $arr: 'sleb128-null-sentinel'; $sentinel: number } // replace $sentinel value with null
  | { $arr: 'sleb128-slide-prefix'; $nullSentinel: number; $slideSentinel: number };
  // sleb128-slide-prefix: null→$nullSentinel, prefix[i]=i-1→$slideSentinel, else the value.
  // Stack-table prefix arrays have many consecutive "slides" (prefix[i] = i-1) when the
  // profiler appended stacks in order for a growing call chain. Encoding those as a 1-byte
  // sentinel instead of the actual (large) index value saves ~2-4 bytes per slide entry.

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
  desc:
    | { $arr: 'sleb128-null-sentinel'; $sentinel: number }
    | { $arr: 'sleb128-slide-prefix'; $nullSentinel: number; $slideSentinel: number }
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
    case 'uleb128-ms': {
      const usArr = (values as number[]).map((v) => Math.round(v * 1000));
      return { ...desc, $values: encodeULEB128(usArr) };
    }
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
    case 'sleb128-slide-prefix': {
      const nullSentinel = desc.$nullSentinel;
      const slideSentinel = desc.$slideSentinel;
      const arr = values as (number | null)[];
      const mapped: number[] = [];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v === null) {
          mapped.push(nullSentinel);
        } else if (v === i - 1) {
          mapped.push(slideSentinel);
        } else {
          mapped.push(v);
        }
      }
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
    case 'uleb128-ms': {
      const usArr = decodeLEB128(w.$values, false);
      return usArr.map((v) => v * 0.001);
    }
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
    case 'sleb128-slide-prefix': {
      const nullSentinel = w.$nullSentinel;
      const slideSentinel = w.$slideSentinel;
      const vals = decodeLEB128(w.$values, true);
      return vals.map((v, i) => {
        if (v === nullSentinel) return null;
        if (v === slideSentinel) return i - 1;
        return v;
      });
    }
  }
}

function isArrWrapped(v: unknown): v is ArrWrapped {
  return v !== null && typeof v === 'object' && '$arr' in (v as object);
}

// ── String array encoding ───────────────────────────────────────────────────

type EncodedStringArray = { $strBytes: Uint8Array; $strLens: Uint8Array };

function encodeStringArray(strings: string[]): EncodedStringArray {
  const encoder = new TextEncoder();
  const encodedStrings = strings.map((s) => encoder.encode(s));
  const totalBytes = encodedStrings.reduce((sum, e) => sum + e.length, 0);
  const strBytes = new Uint8Array(totalBytes);
  const strLenWriter = new ByteWriter(strings.length * 2);
  let byteOffset = 0;
  for (const encoded of encodedStrings) {
    strBytes.set(encoded, byteOffset);
    byteOffset += encoded.length;
    strLenWriter.writeULEB128(encoded.length);
  }
  return { $strBytes: strBytes, $strLens: strLenWriter.finish() };
}

function decodeStringArray(enc: EncodedStringArray): string[] {
  const decoder = new TextDecoder();
  const lenReader = new ByteReader(enc.$strLens);
  const strings: string[] = [];
  let byteOffset = 0;
  while (lenReader.offset < lenReader.length) {
    const len = lenReader.readULEB128();
    strings.push(decoder.decode(enc.$strBytes.subarray(byteOffset, byteOffset + len)));
    byteOffset += len;
  }
  return strings;
}

function isEncodedStringArray(v: unknown): v is EncodedStringArray {
  return v !== null && typeof v === 'object' && '$strBytes' in (v as object);
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
const SLIDE_PREFIX_DESC = {
  $arr: 'sleb128-slide-prefix' as const,
  $nullSentinel: -1,
  $slideSentinel: -2,
};

function phase1(p: unknown): unknown {
  const cp = p as CompressedProfile;

  // Marker arrays.
  for (const thread of cp.threads) {
    const m = thread.markers as Record<string, unknown>;
    for (const [key, desc] of Object.entries(MARKER_ARRAY_ENCODINGS)) {
      m[key] = encodeArr(m[key] as number[], desc);
    }
    m.fieldStringTable = encodeStringArray(m.fieldStringTable as string[]);
  }

  // shared.* — all created as new objects to avoid mutating the original profile
  // (shared is the same reference in both the original Profile and the CompressedProfile).
  const cpa = cp as unknown as Record<string, unknown>;
  const shared = cpa.shared as Record<string, unknown>;
  const origSt = shared.stackTable as { frame: number[]; prefix: (number | null)[]; length: number };
  const origFt = shared.frameTable as FrameTable;
  const origFuncT = shared.funcTable as FuncTable;
  const origNS = shared.nativeSymbols as NativeSymbolTable;

  cpa.shared = {
    ...shared,
    stringArray: encodeStringArray(shared.stringArray as string[]),
    stackTable: {
      ...origSt,
      frame: encodeArr(origSt.frame, { $arr: 'uleb128' }),
      // slide-prefix encoding: prefix[i]=i-1 (very common in consecutive-stack appends)
      // is stored as a 1-byte sentinel instead of the actual large index value.
      prefix: encodeArr(origSt.prefix, SLIDE_PREFIX_DESC),
    },
    frameTable: {
      ...origFt,
      address: encodeArr(origFt.address, { $arr: 'sleb128' }), // -1 = no address
      inlineDepth: encodeArr(origFt.inlineDepth, { $arr: 'uleb128' }),
      category: encodeArr(origFt.category, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      subcategory: encodeArr(origFt.subcategory, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      func: encodeArr(origFt.func, { $arr: 'uleb128' }),
      nativeSymbol: encodeArr(origFt.nativeSymbol, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      innerWindowID: encodeArr(origFt.innerWindowID, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      line: encodeArr(origFt.line, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      column: encodeArr(origFt.column, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
    },
    funcTable: {
      ...origFuncT,
      name: encodeArr(origFuncT.name, { $arr: 'uleb128' }),
      // booleans converted to 0/1 for ULEB128 encoding; restored to boolean at decode
      isJS: encodeArr(origFuncT.isJS.map((v) => (v ? 1 : 0)), { $arr: 'uleb128' }),
      relevantForJS: encodeArr(origFuncT.relevantForJS.map((v) => (v ? 1 : 0)), { $arr: 'uleb128' }),
      resource: encodeArr(origFuncT.resource, { $arr: 'sleb128' }), // -1 = no resource
      source: encodeArr(origFuncT.source, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      lineNumber: encodeArr(origFuncT.lineNumber, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
      columnNumber: encodeArr(origFuncT.columnNumber, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
    },
    nativeSymbols: {
      ...origNS,
      libIndex: encodeArr(origNS.libIndex, { $arr: 'uleb128' }),
      address: encodeArr(origNS.address, { $arr: 'uleb128' }),
      name: encodeArr(origNS.name, { $arr: 'uleb128' }),
      functionSize: encodeArr(origNS.functionSize, { $arr: 'sleb128-null-sentinel', $sentinel: -1 }),
    },
  };

  // samples per thread (thread objects are new from compressMarkers, safe to mutate).
  for (const thread of cp.threads) {
    const s = thread.samples as RawSamplesTable;
    const newSamples: Record<string, unknown> = {
      ...(s as unknown as Record<string, unknown>),
    };
    if (s.time) {
      newSamples.time = encodeArr(s.time, MS_DELTA_DESC);
    }
    if (s.timeDeltas) {
      // timeDeltas values are already deltas in ms; encode as µs integers.
      newSamples.timeDeltas = encodeArr(s.timeDeltas, { $arr: 'uleb128-ms' });
    }
    newSamples.stack = encodeArr(s.stack, { $arr: 'sleb128-null-sentinel', $sentinel: -1 });
    if (s.threadCPUDelta) {
      newSamples.threadCPUDelta = encodeArr(
        s.threadCPUDelta,
        { $arr: 'sleb128-null-sentinel', $sentinel: -1 }
      );
    }
    if (s.weight !== null && s.weight !== undefined) {
      // weight can be negative in diff profiles, so use sleb128
      newSamples.weight = encodeArr(s.weight, { $arr: 'sleb128' });
    }
    (thread as unknown as Record<string, unknown>).samples = newSamples;
  }

  // counters[i].samples — create new counter+samples objects to avoid mutating the original.
  const counters = (cpa.counters ?? []) as Array<{
    samples: { time?: number[]; count?: number[]; number?: number[] };
  }>;
  if (cpa.counters !== undefined) {
    cpa.counters = counters.map((counter) => {
      const s = counter.samples;
      const newSamples: Record<string, unknown> = { ...s };
      if (s.time) {
        newSamples.time = encodeArr(s.time, MS_DELTA_DESC);
      }
      if (s.count) {
        newSamples.count = encodeArr(s.count, { $arr: 'uleb128' });
      }
      if (s.number) {
        newSamples.number = encodeArr(s.number, { $arr: 'uleb128' });
      }
      return { ...counter, samples: newSamples };
    });
  }

  return cp;
}

function phase1Decode(p: unknown): unknown {
  const cp = p as {
    threads: Array<{
      markers: Record<string, unknown>;
      samples: Record<string, unknown>;
    }>;
    shared: Record<string, unknown>;
    counters?: Array<{ samples: Record<string, unknown> }>;
  };

  // Marker arrays.
  for (const thread of cp.threads) {
    const m = thread.markers;
    for (const key of Object.keys(MARKER_ARRAY_ENCODINGS)) {
      m[key] = decodeArr(m[key] as ArrWrapped);
    }
    if (isEncodedStringArray(m.fieldStringTable)) {
      m.fieldStringTable = decodeStringArray(m.fieldStringTable);
    }
  }

  // shared.stackTable.
  const st = cp.shared.stackTable as Record<string, unknown>;
  st.frame = decodeArr(st.frame as ArrWrapped);
  st.prefix = decodeArr(st.prefix as ArrWrapped);

  // shared.frameTable.
  const ft = cp.shared.frameTable as Record<string, unknown>;
  for (const key of [
    'address', 'inlineDepth', 'category', 'subcategory', 'func',
    'nativeSymbol', 'innerWindowID', 'line', 'column',
  ]) {
    if (isArrWrapped(ft[key])) {
      ft[key] = decodeArr(ft[key] as ArrWrapped);
    }
  }

  // shared.funcTable.
  const funcT = cp.shared.funcTable as Record<string, unknown>;
  for (const key of ['name', 'resource', 'source', 'lineNumber', 'columnNumber']) {
    if (isArrWrapped(funcT[key])) {
      funcT[key] = decodeArr(funcT[key] as ArrWrapped);
    }
  }
  // Restore booleans from 0/1 numbers.
  if (isArrWrapped(funcT.isJS)) {
    funcT.isJS = (decodeArr(funcT.isJS) as number[]).map((v) => v !== 0);
  }
  if (isArrWrapped(funcT.relevantForJS)) {
    funcT.relevantForJS = (decodeArr(funcT.relevantForJS) as number[]).map((v) => v !== 0);
  }

  // shared.nativeSymbols.
  const ns = cp.shared.nativeSymbols as Record<string, unknown>;
  for (const key of ['libIndex', 'address', 'name', 'functionSize']) {
    if (isArrWrapped(ns[key])) {
      ns[key] = decodeArr(ns[key] as ArrWrapped);
    }
  }

  // shared.stringArray.
  if (isEncodedStringArray(cp.shared.stringArray)) {
    cp.shared.stringArray = decodeStringArray(cp.shared.stringArray);
  }

  // samples per thread.
  for (const thread of cp.threads) {
    const s = thread.samples;
    if (isArrWrapped(s.time)) {
      s.time = decodeArr(s.time);
    }
    if (isArrWrapped(s.timeDeltas)) {
      s.timeDeltas = decodeArr(s.timeDeltas);
    }
    if (isArrWrapped(s.stack)) {
      s.stack = decodeArr(s.stack);
    }
    if (isArrWrapped(s.threadCPUDelta)) {
      s.threadCPUDelta = decodeArr(s.threadCPUDelta);
    }
    if (isArrWrapped(s.weight)) {
      s.weight = decodeArr(s.weight);
    }
  }

  // counters[i].samples.
  for (const counter of cp.counters ?? []) {
    const s = counter.samples;
    if (isArrWrapped(s.time)) {
      s.time = decodeArr(s.time);
    }
    if (isArrWrapped(s.count)) {
      s.count = decodeArr(s.count);
    }
    if (isArrWrapped(s.number)) {
      s.number = decodeArr(s.number);
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
