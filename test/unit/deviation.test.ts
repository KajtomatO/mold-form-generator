import { describe, expect, it } from 'vitest';
import { BOUND_SLACK_MM, checkDeviation, maxDeviation, pointTriangleDistance2, SurfaceIndex, surfaceSamples } from '../../src/core/mesh/deviation';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { box } from '../fixtures/synthetic';

/** A small fixed generator, so every run checks the same points. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** `count` random triangles in a 10 mm cube, sized about 1 mm, each with its own three vertices. */
function scattered(count: number, next: () => number): WeldedMesh {
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const cx = next() * 10, cy = next() * 10, cz = next() * 10;
    for (let c = 0; c < 3; c++) {
      positions[t * 9 + c * 3] = cx + (next() - 0.5) * 2;
      positions[t * 9 + c * 3 + 1] = cy + (next() - 0.5) * 2;
      positions[t * 9 + c * 3 + 2] = cz + (next() - 0.5) * 2;
    }
  }
  return { positions, indices: Uint32Array.from({ length: count * 3 }, (_, k) => k) };
}

/** The distance from a point to every triangle, the slow way. */
function brute(mesh: WeldedMesh, x: number, y: number, z: number): number {
  let best = Infinity;
  for (let t = 0; t < mesh.indices.length / 3; t++) best = Math.min(best, pointTriangleDistance2(x, y, z, mesh.positions, mesh.indices[t * 3] * 3, mesh.indices[t * 3 + 1] * 3, mesh.indices[t * 3 + 2] * 3));
  return Math.sqrt(best);
}

/** Dense samples of a triangle, a grid of barycentric points, whose least distance to a point is never below the exact one. */
function sampled(P: Float32Array, a: number, b: number, c: number, x: number, y: number, z: number, steps = 60): number {
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; i + j <= steps; j++) {
      const u = i / steps, v = j / steps, w = 1 - u - v;
      const px = u * P[a] + v * P[b] + w * P[c], py = u * P[a + 1] + v * P[b + 1] + w * P[c + 1], pz = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      best = Math.min(best, Math.hypot(px - x, py - y, pz - z));
    }
  }
  return best;
}

describe('MM2: the distance from a point to a mesh, exact', () => {
  it('a point\'s distance to a triangle is never above dense sampling of it, and equals it to the sampling\'s step', () => {
    const next = random(7);
    const P = new Float32Array(9);
    for (let k = 0; k < 400; k++) {
      for (let i = 0; i < 9; i++) P[i] = next() * 4 - 2;
      const x = next() * 6 - 3, y = next() * 6 - 3, z = next() * 6 - 3;
      const exact = Math.sqrt(pointTriangleDistance2(x, y, z, P, 0, 3, 6));
      const dense = sampled(P, 0, 3, 6, x, y, z);
      expect(exact).toBeLessThanOrEqual(dense + 1e-9);
      // The grid's step on a triangle up to about 7 mm across.
      expect(dense - exact).toBeLessThan(0.12);
    }
  });

  it('checkDeviation\'s maximum and the points past the bound equal brute force, on 300 triangles and 3,000 points', () => {
    const next = random(11);
    const mesh = scattered(300, next);
    const points = new Float32Array(3000 * 3).map(() => next() * 10);
    const distances = Array.from({ length: 3000 }, (_, p) => brute(mesh, points[p * 3], points[p * 3 + 1], points[p * 3 + 2]));
    const bound = 0.8;
    const found = checkDeviation(mesh, points, bound, 3);
    const max = Math.max(...distances);
    expect(max).toBeLessThan(3);
    expect(found.beyond).toBe(0);
    expect(found.max).toBeCloseTo(max, 5);
    expect([...found.past]).toEqual(distances.flatMap((d, p) => (d > bound ? [p] : [])));
    // The one-sided maximum through maxDeviation, which grows its reach until no point is beyond it.
    expect(maxDeviation(mesh, [points], 0.25)).toBeCloseTo(max, 5);
  });

  it('a point with no triangle within the reach is past the bound and counted as beyond, never taken as near', () => {
    const next = random(13);
    const mesh = scattered(50, next);
    const far = Float32Array.of(100, 100, 100, ...mesh.positions.subarray(0, 3));
    const found = new SurfaceIndex(mesh, 0.5).check(far, 0.5);
    expect(found.beyond).toBe(1);
    expect([...found.past]).toEqual([0]);
    expect(found.max).toBe(0.5);
    expect(() => new SurfaceIndex(mesh, 0.5).check(far, 0.6)).toThrow(/reach/);
  });

  it('a surface is sampled at each triangle\'s centroid and each edge\'s midpoint, each edge once', () => {
    const cube = box([0, 0, 0], [2, 2, 2]);
    const { points, centroids, edges } = surfaceSamples(cube);
    expect(centroids).toBe(12);
    // A cube of 12 triangles has 18 edges: its 12 sides and 6 face diagonals.
    expect(edges.length / 2).toBe(18);
    expect(points.length / 3).toBe(30);
    const mids = new Set(Array.from({ length: 18 }, (_, k) => [...points.subarray((12 + k) * 3, (13 + k) * 3)].join(',')));
    expect(mids.size).toBe(18);
    expect(mids.has('1,0,0')).toBe(true);
    // Every sample lies on the cube, at 0 from it.
    expect(checkDeviation(cube, points, 1e-6).max).toBeLessThan(1e-6);
  });

});

/** Every point of a grid of `steps` x `steps` barycentric points on each triangle of `mesh`, 3 floats each. */
function gridOf(mesh: WeldedMesh, steps: number, only?: number): Float32Array {
  const P = mesh.positions, I = mesh.indices, list = only === undefined ? Array.from({ length: I.length / 3 }, (_, t) => t) : [only];
  const out: number[] = [];
  for (const t of list) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        for (let d = 0; d < 3; d++) out.push(u * P[a + d] + v * P[b + d] + w * P[c + d]);
      }
    }
  }
  return Float32Array.from(out);
}

/** The plane z = 0 over [0, 10] x [0, 10] in 0.5 mm squares, two triangles each, less the squares `hole` says. */
function holedPlane(hole: (x: number, y: number) => boolean): WeldedMesh {
  const n = 20, step = 0.5, positions: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * step, j * step, 0);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (hole((i + 0.5) * step, (j + 0.5) * step)) continue;
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

describe('MM2 review: a bound over the whole surface, not its samples (SurfaceIndex.bound)', () => {
  it('a hole between a triangle\'s samples is found: its vertices, centroid and edge midpoints all lie on the plane, the surface around (6, 2) does not', () => {
    const plane = holedPlane((x, y) => Math.abs(x - 6) < 0.5 && Math.abs(y - 2) < 0.5);
    const big: WeldedMesh = { positions: Float32Array.of(0, 0, 0, 10, 0, 0, 0, 10, 0), indices: Uint32Array.of(0, 1, 2) };
    const { points } = surfaceSamples(big);
    // The samples say 0: every one lies on the plane.
    expect(maxDeviation(plane, [big.positions, points])).toBe(0);
    // The hole's middle is 0.5 mm from its edge, and the bound sees it.
    const proved = new SurfaceIndex(plane, 1).bound(big, null);
    const dense = maxDeviation(plane, [gridOf(big, 200)]);
    expect(dense).toBeGreaterThan(0.45);
    expect(proved.beyond).toBe(false);
    expect(proved.bound).toBeGreaterThanOrEqual(dense);
    expect(proved.bound).toBeLessThanOrEqual(0.5 + BOUND_SLACK_MM + 1e-9);
    // With a limit of 0.3 mm the triangle is past it; with 0.6 it is proved within.
    expect([...new SurfaceIndex(plane, 0.3).bound(big, 0.3).past]).toEqual([0]);
    expect([...new SurfaceIndex(plane, 0.6).bound(big, 0.6).past]).toEqual([]);
  });

  it('on 40 random triangles against 300, never under dense sampling of each, and within the slack and the sampling\'s step of it; every triangle with a point past the limit is past', () => {
    const next = random(17);
    const to = scattered(300, next), from = scattered(40, next);
    const proved = new SurfaceIndex(to, 3, 3).bound(from, null);
    expect(proved.beyond).toBe(false);
    const dense = maxDeviation(to, [gridOf(from, 80)], 3);
    expect(proved.bound).toBeGreaterThanOrEqual(dense);
    expect(proved.found).toBeLessThanOrEqual(proved.bound);
    // A grid of 80 steps on triangles about 2 mm across lies within 0.02 mm of every point of them.
    expect(proved.bound - dense).toBeLessThan(BOUND_SLACK_MM + 0.02);
    const limit = (dense + proved.found) / 4;
    const past = new Set(new SurfaceIndex(to, 3, 3).bound(from, limit).past);
    for (let t = 0; t < 40; t++) {
      const own = maxDeviation(to, [gridOf(from, 40, t)], 3);
      if (own > limit) expect(past.has(t)).toBe(true);
      // One proved within the limit has every point within it.
      if (!past.has(t)) expect(own).toBeLessThanOrEqual(limit);
    }
    expect(past.size).toBeGreaterThan(0);
    expect(past.size).toBeLessThan(40);
  });

  it('a surface with nothing within the reach is past any limit, and measured alone it says so, for a larger reach', () => {
    const next = random(19);
    const to = scattered(50, next);
    const far: WeldedMesh = { positions: Float32Array.of(100, 100, 100, 101, 100, 100, 100, 101, 100), indices: Uint32Array.of(0, 1, 2) };
    const limited = new SurfaceIndex(to, 0.5).bound(far, 0.5);
    expect([...limited.past]).toEqual([0]);
    expect(limited.beyond).toBe(true);
    expect(new SurfaceIndex(to, 0.5).bound(far, null).beyond).toBe(true);
    expect(() => new SurfaceIndex(to, 0.5).bound(far, 0.6)).toThrow(/reach/);
  });
});
