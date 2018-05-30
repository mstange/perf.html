/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { timeCode } from '../utils/time-code';
import {
  getSampleCallNodes,
  resourceTypes,
  getOriginAnnotationForFunc,
  getCallNodePathFromIndex,
  getCallNodeIndexFromPath,
  getCallNodeIndicesFromPaths,
} from './profile-data';
import { UniqueStringArray } from '../utils/unique-string-array';
import type {
  Thread,
  FuncTable,
  ResourceTable,
  IndexIntoFuncTable,
} from '../types/profile';
import type {
  CallNodeTable,
  IndexIntoCallNodeTable,
  CallNodeInfo,
  CallNodeData,
  CallNodeDisplayData,
  CallNodePath,
} from '../types/profile-derived';
import type { Tree } from '../components/shared/TreeView.js';
import type { Milliseconds } from '../types/units';
import ExtensionIcon from '../../res/img/svg/extension.svg';

export type CallNodeIndex = string;

type CallNodeChildren = CallNodeIndex[];
type CallNodeTimes = {
  selfTime: Float32Array,
  totalTime: Float32Array,
};
type CallTreeCountsAndTimings = {
  callNodeChildCount: Uint32Array,
  callNodeTimes: CallNodeTimes,
  rootCount: number,
  rootTotalTime: number,
};

export type CallTree = Tree<CallNodeIndex, CallNodeDisplayData> & {
  preloadChildrenCache(): void,
  getNodeData(node: CallNodeIndex): CallNodeData,
  getTimingDisplayData(callNodeIndex: CallNodeIndex): Object,
  getCallNodePathFromNodeIndex(
    callNodeIndex: CallNodeIndex | null
  ): CallNodePath,
  getNodeIndexFromCallNodePath(
    callNodePath: CallNodePath
  ): CallNodeIndex | null,
  getNodeIndicesFromCallNodePaths(
    callNodePaths: Array<CallNodePath>
  ): Array<CallNodeIndex | null>,
  getAllDescendants(node: CallNodeIndex): Set<CallNodeIndex>,
};

function extractFaviconFromLibname(libname: string): string | null {
  const url = new URL('/favicon.ico', libname);
  if (url.protocol === 'http:') {
    // Upgrade http requests.
    url.protocol = 'https:';
  }
  return url.href;
}

export class CallTreeRegular {
  _callNodeTable: CallNodeTable;
  _callNodeTimes: CallNodeTimes;
  _callNodeChildCount: Uint32Array; // A table column matching the callNodeTable
  _funcTable: FuncTable;
  _resourceTable: ResourceTable;
  _stringTable: UniqueStringArray;
  _rootTotalTime: number;
  _rootCount: number;
  _displayDataByIndex: Map<CallNodeIndex, CallNodeDisplayData>;
  _children: Map<CallNodeIndex | -1, CallNodeChildren>;
  _isChildrenCachePreloaded: boolean;
  _jsOnly: boolean;
  _isIntegerInterval: boolean;

  constructor(
    { funcTable, resourceTable, stringTable }: Thread,
    callNodeTable: CallNodeTable,
    callNodeTimes: CallNodeTimes,
    callNodeChildCount: Uint32Array,
    rootTotalTime: number,
    rootCount: number,
    jsOnly: boolean,
    isIntegerInterval: boolean
  ) {
    this._callNodeTable = callNodeTable;
    this._callNodeTimes = callNodeTimes;
    this._callNodeChildCount = callNodeChildCount;
    this._funcTable = funcTable;
    this._resourceTable = resourceTable;
    this._stringTable = stringTable;
    this._rootTotalTime = rootTotalTime;
    this._rootCount = rootCount;
    this._displayDataByIndex = new Map();
    this._children = new Map();
    this._isChildrenCachePreloaded = false;
    this._jsOnly = jsOnly;
    this._isIntegerInterval = isIntegerInterval;
  }

  getRoots() {
    return this._getChildren(-1);
  }

  /**
   * Preload the internal cache of children so that subsequent calls
   * to getChildren() return in constant time.
   *
   * This is an essential optimization for the flame graph since it
   * needs to traverse all children of the call tree in one pass.
   */
  preloadChildrenCache() {
    if (!this._isChildrenCachePreloaded) {
      this._children.clear();
      this._children.set("-1", []); // -1 is the parent of the roots
      for (
        let callNodeIndex = 0;
        callNodeIndex < this._callNodeTable.length;
        callNodeIndex++
      ) {
        // This loop assumes parents always come before their children
        // in the call node table. For every call node index, we set
        // its children to be an empty array. Then we always have an
        // array to append to when any call node acts as a parent
        // through the prefix.
        this._children.set(callNodeIndex + "", []);

        if (this._callNodeTimes.totalTime[callNodeIndex] === 0) {
          continue;
        }

        const siblings = this._children.get(
          this._callNodeTable.prefix[callNodeIndex] + ""
        );
        if (siblings === undefined) {
          // We should definitely have created a children array for
          // the parent in an earlier iteration of this loop. Add this
          // condition to satisfy flow.
          throw new Error(
            "Failed to retrieve array of children. This shouldn't happen."
          );
        }
        siblings.push(callNodeIndex + "");
        siblings.sort(
          (a, b) =>
            this._callNodeTimes.totalTime[+b] - this._callNodeTimes.totalTime[+a]
        );
      }
      this._isChildrenCachePreloaded = true;
    }
  }

  getCallNodePathFromNodeIndex(
    callNodeIndex: CallNodeIndex | null
  ): CallNodePath {
    return getCallNodePathFromIndex(+callNodeIndex, this._callNodeTable);
  }

  getNodeIndexFromCallNodePath(
    callNodePath: CallNodePath
  ): CallNodeIndex | null {
    const index = getCallNodeIndexFromPath(callNodePath, this._callNodeTable);
    return index === null ? null : index + "";
  }

  getNodeIndicesFromCallNodePaths(
    callNodePaths: Array<CallNodePath>
  ): Array<CallNodeIndex | null> {
    return getCallNodeIndicesFromPaths(callNodePaths, this._callNodeTable).map(index => index === null ? null : index + "");
  }

  getChildren(callNodeIndex: CallNodeIndex): CallNodeChildren {
    return this._getChildren(callNodeIndex);
  }

  _getChildren(callNodeIndex: CallNodeIndex | -1): CallNodeChildren {
    let children = this._children.get(callNodeIndex);
    if (children === undefined) {
      if (this._isChildrenCachePreloaded) {
        console.error(
          `Children for callNodeIndex ${callNodeIndex} not found in cache despite having a preloaded cache.`
        );
      }
      const childCount =
        callNodeIndex === -1
          ? this._rootCount
          : this._callNodeChildCount[+callNodeIndex];
      children = [];
      for (
        let childCallNodeIndex = +callNodeIndex + 1;
        childCallNodeIndex < this._callNodeTable.length &&
        children.length < childCount;
        childCallNodeIndex++
      ) {
        if (
          this._callNodeTable.prefix[childCallNodeIndex] === +callNodeIndex &&
          this._callNodeTimes.totalTime[childCallNodeIndex] !== 0
        ) {
          children.push(childCallNodeIndex + "");
        }
      }
      children.sort(
        (a, b) =>
          this._callNodeTimes.totalTime[+b] - this._callNodeTimes.totalTime[+a]
      );
      this._children.set(callNodeIndex, children);
    }
    return children;
  }

  hasChildren(callNodeIndex: CallNodeIndex): boolean {
    return this.getChildren(callNodeIndex).length !== 0;
  }

  _addDescendantsToSet(
    callNodeIndex: CallNodeIndex,
    set: Set<CallNodeIndex>
  ): void {
    for (const child of this.getChildren(callNodeIndex)) {
      set.add(child);
      this._addDescendantsToSet(child, set);
    }
  }

  getAllDescendants(callNodeIndex: CallNodeIndex): Set<CallNodeIndex> {
    const result = new Set();
    this._addDescendantsToSet(callNodeIndex, result);
    return result;
  }

  getParent(callNodeIndex: CallNodeIndex): CallNodeIndex | null {
    const index = this._callNodeTable.prefix[+callNodeIndex];
    return index === -1 ? null : index + "";
  }

  getDepth(callNodeIndex: CallNodeIndex): number {
    return this._callNodeTable.depth[+callNodeIndex];
  }

  getNodeData(callNodeIndex: CallNodeIndex): CallNodeData {
    const funcIndex = this._callNodeTable.func[+callNodeIndex];
    const funcName = this._stringTable.getString(
      this._funcTable.name[funcIndex]
    );
    const totalTime = this._callNodeTimes.totalTime[+callNodeIndex];
    const totalTimeRelative = totalTime / this._rootTotalTime;
    const selfTime = this._callNodeTimes.selfTime[+callNodeIndex];
    const selfTimeRelative = selfTime / this._rootTotalTime;

    return {
      funcName,
      totalTime,
      totalTimeRelative,
      selfTime,
      selfTimeRelative,
    };
  }

  getTimingDisplayData(callNodeIndex: CallNodeIndex) {
    const totalTime = this._callNodeTimes.totalTime[+callNodeIndex];
    const selfTime = this._callNodeTimes.selfTime[+callNodeIndex];
    const formatNumber = this._isIntegerInterval
      ? _formatIntegerNumber
      : _formatDecimalNumber;
    return {
      totalTime: `${formatNumber(totalTime)}`,
      selfTime: selfTime === 0 ? '—' : `${formatNumber(selfTime)}`,
    };
  }

  getDisplayData(callNodeIndex: CallNodeIndex): CallNodeDisplayData {
    let displayData = this._displayDataByIndex.get(callNodeIndex);
    if (displayData === undefined) {
      const { funcName, totalTimeRelative } = this.getNodeData(callNodeIndex);
      const funcIndex = this._callNodeTable.func[+callNodeIndex];
      const resourceIndex = this._funcTable.resource[funcIndex];
      const resourceType = this._resourceTable.type[resourceIndex];
      const isJS = this._funcTable.isJS[funcIndex];
      const libName = this._getOriginAnnotation(funcIndex);
      const precision = this._isIntegerInterval ? 0 : 1;

      let icon = null;
      if (resourceType === resourceTypes.webhost) {
        icon = extractFaviconFromLibname(libName);
      } else if (resourceType === resourceTypes.addon) {
        icon = ExtensionIcon;
      }

      displayData = {
        ...this.getTimingDisplayData(callNodeIndex),
        totalTimePercent: `${(100 * totalTimeRelative).toFixed(precision)}%`,
        name: funcName,
        lib: libName,
        // Dim platform pseudo-stacks.
        dim: !isJS && this._jsOnly,
        icon,
      };
      this._displayDataByIndex.set(callNodeIndex, displayData);
    }
    return displayData;
  }

  _getOriginAnnotation(funcIndex: IndexIntoFuncTable): string {
    return getOriginAnnotationForFunc(
      funcIndex,
      this._funcTable,
      this._resourceTable,
      this._stringTable
    );
  }
}

/**
 * This is a helper function to get the stack timings for un-inverted call trees.
 */
function _getStackSelfTimes(
  thread: Thread,
  callNodeTable: CallNodeTable,
  sampleCallNodes: Array<null | IndexIntoCallNodeTable>,
  interval: Milliseconds
): Float32Array /* Milliseconds[] */ {
  const callNodeSelfTime = new Float32Array(callNodeTable.length);

  for (
    let sampleIndex = 0;
    sampleIndex < sampleCallNodes.length;
    sampleIndex++
  ) {
    const callNodeIndex = sampleCallNodes[sampleIndex];
    if (callNodeIndex !== null) {
      callNodeSelfTime[callNodeIndex] += interval;
    }
  }

  return callNodeSelfTime;
}

/**
 * This computes all of the count and timing information displayed in the calltree.
 * It takes into account both the normal tree, and the inverted tree.
 */
export function computeCallTreeCountsAndTimings(
  thread: Thread,
  { callNodeTable, stackIndexToCallNodeIndex }: CallNodeInfo,
  interval: Milliseconds
): CallTreeCountsAndTimings {
  const sampleCallNodes = getSampleCallNodes(
    thread.samples,
    stackIndexToCallNodeIndex
  );
  const callNodeSelfTime = _getStackSelfTimes(
    thread,
    callNodeTable,
    sampleCallNodes,
    interval
  );
  const callNodeLeafTime = callNodeSelfTime;

  // Compute the following variables:
  const callNodeTotalTime = new Float32Array(callNodeTable.length);
  const callNodeChildCount = new Uint32Array(callNodeTable.length);
  let rootTotalTime = 0;
  let rootCount = 0;

  for (
    let callNodeIndex = callNodeTable.length - 1;
    callNodeIndex >= 0;
    callNodeIndex--
  ) {
    callNodeTotalTime[callNodeIndex] += callNodeLeafTime[callNodeIndex];
    if (callNodeTotalTime[callNodeIndex] === 0) {
      continue;
    }
    const prefixCallNode = callNodeTable.prefix[callNodeIndex];
    if (prefixCallNode === -1) {
      rootTotalTime += callNodeTotalTime[callNodeIndex];
      rootCount++;
    } else {
      callNodeTotalTime[prefixCallNode] += callNodeTotalTime[callNodeIndex];
      callNodeChildCount[prefixCallNode]++;
    }
  }

  return {
    callNodeTimes: {
      selfTime: callNodeSelfTime,
      totalTime: callNodeTotalTime,
    },
    callNodeChildCount,
    rootTotalTime,
    rootCount,
  };
}

type UnpackedInvertedCallTreeNodeIndex = {
  +nodeCallNodeIndex: IndexIntoCallNodeTable,
  +rootCallNodeIndex: IndexIntoCallNodeTable,
};

type InvertedCallTreeNodeInfo = {
  callNodePath: CallNodePath,
  callNodes: Array<UnpackedInvertedCallTreeNodeIndex>,
  nodeTime: Milliseconds,
};

export class CallTreeInverted {
  _callNodeTable: CallNodeTable;
  _callNodeSelfTime: Float32Array;
  _firstCallNodeForRootFunc: Array<IndexIntoCallNodeTable | null>;
  _funcTable: FuncTable;
  _resourceTable: ResourceTable;
  _stringTable: UniqueStringArray;
  _rootTotalTime: Milliseconds;
  _rootNodes: Array<CallNodeIndex>;
  _displayDataByIndex: Map<CallNodeIndex, CallNodeDisplayData>;
  _nodeInfo: Map<CallNodeIndex, Object>;
  _children: Map<CallNodeIndex | -1, CallNodeChildren>;
  _parentCache: Map<CallNodeIndex, CallNodeIndex | null>;
  _pathToIndexCache: Map<string, CallNodeIndex | null>;
  _isIntegerInterval: boolean;

  constructor(
    { funcTable, resourceTable, stringTable }: Thread,
    callNodeTable: CallNodeTable,
    callNodeSelfTime: Float32Array,
    rootTotalTime: Milliseconds,
    rootNodes: Array<InvertedCallTreeNodeInfo>,
    jsOnly: boolean,
    isIntegerInterval: boolean
  ) {
    this._callNodeTable = callNodeTable;
    this._callNodeSelfTime = callNodeSelfTime;
    this._funcTable = funcTable;
    this._resourceTable = resourceTable;
    this._stringTable = stringTable;
    this._nodeInfo = new Map();
    this._rootTotalTime = rootTotalTime;
    this._pathToIndexCache = new Map();
    this._parentCache = new Map();
    const firstCallNodeForRootFunc = Array.from(
      Array(funcTable.length),
      () => null
    );

    for (
      let callNodeIndex = 0;
      callNodeIndex < callNodeTable.length;
      callNodeIndex++
    ) {
      const func = callNodeTable.func[callNodeIndex];
      if (firstCallNodeForRootFunc[func] === null) {
        firstCallNodeForRootFunc[func] = callNodeIndex;
      }
    }
    this._firstCallNodeForRootFunc = firstCallNodeForRootFunc;

    this._rootNodes = rootNodes.map(rootNode => {
      const nodeIndex = this.getNodeIndexFromCallNodePath(
        rootNode.callNodePath
      );
      if (nodeIndex === null) {
        throw new Error('unexpected null nodeIndex');
      }
      this._nodeInfo.set(nodeIndex, rootNode);
      return nodeIndex;
    });
    this._children = new Map();
    this._displayDataByIndex = new Map();
    this._isIntegerInterval = isIntegerInterval;
  }

  getRoots(): Array<CallNodeIndex> {
    return this._rootNodes;
  }

  preloadChildrenCache() {}

  _getNodeInfo(nodeIndex: CallNodeIndex): InvertedCallTreeNodeInfo {
    let nodeInfo = this._nodeInfo.get(nodeIndex);
    if (nodeInfo !== undefined) {
      return nodeInfo;
    }
    const unpackedIndex = this._unpackNodeIndex(nodeIndex);
    const { nodeCallNodeIndex, rootCallNodeIndex } = unpackedIndex;
    if (nodeCallNodeIndex === rootCallNodeIndex) {
      throw new Error("don't call _getNodeInfo for root nodes");
    }
    const func = this._callNodeTable.func[nodeCallNodeIndex];
    const callNodePath = this._getCallNodePathFromUnpackedInvertedCallTreeNodeIndex(
      unpackedIndex
    );
    const parentNodeIndex = this.getParent(nodeIndex);
    if (parentNodeIndex === null) {
      throw new Error('unexpected null nodeIndex');
    }
    const parentInfo = this._getNodeInfo(parentNodeIndex);
    const callNodes: Array<UnpackedInvertedCallTreeNodeIndex> = [];
    let nodeTime = 0;
    for (const {
      nodeCallNodeIndex,
      rootCallNodeIndex,
    } of parentInfo.callNodes) {
      const prefixCallNode = this._callNodeTable.prefix[nodeCallNodeIndex];
      if (prefixCallNode === -1) {
        continue;
      }
      const prefixFunc = this._callNodeTable.func[prefixCallNode];
      if (prefixFunc !== func) {
        continue;
      }
      callNodes.push({
        nodeCallNodeIndex: prefixCallNode,
        rootCallNodeIndex,
      });
      nodeTime += this._callNodeSelfTime[rootCallNodeIndex];
    }
    nodeInfo = {
      callNodePath,
      callNodes,
      nodeTime,
    };
    this._nodeInfo.set(nodeIndex, nodeInfo);
    return nodeInfo;
  }

  getChildren(nodeIndex: CallNodeIndex): CallNodeChildren {
    let children = this._children.get(nodeIndex);
    if (children === undefined) {
      const { callNodes, callNodePath } = this._getNodeInfo(nodeIndex);
      const childMap = new Map();
      for (const { nodeCallNodeIndex, rootCallNodeIndex } of callNodes) {
        const prefixCallNode = this._callNodeTable.prefix[nodeCallNodeIndex];
        if (prefixCallNode === -1) {
          continue;
        }
        const prefixFunc = this._callNodeTable.func[prefixCallNode];
        const childData = childMap.get(prefixFunc);
        if (childData === undefined) {
          const childNodeIndex = this.getNodeIndexFromCallNodePath([
            ...callNodePath,
            prefixFunc,
          ]);
          if (childNodeIndex !== null) {
            this._parentCache.set(childNodeIndex, nodeIndex);
            childMap.set(prefixFunc, {
              nodeIndex: childNodeIndex,
              nodeTime: this._callNodeSelfTime[rootCallNodeIndex],
            });
          }
        } else {
          childData.nodeTime += this._callNodeSelfTime[rootCallNodeIndex];
        }
      }
      const childArray = Array.from(childMap.values());
      childArray.sort((a, b) => b.nodeTime - a.nodeTime);
      children = childArray.map(({ nodeIndex }) => nodeIndex);
      this._children.set(nodeIndex, children);
    }
    return children;
  }

  hasChildren(nodeIndex: CallNodeIndex): boolean {
    return this.getChildren(nodeIndex).length !== 0;
  }

  _addDescendantsToSet(
    nodeIndex: CallNodeIndex,
    set: Set<CallNodeIndex>
  ): void {
    for (const child of this.getChildren(nodeIndex)) {
      set.add(child);
      this._addDescendantsToSet(child, set);
    }
  }

  getAllDescendants(nodeIndex: CallNodeIndex): Set<CallNodeIndex> {
    const result = new Set();
    this._addDescendantsToSet(nodeIndex, result);
    return result;
  }

  getParent(nodeIndex: CallNodeIndex): CallNodeIndex | null {
    let parentIndex = this._parentCache.get(nodeIndex);
    if (parentIndex === undefined) {
      const callNodePath = this.getCallNodePathFromNodeIndex(nodeIndex);
      const parentCallNodePath = callNodePath.slice(0, callNodePath.length - 1);
      parentIndex = this.getNodeIndexFromCallNodePath(parentCallNodePath);
      this._parentCache.set(nodeIndex, parentIndex);
    }
    return parentIndex;
  }

  getDepth(nodeIndex: CallNodeIndex): number {
    return this.getCallNodePathFromNodeIndex(nodeIndex).length - 1;
  }

  getCallNodePathFromNodeIndex(nodeIndex: CallNodeIndex | null): CallNodePath {
    if (nodeIndex === null) {
      return [];
    }
    return this._getCallNodePathFromUnpackedInvertedCallTreeNodeIndex(
      this._unpackNodeIndex(nodeIndex)
    );
  }

  _getCallNodePathFromUnpackedInvertedCallTreeNodeIndex({
    nodeCallNodeIndex,
    rootCallNodeIndex,
  }: UnpackedInvertedCallTreeNodeIndex): CallNodePath {
    const path = [];
    for (
      let callNode = rootCallNodeIndex;
      true;
      callNode = this._callNodeTable.prefix[callNode]
    ) {
      path.push(this._callNodeTable.func[callNode]);
      if (callNode === nodeCallNodeIndex) {
        break;
      }
    }
    return path;
  }

  _getUnpackedIndexIfCallNodeMatchesPath(
    callNodeIndex: IndexIntoCallNodeTable,
    callNodePath: CallNodePath
  ): UnpackedInvertedCallTreeNodeIndex | null {
    let indexInPath = 0;
    let currentCallNode = callNodeIndex;
    while (true) {
      if (
        this._callNodeTable.func[currentCallNode] !== callNodePath[indexInPath]
      ) {
        return null;
      }
      indexInPath++;
      if (indexInPath === callNodePath.length) {
        break;
      }
      currentCallNode = this._callNodeTable.prefix[currentCallNode];
      if (currentCallNode === -1) {
        return null;
      }
    }
    return {
      rootCallNodeIndex: callNodeIndex,
      nodeCallNodeIndex: currentCallNode,
    };
  }

  _getNodeIndexFromCallNodePathWithCache(
    callNodePath: CallNodePath,
    cache: Map<string, CallNodeIndex | null>
  ): CallNodeIndex | null {
    if (callNodePath.length === 0) {
      return null;
    }

    const hash = callNodePath.join('-');
    const cachedIndex = cache.get(hash);
    if (cachedIndex !== undefined) {
      return cachedIndex;
    }

    if (callNodePath.length === 1) {
      // A root
      const func = callNodePath[0];
      const callNodeIndex = this._firstCallNodeForRootFunc[func];
      if (callNodeIndex === null) {
        cache.set(hash, null);
        return null;
      }
      const result = this._packNodeIndex({
        nodeCallNodeIndex: callNodeIndex,
        rootCallNodeIndex: callNodeIndex,
      });
      cache.set(hash, result);
      return result;
    }

    const potentialChildIndex = this._getNodeIndexFromCallNodePathWithCache(
      callNodePath.slice(0, callNodePath.length - 1),
      cache
    );
    if (potentialChildIndex === null) {
      cache.set(hash, null);
      return null;
    }

    const potentialChildUnpackedIndex = this._unpackNodeIndex(
      potentialChildIndex
    );
    const lastFunc = callNodePath[callNodePath.length - 1];
    const potentialChildPrefixCallNodeIndex = this._callNodeTable.prefix[
      potentialChildUnpackedIndex.nodeCallNodeIndex
    ];
    if (
      this._callNodeTable.func[potentialChildPrefixCallNodeIndex] === lastFunc
    ) {
      const result = this._packNodeIndex({
        nodeCallNodeIndex: potentialChildPrefixCallNodeIndex,
        rootCallNodeIndex: potentialChildUnpackedIndex.rootCallNodeIndex,
      });
      cache.set(hash, result);
      return result;
    }

    const indexInPath = 0;
    const callNodeTable = this._callNodeTable;
    for (
      let callNodeIndex = potentialChildUnpackedIndex.rootCallNodeIndex + 1;
      callNodeIndex < this._callNodeTable.length;
      callNodeIndex++
    ) {
      const unpackedIndexOrNull = this._getUnpackedIndexIfCallNodeMatchesPath(
        callNodeIndex,
        callNodePath
      );
      if (unpackedIndexOrNull !== null) {
        return this._packNodeIndex(unpackedIndexOrNull);
      }
    }
    return null;
  }

  getNodeIndexFromCallNodePath(
    callNodePath: CallNodePath
  ): CallNodeIndex | null {
    return this._getNodeIndexFromCallNodePathWithCache(
      callNodePath,
      this._pathToIndexCache
    );
  }

  getNodeIndicesFromCallNodePaths(
    callNodePaths: Array<CallNodePath>
  ): Array<CallNodeIndex | null> {
    const result = [];
    for (const callNodePath of callNodePaths) {
      result.push(
        this._getNodeIndexFromCallNodePathWithCache(
          callNodePath,
          this._pathToIndexCache
        )
      );
    }
    // const keys = Array.from(this._pathToIndexCache.keys());
    // keys.sort((a, b) => b.length - a.length);
    // console.log(keys);
    return result;
  }

  _packNodeIndex({
    nodeCallNodeIndex,
    rootCallNodeIndex,
  }: UnpackedInvertedCallTreeNodeIndex): CallNodeIndex {
    return this._callNodeTable.length * nodeCallNodeIndex + rootCallNodeIndex + "";
  }

  _unpackNodeIndex(
    nodeIndex: CallNodeIndex
  ): UnpackedInvertedCallTreeNodeIndex {
    const nodeCallNodeIndex = Math.floor(
      +nodeIndex / this._callNodeTable.length
    );
    const rootCallNodeIndex =
      +nodeIndex - nodeCallNodeIndex * this._callNodeTable.length;
    return { nodeCallNodeIndex, rootCallNodeIndex };
  }

  getNodeData(nodeIndex: CallNodeIndex): CallNodeData {
    const { nodeCallNodeIndex, rootCallNodeIndex } = this._unpackNodeIndex(
      nodeIndex
    );
    const funcIndex = this._callNodeTable.func[nodeCallNodeIndex];
    const funcName = this._stringTable.getString(
      this._funcTable.name[funcIndex]
    );
    const isRoot = nodeCallNodeIndex === rootCallNodeIndex;
    const totalTime = this._getNodeInfo(nodeIndex).nodeTime;
    const totalTimeRelative = totalTime / this._rootTotalTime;
    const selfTime = isRoot ? totalTime : 0;
    const selfTimeRelative = isRoot ? totalTimeRelative : 0;

    return {
      funcName,
      totalTime,
      totalTimeRelative,
      selfTime,
      selfTimeRelative,
    };
  }

  getTimingDisplayData(nodeIndex: CallNodeIndex) {
    const { nodeCallNodeIndex, rootCallNodeIndex } = this._unpackNodeIndex(
      nodeIndex
    );
    const isRoot = nodeCallNodeIndex === rootCallNodeIndex;
    const totalTime = this._getNodeInfo(nodeIndex).nodeTime;
    const totalTimeRelative = totalTime / this._rootTotalTime;
    const selfTime = isRoot ? totalTime : 0;
    const formatNumber = this._isIntegerInterval
      ? _formatIntegerNumber
      : _formatDecimalNumber;
    return {
      totalTime: `${formatNumber(totalTime)}`,
      selfTime: selfTime === 0 ? '—' : `${formatNumber(selfTime)}`,
    };
  }

  getDisplayData(nodeIndex: CallNodeIndex): CallNodeDisplayData {
    let displayData = this._displayDataByIndex.get(nodeIndex);
    if (displayData === undefined) {
      const { funcName, totalTimeRelative } = this.getNodeData(nodeIndex);
      const { nodeCallNodeIndex, rootCallNodeIndex } = this._unpackNodeIndex(
        nodeIndex
      );
      const funcIndex = this._callNodeTable.func[nodeCallNodeIndex];
      const resourceIndex = this._funcTable.resource[funcIndex];
      const resourceType = this._resourceTable.type[resourceIndex];
      const isJS = this._funcTable.isJS[funcIndex];
      const libName = this._getOriginAnnotation(funcIndex);
      const precision = this._isIntegerInterval ? 0 : 1;

      let icon = null;
      if (resourceType === resourceTypes.webhost) {
        icon = extractFaviconFromLibname(libName);
      } else if (resourceType === resourceTypes.addon) {
        icon = ExtensionIcon;
      }

      displayData = {
        ...this.getTimingDisplayData(nodeIndex),
        totalTimePercent: `${(100 * totalTimeRelative).toFixed(precision)}%`,
        name: funcName,
        lib: libName,
        dim: false,
        icon,
      };
      this._displayDataByIndex.set(nodeIndex, displayData);
    }
    return displayData;
  }

  _getOriginAnnotation(funcIndex: IndexIntoFuncTable): string {
    return getOriginAnnotationForFunc(
      funcIndex,
      this._funcTable,
      this._resourceTable,
      this._stringTable
    );
  }
}

/**
 * This computes all of the count and timing information displayed in the calltree.
 * It takes into account both the normal tree, and the inverted tree.
 */
function computeCallTreeCountsAndTimingsInverted(
  thread: Thread,
  { callNodeTable, stackIndexToCallNodeIndex }: CallNodeInfo,
  interval: Milliseconds
) {
  const sampleCallNodes = getSampleCallNodes(
    thread.samples,
    stackIndexToCallNodeIndex
  );
  const callNodeSelfTime = _getStackSelfTimes(
    thread,
    callNodeTable,
    sampleCallNodes,
    interval
  );

  // Compute the following variables:
  let rootTotalTime = 0;
  const rootNodeMap = new Map();

  for (
    let callNodeIndex = 0;
    callNodeIndex < callNodeTable.length;
    callNodeIndex++
  ) {
    const nodeTime = callNodeSelfTime[callNodeIndex];
    if (nodeTime === 0) {
      continue;
    }
    rootTotalTime += nodeTime;
    const func = callNodeTable.func[callNodeIndex];
    const rootNode = rootNodeMap.get(func);
    if (rootNode === undefined) {
      rootNodeMap.set(func, {
        callNodePath: [func],
        callNodes: [
          {
            nodeCallNodeIndex: callNodeIndex,
            rootCallNodeIndex: callNodeIndex,
          },
        ],
        nodeTime,
      });
    } else {
      rootNode.callNodes.push({
        nodeCallNodeIndex: callNodeIndex,
        rootCallNodeIndex: callNodeIndex,
      });
      rootNode.nodeTime += nodeTime;
    }
  }

  const rootNodes = Array.from(rootNodeMap.values());
  rootNodes.sort((a, b) => b.nodeTime - a.nodeTime);

  return {
    callNodeSelfTime,
    rootTotalTime,
    rootNodes,
  };
}

/**
 * An exported interface to get an instance of the CallTree class.
 * This handles computing timing information, and passing it all into
 * the CallTree constructor.
 */
export function getCallTree(
  thread: Thread,
  interval: Milliseconds,
  callNodeInfo: CallNodeInfo,
  implementationFilter: string,
  invertCallstack: boolean
): CallTree {
  return timeCode('getCallTree', () => {
    if (invertCallstack) {
      const {
        callNodeSelfTime,
        rootTotalTime,
        rootNodes,
      } = computeCallTreeCountsAndTimingsInverted(
        thread,
        callNodeInfo,
        interval
      );

      const jsOnly = implementationFilter === 'js';
      const isIntegerInterval = Math.floor(interval) === interval;

      return new CallTreeInverted(
        thread,
        callNodeInfo.callNodeTable,
        callNodeSelfTime,
        rootTotalTime,
        rootNodes,
        jsOnly,
        isIntegerInterval
      );
    } else {
      const {
        callNodeTimes,
        callNodeChildCount,
        rootTotalTime,
        rootCount,
      } = computeCallTreeCountsAndTimings(thread, callNodeInfo, interval);

      const jsOnly = implementationFilter === 'js';
      const isIntegerInterval = Math.floor(interval) === interval;

      return new CallTreeRegular(
        thread,
        callNodeInfo.callNodeTable,
        callNodeTimes,
        callNodeChildCount,
        rootTotalTime,
        rootCount,
        jsOnly,
        isIntegerInterval
      );
    }
  });
}

const LOCALE_WITH_DECIMAL_POINT = {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
};
function _formatDecimalNumber(number: number): string {
  return number.toLocaleString(undefined, LOCALE_WITH_DECIMAL_POINT);
}

function _formatIntegerNumber(number: number): string {
  return number.toLocaleString();
}
