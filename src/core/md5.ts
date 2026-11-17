// MD5, implemented here so that grouping stays synchronous and free of
// runtime APIs. Used for grouping hashes only, never for security.

const SHIFTS = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
];

const CONSTANTS = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 4_294_967_296),
);

type State = [a: number, b: number, c: number, d: number];

function pad(bytes: Uint8Array): DataView {
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  const view = new DataView(padded.buffer);

  padded.set(bytes);
  padded[bytes.length] = 0x80;
  view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bytes.length / 536_870_912), true);

  return view;
}

function mix(round: number, [, b, c, d]: State): number {
  if (round === 0) {
    return (b & c) | (~b & d);
  }

  if (round === 1) {
    return (d & b) | (~d & c);
  }

  return round === 2 ? b ^ c ^ d : c ^ (b | ~d);
}

function wordIndex(round: number, step: number): number {
  const multipliers = [1, 5, 3, 7];
  const offsets = [0, 1, 5, 0];

  return ((multipliers[round] ?? 1) * step + (offsets[round] ?? 0)) % 16;
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function processChunk(view: DataView, offset: number, state: State): State {
  let [a, b, c, d] = state;

  for (let step = 0; step < 64; step += 1) {
    const round = step >> 4;
    const word = view.getUint32(offset + wordIndex(round, step) * 4, true);
    const sum = (a + mix(round, [a, b, c, d]) + (CONSTANTS[step] ?? 0) + word) | 0;
    const shift = SHIFTS[round]?.[step % 4] ?? 0;

    a = d;
    d = c;
    c = b;
    b = (b + rotateLeft(sum, shift)) | 0;
  }

  return [(state[0] + a) | 0, (state[1] + b) | 0, (state[2] + c) | 0, (state[3] + d) | 0];
}

function littleEndianHex(word: number): string {
  let hex = "";

  for (let shift = 0; shift < 32; shift += 8) {
    hex += ((word >>> shift) & 0xff).toString(16).padStart(2, "0");
  }

  return hex;
}

export function md5Hex(text: string): string {
  const view = pad(new TextEncoder().encode(text));
  let state: State = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];

  for (let offset = 0; offset < view.byteLength; offset += 64) {
    state = processChunk(view, offset, state);
  }

  return state.map(littleEndianHex).join("");
}
