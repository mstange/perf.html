/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  Profile,
  FrameTable,
  FuncTable,
  NativeSymbolTable,
  RawSamplesTable,
  ResourceTable,
  SourceTable,
} from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import type { CompressedProfile } from './markers';
import { Jslabs } from './jslabs';
import { ByteWriter, ByteReader } from './byte-io';

// ── Encoded array type ──────────────────────────────────────────────────────

type ArrWrapped =
  | { $arr: 'uleb128'; $values: Uint8Array }
  | { $arr: 'sleb128'; $values: Uint8Array }
  | { $arr: 'uleb128-ms'; $values: Uint8Array } // ms float → µs integer (lossy for sub-µs)
  | { $arr: 'uleb128-delta'; $scale?: number; $values: Uint8Array } // prefix-sum then ×$scale; encode: round(delta/$scale)
  | { $arr: 'sleb128-null-sentinel'; $sentinel: number; $values: Uint8Array } // replace $sentinel value with null
  | { $arr: 'sleb128-slide-prefix'; $nullSentinel: number; $slideSentinel: number; $values: Uint8Array }
  // sleb128-slide-prefix: null→$nullSentinel, prefix[i]=i-1→$slideSentinel, else the value.
  // Stack-table prefix arrays have many consecutive "slides" (prefix[i] = i-1) when the
  // profiler appended stacks in order for a growing call chain. Encoding those as a 1-byte
  // sentinel instead of the actual (large) index value saves ~2-4 bytes per slide entry.
  | { $arr: 'constant-null'; $length: number }; // all values are null — no $values needed

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

function decodeULEB128(bytes: Uint8Array): number[] {
  const r = new ByteReader(bytes);
  const out: number[] = [];
  while (r.offset < r.length) out.push(r.readULEB128());
  return out;
}

function decodeSLEB128(bytes: Uint8Array): number[] {
  const r = new ByteReader(bytes);
  const out: number[] = [];
  while (r.offset < r.length) out.push(r.readSLEB128());
  return out;
}

// ── Per-encoding encode functions ───────────────────────────────────────────

function encodeUleb128Arr(values: number[]): ArrWrapped {
  return { $arr: 'uleb128', $values: encodeULEB128(values) };
}

function encodeSleb128Arr(values: number[]): ArrWrapped {
  return { $arr: 'sleb128', $values: encodeSLEB128(values) };
}

function encodeUleb128MsArr(values: number[]): ArrWrapped {
  return { $arr: 'uleb128-ms', $values: encodeULEB128(values.map((v) => Math.round(v * 1000))) };
}

function encodeUleb128DeltaArr(values: number[], scale: number = 1): ArrWrapped {
  const deltas: number[] = [];
  let prev = 0;
  for (const v of values) {
    deltas.push(Math.round((v - prev) / scale));
    prev = v;
  }
  return { $arr: 'uleb128-delta', $scale: scale, $values: encodeULEB128(deltas) };
}

function encodeSleb128NullSentinelArr(
  values: (number | null)[],
  sentinel: number
): ArrWrapped {
  return {
    $arr: 'sleb128-null-sentinel',
    $sentinel: sentinel,
    $values: encodeSLEB128(values.map((v) => (v === null ? sentinel : v))),
  };
}

function encodeSleb128SlidePrefixArr(
  values: (number | null)[],
  nullSentinel: number,
  slideSentinel: number
): ArrWrapped {
  const mapped: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    mapped.push(v === null ? nullSentinel : v === i - 1 ? slideSentinel : v);
  }
  return {
    $arr: 'sleb128-slide-prefix',
    $nullSentinel: nullSentinel,
    $slideSentinel: slideSentinel,
    $values: encodeSLEB128(mapped),
  };
}

function decodeArr(w: ArrWrapped): number[] | (number | null)[] {
  switch (w.$arr) {
    case 'uleb128':
      return decodeULEB128(w.$values);
    case 'sleb128':
      return decodeSLEB128(w.$values);
    case 'uleb128-ms':
      return decodeULEB128(w.$values).map((v) => v * 0.001);
    case 'uleb128-delta': {
      const scale = w.$scale ?? 1;
      const out: number[] = [];
      let acc = 0;
      for (const d of decodeULEB128(w.$values)) {
        acc += d;
        out.push(acc * scale);
      }
      return out;
    }
    case 'sleb128-null-sentinel': {
      const sentinel = w.$sentinel;
      return decodeSLEB128(w.$values).map((v) => (v === sentinel ? null : v));
    }
    case 'sleb128-slide-prefix': {
      const { $nullSentinel: ns, $slideSentinel: ss } = w;
      return decodeSLEB128(w.$values).map((v, i) => {
        if (v === ns) return null;
        if (v === ss) return i - 1;
        return v;
      });
    }
    case 'constant-null':
      return Array(w.$length).fill(null);
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

// ── Column encoding: number[] ↔ { $arr, $values } ──────────────────────────

const MARKER_ARRAY_ENCODINGS: Record<string, (values: number[]) => ArrWrapped> = {
  startTimeDeltaMicros:        encodeUleb128Arr,
  endTimeDeltaMicros:          encodeUleb128Arr,
  allStringFieldValues:        encodeUleb128Arr,
  fieldBits:                   encodeUleb128Arr,
  allTimeFieldValues:          encodeUleb128Arr,
  phaseNonZeroIndexDeltas:     encodeUleb128Arr,
  phaseNonZeroValues:          encodeUleb128Arr,
  categoryOverrideIndexDeltas: encodeUleb128Arr,
  categoryOverrideValues:      encodeUleb128Arr,
  allCauseStacks:              encodeUleb128Arr,
  allCauseTimes:               encodeUleb128Arr,
  allCauseTids:                encodeUleb128Arr,
  nameDeltaValues:             encodeSleb128Arr,
  schemaIndexDeltaValues:      encodeSleb128Arr,
  allPageIndexDeltas:          encodeSleb128Arr,
  allIntegerFieldValues:       encodeUleb128Arr,
};

function encodeColumns(p: unknown): unknown {
  const cp = p as CompressedProfile;

  // Marker arrays.
  for (const thread of cp.threads) {
    const m = thread.markers as Record<string, unknown>;
    for (const [key, encode] of Object.entries(MARKER_ARRAY_ENCODINGS)) {
      m[key] = encode(m[key] as number[]);
    }
    m.fieldStringTable = encodeStringArray(m.fieldStringTable as string[]);
    m.allFloatFieldValues = new Float64Array(m.allFloatFieldValues as number[]);
  }

  // shared.* — all created as new objects to avoid mutating the original profile
  // (shared is the same reference in both the original Profile and the CompressedProfile).
  const cpa = cp as unknown as Record<string, unknown>;
  const shared = cpa.shared as Record<string, unknown>;
  const origSt = shared.stackTable as { frame: number[]; prefix: (number | null)[]; length: number };
  const origFt = shared.frameTable as FrameTable;
  const origFuncT = shared.funcTable as FuncTable;
  const origNS = shared.nativeSymbols as NativeSymbolTable;
  const origRt = shared.resourceTable as ResourceTable;
  const origSources = shared.sources as SourceTable | undefined;

  cpa.shared = {
    ...shared,
    stringArray: encodeStringArray(shared.stringArray as string[]),
    stackTable: {
      ...origSt,
      frame: encodeUleb128Arr(origSt.frame),
      // slide-prefix encoding: prefix[i]=i-1 (very common in consecutive-stack appends)
      // is stored as a 1-byte sentinel instead of the actual large index value.
      prefix: encodeSleb128SlidePrefixArr(origSt.prefix, -1, -2),
    },
    frameTable: {
      ...origFt,
      address: encodeSleb128Arr(origFt.address), // -1 = no address
      inlineDepth: encodeUleb128Arr(origFt.inlineDepth),
      category: encodeSleb128NullSentinelArr(origFt.category, -1),
      subcategory: encodeSleb128NullSentinelArr(origFt.subcategory, -1),
      func: encodeUleb128Arr(origFt.func),
      nativeSymbol: encodeSleb128NullSentinelArr(origFt.nativeSymbol, -1),
      innerWindowID: encodeSleb128NullSentinelArr(origFt.innerWindowID, -1),
      line: encodeSleb128NullSentinelArr(origFt.line, -1),
      column: encodeSleb128NullSentinelArr(origFt.column, -1),
    },
    funcTable: {
      ...origFuncT,
      name: encodeUleb128Arr(origFuncT.name),
      // booleans converted to 0/1 for ULEB128 encoding; restored to boolean at decode
      isJS: encodeUleb128Arr(origFuncT.isJS.map((v) => (v ? 1 : 0))),
      relevantForJS: encodeUleb128Arr(origFuncT.relevantForJS.map((v) => (v ? 1 : 0))),
      resource: encodeSleb128Arr(origFuncT.resource), // -1 = no resource
      source: encodeSleb128NullSentinelArr(origFuncT.source, -1),
      lineNumber: encodeSleb128NullSentinelArr(origFuncT.lineNumber, -1),
      columnNumber: encodeSleb128NullSentinelArr(origFuncT.columnNumber, -1),
    },
    nativeSymbols: {
      ...origNS,
      libIndex: encodeUleb128Arr(origNS.libIndex),
      address: encodeUleb128Arr(origNS.address),
      name: encodeUleb128Arr(origNS.name),
      functionSize: encodeSleb128NullSentinelArr(origNS.functionSize, -1),
    },
    resourceTable: {
      ...origRt,
      lib: encodeSleb128NullSentinelArr(origRt.lib, -1),
      name: encodeUleb128Arr(origRt.name),
      host: encodeSleb128NullSentinelArr(origRt.host, -1),
      type: encodeUleb128Arr(origRt.type),
    },
    ...(origSources !== undefined ? {
      sources: {
        ...origSources,
        filename: encodeUleb128Arr(origSources.filename),
        startLine: encodeUleb128Arr(origSources.startLine),
        startColumn: encodeUleb128Arr(origSources.startColumn),
        sourceMapURL: origSources.sourceMapURL.every((v) => v === null)
          ? ({ $arr: 'constant-null', $length: origSources.sourceMapURL.length } as ArrWrapped)
          : encodeSleb128NullSentinelArr(origSources.sourceMapURL, -1),
        id: origSources.id.every((v) => v === null)
          ? ({ $arr: 'constant-null', $length: origSources.id.length } as ArrWrapped)
          : origSources.id,
      },
    } : {}),
  };

  // samples per thread (thread objects are new from compressMarkers, safe to mutate).
  for (const thread of cp.threads) {
    const s = thread.samples as RawSamplesTable;
    const newSamples: Record<string, unknown> = {
      ...(s as unknown as Record<string, unknown>),
    };
    if (s.time) {
      newSamples.time = encodeUleb128DeltaArr(s.time, 0.001); // scale: ms → µs integers
    }
    if (s.timeDeltas) {
      // timeDeltas values are already deltas in ms; encode as µs integers.
      newSamples.timeDeltas = encodeUleb128MsArr(s.timeDeltas);
    }
    newSamples.stack = encodeSleb128NullSentinelArr(s.stack, -1);
    if (s.threadCPUDelta) {
      newSamples.threadCPUDelta = encodeSleb128NullSentinelArr(s.threadCPUDelta, -1);
    }
    if (s.weight !== null && s.weight !== undefined) {
      // weight can be negative in diff profiles, so use sleb128
      newSamples.weight = encodeSleb128Arr(s.weight);
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
        newSamples.time = encodeUleb128DeltaArr(s.time, 0.001); // scale: ms → µs integers
      }
      if (s.count) {
        newSamples.count = encodeUleb128Arr(s.count);
      }
      if (s.number) {
        newSamples.number = encodeUleb128Arr(s.number);
      }
      return { ...counter, samples: newSamples };
    });
  }

  return cp;
}

function decodeColumns(p: unknown): unknown {
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
    if (m.allFloatFieldValues instanceof Float64Array) {
      m.allFloatFieldValues = Array.from(m.allFloatFieldValues as Float64Array);
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

  // shared.resourceTable.
  const rt = cp.shared.resourceTable as Record<string, unknown> | undefined;
  if (rt !== undefined) {
    for (const key of ['lib', 'name', 'host', 'type']) {
      if (isArrWrapped(rt[key])) {
        rt[key] = decodeArr(rt[key] as ArrWrapped);
      }
    }
  }

  // shared.sources.
  const sources = cp.shared.sources as Record<string, unknown> | undefined;
  if (sources !== undefined) {
    for (const key of ['filename', 'startLine', 'startColumn', 'sourceMapURL']) {
      if (isArrWrapped(sources[key])) {
        sources[key] = decodeArr(sources[key] as ArrWrapped);
      }
    }
    // id is string | null — only wrapped when all-null; otherwise left as raw string[].
    if (isArrWrapped(sources.id)) {
      sources.id = decodeArr(sources.id as ArrWrapped) as unknown as (string | null)[];
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

// ── Public API ─────────────────────────────────────────────────────────────

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p: unknown = compressMarkers(profile) as unknown;
  p = encodeColumns(p);
  return Jslabs.slabify(p);
}

export function uncompressProfile(buffer: Uint8Array): Profile {
  let p = Jslabs.parse(buffer);
  p = decodeColumns(p);
  return uncompressMarkers(p as any) as unknown as Profile;
}
