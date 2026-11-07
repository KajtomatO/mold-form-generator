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

/** Bytes in order, such as an exported file. */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 16777619);
    b = mix(b, bytes[i] + i);
  }
  return finish(a ^ bytes.length).toString(16).padStart(8, '0') + finish(b).toString(16).padStart(8, '0');
}
