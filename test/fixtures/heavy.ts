import type { WeldedMesh } from '../../src/core/mesh/weld';

/**
 * M11's heavy inputs, made here and never kept as files: a closed block standing on z = 0 whose top is a
 * rippled height field of n x n cells, so its triangle count follows n and nothing else. n = 1224 gives the
 * plan's 3 million triangles. Deterministic: the same n always gives the same bytes.
 */
export interface HeightBlock {
  /** Cells along each side of the top. */
  n: number;
  /** Side of the square footprint, in mm. */
  size: number;
  /** Mean height of the top, in mm. */
  height: number;
  /** Half the ripple's height, in mm, and its wavelength. */
  ripple: number;
  wavelength: number;
}

/**
 * A ripple 2 mm high every 2 mm, as a scan's texture: rough enough that simplifying it to 2 million triangles
 * leaves an error meshoptimizer can measure. A smooth 25 mm ripple left under a micron, which it read as 0.
 */
export const HEAVY_BLOCK: HeightBlock = { n: 1224, size: 100, height: 20, ripple: 1, wavelength: 2 };

/** 2 n^2 on top, 2 per boundary cell on the sides, and a fan of 4 n under it. */
export function heightBlockTriangles(n: number): number {
  return 2 * n * n + 8 * n + 4 * n;
}

/**
 * Calls `emit` with each triangle's 9 coordinates, wound outward. Top vertices are worked out once, as
 * float32, so each wall shares its corners with the top bit for bit and the file welds closed.
 */
function eachTriangle(block: HeightBlock, emit: (c: Float32Array) => void): void {
  const { n, size, height, ripple, wavelength } = block;
  const step = size / n;
  const k = (2 * Math.PI) / wavelength;
  const top = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = i * step, y = j * step, at = (j * (n + 1) + i) * 3;
      top[at] = x;
      top[at + 1] = y;
      top[at + 2] = height + ripple * Math.sin(k * x) * Math.cos(k * y);
    }
  }
  const c = new Float32Array(9);
  const put = (slot: number, x: number, y: number, z: number): void => {
    c[slot * 3] = x;
    c[slot * 3 + 1] = y;
    c[slot * 3 + 2] = z;
  };
  const putTop = (slot: number, i: number, j: number): void => {
    const at = (j * (n + 1) + i) * 3;
    put(slot, top[at], top[at + 1], top[at + 2]);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      putTop(0, i, j);
      putTop(1, i + 1, j);
      putTop(2, i + 1, j + 1);
      emit(c);
      putTop(0, i, j);
      putTop(1, i + 1, j + 1);
      putTop(2, i, j + 1);
      emit(c);
    }
  }
  // The boundary, anticlockwise seen from above; outward is to the right of the way it runs.
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) ring.push([i, 0]);
  for (let j = 0; j < n; j++) ring.push([n, j]);
  for (let i = n; i > 0; i--) ring.push([i, n]);
  for (let j = n; j > 0; j--) ring.push([0, j]);
  for (let r = 0; r < ring.length; r++) {
    const [pi, pj] = ring[r], [qi, qj] = ring[(r + 1) % ring.length];
    const px = top[(pj * (n + 1) + pi) * 3], py = top[(pj * (n + 1) + pi) * 3 + 1];
    const qx = top[(qj * (n + 1) + qi) * 3], qy = top[(qj * (n + 1) + qi) * 3 + 1];
    put(0, px, py, 0);
    put(1, qx, qy, 0);
    putTop(2, qi, qj);
    emit(c);
    put(0, px, py, 0);
    putTop(1, qi, qj);
    putTop(2, pi, pj);
    emit(c);
    // The floor: a fan from the middle, facing down.
    put(0, size / 2, size / 2, 0);
    put(1, qx, qy, 0);
    put(2, px, py, 0);
    emit(c);
  }
}

/** The block as a binary STL, written straight into its bytes, as 3 million triangles are 150 MB. */
export function heightBlockStl(block: HeightBlock = HEAVY_BLOCK): Uint8Array {
  const count = heightBlockTriangles(block.n);
  const bytes = new Uint8Array(84 + 50 * count);
  bytes.set(new TextEncoder().encode(`M11 heavy block, ${block.n} x ${block.n} cells`));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let at = 84;
  eachTriangle(block, (c) => {
    // The stored normal is left at 0: the parser reads positions only, as stored normals are often wrong.
    for (let k = 0; k < 9; k++) view.setFloat32(at + 12 + 4 * k, c[k], true);
    at += 50;
  });
  return bytes;
}

/** The block as a triangle soup, for a small n. */
export function heightBlockSoup(block: HeightBlock): Float32Array {
  const soup = new Float32Array(heightBlockTriangles(block.n) * 9);
  let at = 0;
  eachTriangle(block, (c) => {
    soup.set(c, at);
    at += 9;
  });
  return soup;
}

/** The block's mesh, welded as the app welds it. */
export function heightBlockMesh(block: HeightBlock, weld: (soup: Float32Array) => WeldedMesh): WeldedMesh {
  return weld(heightBlockSoup(block));
}

/**
 * RM: the 3 million triangle block broken as a scan can be (the design's bar case, docs/PLAN.md, RM): a hole of 24 x
 * 24 top cells, about 2 x 2 mm, cut out of its top, and a fin of no thickness, 5 mm high, standing on 300 top edges
 * along row 400, about 24.5 mm long, each of which three faces then share. So it is no solid, and its repair is a
 * rebuild with a part left out. 3,010,488 triangles, as a binary STL written straight into its bytes.
 */
export function heightBlockHoleFinStl(block: HeightBlock = HEAVY_BLOCK): Uint8Array {
  const { n } = block;
  const base = heightBlockSoup(block);
  const T = heightBlockTriangles(n);
  const dropped = (t: number): boolean => {
    if (t >= 2 * n * n) return false;
    const cell = Math.floor(t / 2), i = cell % n, j = Math.floor(cell / n);
    return i >= 600 && i < 624 && j >= 600 && j < 624;
  };
  const FIN = 300, ROW = 400;
  const count = T - 2 * 24 * 24 + 2 * FIN;
  const bytes = new Uint8Array(84 + 50 * count);
  bytes.set(new TextEncoder().encode(`RM heavy block with a hole and a fin, ${n} x ${n} cells`));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let at = 84;
  const write = (c: ArrayLike<number>): void => {
    for (let k = 0; k < 9; k++) view.setFloat32(at + 12 + 4 * k, c[k], true);
    at += 50;
  };
  for (let t = 0; t < T; t++) if (!dropped(t)) write(base.subarray(t * 9, t * 9 + 9));
  for (let i = 300; i < 300 + FIN; i++) {
    // Triangle 2 (j n + i) is (i, j), (i + 1, j), (i + 1, j + 1): its first two corners are the edge the fin stands on.
    const t = 2 * (ROW * n + i);
    const ax = base[t * 9], ay = base[t * 9 + 1], az = base[t * 9 + 2];
    const bx = base[t * 9 + 3], by = base[t * 9 + 4], bz = base[t * 9 + 5];
    write([ax, ay, az, bx, by, bz, bx, by, bz + 5]);
    write([ax, ay, az, bx, by, bz + 5, ax, ay, az + 5]);
  }
  return bytes;
}
