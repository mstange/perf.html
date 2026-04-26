/**
 * CLI tool for experimenting with in-memory profile compression.
 *
 * Loads a profile, runs it through compressProfile/uncompressProfile, reports
 * the size reduction, verifies the round-trip is lossless, and optionally
 * writes the compressed form to disk.
 *
 * Build and run:
 *   yarn build-node-tools
 *   node node-tools-dist/profile-compress.js --input profile.json [--output out.pfcb]
 *   node node-tools-dist/profile-compress.js --input profile.json --analyze
 *   node node-tools-dist/profile-compress.js --input profile.json --output-skeleton skeleton.json
 *   node node-tools-dist/profile-compress.js --hash <profile-store-hash>
 */

import fs from 'fs';
import minimist from 'minimist';
import parser from 'stream-json/parser.js';
import Assembler from 'stream-json/assembler.js';

import { unserializeProfileOfArbitraryFormat } from 'firefox-profiler/profile-logic/process-profile';
import { GOOGLE_STORAGE_BUCKET } from 'firefox-profiler/app-logic/constants';

import type { Profile } from 'firefox-profiler/types/profile';
import { compress as gzEncode } from 'firefox-profiler/utils/gz';
import {
  compressProfile,
  uncompressProfile,
} from 'firefox-profiler/profile-logic/compress';
import { checkLossless } from 'firefox-profiler/utils/check-lossless';
import { reportBinaryPotential } from 'firefox-profiler/profile-logic/compress/binary-analysis';
import { decode as decodeBinaryContainer } from 'firefox-profiler/profile-logic/compress/json-slabs';

type ProfileSource =
  | {
      type: 'HASH';
      hash: string;
    }
  | {
      type: 'FILE';
      file: string;
    };

interface CliOptions {
  profile: ProfileSource;
  outputFile?: string;
  outputSkeletonFile?: string;
  analyze: boolean;
}

export function getProfileUrlForHash(hash: string): string {
  // See https://cloud.google.com/storage/docs/access-public-data
  // The URL is https://storage.googleapis.com/<BUCKET>/<FILEPATH>.
  // https://<BUCKET>.storage.googleapis.com/<FILEPATH> seems to also work but
  // is not documented nowadays.

  // By convention, "profile-store" is the name of our bucket, and the file path
  // is the hash we receive in the URL.
  return `https://storage.googleapis.com/${GOOGLE_STORAGE_BUCKET}/${hash}`;
}

async function fetchProfileWithHash(hash: string): Promise<Profile> {
  const response = await fetch(getProfileUrlForHash(hash));
  const serializedProfile = await response.json();
  return unserializeProfileOfArbitraryFormat(serializedProfile);
}

async function loadProfileFromFile(path: string): Promise<Profile> {
  // V8 caps strings at ~512 MiB. For files near or beyond that, the
  // `readFileSync` + TextDecoder + JSON.parse path fails with
  // ERR_STRING_TOO_LONG. Stream-parse instead so we never materialize the
  // file as a single string — the resulting JS object has no such limit.
  const sizeBytes = fs.statSync(path).size;
  const STREAM_THRESHOLD = 256 * 1024 * 1024; // 256 MiB; well below the 512 MiB string cap

  if (sizeBytes < STREAM_THRESHOLD) {
    const uint8Array = fs.readFileSync(path, null);
    return unserializeProfileOfArbitraryFormat(uint8Array.buffer); // accepts ArrayBuffer
  }

  const obj = await streamParseJsonFile(path);
  return unserializeProfileOfArbitraryFormat(obj);
}

function streamParseJsonFile(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(path);
    const tokenStream = fileStream.pipe(parser.asStream());
    const assembler = Assembler.connectTo(tokenStream);
    assembler.on('done', (a) => resolve(a.current));
    fileStream.on('error', reject);
    tokenStream.on('error', reject);
  });
}

async function loadProfile(source: ProfileSource): Promise<Profile> {
  switch (source.type) {
    case 'HASH':
      return fetchProfileWithHash(source.hash);
    case 'FILE':
      return loadProfileFromFile(source.file);
    default:
      return source; // unreachable; satisfies TypeScript exhaustiveness
  }
}

const STRING_FORMATS = new Set(['string', 'url', 'sanitized-string', 'file-path']);
const NUMERIC_FORMATS = new Set([
  'time', 'duration', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds',
  'integer', 'bytes', 'percentage', 'decimal', 'unique-string', 'flow-id',
  'terminating-flow-id',
]);

/**
 * Normalises a profile so that the compressor can guarantee a lossless
 * round-trip.  Rules we enforce:
 *
 * 1. Marker schema field values must match their declared format type:
 *    - string/url/sanitized-string/file-path  → coerce to String(v)
 *    - numeric formats (time, integer, …)      → coerce to Number(v)
 *
 * 2. Phase-dependent sentinel values in the marker table:
 *    - phase 0 (Instant):       endTime must be 0
 *    - phase 2 (IntervalStart): endTime must be null
 *    - phase 3 (IntervalEnd):   startTime must be null
 *
 * Profiles that already satisfy these rules are unchanged.
 */
function canonicalizeProfile(profile: Profile): void {
  const schemaByName = new Map(
    profile.meta.markerSchema.map((s) => [s.name, s])
  );
  for (const thread of profile.threads) {
    const markers = thread.markers;
    for (let i = 0; i < markers.length; i++) {
      // Rule 2: phase-dependent sentinels.
      const phase = markers.phase[i];
      if (phase === 0) {
        markers.endTime[i] = 0;
      } else if (phase === 2) {
        markers.endTime[i] = null;
      } else if (phase === 3) {
        markers.startTime[i] = null;
      }

      // Rule 1: schema field type coercions.
      const data = markers.data[i] as Record<string, unknown> | null;
      if (!data || typeof data.type !== 'string') continue;
      const schema = schemaByName.get(data.type);
      if (!schema) continue;
      for (const field of schema.fields) {
        const value = data[field.key];
        if (value === undefined) continue;
        if (STRING_FORMATS.has(field.format as string) && typeof value !== 'string') {
          data[field.key] = String(value);
        } else if (NUMERIC_FORMATS.has(field.format as string) && typeof value !== 'number') {
          data[field.key] = Number(value);
        }
      }
    }
  }
}

export async function run(options: CliOptions) {
  const profile: Profile = await loadProfile(options.profile);
  canonicalizeProfile(profile);
  const originalSize = new TextEncoder().encode(
    JSON.stringify(profile)
  ).byteLength;
  const buffer = compressProfile(profile);
  const compressedSize = buffer.byteLength;
  const gzBuffer = await gzEncode(buffer);
  const gzSize = gzBuffer.byteLength;
  const recoveredProfile = uncompressProfile(buffer);
  console.log(
    `Compression: ${(originalSize / 1000 / 1000).toFixed(2)} MB -> ${(compressedSize / 1000 / 1000).toFixed(2)} MB (${((100 * compressedSize) / originalSize).toFixed(1)}%) / ${(gzSize / 1000 / 1000).toFixed(2)} MB after gzip`
  );

  // Write before checking losslessness so the file is available for inspection on failure.
  if (options.outputFile !== undefined) {
    if (options.outputFile.endsWith('.gz')) {
      fs.writeFileSync(options.outputFile, gzBuffer);
    } else {
      fs.writeFileSync(options.outputFile, buffer);
    }
  }

  if (options.outputSkeletonFile !== undefined) {
    fs.writeFileSync(options.outputSkeletonFile, decodeBinaryContainer(buffer).jsonBytes);
  }

  if (options.analyze) {
    reportBinaryPotential(buffer);
  }

  // Allow sub-nanosecond deviances (1 ns = 1e-6 ms) from float rounding at ns precision.
  checkLossless(profile, recoveredProfile, '', 1e-6);
}

export function makeOptionsFromArgv(processArgv: string[]): CliOptions {
  const argv = minimist(processArgv.slice(2));

  const hasSamplesHash = 'hash' in argv && typeof argv.hash === 'string';
  const hasSamplesFile = 'input' in argv && typeof argv.input === 'string';

  if (!hasSamplesHash && !hasSamplesFile) {
    throw new Error('Either --input or --hash must be supplied');
  }
  if (hasSamplesHash && hasSamplesFile) {
    throw new Error('Only one of --input or --hash can be supplied');
  }

  const profile: ProfileSource = hasSamplesHash
    ? { type: 'HASH', hash: argv.hash }
    : { type: 'FILE', file: argv.input };

  return {
    profile,
    outputFile: argv.output,
    outputSkeletonFile: argv['output-skeleton'],
    analyze: !!argv.analyze,
  };
}

// Run when invoked directly; skip when imported (e.g. in tests).
if (!module.parent) {
  try {
    const options = makeOptionsFromArgv(process.argv);
    // Re-throw so async errors surface as uncaught exceptions rather than silent rejections.
    run(options).catch((err) => {
      throw err;
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
