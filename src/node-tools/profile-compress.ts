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
import { decode as decodeBinaryContainer } from 'firefox-profiler/profile-logic/compress/jslabs';

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
  const uint8Array = fs.readFileSync(path, null);
  return unserializeProfileOfArbitraryFormat(uint8Array.buffer); // accepts ArrayBuffer, not Uint8Array
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

export async function run(options: CliOptions) {
  const profile: Profile = await loadProfile(options.profile);
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

  checkLossless(profile, recoveredProfile);
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
