/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile, RawMarkerTable, RawThread } from '../../types/profile';
import type { MarkerSchema } from '../../types/markers';

/**
 * Replaces the per-marker `data` object with parallel structures:
 *
 *   schemaIndex[i]       — index into the unified markerSchema (0 means no known schema)
 *   fieldBits[i]         — bitmask encoding which data is present:
 *                            bit 0:     has an entry in extraObjects (unknown-type marker
 *                                       or overflow fields, excluding innerWindowID/cause)
 *                            bit 1:     has innerWindowID (value in allInnerWindowIDs)
 *                            bit 2:     has cause (entry in allCause* arrays)
 *                            bit k+3:   schema field at index k has a value
 *   allInnerWindowIDs    — flat array of innerWindowID values (one per bit-1 marker)
 *   allCauseStacks       — stack index per cause (number | null)
 *   allCauseTimes        — delta-encoded µs timestamps per cause (number | null)
 *   allCauseTids         — tid per cause (number | null); null when absent
 *   extraObjects         — verbatim overflow objects; one per bit-0 marker
 *   allStringFieldValues — flat array of string-table indices for string-format fields
 *   fieldStringTable     — deduplicated string pool referenced by allStringFieldValues
 *   allOtherFieldValues  — flat array for all other field types (numbers, booleans, etc.)
 *
 * schemaIndex 0 is reserved for the synthetic '__plain' schema (no fields). It is used
 * both for null-data markers (fieldBits === 0) and for markers whose type is absent from
 * the schema (bit 0 set, whole data object stored in extraObjects).
 *
 * endTime encoding:
 *   endTimeDeltaMicros is a dense delta-encoded array of integer microseconds.
 *   - Instant markers (phase 0): encodes startTime; decoded back to 0 via phase array.
 *   - IntervalStart markers (phase 2): encodes 0 delta; decoded back to null via phase array.
 *   - All other markers: encodes actual endTime.
 */
type CompressedMarkerTable = Omit<RawMarkerTable, 'data' | 'startTime' | 'endTime'> & {
  startTimeDeltaMicros: (number | null)[];
  endTimeDeltaMicros: number[];
  schemaIndex: number[];
  fieldBits: number[];
  allInnerWindowIDs: unknown[];
  allCauseStacks: (number | null)[];
  allCauseTimes: (number | null)[];
  allCauseTids: (number | null)[];
  extraObjects: unknown[];
  fieldStringTable: string[];
  allStringFieldValues: number[];
  allOtherFieldValues: unknown[];
};

const STRING_FORMATS = new Set(['string', 'url', 'sanitized-string', 'file-path']);

function isStringFormat(format: MarkerSchema['fields'][number]['format']): boolean {
  return typeof format === 'string' && STRING_FORMATS.has(format);
}

type CompressedThread = Omit<RawThread, 'markers'> & {
  markers: CompressedMarkerTable;
};

type CompressedProfile = Omit<Profile, 'threads'> & {
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

  const threads = p.threads.map((thread) => {
    const { markers } = thread;
    const markerCount = markers.length;
    const schemaIndexCol = new Array<number>(markerCount);
    const fieldBitsCol = new Array<number>(markerCount);
    const allInnerWindowIDs: unknown[] = [];
    const allCauseStacks: (number | null)[] = [];
    const allCauseTimes: (number | null)[] = [];
    const allCauseTids: (number | null)[] = [];
    const extraObjects: unknown[] = [];
    const fieldStringTable: string[] = [];
    const fieldStringMap = new Map<string, number>();
    const allStringFieldValues: number[] = [];
    const allOtherFieldValues: unknown[] = [];

    function internString(s: string): number {
      let idx = fieldStringMap.get(s);
      if (idx === undefined) {
        idx = fieldStringTable.length;
        fieldStringTable.push(s);
        fieldStringMap.set(s, idx);
      }
      return idx;
    }

    let prevCauseMicros = 0;

    // Extracts innerWindowID and cause into their dedicated arrays and pushes
    // everything else into extraObjects. Returns bits to OR into fieldBits.
    function pushSpecialAndExtra(obj: Record<string, unknown>): number {
      let bits = 0;
      const remaining: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'innerWindowID') {
          bits |= 1 << 1;
          allInnerWindowIDs.push(val);
        } else if (key === 'cause') {
          bits |= 1 << 2;
          const cause = val as Record<string, unknown>;
          const stack = cause.stack as number | null;
          const time = cause.time as number | undefined;
          const tid = cause.tid as number | undefined;
          allCauseStacks.push(stack ?? null);
          if (time !== undefined) {
            const micros = Math.round(time * 1_000);
            allCauseTimes.push(micros - prevCauseMicros);
            prevCauseMicros = micros;
          } else {
            allCauseTimes.push(null);
          }
          allCauseTids.push(tid !== undefined ? tid : null);
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
        fieldBits |= 1 << (fieldIndex + 3);
        const value = dataMap.get(field.key);
        if (isStringFormat(field.format)) {
          allStringFieldValues.push(internString(value as string));
        } else {
          allOtherFieldValues.push(value);
        }
        dataMap.delete(field.key);
      }

      if (dataMap.size !== 0) {
        fieldBits |= pushSpecialAndExtra(Object.fromEntries(dataMap));
      }

      schemaIndexCol[i] = index;
      fieldBitsCol[i] = fieldBits;
    }

    // Delta-encode startTime as integer microseconds.
    const startTimeDeltaMicros: (number | null)[] = [];
    let prevStartMicros = 0;
    for (const t of markers.startTime) {
      if (t === null) {
        startTimeDeltaMicros.push(null);
      } else {
        const micros = Math.round(t * 1_000);
        startTimeDeltaMicros.push(micros - prevStartMicros);
        prevStartMicros = micros;
      }
    }

    // Dense delta-encode endTime as integer microseconds.
    // - Instant (phase 0): store startTime so the stream stays monotonic; decoded to 0.
    // - IntervalStart (phase 2): store 0 delta (prevEndMicros unchanged); decoded to null.
    // - All others: store actual endTime.
    const endTimeDeltaMicros: number[] = [];
    let prevEndMicros = 0;
    for (let i = 0; i < markerCount; i++) {
      const phase = markers.phase[i];
      const e = markers.endTime[i];
      let effectiveMicros: number;
      if (phase === 0) {
        effectiveMicros = Math.round((markers.startTime[i] ?? 0) * 1_000);
      } else if (phase === 2) {
        effectiveMicros = prevEndMicros;
      } else {
        effectiveMicros = Math.round((e ?? 0) * 1_000);
      }
      endTimeDeltaMicros.push(effectiveMicros - prevEndMicros);
      prevEndMicros = effectiveMicros;
    }

    const newMarkers: CompressedMarkerTable = {
      name: markers.name,
      startTimeDeltaMicros,
      endTimeDeltaMicros,
      phase: markers.phase,
      category: markers.category,
      ...('threadId' in markers ? { threadId: markers.threadId } : {}),
      schemaIndex: schemaIndexCol,
      fieldBits: fieldBitsCol,
      allInnerWindowIDs,
      allCauseStacks,
      allCauseTimes,
      allCauseTids,
      extraObjects,
      fieldStringTable,
      allStringFieldValues,
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
    const { markers } = thread;
    const markerCount = markers.length;
    const {
      schemaIndex: schemaIndexCol,
      fieldBits: fieldBitsCol,
      allInnerWindowIDs,
      allCauseStacks,
      allCauseTimes,
      allCauseTids,
      extraObjects,
      endTimeDeltaMicros,
      fieldStringTable,
      allStringFieldValues,
      allOtherFieldValues,
      startTimeDeltaMicros,
      ...restMarkers
    } = markers;

    // Decode startTime.
    const startTimeNanos: (number | null)[] = [];
    let prevNanos = 0;
    for (const d of startTimeDeltaMicros) {
      if (d === null) {
        startTimeNanos.push(null);
      } else {
        prevNanos += d;
        startTimeNanos.push(prevNanos);
      }
    }
    const startTime = startTimeNanos.map((n) => (n === null ? null : n / 1_000));

    // Decode endTime, restoring sentinels from the phase array.
    const endTime: (number | null)[] = [];
    let prevEndMicros = 0;
    for (let i = 0; i < markerCount; i++) {
      prevEndMicros += endTimeDeltaMicros[i];
      const phase = restMarkers.phase[i];
      if (phase === 0) {
        endTime.push(0);
      } else if (phase === 2) {
        endTime.push(null);
      } else {
        endTime.push(prevEndMicros / 1_000);
      }
    }

    let stringValuesPtr = 0;
    let otherValuesPtr = 0;
    let innerWindowIDPtr = 0;
    let causePtr = 0;
    let extraObjPtr = 0;
    let prevCauseMicros = 0;
    const dataCol = new Array<unknown>(markerCount);

    function popCause(): Record<string, unknown> {
      const cause: Record<string, unknown> = {};
      const stack = allCauseStacks[causePtr];
      const timeDelta = allCauseTimes[causePtr];
      const tid = allCauseTids[causePtr];
      causePtr++;
      cause.stack = stack;
      if (timeDelta !== null) {
        prevCauseMicros += timeDelta;
        cause.time = prevCauseMicros / 1_000;
      }
      if (tid !== null) {
        cause.tid = tid;
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
          if (fieldBits & (1 << 1)) obj.innerWindowID = allInnerWindowIDs[innerWindowIDPtr++];
          if (fieldBits & (1 << 2)) obj.cause = popCause();
          if (fieldBits & 1) Object.assign(obj, extraObjects[extraObjPtr++]);
          dataCol[i] = obj;
        }
        continue;
      }

      const schema = p.meta.markerSchema[schemaIndex];
      const data: Record<string, unknown> = { type: schema.name };

      for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        if (fieldBits & (1 << (fieldIndex + 3))) {
          const field = schema.fields[fieldIndex];
          if (isStringFormat(field.format)) {
            data[field.key] = fieldStringTable[allStringFieldValues[stringValuesPtr++]];
          } else {
            data[field.key] = allOtherFieldValues[otherValuesPtr++];
          }
        }
      }

      if (fieldBits & (1 << 1)) data.innerWindowID = allInnerWindowIDs[innerWindowIDPtr++];
      if (fieldBits & (1 << 2)) data.cause = popCause();
      if (fieldBits & 1) Object.assign(data, extraObjects[extraObjPtr++]);

      dataCol[i] = data;
    }

    const newMarkers: RawMarkerTable = {
      ...restMarkers,
      startTime: startTime as RawMarkerTable['startTime'],
      endTime: endTime as RawMarkerTable['endTime'],
      data: dataCol as RawMarkerTable['data'],
    };

    return { ...thread, markers: newMarkers };
  });

  return { ...p, meta, threads } as Profile;
}
