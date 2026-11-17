import type { WeldedMesh } from './weld';

/**
 * RM, rung B's extraction: marching tetrahedra on the Kuhn (Freudenthal) split, six tetrahedra a cube along its
 * (0,0,0) to (1,1,1) diagonal, which meet face to face across cubes, so the surface it makes is closed wherever the
 * field is negative on the lattice's outer layer. Inside is f > 0 (f = 0 counts as outside). A vertex is shared by
 * its lower node and one of seven edge directions, through two rolling slabs, and each is worked out from its
 * edge's two nodes in one order, so neighbouring cubes make it bit for bit the same. Only + - * / and comparisons
 * on the geometry, so Node, Chromium and Firefox make the same mesh. Our own code, from the method's standard
 * description (Doi and Koide 1991; Treece, Prager and Gee 1999).
 */

export interface Lattice {
  /** The cell, in mm. */
  h: number;
  /** The first node. */
  o: [number, number, number];
  /** Nodes on each axis. */
  n: [number, number, number];
}

export interface Extracted {
  mesh: WeldedMesh;
  insideNodes: number;
  mixedCubes: number;
}

/** A pair of growing typed arrays. */
class Growing {
  pos = new Float32Array(3 * 65536);
  idx = new Uint32Array(3 * 65536);
  nv = 0;
  ni = 0;
  vert(x: number, y: number, z: number): number {
    if (this.nv * 3 + 3 > this.pos.length) {
      const grown = new Float32Array(this.pos.length * 2);
      grown.set(this.pos);
      this.pos = grown;
    }
    const o = this.nv * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    return this.nv++;
  }
  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const grown = new Uint32Array(this.idx.length * 2);
      grown.set(this.idx);
      this.idx = grown;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }
}

/** Edge direction by the bits an edge adds to its lower corner (x = 1, y = 2, z = 4). */
const DIR = [-1, 0, 1, 3, 2, 4, 5, 6];

/** The six Kuhn tetrahedra of a cube, each in positive orientation, by cube corner (x = 1, y = 2, z = 4). */
const TETS: number[][] = (() => {
  const perms: [number, number, number][] = [
    [1, 2, 1],
    [2, 4, 1],
    [4, 1, 1],
    [1, 4, -1],
    [2, 1, -1],
    [4, 2, -1],
  ];
  return perms.map(([p, q, s]) => (s > 0 ? [0, p, p | q, 7] : [0, p | q, p, 7]));
})();

/**
 * The triangles for each inside mask of a positive tetrahedron (a, b, c, d = bits 1, 2, 4, 8): each as three edges,
 * an edge as two of the tetrahedron's corners, wound to face from inside to outside.
 */
const CASES: number[][][] = (() => {
  const table: number[][][] = Array.from({ length: 16 }, () => []);
  const A = 0, B = 1, C = 2, D = 3;
  const tri = (mask: number, ...edges: [number, number][]): void => void table[mask].push(edges.flat());
  tri(1, [A, B], [A, C], [A, D]);
  tri(2, [B, A], [B, D], [B, C]);
  tri(4, [C, A], [C, B], [C, D]);
  tri(8, [D, A], [D, C], [D, B]);
  tri(14, [A, B], [A, D], [A, C]);
  tri(13, [B, A], [B, C], [B, D]);
  tri(11, [C, A], [C, D], [C, B]);
  tri(7, [D, A], [D, B], [D, C]);
  tri(3, [A, C], [A, D], [B, D]);
  tri(3, [A, C], [B, D], [B, C]);
  tri(5, [A, D], [A, B], [C, B]);
  tri(5, [A, D], [C, B], [C, D]);
  tri(9, [A, B], [A, C], [D, C]);
  tri(9, [A, B], [D, C], [D, B]);
  tri(6, [B, A], [B, D], [C, D]);
  tri(6, [B, A], [C, D], [C, A]);
  tri(10, [B, C], [B, A], [D, A]);
  tri(10, [B, C], [D, A], [D, C]);
  tri(12, [C, A], [C, B], [D, B]);
  tri(12, [C, A], [D, B], [D, A]);
  return table;
})();

/** One unit in the last place of a float32 near |m|, by doubling and halving only, so every engine agrees. */
export function float32Ulp(m: number): number {
  let p = 1;
  if (m >= 1) while (p * 2 <= m) p *= 2;
  else if (m > 0) while (p > m) p /= 2;
  else return 2 ** -149;
  return p * 2 ** -23;
}

/**
 * How near a node a vertex may come along its edge, as a fraction of the edge. The spike's 1e-4 let two vertices
 * on different edges of one node round to the same float32 (on the oil barrel, whose coordinates reach 318 mm),
 * which meshoptimizer takes for a seam and an STL round trip welds into one: so at least 16 float32 steps of the
 * lattice's largest coordinate, and at least 1e-3.
 */
export function clampFor(lat: Lattice): number {
  let m = 0;
  for (let a = 0; a < 3; a++) m = Math.max(m, Math.abs(lat.o[a]), Math.abs(lat.o[a] + (lat.n[a] - 1) * lat.h));
  return Math.max(1e-3, (16 * float32Ulp(m)) / lat.h);
}

/**
 * Marching tetrahedra over a field given slab by slab: `slab(k, f)` fills f (nx * ny, x fastest) with the field at
 * the k-th z layer. `hold` is given the arrays held as each slab ends, for the memory meter.
 */
export function marchSlabs(lat: Lattice, slab: (k: number, f: Float64Array) => void, clamp: number, hold?: (arrays: unknown[]) => void, slabDone?: (k: number) => void): Extracted {
  // A clamp past half an edge would put vertices off their edges (RM's review: 1.25 at 100 m from the origin and a
  // 0.1 mm cell), which repairCellLimit keeps a grid from coming near.
  if (!(clamp < 0.5)) throw new Error(`A clamp of ${clamp} would put the rebuilt surface's vertices off their edges.`);
  const [nx, ny, nz] = lat.n, h = lat.h, [ox, oy, oz] = lat.o;
  const S = nx * ny;
  let f0 = new Float64Array(S), f1 = new Float64Array(S);
  let e0 = new Int32Array(S * 7).fill(-1), e1 = new Int32Array(S * 7).fill(-1);
  const out = new Growing();
  hold?.([f0, f1, e0, e1, out.pos, out.idx]);
  slab(0, f0);
  let insideNodes = 0, mixedCubes = 0;
  for (let i = 0; i < S; i++) if (f0[i] > 0) insideNodes++;
  const fc = new Float64Array(8);
  const vid = new Int32Array(3);
  for (let k = 0; k + 1 < nz; k++) {
    slab(k + 1, f1);
    for (let i = 0; i < S; i++) if (f1[i] > 0) insideNodes++;
    for (let y = 0; y + 1 < ny; y++) {
      for (let x = 0; x + 1 < nx; x++) {
        const s = x + y * nx;
        fc[0] = f0[s];
        fc[1] = f0[s + 1];
        fc[2] = f0[s + nx];
        fc[3] = f0[s + nx + 1];
        fc[4] = f1[s];
        fc[5] = f1[s + 1];
        fc[6] = f1[s + nx];
        fc[7] = f1[s + nx + 1];
        let mask = 0;
        for (let c = 0; c < 8; c++) if (fc[c] > 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        mixedCubes++;
        for (let t = 0; t < 6; t++) {
          const tet = TETS[t];
          let m = 0;
          for (let q = 0; q < 4; q++) if (fc[tet[q]] > 0) m |= 1 << q;
          const tris = CASES[m];
          for (const tr of tris) {
            for (let g = 0; g < 3; g++) {
              let cu = tet[tr[g * 2]], cv = tet[tr[g * 2 + 1]];
              // The edge from its lower corner: its corners' bits nest, as the tetrahedra are chains of them.
              if ((cu & cv) !== cu) {
                const swap = cu;
                cu = cv;
                cv = swap;
              }
              const lx = x + (cu & 1), ly = y + ((cu >> 1) & 1), lz = (cu >> 2) & 1;
              const cache = lz ? e1 : e0;
              const key = (lx + ly * nx) * 7 + DIR[cv ^ cu];
              let id = cache[key];
              if (id < 0) {
                const fu = fc[cu], fv = fc[cv];
                let tt = fu / (fu - fv);
                if (tt < clamp) tt = clamp;
                else if (tt > 1 - clamp) tt = 1 - clamp;
                const ux = ox + lx * h, uy = oy + ly * h, uz = oz + (k + lz) * h;
                const vx = ox + (x + (cv & 1)) * h, vy = oy + (y + ((cv >> 1) & 1)) * h, vz = oz + (k + ((cv >> 2) & 1)) * h;
                id = out.vert(ux + tt * (vx - ux), uy + tt * (vy - uy), uz + tt * (vz - uz));
                cache[key] = id;
              }
              vid[g] = id;
            }
            out.tri(vid[0], vid[1], vid[2]);
          }
        }
      }
    }
    const tf = f0;
    f0 = f1;
    f1 = tf;
    const te = e0;
    e0 = e1;
    e1 = te;
    e1.fill(-1);
    hold?.([f0, f1, e0, e1, out.pos, out.idx]);
    slabDone?.(k + 1);
  }
  return { mesh: { positions: out.pos.slice(0, out.nv * 3), indices: out.idx.slice(0, out.ni) }, insideNodes, mixedCubes };
}

/** Marching tetrahedra over a field given as a function, for the extractor's own tests. */
export function marchField(lat: Lattice, field: (x: number, y: number, z: number) => number, clamp = clampFor(lat)): Extracted {
  const [nx, ny] = lat.n, h = lat.h, [ox, oy, oz] = lat.o;
  return marchSlabs(
    lat,
    (k, f) => {
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) f[x + y * nx] = field(ox + x * h, oy + y * h, oz + k * h);
    },
    clamp,
  );
}
