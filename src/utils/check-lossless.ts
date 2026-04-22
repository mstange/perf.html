/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Recursively compares `original` and `recovered`, exiting with a descriptive
 * error on the first mismatch. More useful than assert.deepEqual because it
 * reports the exact dotted path and values that differ.
 */
export function checkLossless(
  original: any,
  recovered: any,
  path: string = ''
) {
  const loc = path || 'root';
  if (original === null || original === undefined || typeof original !== 'object') {
    if (original !== recovered) {
      console.error(
        `Value mismatch at ${loc}: ${JSON.stringify(original)} vs ${JSON.stringify(recovered)}`
      );
      process.exit(1);
    }
    return;
  }
  if (recovered === null || recovered === undefined || typeof recovered !== 'object') {
    console.error(`Expected object at ${loc}, got: ${JSON.stringify(recovered)}`);
    process.exit(1);
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(recovered)) {
      console.error(`Expected array at ${loc}, got non-array`);
      process.exit(1);
    }
    if (original.length !== recovered.length) {
      console.error(
        `Array length mismatch at ${loc}: ${original.length} vs ${recovered.length}`
      );
      process.exit(1);
    }
    for (let i = 0; i < original.length; i++) {
      checkLossless(original[i], recovered[i], `${path}[${i}]`);
    }
    return;
  }
  const origKeys = new Set(Object.keys(original));
  const recKeys = new Set(Object.keys(recovered));
  for (const key of origKeys) {
    if (!recKeys.has(key)) {
      console.error(`Key missing in recovered at ${loc}: "${key}"`);
      process.exit(1);
    }
  }
  for (const key of recKeys) {
    if (!origKeys.has(key)) {
      console.error(`Extra key in recovered at ${loc}: "${key}"`);
      process.exit(1);
    }
  }
  for (const key of origKeys) {
    checkLossless(original[key], recovered[key], `${path}.${key}`);
  }
}
