/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  GECKO_PROFILE_VERSION,
  PROCESSED_PROFILE_VERSION,
} from '../app-logic/constants';

import type {
  RawProfileSharedData,
  RawThread,
  RawSamplesTable,
  RawFrameTable,
  RawStackTable,
  RawJsAllocationsTable,
  RawUnbalancedNativeAllocationsTable,
  RawBalancedNativeAllocationsTable,
  RawFuncTable,
  RawMarkerTable,
  RawResourceTable,
  ResourceType,
  NativeSymbolTable,
  RawNativeSymbolTable,
  Profile,
  ExtensionTable,
  CategoryList,
  JsTracerTable,
  CallNodeTable,
  SourceTable,
  RawSourceLocationTable,
  IndexIntoFrameTable,
  IndexIntoFuncTable,
  IndexIntoLibs,
  IndexIntoResourceTable,
  IndexIntoSourceTable,
  IndexIntoStackTable,
  IndexIntoStringTable,
  IndexIntoCategoryList,
  IndexIntoSubcategoryListForCategory,
  IndexIntoNativeSymbolTable,
  IndexIntoSourceLocationTable,
  InnerWindowID,
  Address,
  Bytes,
  Milliseconds,
  Tid,
  MarkerPhase,
  MarkerPayload,
  WeightType,
} from 'firefox-profiler/types';

import {
  toInt32ArraySetNullToNegOne,
  toFloat64ArraySetNullToNaN,
} from '../utils/typed-arrays';

/**
 * Builder-variants of various tables. The columns here use plain
 * arrays so that elements can be added one-by-one by pushing to
 * the column arrays.
 *
 * The "raw" variants of these arrays (i.e. what's stored in the
 * profile files) may be using typed arrays for some of the columns,
 * and you can't push to a typed array.
 */
export type RawSamplesTableBuilder = {
  responsiveness?: Array<Milliseconds | null>;
  eventDelay?: Array<Milliseconds | null>;
  stack: Array<IndexIntoStackTable | null>;
  time?: Milliseconds[];
  timeDeltas?: Milliseconds[];
  // See `RawSamplesTable.argumentValues` for the encoding (`-1` for "no
  // data", `-2` / `-3` for the Firefox magic constants, `>= 0` for buffer
  // indices).
  argumentValues?: number[];
  weight: null | number[];
  weightType: WeightType;
  threadCPUDelta?: Array<number | null>;
  threadId?: Tid[];
  length: number;
};

export type RawMarkerTableBuilder = {
  data: Array<MarkerPayload | null>;
  name: IndexIntoStringTable[];
  startTime: Array<Milliseconds | null>;
  endTime: Array<Milliseconds | null>;
  phase: MarkerPhase[];
  category: IndexIntoCategoryList[];
  threadId?: Array<Tid | null>;
  length: number;
};

export type SourceTableBuilder = {
  id: Array<string | null>;
  filename: IndexIntoStringTable[];
  startLine: number[];
  startColumn: number[];
  sourceMapURL: Array<IndexIntoStringTable | null>;
  content: Array<string | null>;
  length: number;
};

export type RawJsAllocationsTableBuilder = {
  time: Milliseconds[];
  className: string[];
  typeName: string[];
  coarseType: string[];
  weight: Bytes[];
  weightType: 'bytes';
  inNursery: boolean[];
  stack: Array<IndexIntoStackTable | null>;
  length: number;
};

export type RawUnbalancedNativeAllocationsTableBuilder = {
  time: Milliseconds[];
  weight: Bytes[];
  weightType: 'bytes';
  stack: Array<IndexIntoStackTable | null>;
  // See `RawSamplesTable.argumentValues` for the encoding.
  argumentValues?: number[];
  length: number;
};

export type RawBalancedNativeAllocationsTableBuilder = {
  time: Milliseconds[];
  weight: Bytes[];
  weightType: 'bytes';
  stack: Array<IndexIntoStackTable | null>;
  // See `RawSamplesTable.argumentValues` for the encoding.
  argumentValues?: number[];
  memoryAddress: number[];
  threadId: number[];
  length: number;
};

export type RawFrameTableBuilder = {
  flags: number[];
  address: Address[];
  category: IndexIntoCategoryList[];
  subcategory: IndexIntoSubcategoryListForCategory[];
  func: IndexIntoFuncTable[];
  lib: IndexIntoLibs[];
  nativeSymbol: IndexIntoNativeSymbolTable[];
  innerWindowID: InnerWindowID[];
  line: number[];
  column: number[];
  originalLocation: IndexIntoSourceLocationTable[];
  length: number;
};

export type RawStackTableBuilder = {
  frame: IndexIntoFrameTable[];
  prefix: Array<IndexIntoStackTable | null>;
  length: number;
};

/**
 * This module collects all of the creation of new empty profile data structures.
 */

export function getRawSamplesTableBuilder(): RawSamplesTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    weightType: 'samples',
    weight: null,
    stack: [],
    time: [],
    length: 0,
  };
}

export function getRawStackTableBuilder(): RawStackTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    frame: [],
    prefix: [],
    length: 0,
  };
}

// Convert a raw sample-table column that may be either a nullable plain array
// or a `Float64Array` with `NaN` as the "measurement failed" sentinel back to
// the builder's plain-array form, restoring `null` in the NaN slots.
function _nullableArrayFromNaNable(
  col: Array<number | null> | Float64Array<ArrayBuffer>
): Array<number | null> {
  if (col instanceof Float64Array) {
    const result = new Array<number | null>(col.length);
    for (let i = 0; i < col.length; i++) {
      const v = col[i];
      result[i] = Number.isNaN(v) ? null : v;
    }
    return result;
  }
  return col.slice();
}

export function getRawSamplesTableBuilderFromExisting(
  existing: RawSamplesTable
): RawSamplesTableBuilder {
  const builder: RawSamplesTableBuilder = {
    stack: Array.from(existing.stack, (v) => (v === -1 ? null : v)),
    weight:
      existing.weight === null ? null : Array.from<number>(existing.weight),
    weightType: existing.weightType,
    length: existing.length,
  };
  if (existing.responsiveness !== undefined) {
    builder.responsiveness = _nullableArrayFromNaNable(existing.responsiveness);
  }
  if (existing.eventDelay !== undefined) {
    builder.eventDelay = _nullableArrayFromNaNable(existing.eventDelay);
  }
  if (existing.time !== undefined) {
    builder.time = Array.from(existing.time);
  }
  if (existing.timeDeltas !== undefined) {
    builder.timeDeltas = Array.from(existing.timeDeltas);
  }
  if (existing.argumentValues !== undefined) {
    builder.argumentValues = Array.from<number>(existing.argumentValues);
  }
  if (existing.threadCPUDelta !== undefined) {
    builder.threadCPUDelta = _nullableArrayFromNaNable(existing.threadCPUDelta);
  }
  return builder;
}

export function finishRawSamplesTableBuilder(
  builder: RawSamplesTableBuilder
): RawSamplesTable {
  return {
    ...builder,
    stack: toInt32ArraySetNullToNegOne(builder.stack),
    time:
      builder.time === undefined ? undefined : new Float64Array(builder.time),
    timeDeltas:
      builder.timeDeltas === undefined
        ? undefined
        : new Float64Array(builder.timeDeltas),
    responsiveness:
      builder.responsiveness === undefined
        ? undefined
        : toFloat64ArraySetNullToNaN(builder.responsiveness),
    eventDelay:
      builder.eventDelay === undefined
        ? undefined
        : toFloat64ArraySetNullToNaN(builder.eventDelay),
    threadCPUDelta:
      builder.threadCPUDelta === undefined
        ? undefined
        : toFloat64ArraySetNullToNaN(builder.threadCPUDelta),
    argumentValues:
      builder.argumentValues === undefined
        ? undefined
        : new Int32Array(builder.argumentValues),
    weight: builder.weight === null ? null : new Float64Array(builder.weight),
  };
}

export function getRawMarkerTableBuilderFromExisting(
  markerTable: RawMarkerTable
): RawMarkerTableBuilder {
  const builder: RawMarkerTableBuilder = {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    data: markerTable.data.slice(),
    name: Array.from(markerTable.name),
    startTime: Array.from(markerTable.startTime),
    endTime: Array.from(markerTable.endTime),
    phase: Array.from(markerTable.phase) as MarkerPhase[],
    category: Array.from(markerTable.category),
    length: markerTable.length,
  };
  if (markerTable.threadId !== undefined) {
    builder.threadId = markerTable.threadId.slice();
  }
  return builder;
}

export function getRawStackTableBuilderWithExistingContents(
  existing: RawStackTable
): RawStackTableBuilder {
  const prefix = new Array<IndexIntoStackTable | null>(existing.length);
  for (let i = 0; i < existing.length; i++) {
    const offset = existing.prefixOffset[i];
    prefix[i] = offset === 0 ? null : i - offset;
  }
  return {
    frame: [...existing.frame],
    prefix,
    length: existing.length,
  };
}

export function finishRawStackTableBuilder(
  builder: RawStackTableBuilder
): RawStackTable {
  const { frame, prefix, length } = builder;
  const prefixOffset = new Int32Array(length);
  for (let i = 0; i < length; i++) {
    const p = prefix[i];
    prefixOffset[i] = p === null ? 0 : i - p;
  }
  return {
    frame: new Int32Array(frame),
    prefixOffset,
    length,
  };
}

/**
 * Returns an empty samples table with eventDelay field instead of responsiveness.
 * eventDelay is a new field and it replaced responsiveness. We should still
 * account for older profiles and use both of the flavors if needed.
 */
export function getRawSamplesTableBuilderWithEventDelay(): RawSamplesTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    weightType: 'samples',
    weight: null,
    eventDelay: [],
    stack: [],
    time: [],
    length: 0,
  };
}

export function getRawFrameTableBuilder(): RawFrameTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: [],
    address: [],
    category: [],
    subcategory: [],
    func: [],
    lib: [],
    nativeSymbol: [],
    innerWindowID: [],
    line: [],
    column: [],
    originalLocation: [],
    length: 0,
  };
}

export function getRawFrameTableBuilderWithExistingContents(
  frameTable: RawFrameTable
): RawFrameTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: Array.from(frameTable.flags),
    address: Array.from(frameTable.address),
    category: Array.from(frameTable.category),
    subcategory: Array.from(frameTable.subcategory),
    func: Array.from(frameTable.func),
    lib: Array.from(frameTable.lib),
    nativeSymbol: Array.from(frameTable.nativeSymbol),
    innerWindowID: Array.from(frameTable.innerWindowID),
    line: Array.from(frameTable.line),
    column: Array.from(frameTable.column),
    originalLocation: Array.from(frameTable.originalLocation),
    length: frameTable.length,
  };
}

export function finishRawFrameTableBuilder(
  builder: RawFrameTableBuilder
): RawFrameTable {
  return {
    ...builder,
    flags: new Uint8Array(builder.flags),
    address: new Int32Array(builder.address),
    func: new Int32Array(builder.func),
  };
}

export type RawFuncTableBuilder = {
  flags: number[];
  name: IndexIntoStringTable[];
  resource: IndexIntoResourceTable[];
  source: IndexIntoSourceTable[];
  lineNumber: number[];
  columnNumber: number[];
  originalLocation: IndexIntoSourceLocationTable[];
  length: number;
};

export function getRawFuncTableBuilder(): RawFuncTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: [],
    name: [],
    resource: [],
    source: [],
    lineNumber: [],
    columnNumber: [],
    originalLocation: [],
    length: 0,
  };
}

export function getRawFuncTableBuilderWithExistingContents(
  funcTable: RawFuncTable
): RawFuncTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: Array.from(funcTable.flags),
    name: Array.from(funcTable.name),
    resource: Array.from(funcTable.resource),
    source: Array.from(funcTable.source),
    lineNumber: Array.from(funcTable.lineNumber),
    columnNumber: Array.from(funcTable.columnNumber),
    originalLocation: Array.from(funcTable.originalLocation),
    length: funcTable.length,
  };
}

export function finishRawFuncTableBuilder(
  builder: RawFuncTableBuilder
): RawFuncTable {
  return { ...builder };
}

export function getEmptyRawFuncTable(): RawFuncTable {
  return finishRawFuncTableBuilder(getRawFuncTableBuilder());
}

export type RawSourceLocationTableBuilder = {
  source: IndexIntoSourceTable[];
  line: number[];
  column: number[];
  length: number;
};

export function getRawSourceLocationTableBuilder(): RawSourceLocationTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    source: [],
    line: [],
    column: [],
    length: 0,
  };
}

export function getRawSourceLocationTableBuilderWithExistingContents(
  sourceLocationTable: RawSourceLocationTable
): RawSourceLocationTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    source: Array.from(sourceLocationTable.source),
    line: Array.from(sourceLocationTable.line),
    column: Array.from(sourceLocationTable.column),
    length: sourceLocationTable.length,
  };
}

export function finishRawSourceLocationTableBuilder(
  builder: RawSourceLocationTableBuilder
): RawSourceLocationTable {
  return { ...builder };
}

export function getEmptyRawSourceLocationTable(): RawSourceLocationTable {
  return finishRawSourceLocationTableBuilder(
    getRawSourceLocationTableBuilder()
  );
}

export type RawNativeSymbolTableBuilder = {
  libIndex: IndexIntoLibs[];
  address: Address[];
  name: IndexIntoStringTable[];
  functionSize: Array<Bytes | null>;
  length: number;
};

export function getRawNativeSymbolTableBuilder(): RawNativeSymbolTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    libIndex: [],
    address: [],
    name: [],
    functionSize: [],
    length: 0,
  };
}

export function getRawNativeSymbolTableBuilderWithExistingContents(
  nativeSymbols: RawNativeSymbolTable
): RawNativeSymbolTableBuilder {
  const length = nativeSymbols.length;
  const rawFunctionSize = nativeSymbols.functionSize;
  const functionSize: Array<Bytes | null> = new Array(length);
  if (rawFunctionSize instanceof Int32Array) {
    // -1 is the "size unknown" sentinel in the typed-array form.
    for (let i = 0; i < length; i++) {
      const v = rawFunctionSize[i];
      functionSize[i] = v === -1 ? null : v;
    }
  } else {
    for (let i = 0; i < length; i++) {
      functionSize[i] = rawFunctionSize[i];
    }
  }
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    libIndex: Array.from(nativeSymbols.libIndex),
    address: Array.from(nativeSymbols.address),
    name: Array.from(nativeSymbols.name),
    functionSize,
    length,
  };
}

export function finishRawNativeSymbolTableBuilder(
  builder: RawNativeSymbolTableBuilder
): RawNativeSymbolTable {
  return { ...builder };
}

export type RawResourceTableBuilder = {
  flags: number[];
  name: IndexIntoStringTable[];
  host: IndexIntoStringTable[];
  type: ResourceType[];
  length: number;
};

export function getRawResourceTableBuilder(): RawResourceTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: [],
    name: [],
    host: [],
    type: [],
    length: 0,
  };
}

export function getRawResourceTableBuilderWithExistingContents(
  resourceTable: RawResourceTable
): RawResourceTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    flags: Array.from(resourceTable.flags),
    name: Array.from(resourceTable.name),
    host: Array.from(resourceTable.host),
    type: Array.from(resourceTable.type) as ResourceType[],
    length: resourceTable.length,
  };
}

export function finishRawResourceTableBuilder(
  builder: RawResourceTableBuilder
): RawResourceTable {
  return { ...builder };
}

export function getEmptyRawResourceTable(): RawResourceTable {
  return finishRawResourceTableBuilder(getRawResourceTableBuilder());
}

export function getEmptyNativeSymbolTable(): NativeSymbolTable {
  return {
    libIndex: new Int32Array(0),
    address: new Int32Array(0),
    name: new Int32Array(0),
    functionSize: new Int32Array(0),
    length: 0,
  };
}

export function getEmptyRawNativeSymbolTable(): RawNativeSymbolTable {
  return finishRawNativeSymbolTableBuilder(getRawNativeSymbolTableBuilder());
}

export function getEmptyRawMarkerTable(): RawMarkerTableBuilder {
  // Important!
  // If modifying this structure, please update all callers of this function to ensure
  // that they are pushing on correctly to the data structure. These pushes may not
  // be caught by the type system.
  return {
    data: [],
    name: [],
    startTime: [],
    endTime: [],
    phase: [],
    category: [],
    length: 0,
  };
}

export function getEmptyRawJsAllocationsTable(): RawJsAllocationsTableBuilder {
  // Important!
  // If modifying this structure, please update all callers of this function to ensure
  // that they are pushing on correctly to the data structure. These pushes may not
  // be caught by the type system.
  return {
    time: [],
    className: [],
    typeName: [],
    coarseType: [],
    weight: [],
    weightType: 'bytes',
    inNursery: [],
    stack: [],
    length: 0,
  };
}

/**
 * The native allocation tables come in two varieties. Get one of the members of the
 * union.
 */
export function getEmptyRawUnbalancedNativeAllocationsTable(): RawUnbalancedNativeAllocationsTableBuilder {
  // Important!
  // If modifying this structure, please update all callers of this function to ensure
  // that they are pushing on correctly to the data structure. These pushes may not
  // be caught by the type system.
  return {
    time: [],
    weight: [],
    weightType: 'bytes',
    stack: [],
    length: 0,
  };
}

/**
 * The native allocation tables come in two varieties. Get one of the members of the
 * union.
 */
export function getEmptyRawBalancedNativeAllocationsTable(): RawBalancedNativeAllocationsTableBuilder {
  // Important!
  // If modifying this structure, please update all callers of this function to ensure
  // that they are pushing on correctly to the data structure. These pushes may not
  // be caught by the type system.
  return {
    time: [],
    weight: [],
    weightType: 'bytes',
    stack: [],
    memoryAddress: [],
    threadId: [],
    length: 0,
  };
}

export function finishRawJsAllocationsTableBuilder(
  builder: RawJsAllocationsTableBuilder
): RawJsAllocationsTable {
  return {
    ...builder,
    time: new Float64Array(builder.time),
  };
}

export function finishRawUnbalancedNativeAllocationsTableBuilder(
  builder: RawUnbalancedNativeAllocationsTableBuilder
): RawUnbalancedNativeAllocationsTable {
  return {
    ...builder,
    time: new Float64Array(builder.time),
  };
}

export function finishRawBalancedNativeAllocationsTableBuilder(
  builder: RawBalancedNativeAllocationsTableBuilder
): RawBalancedNativeAllocationsTable {
  return {
    ...builder,
    time: new Float64Array(builder.time),
  };
}

export function getEmptyExtensions(): ExtensionTable {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    id: [],
    name: [],
    baseURL: [],
    length: 0,
  };
}

export function getDefaultCategories(): CategoryList {
  return [
    // Make sure 'Other' is at index 0, as it's used as the category for stacks when no
    // categories are provided by an imported (non-Gecko profiler) profile.
    { name: 'Other', color: 'grey', subcategories: ['Other'] },
    { name: 'Idle', color: 'transparent', subcategories: ['Other'] },
    { name: 'Layout', color: 'purple', subcategories: ['Other'] },
    { name: 'JavaScript', color: 'yellow', subcategories: ['Other'] },
    { name: 'GC / CC', color: 'orange', subcategories: ['Other'] },
    { name: 'Network', color: 'lightblue', subcategories: ['Other'] },
    { name: 'Graphics', color: 'green', subcategories: ['Other'] },
    { name: 'DOM', color: 'blue', subcategories: ['Other'] },
  ];
}

export function getEmptyJsTracerTable(): JsTracerTable {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    events: [],
    timestamps: [],
    durations: [],
    line: [],
    column: [],
    length: 0,
  };
}

export function getEmptySourceTable(): SourceTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    id: [],
    filename: [],
    startLine: [],
    startColumn: [],
    sourceMapURL: [],
    content: [],
    length: 0,
  };
}

export function getSourceTableBuilderFromExisting(
  sourceTable: SourceTable
): SourceTableBuilder {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    id: sourceTable.id.slice(),
    filename: Array.from(sourceTable.filename),
    startLine: Array.from(sourceTable.startLine),
    startColumn: Array.from(sourceTable.startColumn),
    sourceMapURL: sourceTable.sourceMapURL.slice(),
    content: sourceTable.content.slice(),
    length: sourceTable.length,
  };
}

export function getEmptyThread(overrides?: Partial<RawThread>): RawThread {
  const defaultThread: RawThread = {
    processType: 'default',
    processStartupTime: 0,
    processShutdownTime: null,
    registerTime: 0,
    unregisterTime: null,
    pausedRanges: [],
    name: 'Empty',
    isMainThread: false,
    pid: '0',
    tid: 0,
    // Creating samples with event delay since it's the new samples table.
    samples: finishRawSamplesTableBuilder(
      getRawSamplesTableBuilderWithEventDelay()
    ),
    markers: getEmptyRawMarkerTable(),
  };

  return {
    ...defaultThread,
    ...overrides,
  };
}

export function getEmptySharedData(): RawProfileSharedData {
  return {
    stackTable: finishRawStackTableBuilder(getRawStackTableBuilder()),
    frameTable: finishRawFrameTableBuilder(getRawFrameTableBuilder()),
    funcTable: getEmptyRawFuncTable(),
    resourceTable: getEmptyRawResourceTable(),
    nativeSymbols: getEmptyRawNativeSymbolTable(),
    sources: getEmptySourceTable(),
    stringArray: [],
    sourceLocationTable: getEmptyRawSourceLocationTable(),
  };
}

export function getEmptyProfile(): Profile {
  return {
    meta: {
      interval: 1,
      startTime: 0,
      abi: '',
      misc: '',
      oscpu: '',
      platform: '',
      processType: 0,
      extensions: getEmptyExtensions(),
      categories: getDefaultCategories(),
      product: 'Firefox',
      stackwalk: 0,
      toolkit: '',
      version: GECKO_PROFILE_VERSION,
      preprocessedProfileVersion: PROCESSED_PROFILE_VERSION,
      appBuildID: '',
      sourceURL: '',
      physicalCPUs: 0,
      logicalCPUs: 0,
      CPUName: '',
      symbolicated: true,
      markerSchema: [],
    },
    libs: [],
    pages: [],
    shared: getEmptySharedData(),
    threads: [],
  };
}

export function getEmptyCallNodeTable(): CallNodeTable {
  return {
    // Important!
    // If modifying this structure, please update all callers of this function to ensure
    // that they are pushing on correctly to the data structure. These pushes may not
    // be caught by the type system.
    prefix: new Int32Array(0),
    subtreeRangeEnd: new Uint32Array(0),
    nextSibling: new Int32Array(0),
    func: new Int32Array(0),
    category: new Int32Array(0),
    subcategory: new Int32Array(0),
    innerWindowID: new Float64Array(0),
    sourceFramesInlinedIntoSymbol: new Int32Array(0),
    depth: new Int32Array(0),
    maxDepth: -1,
    length: 0,
  };
}
