/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function _roundDownPow2(n) {
  // n must be > 0
  return 1 << (31 - Math.clz32(n));
}

function _clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Returns a ReadableStream which emits the original array data in chunks, with
// a chunk size chosen to create at least 100 chunks.
function _getChunkStream(arrayData, onReadProgress) {
  const totalByteCount = arrayData.length;
  const MIN_CHUNK_SIZE = 1; // 1 byte
  const MAX_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MiB
  const chunkSize = _roundDownPow2(
    _clamp(Math.floor(totalByteCount / 100), MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
  );
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= totalByteCount) {
        controller.close();
        return;
      }
      const chunkData = arrayData.subarray(offset, offset + chunkSize);
      offset += chunkData.length;
      controller.enqueue(chunkData);
      if (onReadProgress) {
        onReadProgress(offset, totalByteCount);
      }
    },
  });
}

async function _pipeStreamToParent(stream) {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        postMessage({ type: 'CHUNK', chunk: value }, [value.buffer]);
      }
    }
  } finally {
    reader.releaseLock();
  }
  postMessage({ type: 'CLOSE' });
}

function _sendProgressToParent(bytesRead, bytesTotal) {
  postMessage({ type: 'READ_PROGRESS', bytesRead, bytesTotal });
}

onmessage = async (e) => {
  const { kind, arrayData } = e.data;
  // Create a stream that emits the contents of the original array in chunks,
  // so that we can stream the compressed data to the parent, and it can stream
  // it to a server or to a file incrementally while compression is still ongoing.
  // We could even use this to show compression progress in the UI.
  const chunkStream = _getChunkStream(arrayData, _sendProgressToParent);
  if (kind === 'compress') {
    const compressionStream = new CompressionStream('gzip');
    await _pipeStreamToParent(chunkStream.pipeThrough(compressionStream));
  } else if (kind === 'decompress') {
    const decompressionStream = new DecompressionStream('gzip');
    await _pipeStreamToParent(chunkStream.pipeThrough(decompressionStream));
  } else {
    throw new Error('unknown message');
  }
};
