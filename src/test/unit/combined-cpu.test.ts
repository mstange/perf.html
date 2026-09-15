/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { combineCPUDataFromThreads } from 'firefox-profiler/profile-logic/combined-cpu';
import type { SamplesTable } from 'firefox-profiler/types';

function createSamplesTable(time: number[], cpuRatio: number[]): SamplesTable {
  // threadCPUPercent has length + 1 elements; the extra element covers "after last sample"
  const percentValues = cpuRatio.map((v) => Math.round(v * 100));
  percentValues.push(0);
  return {
    time: Float64Array.from(time),
    threadCPUPercent: Uint8Array.from(percentValues),
    hasCPUDeltas: true,
    // Other required fields (stubbed for test purposes)
    stack: new Array(time.length).fill(null),
    length: time.length,
    weight: null,
    weightType: 'samples',
    category: new Uint8Array(time.length),
    subcategory: new Uint8Array(time.length),
  };
}

describe('combineCPUDataFromThreads', function () {
  it('returns null when given empty array', function () {
    const result = combineCPUDataFromThreads([]);
    expect(result).toBeNull();
  });

  it('returns single thread data unchanged for one thread', function () {
    const samples = [createSamplesTable([0, 100, 200], [0.0, 0.5, 0.8])];

    const result = combineCPUDataFromThreads(samples);

    expect(result).not.toBeNull();
    expect(Array.from(result!.time)).toEqual([0, 100, 200]);
    expect(Array.from(result!.cpuRatio)).toEqual([0.0, 0.5, 0.8]);
  });

  it('combines two threads with same sample times', function () {
    const samples = [
      createSamplesTable([0, 100, 200], [0, 0.5, 0.3]),
      createSamplesTable([0, 100, 200], [0, 0.4, 0.5]),
    ];

    const result = combineCPUDataFromThreads(samples);

    expect(result).not.toBeNull();
    expect(Array.from(result!.time)).toEqual([0, 100, 200]);
    // The sum of the threads' ratios is maintained incrementally, so it is
    // subject to floating point rounding and is not exactly 0.8 here.
    expect(Array.from(result!.cpuRatio)).toEqual([0, 0.9, expect.closeTo(0.8)]);
  });

  it('combines threads with different sample times', function () {
    const samples = [
      createSamplesTable([0, 100, 200], [0.0, 0.5, 0.8]),
      createSamplesTable([50, 150, 250], [0.0, 0.3, 0.4]),
    ];

    const result = combineCPUDataFromThreads(samples);

    expect(result).not.toBeNull();
    // Should have all unique time points
    expect(Array.from(result!.time)).toEqual([0, 50, 100, 150, 200, 250]);

    //       0: thread1=bef, thread2=bef → 0.0
    //   0- 50: thread1=0.5, thread2=bef → 0.5
    //  50-100: thread1=0.5, thread2=0.3 → 0.8
    // 100-150: thread1=0.8, thread2=0.3 → 1.1
    // 150-200: thread1=0.8, thread2=0.4 → 1.2
    // 200-250: thread1=end, thread2=0.4 → 0.4
    const expected = [0.0, 0.5, 0.8, 1.1, 1.2, 0.4];
    const actual = Array.from(result!.cpuRatio);
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBeCloseTo(expected[i], 10);
    }
  });

  it('handles threads with non-overlapping time ranges', function () {
    const samples = [
      createSamplesTable([0, 10, 20], [0.0, 0.3, 0.5]),
      createSamplesTable([30, 40, 50], [0.0, 0.4, 0.6]),
    ];

    const result = combineCPUDataFromThreads(samples);

    expect(result).not.toBeNull();
    expect(Array.from(result!.time)).toEqual([0, 10, 20, 30, 40, 50]);

    // At times 0, 10, 20: only thread1 has samples
    // At times 30, 40, 50: thread1 has ended (30 > 20), only thread2 contributes
    expect(Array.from(result!.cpuRatio)).toEqual([
      0.0, 0.3, 0.5, 0.0, 0.4, 0.6,
    ]);
  });

  it('emits repeated sample times once and ignores zero-duration ratios', function () {
    const samples = [
      createSamplesTable([0, 10, 10, 20, 20], [0, 0.25, 1, 0.5, 1]),
      createSamplesTable([0, 10, 10, 15, 20], [0, 0.5, 1, 0.25, 0.75]),
    ];

    const result = combineCPUDataFromThreads(samples);

    expect(result).not.toBeNull();
    expect(Array.from(result!.time)).toEqual([0, 10, 15, 20]);
    expect(Array.from(result!.cpuRatio)).toEqual([0, 0.75, 0.75, 1.25]);
    expect(result!.length).toBe(4);
    expect(result!.maxCpuRatio).toBe(1.25);
  });

  // combineCPUDataFromThreads walks the threads' sample times with a min-heap
  // and keeps the sum of the active threads' ratios incrementally, which is
  // considerably harder to follow than scanning every thread at every time
  // point. Check it against a scanning implementation on random input, with
  // enough threads and repeated timestamps to exercise the heap.
  it('agrees with a straightforward implementation', function () {
    function combineByScanning(threads: SamplesTable[]) {
      const times = threads.map((t) => Array.from(t.time));
      const ratios = threads.map((t) =>
        Array.from(t.threadCPUPercent!.subarray(0, t.length), (v) => v / 100)
      );
      const cursors = new Array(threads.length).fill(0);
      const combinedTime: number[] = [];
      const combinedCPURatio: number[] = [];

      for (;;) {
        let sampleTime = Infinity;
        for (let i = 0; i < threads.length; i++) {
          if (cursors[i] < times[i].length) {
            sampleTime = Math.min(sampleTime, times[i][cursors[i]]);
          }
        }
        if (sampleTime === Infinity) {
          break;
        }

        let sum = 0;
        for (let i = 0; i < threads.length; i++) {
          const cursor = cursors[i];
          if (cursor === times[i].length) {
            continue;
          }
          if (cursor > 0) {
            sum += ratios[i][cursor];
          }
          while (times[i][cursors[i]] === sampleTime) {
            cursors[i]++;
          }
        }

        combinedTime.push(sampleTime);
        combinedCPURatio.push(sum);
      }

      return { time: combinedTime, cpuRatio: combinedCPURatio };
    }

    // A tiny deterministic generator, so a failure is reproducible.
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const threads: SamplesTable[] = [];
    for (let i = 0; i < 40; i++) {
      const sampleCount = 2 + Math.floor(random() * 30);
      // Start times differ per thread and steps are small whole numbers, so
      // threads share plenty of timestamps.
      let time = Math.floor(random() * 5);
      const times: number[] = [];
      const ratios: number[] = [];
      for (let j = 0; j < sampleCount; j++) {
        times.push(time);
        // A step of 0 gives a thread two samples at the same time.
        time += Math.floor(random() * 4);
        ratios.push(Math.round(random() * 100) / 100);
      }
      threads.push(createSamplesTable(times, ratios));
    }

    const result = combineCPUDataFromThreads(threads);
    const expected = combineByScanning(threads);

    expect(result).not.toBeNull();
    expect(Array.from(result!.time)).toEqual(expected.time);
    expect(result!.cpuRatio.length).toBe(expected.cpuRatio.length);
    for (let i = 0; i < expected.cpuRatio.length; i++) {
      expect(result!.cpuRatio[i]).toBeCloseTo(expected.cpuRatio[i], 10);
    }
    expect(result!.maxCpuRatio).toBeCloseTo(Math.max(...expected.cpuRatio), 10);
  });
});
