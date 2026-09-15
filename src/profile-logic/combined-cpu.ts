/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Milliseconds, SamplesTable } from 'firefox-profiler/types';
import { bisectionLeft } from '../utils/bisect';

/**
 * Represents CPU usage over time for a single thread.
 */
export type CpuRatioTimeSeries = {
  time: Float64Array<ArrayBuffer>;
  cpuRatio: Float64Array;
  maxCpuRatio: number;
  length: number;
};

/**
 * A binary min-heap of thread indexes, ordered by a key which the heap looks
 * up on demand through the `keyOf` function it was given. That means a
 * thread's key may change while the heap is in use, as long as it changes
 * only while the thread is not in the heap: pop the thread, change its key,
 * then push it back.
 */
class ThreadIndexMinHeap {
  _threadIndexes: Int32Array;
  _size: number;
  _keyOf: (threadIndex: number) => number;

  constructor(capacity: number, keyOf: (threadIndex: number) => number) {
    this._threadIndexes = new Int32Array(capacity);
    this._size = 0;
    this._keyOf = keyOf;
  }

  get size(): number {
    return this._size;
  }

  // Returns the thread index with the lowest key. Only call this on a
  // non-empty heap.
  peek(): number {
    return this._threadIndexes[0];
  }

  push(threadIndex: number) {
    const threadIndexes = this._threadIndexes;
    const key = this._keyOf(threadIndex);
    let child = this._size++;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this._keyOf(threadIndexes[parent]) <= key) {
        break;
      }
      threadIndexes[child] = threadIndexes[parent];
      child = parent;
    }
    threadIndexes[child] = threadIndex;
  }

  // Removes and returns the thread index with the lowest key. Only call this
  // on a non-empty heap.
  pop(): number {
    const threadIndexes = this._threadIndexes;
    const lowest = threadIndexes[0];
    const moved = threadIndexes[--this._size];
    const size = this._size;
    if (size > 0) {
      const key = this._keyOf(moved);
      let parent = 0;
      for (;;) {
        let child = parent * 2 + 1;
        if (child >= size) {
          break;
        }
        if (
          child + 1 < size &&
          this._keyOf(threadIndexes[child + 1]) <
            this._keyOf(threadIndexes[child])
        ) {
          child++;
        }
        if (this._keyOf(threadIndexes[child]) >= key) {
          break;
        }
        threadIndexes[parent] = threadIndexes[child];
        parent = child;
      }
      threadIndexes[parent] = moved;
    }
    return lowest;
  }
}

/**
 * Combines CPU usage data from multiple threads into a single timeline.
 *
 * This function takes CPU ratio data from multiple threads, each with potentially
 * different sampling times, and creates a unified timeline where CPU ratios are
 * summed. The result can exceed 1.0 when multiple threads are active simultaneously.
 *
 * The algorithm:
 * 1. Maintains a cursor for each thread tracking the current sample index
 * 2. Processes all sample times in ascending order, taking the next-lowest time
 *    from a min-heap of the threads' cursors
 * 3. For each time point, sums CPU ratios from threads that are active at that time
 * 4. A thread is considered active only between its first and last sample times
 *
 * Note: cpuRatio[i] represents CPU usage between time[i-1] and time[i], so we don't
 * extend a thread's CPU usage beyond its last sample time.
 *
 * @param threadSamples - Array of SamplesTable objects, one per thread
 * @param rangeStart - Optional start time to filter samples (inclusive)
 * @param rangeEnd - Optional end time to filter samples (exclusive)
 * @returns Combined CPU data with unified time array and summed CPU ratios,
 *          or null if no threads have CPU data
 */
export function combineCPUDataFromThreads(
  threadSamples: SamplesTable[],
  rangeStart?: number,
  rangeEnd?: number
): CpuRatioTimeSeries | null {
  // Filter threads that have CPU ratio data.
  // We require at least two samples per thread; the first sample's CPU ratio
  // is meaningless. threadCPUPercent[1] is the CPU percentage between
  // samples.time[0] and samples.time[1].
  const threadsWithCPU: CpuRatioTimeSeries[] = [];
  for (const samples of threadSamples) {
    if (samples.hasCPUDeltas && samples.time.length >= 2) {
      let time = samples.time;
      let cpuRatio = Float64Array.from(
        samples.threadCPUPercent.subarray(0, samples.length),
        (v) => v / 100
      );
      let length = samples.length;

      if (rangeStart !== undefined && rangeEnd !== undefined) {
        const startIndex = bisectionLeft(samples.time, rangeStart);
        const endIndex = bisectionLeft(samples.time, rangeEnd, startIndex);

        if (startIndex < endIndex) {
          time = samples.time.slice(startIndex, endIndex);
          cpuRatio = Float64Array.from(
            samples.threadCPUPercent.subarray(startIndex, endIndex),
            (v) => v / 100
          );
          length = endIndex - startIndex;
        } else {
          continue;
        }
      }

      threadsWithCPU.push({
        time,
        cpuRatio,
        maxCpuRatio: Infinity,
        length,
      });
    }
  }

  if (threadsWithCPU.length === 0) {
    return null;
  }

  const threadCount = threadsWithCPU.length;
  const cursors = new Uint32Array(threadCount);
  const combinedTime: Milliseconds[] = [];
  const combinedCPURatio: number[] = [];
  let combinedMaxCpuRatio = 0;

  const timeAtCursor = (threadIdx: number) =>
    threadsWithCPU[threadIdx].time[cursors[threadIdx]];

  // Visit the threads in ascending sample-time order, rather than scanning
  // every thread at every time point: that scan makes the merge quadratic in
  // the thread count, which is far too slow for system-wide recordings, where
  // ten thousand threads is not unusual.
  const heap = new ThreadIndexMinHeap(threadCount, timeAtCursor);
  for (let threadIdx = 0; threadIdx < threadCount; threadIdx++) {
    heap.push(threadIdx);
  }

  // The sum of cpuRatio[cursor] over the threads which have started but not
  // finished, maintained incrementally: it only changes when a cursor moves.
  // A thread at cursor 0 contributes nothing because its first CPU ratio
  // covers time before its first sample.
  let sumCPURatio = 0;

  while (heap.size > 0) {
    const sampleTime = timeAtCursor(heap.peek());

    combinedTime.push(sampleTime);
    combinedCPURatio.push(sumCPURatio);
    if (sumCPURatio > combinedMaxCpuRatio) {
      combinedMaxCpuRatio = sumCPURatio;
    }

    // A thread can be pushed back with the same time. Consume all such samples
    // before emitting the next point; their zero-duration ratios are ignored.
    while (heap.size > 0 && timeAtCursor(heap.peek()) === sampleTime) {
      const threadIdx = heap.pop();
      const thread = threadsWithCPU[threadIdx];
      const cursor = cursors[threadIdx];
      if (cursor > 0) {
        sumCPURatio -= thread.cpuRatio[cursor];
      }
      const newCursor = cursor + 1;
      cursors[threadIdx] = newCursor;
      if (newCursor < thread.time.length) {
        sumCPURatio += thread.cpuRatio[newCursor];
        heap.push(threadIdx);
      }
    }
  }

  return {
    time: Float64Array.from(combinedTime),
    cpuRatio: Float64Array.from(combinedCPURatio),
    maxCpuRatio: combinedMaxCpuRatio,
    length: combinedTime.length,
  };
}
