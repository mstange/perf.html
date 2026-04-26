/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile, RawMarkerTable, RawThread } from '../../types/profile';
import type { MarkerPhase } from '../../types/gecko-profile';
import type { MarkerSchema } from '../../types/markers';

/**
 * Compressed marker table. All integer columns use delta encoding (stored value
 * is the difference from the previous entry); columns renamed *DeltaValues to
 * make this explicit. Sparse columns store only non-default positions.
 *
 * fieldBits bitmask:
 *   bit 0:   has entry in extraObjects (overflow fields excluding innerWindowID/cause)
 *   bit 1:   has innerWindowID → index in allPageIndexDeltas
 *   bit 2:   has cause → entry in allCause* arrays
 *   bit 3:   cause.stack is non-null  (only meaningful when bit 2 set)
 *   bit 4:   cause.time is defined    (only meaningful when bit 2 set)
 *   bit 5:   cause.tid is defined     (only meaningful when bit 2 set)
 *   bit k+6: schema field k is present
 *
 * startTime encoding (dense delta µs):
 *   phase 3 (IntervalEnd): encodes endTime; decoded back to null via phase.
 *   all others:            encodes actual startTime.
 *
 * endTime encoding (dense delta µs):
 *   phase 0 (Instant):       encodes startTime; decoded back to 0 via phase.
 *   phase 2 (IntervalStart): encodes 0 delta; decoded back to null via phase.
 *   all others:              encodes actual endTime.
 *
 * category encoding:
 *   schemaDefaultCategories[schemaIndex] = most common category for that schema.
 *   Sparse overrides stored in categoryOverride* arrays.
 */
type CompressedMarkerTable = Omit<
  RawMarkerTable,
  'data' | 'startTime' | 'endTime' | 'category' | 'name' | 'phase'
> & {
  nameDeltaValues: number[];
  startTimeDeltaNanos: number[];
  endTimeDeltaNanos: number[];
  // phase: default 0 (Instant); non-zero stored sparsely.
  phaseNonZeroIndexDeltas: number[];
  phaseNonZeroValues: number[];
  schemaIndexDeltaValues: number[];
  innerWindowIDIsPageIndex: boolean;
  allPageIndexDeltas: number[];
  allCauseStacks: number[];
  allCauseTimes: number[];
  allCauseTids: number[];
  extraObjects: unknown[];
  schemaDefaultCategories: number[];
  categoryOverrideIndexDeltas: number[];
  categoryOverrideValues: number[];
  fieldStringTable: string[];
  allStringFieldValues: number[];
  fieldBits: number[];
  // allTimeFieldValues: delta-encoded ns for schema fields with format === 'time'.
  allTimeFieldValues: number[];
  allIntegerFieldValues: number[];
  allFloatFieldValues: number[];
  allOtherFieldValues: unknown[];
};

const STRING_FORMATS = new Set(['string', 'url', 'sanitized-string', 'file-path']);
const INTEGER_FORMATS = new Set([
  'integer', 'bytes', 'unique-string', 'flow-id', 'terminating-flow-id',
]);
const FLOAT_FORMATS = new Set([
  'duration', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds',
  'percentage', 'decimal',
]);

function isStringFormat(format: MarkerSchema['fields'][number]['format']): boolean {
  return typeof format === 'string' && STRING_FORMATS.has(format);
}
function isIntegerFormat(format: MarkerSchema['fields'][number]['format']): boolean {
  return typeof format === 'string' && INTEGER_FORMATS.has(format);
}
function isFloatFormat(format: MarkerSchema['fields'][number]['format']): boolean {
  return typeof format === 'string' && FLOAT_FORMATS.has(format);
}

type CompressedThread = Omit<RawThread, 'markers'> & {
  markers: CompressedMarkerTable | null; // null when original markers.length === 0
};

export type CompressedProfile = Omit<Profile, 'threads'> & {
  threads: CompressedThread[];
};

const PLAIN_SCHEMA: MarkerSchema = {
  name: '__plain',
  display: [],
  fields: [],
};

export function compressMarkers(p: Profile): CompressedProfile {
  const meta = {
    ...p.meta,
    markerSchema: [PLAIN_SCHEMA, ...p.meta.markerSchema],
  };

  const schemaByName = new Map(
    p.meta.markerSchema.map((schema, i) => [schema.name, { index: i + 1, schema }])
  );

  // Build innerWindowID → pageIndex lookup once for all threads.
  const pageIndexByInnerWindowID = new Map<number, number>();
  if (p.pages) {
    for (let pi = 0; pi < p.pages.length; pi++) {
      pageIndexByInnerWindowID.set(p.pages[pi].innerWindowID, pi);
    }
  }
  const innerWindowIDIsPageIndex = pageIndexByInnerWindowID.size > 0;

  const threads = p.threads.map((thread) => {
    const { markers } = thread;
    if (markers.length === 0) {
      return { ...thread, markers: null };
    }
    const markerCount = markers.length;
    const schemaIndexCol = new Array<number>(markerCount);
    const fieldBitsCol = new Array<number>(markerCount);
    const allPageIndexDeltas: number[] = [];
    const allCauseStacks: number[] = [];
    const allCauseTimes: number[] = [];
    const allCauseTids: number[] = [];
    const extraObjects: unknown[] = [];
    const fieldStringTable: string[] = [];
    const fieldStringMap = new Map<string, number>();
    const allStringFieldValues: number[] = [];
    const allTimeFieldValues: number[] = [];
    const allIntegerFieldValues: number[] = [];
    const allFloatFieldValues: number[] = [];
    const allOtherFieldValues: unknown[] = [];

    let prevPageIndex = 0;
    let prevCauseNanos = 0;
    let prevTimeFieldNanos = 0;

    function internString(s: string): number {
      let idx = fieldStringMap.get(s);
      if (idx === undefined) {
        idx = fieldStringTable.length;
        fieldStringTable.push(s);
        fieldStringMap.set(s, idx);
      }
      return idx;
    }

    function pushFieldValue(
      format: MarkerSchema['fields'][number]['format'],
      value: unknown
    ): void {
      if (isStringFormat(format)) {
        allStringFieldValues.push(internString(value as string));
      } else if (format === 'time') {
        const nanos = Math.round((value as number) * 1_000_000);
        allTimeFieldValues.push(nanos - prevTimeFieldNanos);
        prevTimeFieldNanos = nanos;
      } else if (isIntegerFormat(format)) {
        allIntegerFieldValues.push(value as number);
      } else if (isFloatFormat(format)) {
        allFloatFieldValues.push(value as number);
      } else {
        allOtherFieldValues.push(value);
      }
    }

    // Extracts innerWindowID and cause into dedicated arrays; pushes everything
    // else into extraObjects. Returns bits to OR into fieldBits.
    function pushSpecialAndExtra(obj: Record<string, unknown>): number {
      let bits = 0;
      const remaining: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'innerWindowID') {
          bits |= 1 << 1;
          const iwid = val as number;
          const pageIdx = innerWindowIDIsPageIndex
            ? (pageIndexByInnerWindowID.get(iwid) ?? iwid)
            : iwid;
          allPageIndexDeltas.push(pageIdx - prevPageIndex);
          prevPageIndex = pageIdx;
        } else if (key === 'cause') {
          bits |= 1 << 2;
          const cause = val as Record<string, unknown>;
          const stack = cause.stack as number | null;
          const time = cause.time as number | undefined;
          const tid = cause.tid as number | undefined;
          if (stack !== null) { bits |= 1 << 3; allCauseStacks.push(stack); }
          if (time !== undefined) {
            bits |= 1 << 4;
            const nanos = Math.round(time * 1_000_000);
            allCauseTimes.push(nanos - prevCauseNanos);
            prevCauseNanos = nanos;
          }
          if (tid !== undefined) { bits |= 1 << 5; allCauseTids.push(tid); }
        } else {
          remaining[key] = val;
        }
      }
      if (Object.keys(remaining).length > 0) {
        bits |= 1;
        extraObjects.push(remaining);
      }
      return bits;
    }

    for (let i = 0; i < markerCount; i++) {
      const data = markers.data[i];

      if (!data) {
        schemaIndexCol[i] = 0;
        fieldBitsCol[i] = 0;
        continue;
      }

      if (!data.type || !schemaByName.has(data.type)) {
        schemaIndexCol[i] = 0;
        fieldBitsCol[i] = pushSpecialAndExtra(data as Record<string, unknown>);
        continue;
      }

      const dataMap = new Map(Object.entries(data));
      const { index, schema } = schemaByName.get(data.type)!;

      dataMap.delete('type');

      let fieldBits = 0;
      for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        const field = schema.fields[fieldIndex];
        if (!dataMap.has(field.key)) {
          continue;
        }
        fieldBits |= 1 << (fieldIndex + 6);
        pushFieldValue(field.format, dataMap.get(field.key));
        dataMap.delete(field.key);
      }

      if (dataMap.size !== 0) {
        fieldBits |= pushSpecialAndExtra(Object.fromEntries(dataMap));
      }

      schemaIndexCol[i] = index;
      fieldBitsCol[i] = fieldBits;
    }

    // Delta-encode name (string table indices).
    const nameDeltaValues: number[] = [];
    let prevName = 0;
    for (const n of markers.name) {
      nameDeltaValues.push(n - prevName);
      prevName = n;
    }

    // Compute per-schema default category (most common category for each schema).
    const numSchemas = meta.markerSchema.length;
    const schemaCategoryFreq: Map<number, number>[] = Array.from(
      { length: numSchemas },
      () => new Map()
    );
    for (let i = 0; i < markerCount; i++) {
      const freq = schemaCategoryFreq[schemaIndexCol[i]];
      const cat = markers.category[i];
      freq.set(cat, (freq.get(cat) ?? 0) + 1);
    }
    const schemaDefaultCategories: number[] = schemaCategoryFreq.map((freq) => {
      let bestCat = 0;
      let bestCount = 0;
      for (const [cat, count] of freq) {
        if (count > bestCount) {
          bestCat = cat;
          bestCount = count;
        }
      }
      return bestCat;
    });

    // Sparse-encode category overrides.
    const categoryOverrideIndexDeltas: number[] = [];
    const categoryOverrideValues: number[] = [];
    let prevOverrideIdx = 0;
    for (let i = 0; i < markerCount; i++) {
      const actual = markers.category[i];
      if (actual !== schemaDefaultCategories[schemaIndexCol[i]]) {
        categoryOverrideIndexDeltas.push(i - prevOverrideIdx);
        categoryOverrideValues.push(actual);
        prevOverrideIdx = i;
      }
    }

    // Sparse-encode phase (default 0 = Instant).
    const phaseNonZeroIndexDeltas: number[] = [];
    const phaseNonZeroValues: number[] = [];
    let prevPhaseIdx = 0;
    for (let i = 0; i < markerCount; i++) {
      const ph = markers.phase[i];
      if (ph !== 0) {
        phaseNonZeroIndexDeltas.push(i - prevPhaseIdx);
        phaseNonZeroValues.push(ph);
        prevPhaseIdx = i;
      }
    }

    // Delta-encode schemaIndex.
    const schemaIndexDeltaValues: number[] = [];
    let prevSI = 0;
    for (let i = 0; i < markerCount; i++) {
      schemaIndexDeltaValues.push(schemaIndexCol[i] - prevSI);
      prevSI = schemaIndexCol[i];
    }

    // Delta-encode startTime as integer nanoseconds.
    // Phase 3 (IntervalEnd) has startTime = null; encode endTime instead so deltas stay small.
    const startTimeDeltaNanos: number[] = [];
    let prevStartNanos = 0;
    for (let i = 0; i < markerCount; i++) {
      const t = markers.startTime[i];
      const effectiveNanos =
        t === null
          ? Math.round((markers.endTime[i] ?? 0) * 1_000_000)
          : Math.round(t * 1_000_000);
      startTimeDeltaNanos.push(effectiveNanos - prevStartNanos);
      prevStartNanos = effectiveNanos;
    }

    // Dense delta-encode endTime. Phase 0 → store startTime; phase 2 → 0 delta.
    const endTimeDeltaNanos: number[] = [];
    let prevEndNanos = 0;
    for (let i = 0; i < markerCount; i++) {
      const phase = markers.phase[i];
      const e = markers.endTime[i];
      let effectiveNanos: number;
      if (phase === 0) {
        effectiveNanos = Math.round((markers.startTime[i] ?? 0) * 1_000_000);
      } else if (phase === 2) {
        effectiveNanos = prevEndNanos;
      } else {
        effectiveNanos = Math.round((e ?? 0) * 1_000_000);
      }
      endTimeDeltaNanos.push(effectiveNanos - prevEndNanos);
      prevEndNanos = effectiveNanos;
    }

    const newMarkers: CompressedMarkerTable = {
      nameDeltaValues,
      startTimeDeltaNanos,
      endTimeDeltaNanos,
      phaseNonZeroIndexDeltas,
      phaseNonZeroValues,
      ...('threadId' in markers ? { threadId: markers.threadId } : {}),
      schemaIndexDeltaValues,
      fieldBits: fieldBitsCol,
      innerWindowIDIsPageIndex,
      allPageIndexDeltas,
      allCauseStacks,
      allCauseTimes,
      allCauseTids,
      extraObjects,
      schemaDefaultCategories,
      categoryOverrideIndexDeltas,
      categoryOverrideValues,
      fieldStringTable,
      allStringFieldValues,
      allTimeFieldValues,
      allIntegerFieldValues,
      allFloatFieldValues,
      allOtherFieldValues,
      length: markers.length,
    };

    return { ...thread, markers: newMarkers };
  });

  return { ...p, meta, threads };
}

export function uncompressMarkers(p: CompressedProfile): Profile {
  const meta = {
    ...p.meta,
    markerSchema: p.meta.markerSchema.slice(1),
  };

  const threads = p.threads.map((thread) => {
    if (thread.markers === null) {
      const emptyMarkers: RawMarkerTable = {
        name: [],
        startTime: [],
        endTime: [],
        phase: [],
        data: [],
        category: [],
        length: 0,
      };
      return { ...thread, markers: emptyMarkers };
    }
    const { markers } = thread;
    const markerCount = markers.length;
    const {
      nameDeltaValues,
      schemaIndexDeltaValues,
      fieldBits: fieldBitsCol,
      phaseNonZeroIndexDeltas,
      phaseNonZeroValues,
      innerWindowIDIsPageIndex,
      allPageIndexDeltas,
      allCauseStacks,
      allCauseTimes,
      allCauseTids,
      extraObjects,
      schemaDefaultCategories,
      categoryOverrideIndexDeltas,
      categoryOverrideValues,
      endTimeDeltaNanos,
      fieldStringTable,
      allStringFieldValues,
      allTimeFieldValues,
      allIntegerFieldValues,
      allFloatFieldValues,
      allOtherFieldValues,
      startTimeDeltaNanos,
      ...restMarkers
    } = markers;

    // Decode name.
    const name: number[] = [];
    let prevName = 0;
    for (const d of nameDeltaValues) {
      prevName += d;
      name.push(prevName);
    }

    // Decode schemaIndex.
    const schemaIndexCol: number[] = [];
    let prevSI = 0;
    for (let i = 0; i < markerCount; i++) {
      prevSI += schemaIndexDeltaValues[i];
      schemaIndexCol.push(prevSI);
    }

    // Decode phase (default 0).
    const phase: MarkerPhase[] = new Array(markerCount).fill(0);
    let phaseCursor = 0;
    for (let k = 0; k < phaseNonZeroIndexDeltas.length; k++) {
      phaseCursor += phaseNonZeroIndexDeltas[k];
      phase[phaseCursor] = phaseNonZeroValues[k] as MarkerPhase;
    }

    // Resolve page index deltas back to innerWindowIDs.
    const resolvedInnerWindowIDs: unknown[] = [];
    let prevPageIndex = 0;
    for (const d of allPageIndexDeltas) {
      prevPageIndex += d;
      resolvedInnerWindowIDs.push(
        innerWindowIDIsPageIndex && p.pages
          ? p.pages[prevPageIndex].innerWindowID
          : prevPageIndex
      );
    }

    // Decode category: fill from schema defaults, then apply sparse overrides.
    const category: number[] = Array.from(
      { length: markerCount },
      (_, i) => schemaDefaultCategories[schemaIndexCol[i]]
    );
    let overrideCursor = 0;
    for (let k = 0; k < categoryOverrideIndexDeltas.length; k++) {
      overrideCursor += categoryOverrideIndexDeltas[k];
      category[overrideCursor] = categoryOverrideValues[k];
    }

    // Decode startTime. Phase 3 (IntervalEnd) encoded endTime here; recover null via phase.
    const startTime: (number | null)[] = [];
    let prevStartNanos = 0;
    for (let i = 0; i < markerCount; i++) {
      prevStartNanos += startTimeDeltaNanos[i];
      startTime.push(phase[i] === 3 ? null : prevStartNanos / 1_000_000);
    }

    // Decode endTime, restoring sentinels from phase.
    const endTime: (number | null)[] = [];
    let prevEndNanos = 0;
    for (let i = 0; i < markerCount; i++) {
      prevEndNanos += endTimeDeltaNanos[i];
      if (phase[i] === 0) {
        endTime.push(0);
      } else if (phase[i] === 2) {
        endTime.push(null);
      } else {
        endTime.push(prevEndNanos / 1_000_000);
      }
    }

    let stringValuesPtr = 0;
    let timeValuesPtr = 0;
    let integerValuesPtr = 0;
    let floatValuesPtr = 0;
    let otherValuesPtr = 0;
    let innerWindowIDPtr = 0;
    let causeStackPtr = 0;
    let causeTimePtr = 0;
    let causeTidPtr = 0;
    let extraObjPtr = 0;

    let prevCauseNanos = 0;
    let prevTimeFieldNanos = 0;
    const dataCol = new Array<unknown>(markerCount);

    function popFieldValue(
      format: MarkerSchema['fields'][number]['format']
    ): unknown {
      if (isStringFormat(format)) {
        return fieldStringTable[allStringFieldValues[stringValuesPtr++]];
      } else if (format === 'time') {
        prevTimeFieldNanos += allTimeFieldValues[timeValuesPtr++];
        return prevTimeFieldNanos / 1_000_000;
      } else if (isIntegerFormat(format)) {
        return allIntegerFieldValues[integerValuesPtr++];
      } else if (isFloatFormat(format)) {
        return allFloatFieldValues[floatValuesPtr++];
      }
      return allOtherFieldValues[otherValuesPtr++];
    }

    function popCause(fieldBits: number): Record<string, unknown> {
      const cause: Record<string, unknown> = {};
      cause.stack = (fieldBits & (1 << 3)) ? allCauseStacks[causeStackPtr++] : null;
      if (fieldBits & (1 << 4)) {
        prevCauseNanos += allCauseTimes[causeTimePtr++];
        cause.time = prevCauseNanos / 1_000_000;
      }
      if (fieldBits & (1 << 5)) {
        cause.tid = allCauseTids[causeTidPtr++];
      }
      return cause;
    }

    for (let i = 0; i < markerCount; i++) {
      const schemaIndex = schemaIndexCol[i];
      const fieldBits = fieldBitsCol[i];

      if (schemaIndex === 0) {
        if (fieldBits === 0) {
          dataCol[i] = null;
        } else {
          const obj: Record<string, unknown> = {};
          if (fieldBits & (1 << 1)) obj.innerWindowID = resolvedInnerWindowIDs[innerWindowIDPtr++];
          if (fieldBits & (1 << 2)) obj.cause = popCause(fieldBits);
          if (fieldBits & 1) Object.assign(obj, extraObjects[extraObjPtr++]);
          dataCol[i] = obj;
        }
        continue;
      }

      const schema = p.meta.markerSchema[schemaIndex];
      const data: Record<string, unknown> = { type: schema.name };

      for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        if (fieldBits & (1 << (fieldIndex + 6))) {
          const field = schema.fields[fieldIndex];
          data[field.key] = popFieldValue(field.format);
        }
      }

      if (fieldBits & (1 << 1)) data.innerWindowID = resolvedInnerWindowIDs[innerWindowIDPtr++];
      if (fieldBits & (1 << 2)) data.cause = popCause(fieldBits);
      if (fieldBits & 1) Object.assign(data, extraObjects[extraObjPtr++]);

      dataCol[i] = data;
    }

    const newMarkers: RawMarkerTable = {
      ...restMarkers,
      name: name as RawMarkerTable['name'],
      phase: phase as RawMarkerTable['phase'],
      category: category as RawMarkerTable['category'],
      startTime: startTime as RawMarkerTable['startTime'],
      endTime: endTime as RawMarkerTable['endTime'],
      data: dataCol as RawMarkerTable['data'],
    };

    return { ...thread, markers: newMarkers };
  });

  return { ...p, meta, threads } as Profile;
}
