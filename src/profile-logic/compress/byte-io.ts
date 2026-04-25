/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ── ByteWriter ─────────────────────────────────────────────────────────────

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private grow(needed: number): void {
    if (this.pos + needed <= this.buf.length) return;
    let cap = this.buf.length;
    do {
      cap *= 2;
    } while (this.pos + needed > cap);
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeUint8(v: number): void {
    this.grow(1);
    this.buf[this.pos++] = v;
  }

  writeUint32LE(v: number): void {
    this.grow(4);
    this.view.setUint32(this.pos, v >>> 0, /* littleEndian */ true);
    this.pos += 4;
  }

  writeBytes(src: Uint8Array): void {
    this.grow(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  // Safe for any 53-bit non-negative integer; uses division instead of >>> to
  // avoid 32-bit truncation for values above 2^32.
  writeULEB128(v: number): void {
    this.grow(8); // ceil(53/7) = 8 bytes max
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }

  // Safe for any 53-bit signed integer; uses Math.floor division for arithmetic
  // right-shift to avoid 32-bit truncation.
  writeSLEB128(v: number): void {
    this.grow(10); // ceil(53/7) + 1 = 9 bytes max
    while (true) {
      const byte = v & 0x7f;
      v = Math.floor(v / 128);
      const done =
        (v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0);
      this.buf[this.pos++] = done ? byte : byte | 0x80;
      if (done) break;
    }
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ── ByteReader ─────────────────────────────────────────────────────────────

export class ByteReader {
  private pos: number;
  private view: DataView;

  constructor(
    private readonly buf: Uint8Array,
    offset = 0
  ) {
    this.pos = offset;
    // DataView coordinates are relative to buf's own byteOffset within the
    // underlying ArrayBuffer, so reads at this.pos map correctly to buf[this.pos].
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readUint8(): number {
    return this.buf[this.pos++];
  }

  readUint32LE(): number {
    const v = this.view.getUint32(this.pos, /* littleEndian */ true);
    this.pos += 4;
    return v;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  // Safe for any 53-bit integer; uses multiplication to reconstruct high bits
  // without relying on bit-shift operators that truncate to 32 bits.
  readULEB128(): number {
    let result = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return result;
  }

  // Safe for any 53-bit signed integer; sign-extends after the final byte.
  readSLEB128(): number {
    let result = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    if (byte & 0x40) result -= multiplier; // sign-extend
    return result;
  }

  get offset(): number {
    return this.pos;
  }

  get length(): number {
    return this.buf.length;
  }
}
