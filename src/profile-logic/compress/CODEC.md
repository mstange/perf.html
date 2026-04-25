# Array Codec — `$arr` descriptor format

The array codec is independent of the binary container (see `json-slabs/FORMAT.md`).
A `$arr` wrapper can hold its values either as a binary slab (`{ "$bin": N }`)
or as a plain inline JSON number array.  The descriptor records how to decode
either representation back to the original JavaScript array.

---

## `$arr` Descriptor Values

| `$arr` value | Description | Extra fields |
|---|---|---|
| `'leb128'` | LEB128 integers; optional sign, delta, and scale (see below) | `$length`, `$signed?`, `$delta?`, `$scale?` |
| `'sleb128-null-sentinel'` | SLEB128; `$sentinel` value decodes as `null` | `$length`, `$sentinel` |
| `'sleb128-slide-prefix'` | SLEB128; `$nullSentinel`→`null`, `$slideSentinel`→`i-1`, else value | `$length`, `$nullSentinel`, `$slideSentinel` |
| `'constant-null'` | All values are `null`; no `$values` field | `$length` |

## `leb128` Descriptor Fields

| Field     | Type    | Default | Meaning                                               |
|-----------|---------|---------|-------------------------------------------------------|
| `$length` | number  | —       | Number of elements in the decoded array (required)    |
| `$signed` | `true`  | absent  | Use signed LEB128; absent means unsigned              |
| `$delta`  | `true`  | absent  | Prefix-sum the decoded integers before scaling        |
| `$scale`  | number  | absent  | Multiply every value by this constant (after delta)   |

---

## LEB128 Integer Encoding

Integer arrays are LEB128-encoded to a byte blob stored as a `Uint8Array` slab.
The element count is stored as `$length` in the descriptor; the decoder preallocates
an array of that size rather than growing dynamically.

### Unsigned LEB128 (default, `signed` absent or false)

Each value is split into 7-bit groups from least-significant to most-significant.
Each group becomes one byte; the high bit is set on all bytes except the last.

```
value = 300 = 0b10_0101100
  byte 0: (300 & 0x7F) | 0x80 = 0xAC  (continuation)
  byte 1: (300 >> 7) & 0x7F   = 0x02  (final)
```

### Signed LEB128 (`signed: true`)

Standard signed LEB128 (the same encoding used by DWARF and WebAssembly).
Values are encoded in two's-complement 7-bit groups.  The sign bit of the final
group determines the sign of the decoded value.

```
value = -1
  byte 0: 0x7F  (final; bit 6 = 1 → negative sign extension)

value = -128
  byte 0: 0x80  (continuation)
  byte 1: 0x7F  (final; bit 6 = 1 → negative sign extension)
```

Decode: after reading all bytes, if the high bit of the last byte's 7-bit group
is set, sign-extend by subtracting `2^(7*byteCount)`.

### Large-integer note

JavaScript bitwise operators truncate to 32 bits.  The encoder uses
`Math.floor(v / 128)` instead of `v >> 7`, and the decoder uses
`multiplier *= 128` instead of bit-shifts, so values up to ±2^53 round-trip
correctly.  In practice the largest values are absolute µs timestamps (~4 × 10^9
for a profile an hour into system uptime), which exceed 2^32.

---

## Float64 Encoding

Float arrays are stored as a `Float64Array` slab: each element is 8 bytes, IEEE
754 double-precision, little-endian (`DataView.getFloat64(..., true)`).

---

## Null Handling

When `nulls` is present it is a byte array (each element 0–255) forming a packed
presence bitfield.  Bit `i % 8` (counting from LSB) of byte `i >> 3` is **1**
if element `i` is non-null, **0** if null.  `$values` stores only the non-null
elements in order; null slots are re-inserted at decode time using `count` and
the bitfield.

---

## `leb128` Decode Pipeline

```
1. raw = LEB128-decode $values slab into preallocated array of size $length
         (signed LEB128 if $signed, unsigned otherwise)
2. if $delta:  raw[i] += raw[i-1]  for i = 1 … $length-1
3. if $scale:  raw[i] *= $scale    for all i
→ final array
```
