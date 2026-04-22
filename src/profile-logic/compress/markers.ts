/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile, RawMarkerTable, RawThread } from '../../types/profile';
import type { MarkerSchema } from '../../types/markers';

/**
 * Replaces the per-marker `data` object with four parallel structures:
 *
 *   schemaIndex[i]  — index into the unified markerSchema (0 means no known schema)
 *   fieldBits[i]    — bitmask encoding which data is present:
 *                       bit 0:     an object in allExtraDataObjects (unknown-type marker
 *                                  or fields not listed in the schema)
 *                       bit k+1:   schema field at index k has a value in allFieldValues
 *   allFieldValues  — flat array; each set bit k+1 appends one entry, in marker order
 *   allExtraDataObjects — flat array; each set bit 0 appends one entry, in marker order
 *
 * schemaIndex 0 is reserved for the synthetic '__plain' schema (no fields). It is used
 * both for null-data markers (fieldBits === 0) and for markers whose type is absent from
 * the schema (fieldBits & 1, whole data object stored in allExtraDataObjects).
 */
type CompressedMarkerTable = Omit<RawMarkerTable, 'data'> & {
  schemaIndex: number[];
  fieldBits: number[];
  allExtraDataObjects: unknown[];
  allFieldValues: unknown[];
};

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
    // Prepend __plain at index 0 so that schemaIndex=0 means "no known schema".
    markerSchema: [PLAIN_SCHEMA, ...p.meta.markerSchema],
  };

  // Indices start at 1; 0 is reserved for __plain (markers with null/unknown data).
  const schemaByName = new Map(
    p.meta.markerSchema.map((schema, i) => [schema.name, { index: i + 1, schema }])
  );

  const threads = p.threads.map((thread) => {
    const { markers } = thread;
    const markerCount = markers.length;
    const schemaIndexCol = new Array<number>(markerCount);
    const fieldBitsCol = new Array<number>(markerCount);
    const allExtraDataObjects: unknown[] = [];
    const allFieldValues: unknown[] = [];

    for (let i = 0; i < markerCount; i++) {
      const data = markers.data[i];

      if (!data) {
        schemaIndexCol[i] = 0;
        fieldBitsCol[i] = 0;
        continue;
      }

      if (!data.type || !schemaByName.has(data.type)) {
        // Unknown type: store the whole object verbatim as an extra-data entry.
        schemaIndexCol[i] = 0;
        fieldBitsCol[i] = 1;
        allExtraDataObjects.push(data);
        continue;
      }

      const dataMap = new Map(Object.entries(data));
      const { index, schema } = schemaByName.get(data.type)!; // safe: has() checked above

      dataMap.delete('type'); // don't let 'type' spill into allExtraDataObjects

      let fieldBits = 0;
      for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        const field = schema.fields[fieldIndex];
        if (!dataMap.has(field.key)) {
          continue;
        }
        fieldBits |= 1 << (fieldIndex + 1); // +1: bit 0 is reserved for extra data
        allFieldValues.push(dataMap.get(field.key));
        dataMap.delete(field.key);
      }

      if (dataMap.size !== 0) {
        // Fields not listed in the schema (e.g. added by a newer Firefox version).
        fieldBits |= 1;
        allExtraDataObjects.push(Object.fromEntries(dataMap));
      }

      schemaIndexCol[i] = index;
      fieldBitsCol[i] = fieldBits;
    }

    const newMarkers: CompressedMarkerTable = {
      name: markers.name,
      startTime: markers.startTime,
      endTime: markers.endTime,
      phase: markers.phase,
      category: markers.category,
      ...('threadId' in markers ? { threadId: markers.threadId } : {}),
      schemaIndex: schemaIndexCol,
      fieldBits: fieldBitsCol,
      allExtraDataObjects,
      allFieldValues,
      length: markers.length,
    };

    return { ...thread, markers: newMarkers };
  });

  return { ...p, meta, threads };
}

export function uncompressMarkers(p: CompressedProfile): Profile {
  const meta = {
    ...p.meta,
    // Remove the __plain schema that was prepended during compression.
    markerSchema: p.meta.markerSchema.slice(1),
  };

  const threads = p.threads.map((thread) => {
    const { markers } = thread;
    const markerCount = markers.length;
    const {
      schemaIndex: schemaIndexCol,
      fieldBits: fieldBitsCol,
      allExtraDataObjects,
      allFieldValues,
      ...restMarkers
    } = markers;

    // These pointers advance as we consume entries from the flat arrays.
    let fieldValuesPtr = 0;
    let extraDataPtr = 0;
    const dataCol = new Array<unknown>(markerCount);

    for (let i = 0; i < markerCount; i++) {
      const schemaIndex = schemaIndexCol[i];
      const fieldBits = fieldBitsCol[i];

      if (schemaIndex === 0) {
        // Either null data (fieldBits===0) or an opaque unknown-type object (bit 0 set).
        dataCol[i] = fieldBits & 1 ? allExtraDataObjects[extraDataPtr++] : null;
        continue;
      }

      const schema = p.meta.markerSchema[schemaIndex]; // still the compressed schema (includes __plain at 0)
      const data: Record<string, unknown> = { type: schema.name };

      for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex++) {
        if (fieldBits & (1 << (fieldIndex + 1))) {
          data[schema.fields[fieldIndex].key] = allFieldValues[fieldValuesPtr++];
        }
      }

      if (fieldBits & 1) {
        Object.assign(data, allExtraDataObjects[extraDataPtr++]);
      }

      dataCol[i] = data;
    }

    const newMarkers: RawMarkerTable = {
      ...restMarkers,
      data: dataCol as RawMarkerTable['data'],
    };

    return { ...thread, markers: newMarkers };
  });

  return { ...p, meta, threads } as Profile;
}
