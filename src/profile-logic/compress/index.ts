/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Profile } from '../../types/profile';
import { compressMarkers, uncompressMarkers } from './markers';
import { Builder, decode as containerDecode } from './binary-container';

// ── Phase 1: profile-aware transformations ──────────────────────────────────

// Transforms the profile into an intermediate where specific arrays are
// replaced by TypedArrays or { $arr, $values: TypedArray } wrappers. Starts as
// identity. Add explicit handlers here (and matching decoders in phase1Decode)
// as arrays are moved to binary slabs.
function phase1(p: unknown): unknown {
  return p;
}

// Inverse of phase1: reconstruct original arrays from TypedArrays that Phase 2
// has already substituted back in. Add a decoder for each Phase 1 handler.
function phase1Decode(p: unknown): unknown {
  return p;
}

// ── Phase 2: TypedArray ↔ { $bin: N } ──────────────────────────────────────

function makeReplacer(builder: Builder) {
  return function (_key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return builder.addSlabU8(value);
    if (value instanceof Int32Array) return builder.addSlabI32(value);
    if (value instanceof Float64Array) return builder.addSlabF64(value);
    return value;
  };
}

function makeReviver(slabs: Array<Uint8Array | Int32Array | Float64Array>) {
  return function (_key: string, value: unknown): unknown {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      '$bin' in (value as Record<string, unknown>)
    ) {
      return slabs[(value as { $bin: number }).$bin];
    }
    return value;
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function compressProfile(profile: Profile): Uint8Array<ArrayBuffer> {
  let p: unknown = compressMarkers(profile) as unknown;
  p = phase1(p);

  const builder = new Builder();
  const jsonStr = JSON.stringify(p, makeReplacer(builder));
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const chunks = builder.finish(jsonBytes);

  const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out as Uint8Array<ArrayBuffer>;
}

export function uncompressProfile(buffer: Uint8Array): Profile {
  const { jsonBytes, slabs } = containerDecode(buffer);
  let p: unknown = JSON.parse(
    new TextDecoder().decode(jsonBytes),
    makeReviver(slabs)
  );
  p = phase1Decode(p);
  return uncompressMarkers(p as any) as unknown as Profile;
}
