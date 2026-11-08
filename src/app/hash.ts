/**
 * Hashes for stage keys and for comparing geometry between runs, workers and browsers. No Web Crypto,
 * which plain http on a LAN address does not have, and none is needed: nothing here is a secret.
 */

/** 53 bits of a string, as 14 hex digits. Collisions are negligible at the few thousand keys a session makes. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Bit pattern of each float, so -0 and 0 or two NaNs are told apart exactly as stored. */
const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);
function bitsOf(value: number): number {
  scratch[0] = value;
  return scratchBits[0];
}

function mix(h: number, value: number): number {
  h = Math.imul(h ^ value, 0x9e3779b1);
  return (h << 13) | (h >>> 19);
}

function finish(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** An array of float32 values in order, such as a field. */
export function hashFloats(values: ArrayLike<number>): string {
  let a = 0x12345678, b = 0x9abcdef0;
  for (let i = 0; i < values.length; i++) {
    const bits = bitsOf(values[i]);
    a = mix(a, bits);
    b = mix(b, bits ^ i);
  }
  return finish(a).toString(16).padStart(8, '0') + finish(b ^ values.length).toString(16).padStart(8, '0');
}

/**
 * A mesh as a set of oriented triangles: the same geometry gives the same hash whatever order the
 * triangles or vertices come in, so a comparison between workers and browsers checks the geometry and
 * not how it was listed. Each triangle starts at its smallest corner, which keeps its winding, so a
 * flipped face still changes the hash.
 */
export function hashMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): string {
  let sumA = 0, sumB = 0, xor = 0;
  const corner = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    let first = 0;
    for (let c = 0; c < 3; c++) corner[c] = indices[t + c] * 3;
    for (let c = 1; c < 3; c++) if (lessThan(positions, corner[c], corner[first])) first = c;
    let a = 0x2545f491, b = 0x6a09e667;
    for (let k = 0; k < 3; k++) {
      const v = corner[(first + k) % 3];
      for (let d = 0; d < 3; d++) {
        const bits = bitsOf(positions[v + d]);
        a = mix(a, bits);
        b = mix(b, bits + 0x632be5ab);
      }
    }
    // Sums and xor do not care about order, and two of them make an accidental match unlikely.
    sumA = (sumA + finish(a)) >>> 0;
    sumB = (sumB + finish(b)) >>> 0;
    xor ^= finish(a ^ b);
  }
  const count = indices.length / 3;
  return [finish(sumA ^ count), finish(sumB), finish(xor >>> 0)].map((h) => h.toString(16).padStart(8, '0')).join('');
}

function lessThan(p: ArrayLike<number>, a: number, b: number): boolean {
  for (let d = 0; d < 3; d++) {
    if (p[a + d] !== p[b + d]) return p[a + d] < p[b + d];
  }
  return false;
}

/** SHA-256's round constants, FIPS 180-4 section 4.2.2. */
const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** One 64-byte block of SHA-256 at `at`, folded into the state `h`, with `w` as the message schedule. */
function sha256Block(h: Int32Array, w: Int32Array, d: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i++) {
    const j = at + i * 4;
    w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = h[0], b = h[1], c = h[2], e = h[4], f = h[5], g = h[6], k = h[7], dd = h[3];
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (k + s1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    k = g;
    g = f;
    f = e;
    e = (dd + t1) | 0;
    dd = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + dd) | 0;
  h[4] = (h[4] + e) | 0;
  h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0;
  h[7] = (h[7] + k) | 0;
}

/**
 * SHA-256 of the bytes as 64 hex digits, written from FIPS 180-4 in plain JS, because Web Crypto needs
 * a secure context. A project file names its STL by this, so a maker can check it with any sha256sum.
 */
export function sha256(bytes: Uint8Array): string {
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  const length = bytes.length;
  const whole = length - (length % 64);
  for (let at = 0; at < whole; at += 64) sha256Block(h, w, bytes, at);
  // The tail, the 0x80 marker and the length in bits, big-endian in the last 8 bytes.
  const tail = new Uint8Array(length - whole < 56 ? 64 : 128);
  tail.set(bytes.subarray(whole));
  tail[length - whole] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(tail.length - 4, (length * 8) >>> 0);
  for (let at = 0; at < tail.length; at += 64) sha256Block(h, w, tail, at);
  return Array.from(h, (v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Bytes in order, such as an exported file. */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 16777619);
    b = mix(b, bytes[i] + i);
  }
  return finish(a ^ bytes.length).toString(16).padStart(8, '0') + finish(b).toString(16).padStart(8, '0');
}
