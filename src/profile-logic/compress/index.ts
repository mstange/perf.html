/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile } from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import { encode as binaryEncode, decode as binaryDecode } from './binary-container';

/**
 * A playground to experiment with various ways to represent in-memory
 * profile data more compactly.
 *
 * We implement both compressProfile and uncompressProfile so that we
 * can easily check the implementation for correctness.
 *
 * Ideas:
 * - Elide columns which only contain zeros / nulls
 * - In integer+null columns, use -1 instead of null
 * - Markers:
 *   - separate column for marker type (index into schemas), with bits for which fields have values, and concatenatedStringFields + concatenatedNumberFields + concatenatedJSONFields arrays
 *   - all string-typed fields should use string indexes (not just UniqueString)
 * - Use a binary format like flexbuffers instead of JSON (saves conversion to big string and having to look at all bytes (JSON parsing))
 *   - for this we'd like long arrays with numbers to have only numbers and not nulls
 * - Stack table: Reuse common frame subsequences
 * - Any column with numbers: Explore delta / delta-of-delta
 * - Any column with integers: see above + LEB128 / ULEB128
 *
 * The (compressed) in-memory representation should allow the following
 * questions to be answered efficiently:
 * - What are the processes / threads in this profile (with names and time ranges)?
 * - How many markers are on each thread?
 *
 * Goals:
 * - Primary: Smaller in-memory representation
 * - Primary: Reduced load times (avoid having to look at all the bytes to answer any questions)
 * - Secondary: Smaller gzipped on-disk representation
 */

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p = profile;

  p = compressMarkers(p) as unknown as Profile;

  return binaryEncode(p) as Uint8Array<ArrayBuffer>;
}

export function uncompressProfile(buffer: Uint8Array): Profile {
  let p = binaryDecode(buffer) as any;

  p = uncompressMarkers(p);

  return p as any
}
