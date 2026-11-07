/** Indexed triangle mesh. Both arrays are ready to hand to Manifold or meshoptimizer. */
export interface WeldedMesh {
  /** 3 floats per vertex. Every vertex is used by at least one triangle. */
  positions: Float32Array;
  /** 3 indices per triangle. */
  indices: Uint32Array;
}

/**
 * Merges corners with bit-identical coordinates, treating -0 and +0 as equal. Nothing is moved,
 * so this never changes geometry. The output is compact by construction, which meshoptimizer
 * needs because it reads every vertex in the buffer.
 */
export function weld(soup: Float32Array): WeldedMesh {
  const cornerCount = soup.length / 3;
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length);

  let capacity = 16;
  while (capacity < cornerCount * 2) capacity *= 2;
  const mask = capacity - 1;
  const table = new Int32Array(capacity).fill(-1);

  const positions = new Float32Array(soup.length);
  const indices = new Uint32Array(cornerCount);
  let vertexCount = 0;

  for (let corner = 0; corner < cornerCount; corner++) {
    const i = corner * 3;
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    // Comparing to 0 maps -0 to the bit pattern of +0.
    const hx = x === 0 ? 0 : bits[i];
    const hy = y === 0 ? 0 : bits[i + 1];
    const hz = z === 0 ? 0 : bits[i + 2];
    let h = Math.imul(hx, 0x9e3779b1) ^ Math.imul(hy, 0x85ebca77) ^ Math.imul(hz, 0xc2b2ae3d);
    h ^= h >>> 15;

    let slot = h & mask;
    while (true) {
      const found = table[slot];
      if (found < 0) {
        table[slot] = vertexCount;
        const w = vertexCount * 3;
        positions[w] = x;
        positions[w + 1] = y;
        positions[w + 2] = z;
        indices[corner] = vertexCount++;
        break;
      }
      const w = found * 3;
      if (positions[w] === x && positions[w + 1] === y && positions[w + 2] === z) {
        indices[corner] = found;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return { positions: positions.slice(0, vertexCount * 3), indices };
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function meshBounds(positions: ArrayLike<number>): Bounds {
  const min: Bounds['min'] = [Infinity, Infinity, Infinity];
  const max: Bounds['max'] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}
