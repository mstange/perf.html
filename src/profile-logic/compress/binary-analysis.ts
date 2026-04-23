/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Analysis tool for compressed profile buffers.
 *
 * Binary format (magic "PFCB"): reports actual per-section sizes alongside
 *   the path each section came from (recovered by walking the JSON skeleton).
 *
 * Legacy JSON format: estimates LEB128 savings from numeric arrays.
 */

// ── Binary-format analysis ─────────────────────────────────────────────────

function walkForBinPaths(
  node: unknown,
  path: string,
  result: Map<number, string>
): void {
  if (Array.isArray(node)) {
    (node as unknown[]).forEach((item, i) =>
      walkForBinPaths(item, `${path}[${i}]`, result)
    );
  } else if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // Detect $arr wrapper and record the binary section index if present.
    if ('$arr' in obj && '$values' in obj) {
      const values = obj.$values;
      if (
        values !== null &&
        typeof values === 'object' &&
        !Array.isArray(values) &&
        '$bin' in (values as Record<string, unknown>) &&
        typeof (values as Record<string, unknown>).$bin === 'number'
      ) {
        result.set((values as { $bin: number }).$bin, path);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      walkForBinPaths(v, path ? `${path}.${k}` : k, result);
    }
  }
}

function reportBinaryFormat(buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 4; // already verified magic

  const version = view.getUint32(pos, true);
  pos += 4;
  if (version !== 2) throw new Error(`Unknown binary format version ${version}`);

  const jsonLen = view.getUint32(pos, true);
  pos += 4;
  const jsonStr = new TextDecoder().decode(buffer.subarray(pos, pos + jsonLen));
  pos += jsonLen;

  const sectionCount = view.getUint32(pos, true);
  pos += 4;

  const sectionLengths: number[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const len = view.getUint32(pos, true);
    pos += 4 + len;
    sectionLengths.push(len);
  }

  const skeleton = JSON.parse(jsonStr) as unknown;
  const pathByIndex = new Map<number, string>();
  walkForBinPaths(skeleton, '', pathByIndex);

  type SectionReport = { path: string; bytes: number };
  const reports: SectionReport[] = sectionLengths.map((bytes, i) => ({
    path: pathByIndex.get(i) ?? `(section ${i})`,
    bytes,
  }));
  reports.sort((a, b) => b.bytes - a.bytes);

  const totalSectionBytes =
    4 + sectionLengths.reduce((sum, n) => sum + 4 + n, 0);
  const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;
  const COL_PATH = 60;
  const COL_N = 10;
  const divider = '  ' + '-'.repeat(COL_PATH + COL_N);

  console.log('\nBinary format breakdown (top 25 sections by size):');
  console.log('  ' + 'Path'.padEnd(COL_PATH) + 'LEB128'.padStart(COL_N));
  console.log(divider);
  for (const r of reports.slice(0, 25)) {
    console.log('  ' + r.path.padEnd(COL_PATH) + mb(r.bytes).padStart(COL_N));
  }
  if (reports.length > 25) {
    console.log(`  ... ${reports.length - 25} more sections (included in totals)`);
  }
  console.log(divider);
  console.log(`\n  JSON skeleton:   ${mb(jsonLen)}`);
  console.log(`  Binary sections: ${mb(totalSectionBytes)} (${sectionCount} arrays)`);
  console.log(`  Total:           ${mb(buffer.length)}`);
}

// ── Legacy JSON-format analysis (estimate) ─────────────────────────────────

function unsignedLeb128Size(n: number): number {
  if (n < 0x80) return 1;
  if (n < 0x4000) return 2;
  if (n < 0x200000) return 3;
  if (n < 0x10000000) return 4;
  return n < 0x800000000 ? 5 : 6;
}

function leb128Size(n: number, signed: boolean): number {
  if (signed) {
    return unsignedLeb128Size(n >= 0 ? 2 * n : -2 * n - 1);
  }
  return unsignedLeb128Size(n);
}

type ArrayReport = {
  path: string;
  count: number;
  jsonBytes: number;
  leb128Bytes: number;
};

function analyzeArray(path: string, arr: unknown[]): ArrayReport | null {
  if (arr.length === 0) return null;
  let hasNegative = false;
  for (const v of arr) {
    if (v === null) continue;
    if (typeof v !== 'number') return null;
    if (v < 0) hasNegative = true;
  }
  let leb128Bytes = 0;
  for (const v of arr) {
    leb128Bytes +=
      v === null ? 1 : leb128Size(v as number, hasNegative);
  }
  const jsonBytes = JSON.stringify(arr).length;
  return { path, count: arr.length, jsonBytes, leb128Bytes };
}

function walkForArrays(
  node: unknown,
  path: string,
  results: ArrayReport[]
): void {
  if (Array.isArray(node)) {
    const report = analyzeArray(path, node);
    if (report) {
      results.push(report);
    } else {
      (node as unknown[]).forEach((item, i) =>
        walkForArrays(item, `${path}[${i}]`, results)
      );
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walkForArrays(v, path ? `${path}.${k}` : k, results);
    }
  }
}

function reportJsonEstimate(buffer: Uint8Array): void {
  const json = new TextDecoder().decode(buffer);
  const totalBytes = json.length;
  const obj = JSON.parse(json) as unknown;
  const results: ArrayReport[] = [];
  walkForArrays(obj, '', results);
  results.sort(
    (a, b) => b.jsonBytes - b.leb128Bytes - (a.jsonBytes - a.leb128Bytes)
  );

  let totalJsonArrayBytes = 0;
  let totalLeb128Bytes = 0;
  for (const r of results) {
    totalJsonArrayBytes += r.jsonBytes;
    totalLeb128Bytes += r.leb128Bytes;
  }

  const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;
  const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
  const COL_PATH = 60;
  const COL_N = 9;
  const divider = '  ' + '-'.repeat(COL_PATH + COL_N * 4);

  console.log(
    '\nBinary potential — LEB128 encoding for numeric arrays (top 25 by savings):'
  );
  console.log(
    '  ' +
      'Path'.padEnd(COL_PATH) +
      'Count'.padStart(COL_N) +
      'JSON'.padStart(COL_N) +
      'LEB128'.padStart(COL_N) +
      'Savings'.padStart(COL_N)
  );
  console.log(divider);
  for (const r of results.slice(0, 25)) {
    const savings = r.jsonBytes - r.leb128Bytes;
    console.log(
      '  ' +
        r.path.padEnd(COL_PATH) +
        r.count.toLocaleString().padStart(COL_N) +
        mb(r.jsonBytes).padStart(COL_N) +
        mb(r.leb128Bytes).padStart(COL_N) +
        mb(savings).padStart(COL_N)
    );
  }
  if (results.length > 25) {
    console.log(
      `  ... ${results.length - 25} more arrays (included in totals)`
    );
  }
  const arraySavings = totalJsonArrayBytes - totalLeb128Bytes;
  const nonArrayBytes = totalBytes - totalJsonArrayBytes;
  const estimatedTotal = totalLeb128Bytes + nonArrayBytes;
  console.log(divider);
  console.log(
    `\n  Numeric arrays: ${mb(totalJsonArrayBytes)} JSON → ${mb(totalLeb128Bytes)} LEB128` +
      `  (saves ${mb(arraySavings)}, ${pct(arraySavings, totalJsonArrayBytes)} of array content)`
  );
  console.log(`  Non-numeric content: ${mb(nonArrayBytes)}`);
  console.log(
    `  Estimated binary total: ${mb(totalBytes)} → ${mb(estimatedTotal)}` +
      `  (saves ${mb(totalBytes - estimatedTotal)}, ${pct(totalBytes - estimatedTotal, totalBytes)} overall)`
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

export function reportBinaryPotential(buffer: Uint8Array): void {
  const isBinary =
    buffer[0] === 0x50 &&
    buffer[1] === 0x46 &&
    buffer[2] === 0x43 &&
    buffer[3] === 0x42;

  if (isBinary) {
    reportBinaryFormat(buffer);
  } else {
    reportJsonEstimate(buffer);
  }
}
