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
import * as JsonSlabs from 'json-slabs';
import { ByteWriter, ByteReader } from './byte-io';

// ── Encoded array type ──────────────────────────────────────────────────────

type ArrWrapped =
  // leb128: unsigned (default) or signed ($signed), optional delta-decode ($delta),
  // optional post-scale ($scale), optional sentinel substitutions:
  //   $nullSentinel: this raw integer decodes as null
  //   $prevIndexSentinel: this raw integer decodes as i-1 (the previous index)
  // Sentinels are checked before $scale; combining sentinels with $delta is not supported
  // (a sentinel value would be ambiguous with a real delta).
  // Covers uleb128, sleb128, ms-float, delta, null-sentinel, and prev-index variants.
  | { $arr: 'leb128'; $length: number; $signed?: true; $delta?: true; $scale?: number;
      $nullSentinel?: number; $prevIndexSentinel?: number; $values: Uint8Array }
  | { $arr: 'constant-null'; $length: number } // all values are null — no $values needed
  // sparse-float64: nullable float arrays where most entries are null. $indices is itself
  // an ArrWrapped (uleb128-delta) listing the positions of non-null values; $values is a
  // Float64Array of the non-null values in the same order.
  | { $arr: 'sparse-float64'; $length: number; $indices: ArrWrapped; $values: Float64Array };

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

function decodeULEB128(bytes: Uint8Array, length: number): number[] {
  const r = new ByteReader(bytes);
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) out[i] = r.readULEB128();
  return out;
}

function decodeSLEB128(bytes: Uint8Array, length: number): number[] {
  const r = new ByteReader(bytes);
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) out[i] = r.readSLEB128();
  return out;
}

// ── Per-encoding encode functions ───────────────────────────────────────────

function encodeUleb128Arr(values: number[]): ArrWrapped {
  return { $arr: 'leb128', $length: values.length, $values: encodeULEB128(values) };
}

function encodeSleb128Arr(values: number[]): ArrWrapped {
  return { $arr: 'leb128', $length: values.length, $signed: true, $values: encodeSLEB128(values) };
}

function encodeUleb128MsArr(values: number[]): ArrWrapped {
  return { $arr: 'leb128', $length: values.length, $scale: 1e-6, $values: encodeULEB128(values.map((v) => Math.round(v * 1_000_000))) };
}

function encodeUleb128DeltaArr(values: number[], scale: number = 1): ArrWrapped {
  const deltas: number[] = [];
  let prev = 0;
  for (const v of values) {
    deltas.push(Math.round((v - prev) / scale));
    prev = v;
  }
  return {
    $arr: 'leb128',
    $length: values.length,
    $delta: true,
    ...(scale !== 1 && { $scale: scale }),
    $values: encodeULEB128(deltas),
  };
}

function encodeSleb128DeltaArr(values: number[]): ArrWrapped {
  const deltas: number[] = [];
  let prev = 0;
  for (const v of values) { deltas.push(v - prev); prev = v; }
  return { $arr: 'leb128', $length: values.length, $signed: true, $delta: true, $values: encodeSLEB128(deltas) };
}

function encodeSleb128NullSentinelArr(
  values: (number | null)[],
  sentinel: number
): ArrWrapped {
  return {
    $arr: 'leb128',
    $length: values.length,
    $signed: true,
    $nullSentinel: sentinel,
    $values: encodeSLEB128(values.map((v) => (v === null ? sentinel : v))),
  };
}

// Picks the most compact encoding for a nullable float array:
//   all null         → constant-null (no $values, ~free)
//   mostly null      → sparse-float64: indices of non-null entries + Float64Array of values
//   otherwise        → leave as JSON. Float64 binary slabs gzip poorly (random-looking
//                      bytes), and JSON numbers are reasonably compact and gzip well; only
//                      mostly-null arrays benefit from binary encoding after gzip.
function encodeNullableFloatArr(
  values: (number | null)[]
): ArrWrapped | (number | null)[] {
  let nullCount = 0;
  for (const v of values) if (v === null) nullCount++;
  if (nullCount === values.length) {
    return { $arr: 'constant-null', $length: values.length };
  }
  // Threshold: only sparse-encode when nulls dominate. Below this, JSON gzips better than
  // a Float64Array slab and the index overhead eats much of the raw-size win.
  if (nullCount * 2 < values.length) {
    return values;
  }
  const indices: number[] = [];
  const nonNulls: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null) {
      indices.push(i);
      nonNulls.push(v);
    }
  }
  return {
    $arr: 'sparse-float64',
    $length: values.length,
    $indices: encodeUleb128DeltaArr(indices),
    $values: new Float64Array(nonNulls),
  };
}

function decodeNullableFloatArr(v: unknown): (number | null)[] {
  if (isArrWrapped(v)) return decodeArr(v);
  return v as (number | null)[];
}

function encodeSleb128PrevIndexArr(
  values: (number | null)[],
  nullSentinel: number,
  prevIndexSentinel: number
): ArrWrapped {
  const mapped: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    mapped.push(v === null ? nullSentinel : v === i - 1 ? prevIndexSentinel : v);
  }
  return {
    $arr: 'leb128',
    $length: values.length,
    $signed: true,
    $nullSentinel: nullSentinel,
    $prevIndexSentinel: prevIndexSentinel,
    $values: encodeSLEB128(mapped),
  };
}

function decodeArr(w: ArrWrapped): number[] | (number | null)[] {
  switch (w.$arr) {
    case 'leb128': {
      const raw = w.$signed
        ? decodeSLEB128(w.$values, w.$length)
        : decodeULEB128(w.$values, w.$length);
      if (w.$delta) {
        for (let i = 1; i < raw.length; i++) raw[i] += raw[i - 1];
      }
      const ns = w.$nullSentinel;
      const ps = w.$prevIndexSentinel;
      const scale = w.$scale;
      if (ns !== undefined || ps !== undefined) {
        return raw.map((v, i) => {
          if (v === ns) return null;
          if (v === ps) return i - 1;
          return scale !== undefined ? v * scale : v;
        });
      }
      return scale !== undefined ? raw.map((v) => v * scale) : raw;
    }
    case 'constant-null':
      return Array(w.$length).fill(null);
    case 'sparse-float64': {
      const indices = decodeArr(w.$indices) as number[];
      const result: (number | null)[] = new Array(w.$length).fill(null);
      const vals = w.$values;
      for (let i = 0; i < indices.length; i++) {
        result[indices[i]] = vals[i];
      }
      return result;
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

// ── Column encoding: number[] ↔ { $arr, $values } ──────────────────────────

const MARKER_ARRAY_ENCODINGS: Record<string, (values: number[]) => ArrWrapped> = {
  startTimeDeltaNanos:     encodeSleb128Arr,      // pre-delta in markers.ts (phase-aware)
  endTimeDeltaNanos:       encodeSleb128Arr,      // pre-delta in markers.ts (phase-aware)
  allStringFieldValues:    encodeUleb128Arr,
  fieldBits:               encodeUleb128Arr,
  allTimeFieldValues:      encodeSleb128DeltaArr, // raw nanos → delta here
  phaseNonZeroIndexes:     encodeUleb128DeltaArr, // raw indices → delta here
  phaseNonZeroValues:      encodeUleb128Arr,
  categoryOverrideIndexes: encodeUleb128DeltaArr, // raw indices → delta here
  categoryOverrideValues:  encodeUleb128Arr,
  allCauseStacks:          encodeUleb128Arr,
  allCauseTimes:           encodeSleb128DeltaArr, // raw nanos → delta here
  allCauseTids:            encodeUleb128Arr,
  nameValues:              encodeSleb128DeltaArr, // raw indices → delta here
  schemaIndexValues:       encodeSleb128DeltaArr, // raw indices → delta here
  allPageIndexes:          encodeSleb128DeltaArr, // raw indices → delta here
  allIntegerFieldValues:   encodeSleb128Arr,
};

function encodeColumns(p: unknown): unknown {
  const cp = p as CompressedProfile;

  // Marker arrays (null means zero-length marker table — skip encoding).
  // Empty arrays are omitted entirely; decodeColumns restores them as [].
  for (const thread of cp.threads) {
    if (thread.markers === null) continue;
    const m = thread.markers as Record<string, unknown>;
    for (const [key, encode] of Object.entries(MARKER_ARRAY_ENCODINGS)) {
      const arr = m[key] as number[];
      if (arr.length === 0) {
        delete m[key];
      } else {
        m[key] = encode(arr);
      }
    }
    const strTable = m.fieldStringTable as string[];
    if (strTable.length > 0) {
      m.fieldStringTable = encodeStringArray(strTable);
    } else {
      delete m.fieldStringTable;
    }
    const floats = m.allFloatFieldValues as number[];
    if (floats.length > 0) {
      m.allFloatFieldValues = new Float64Array(floats);
    } else {
      delete m.allFloatFieldValues;
    }
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
      // sleb128-delta: deltas can be negative (consecutive stacks often
      // reference different frames). Saves ~30% over plain uleb128.
      frame: encodeSleb128DeltaArr(origSt.frame),
      // prev-index encoding: prefix[i]=i-1 (very common in consecutive-stack appends)
      // is stored as a 1-byte sentinel instead of the actual large index value.
      prefix: encodeSleb128PrevIndexArr(origSt.prefix, -1, -2),
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
      newSamples.time = encodeUleb128DeltaArr(s.time, 1e-6); // scale: ms → ns integers
    }
    if (s.timeDeltas) {
      // timeDeltas values are already deltas in ms; encode as ns integers.
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
    if (s.eventDelay !== undefined) {
      newSamples.eventDelay = encodeNullableFloatArr(s.eventDelay);
    }
    if (s.responsiveness !== undefined) {
      newSamples.responsiveness = encodeNullableFloatArr(s.responsiveness);
    }
    if (s.argumentValues !== undefined) {
      newSamples.argumentValues = encodeNullableFloatArr(s.argumentValues);
    }
    (thread as unknown as Record<string, unknown>).samples = newSamples;
  }

  // counters[i].samples — create new counter+samples objects to avoid mutating the original.
  const counters = (cpa.counters ?? []) as Array<{
    samples: {
      time?: number[];
      timeDeltas?: number[];
      count?: number[];
      number?: number[];
      argumentValues?: (number | null)[];
    };
  }>;
  if (cpa.counters !== undefined) {
    cpa.counters = counters.map((counter) => {
      const s = counter.samples;
      const newSamples: Record<string, unknown> = { ...s };
      if (s.time) {
        newSamples.time = encodeUleb128DeltaArr(s.time, 1e-6); // scale: ms → ns integers
      }
      if (s.timeDeltas) {
        // timeDeltas values are already deltas in ms; encode as ns integers.
        newSamples.timeDeltas = encodeUleb128MsArr(s.timeDeltas);
      }
      if (s.count) {
        newSamples.count = encodeSleb128Arr(s.count);
      }
      if (s.number) {
        newSamples.number = encodeUleb128Arr(s.number);
      }
      if (s.argumentValues !== undefined) {
        newSamples.argumentValues = encodeNullableFloatArr(s.argumentValues);
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

  // Marker arrays (null means zero-length marker table — skip decoding).
  // Absent keys were empty arrays at encode time; restore them as [].
  for (const thread of cp.threads) {
    if (thread.markers === null) continue;
    const m = thread.markers;
    for (const key of Object.keys(MARKER_ARRAY_ENCODINGS)) {
      if (isArrWrapped(m[key])) {
        m[key] = decodeArr(m[key] as ArrWrapped);
      } else {
        m[key] = [];
      }
    }
    if (isEncodedStringArray(m.fieldStringTable)) {
      m.fieldStringTable = decodeStringArray(m.fieldStringTable);
    } else {
      m.fieldStringTable = [];
    }
    if (m.allFloatFieldValues instanceof Float64Array) {
      m.allFloatFieldValues = Array.from(m.allFloatFieldValues as Float64Array);
    } else {
      m.allFloatFieldValues = [];
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
    if (s.eventDelay !== undefined) {
      s.eventDelay = decodeNullableFloatArr(s.eventDelay);
    }
    if (s.responsiveness !== undefined) {
      s.responsiveness = decodeNullableFloatArr(s.responsiveness);
    }
    if (s.argumentValues !== undefined) {
      s.argumentValues = decodeNullableFloatArr(s.argumentValues);
    }
  }

  // counters[i].samples.
  for (const counter of cp.counters ?? []) {
    const s = counter.samples;
    if (isArrWrapped(s.time)) {
      s.time = decodeArr(s.time);
    }
    if (isArrWrapped(s.timeDeltas)) {
      s.timeDeltas = decodeArr(s.timeDeltas);
    }
    if (isArrWrapped(s.count)) {
      s.count = decodeArr(s.count);
    }
    if (isArrWrapped(s.number)) {
      s.number = decodeArr(s.number);
    }
    if (s.argumentValues !== undefined) {
      s.argumentValues = decodeNullableFloatArr(s.argumentValues);
    }
  }

  return cp;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p: unknown = compressMarkers(profile) as unknown;
  p = encodeColumns(p);
  return JsonSlabs.slabify(p);
}

export function uncompressProfile(buffer: Uint8Array): Profile {
  let p = JsonSlabs.parse(buffer);
  p = decodeColumns(p);
  return uncompressMarkers(p as any) as unknown as Profile;
}
