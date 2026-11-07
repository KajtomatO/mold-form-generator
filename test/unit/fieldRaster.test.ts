import { describe, expect, it } from 'vitest';
import { dilate } from '../../src/core/field/dilate';
import type { Field, Grid } from '../../src/core/field/grid';
import { NO_SOURCE, rasterize } from '../../src/core/field/raster';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { cornerRaster } from '../fixtures/cornerRaster';
import { box, needle, signedVolume } from '../fixtures/synthetic';

const grid: Grid = { nx: 41, ny: 41, cell: 0.25, x0: -5, y0: -5 };

function triangle(points: number[][]): WeldedMesh {
  return { positions: Float32Array.from(points.flat()), indices: Uint32Array.from([0, 1, 2]) };
}

const cellOf = (field: Field, x: number, y: number): number => {
  const i = Math.floor((x - field.x0) / field.cell + 0.5);
  const j = Math.floor((y - field.y0) / field.cell + 0.5);
  return i + j * field.nx;
};

/** Random triangle corners, by a fixed sequence so a failure reproduces. */
function randomTriangles(count: number, seed: number): number[][][] {
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: count }, () => {
    const cx = -3 + next() * 6, cy = -3 + next() * 6;
    const size = 0.1 + next() * next() * 3;
    // Rounded as the mesh will store them: on a nearly vertical triangle a float step moves z a lot.
    return [0, 1, 2].map(() => [cx + (next() - 0.5) * size, cy + (next() - 0.5) * size, next() * next() * 20].map(Math.fround));
  });
}

/** Max z of the triangle within a cell, from the corners of their overlap, or null if none. */
function highestInCell(t: number[][], i: number, j: number): number | null {
  const u0 = grid.x0 + (i - 0.5) * grid.cell, u1 = u0 + grid.cell;
  const v0 = grid.y0 + (j - 0.5) * grid.cell, v1 = v0 + grid.cell;
  const [A, B, C] = t;
  const doubled = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  const plane = (x: number, y: number): number => {
    const u = ((B[0] - x) * (C[1] - y) - (B[1] - y) * (C[0] - x)) / doubled;
    const v = ((C[0] - x) * (A[1] - y) - (C[1] - y) * (A[0] - x)) / doubled;
    return u * A[2] + v * B[2] + (1 - u - v) * C[2];
  };
  const inTriangle = (x: number, y: number): boolean => {
    const s = Math.sign(doubled);
    return s * ((B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (x - A[0])) >= 0 && s * ((C[0] - B[0]) * (y - B[1]) - (C[1] - B[1]) * (x - B[0])) >= 0 && s * ((A[0] - C[0]) * (y - C[1]) - (A[1] - C[1]) * (x - C[0])) >= 0;
  };
  // With some slack, as a point computed on a cell's edge can land a rounding error outside.
  const inCell = (x: number, y: number): boolean => x >= u0 - 1e-9 && x <= u1 + 1e-9 && y >= v0 - 1e-9 && y <= v1 + 1e-9;
  let best: number | null = null;
  const consider = (z: number): void => {
    if (best === null || z > best) best = z;
  };
  for (const P of t) if (inCell(P[0], P[1])) consider(P[2]);
  for (const x of [u0, u1]) for (const y of [v0, v1]) if (inTriangle(x, y)) consider(plane(x, y));
  for (const [P, Q] of [[A, B], [B, C], [C, A]]) {
    for (const [axis, bound] of [[0, u0], [0, u1], [1, v0], [1, v1]]) {
      if ((P[axis] - bound) * (Q[axis] - bound) >= 0) continue;
      const s = (bound - P[axis]) / (Q[axis] - P[axis]);
      const x = P[0] + s * (Q[0] - P[0]), y = P[1] + s * (Q[1] - P[1]);
      if (inCell(x, y)) consider(P[2] + s * (Q[2] - P[2]));
    }
  }
  return best;
}

/** Whether the triangle's bounding box only just reaches the cell, within rounding of the conversion. */
function cellTouchedOnlyAtEdge(t: number[][], i: number, j: number): boolean {
  const pad = 1e-6;
  const u0 = grid.x0 + (i - 0.5) * grid.cell, v0 = grid.y0 + (j - 0.5) * grid.cell;
  return t.some((P) => Math.abs(P[0] - u0) < pad || Math.abs(P[1] - v0) < pad || Math.abs(P[0] - u0 - grid.cell) < pad || Math.abs(P[1] - v0 - grid.cell) < pad);
}

describe('conservative raster', () => {
  it('a flat triangle gets its height in exactly the cells it touches', () => {
    const field = rasterize(triangle([[-1.1, -1.1, 7], [1.1, -1.1, 7], [-1.1, 1.1, 7]]), grid);
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const u0 = -5 + (i - 0.5) * 0.25, u1 = u0 + 0.25, v0 = -5 + (j - 0.5) * 0.25, v1 = v0 + 0.25;
        // The hypotenuse is x + y = 0, so the cell's lower-left corner decides on that side.
        const touches = u1 > -1.1 && u0 < 1.1 && v1 > -1.1 && v0 < 1.1 && u0 + v0 <= 0;
        const value = field.values[i + j * grid.nx];
        if (touches) expect(value, `cell ${i},${j}`).toBe(7);
        else expect(value, `cell ${i},${j}`).toBe(NO_SOURCE);
      }
    }
  });

  it('on random triangles, holds exactly the highest point of the triangle in each cell', () => {
    for (const t of randomTriangles(300, 12345)) {
      const field = rasterize(triangle(t), grid);
      for (let n = 0; n < field.values.length; n++) {
        const expected = highestInCell(t, n % grid.nx, Math.floor(n / grid.nx));
        if (expected === null) {
          // A corner-only touch is the one thing the two ways may see differently, and it adds no area.
          if (field.values[n] !== NO_SOURCE) expect(cellTouchedOnlyAtEdge(t, n % grid.nx, Math.floor(n / grid.nx))).toBe(true);
        } else {
          expect(field.values[n]).toBeCloseTo(expected, 3);
        }
      }
    }
  });

  it('no sampled point of a random triangle lies above its cell', () => {
    let worst = Infinity;
    for (const t of randomTriangles(100, 4242)) {
      const field = rasterize(triangle(t), grid);
      const steps = 150;
      for (let a = 0; a <= steps; a++) {
        for (let b = 0; b <= steps - a; b++) {
          const u = a / steps, v = b / steps, w = 1 - u - v;
          const x = u * t[0][0] + v * t[1][0] + w * t[2][0];
          const y = u * t[0][1] + v * t[1][1] + w * t[2][1];
          const z = u * t[0][2] + v * t[1][2] + w * t[2][2];
          worst = Math.min(worst, field.values[cellOf(field, x, y)] - z);
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-5);
  });

  it('is never above the plan corner formula, and covers the same cells', () => {
    for (const t of randomTriangles(400, 777)) {
      const mesh = triangle(t);
      const clipped = rasterize(mesh, grid);
      const corners = cornerRaster(mesh, grid);
      for (let n = 0; n < clipped.values.length; n++) {
        expect(clipped.values[n] === NO_SOURCE).toBe(corners.values[n] === NO_SOURCE);
        expect(clipped.values[n]).toBeLessThanOrEqual(corners.values[n] + 1e-4);
      }
    }
  });

  it('is tighter than the corner formula where a steep facet ends inside a cell', () => {
    // Rises along x and y, but stops at a sliver in y, far short of the cell's high corner. The
    // corner formula extends the plane to that corner, and the triangle's top is too far on to cap it.
    const mesh = triangle([[0, 0, 0], [2, 0, 100], [2, 0.05, 102.5]]);
    const n = cellOf(rasterize(mesh, grid), 0.25, 0);
    expect(rasterize(mesh, grid).values[n]).toBeCloseTo(50 * 0.375 + 50 * 0.05 * (0.375 / 2), 3);
    expect(cornerRaster(mesh, grid).values[n]).toBeCloseTo(50 * 0.375 + 50 * 0.125, 3);
  });

  it('a vertical triangle reports the height it reaches in each cell', () => {
    // Stands on the x axis, rising from z=0 at x=-1 to z=10 at x=1.
    const field = rasterize(triangle([[-1, 0.1, 0], [1, 0.1, 0], [1, 0.1, 10]]), grid);
    for (const x of [-0.75, -0.25, 0.25, 0.75]) {
      const i = Math.round((x + 5) / 0.25);
      const cellRight = -5 + (i + 0.5) * 0.25;
      const n = i + Math.round((0.1 + 5) / 0.25) * grid.nx;
      expect(field.values[n]).toBeCloseTo(Math.min(10, ((cellRight + 1) / 2) * 10), 5);
    }
  });

  it('keeps the one point of a triangle seen edge-on, as a line or a dot', () => {
    // All three corners project to one point, so only clipping in 3D can give it a height.
    const field = rasterize(triangle([[0.05, 0.05, 1], [0.05, 0.05, 4], [0.05, 0.05, 9]]), grid);
    const n = cellOf(field, 0.05, 0.05);
    expect(field.values[n]).toBe(9);
    expect(field.values.filter((v) => v !== NO_SOURCE)).toHaveLength(1);
  });

  it('a needle at a cell corner lands in a cell, however thin, and stays covered after dilation', () => {
    // Cell corners of this grid sit at multiples of 0.125 from the nodes at multiples of 0.25.
    const x = 0.125, y = 0.375, height = 20;
    const thin = needle(x, y, height, 0.001);
    expect(signedVolume(thin)).toBeGreaterThan(0);
    const raster = rasterize(thin, grid);
    const highest = Math.max(...raster.values);
    expect(highest).toBe(height);

    // G4 at this cell: r = t + 2.13 h, and every node around the needle's xy clears its tip by t.
    const t = 2;
    const field = dilate(raster, t + 2.13 * 0.25);
    const i = Math.floor((x - grid.x0) / grid.cell), j = Math.floor((y - grid.y0) / grid.cell);
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(field.values[i + a + (j + b) * grid.nx]).toBeGreaterThanOrEqual(height + t);
    }

  });

  it('skips what lies wholly below the plane and clips what crosses it', () => {
    const below = rasterize(triangle([[-1, -1, -3], [1, -1, -3], [-1, 1, -0.5]]), grid);
    expect(below.values.every((v) => v === NO_SOURCE)).toBe(true);

    // Crosses z=0 at x=0: the half below the plane leaves no source at all.
    const crossing = rasterize(triangle([[-2, -1, -4], [2, -1, 4], [-2, 1, -4]]), grid);
    expect(crossing.values[cellOf(crossing, -1, -0.8)]).toBe(NO_SOURCE);
    expect(crossing.values[cellOf(crossing, 1, -0.9)]).toBeGreaterThan(1.5);
    expect(crossing.values.every((v) => v === NO_SOURCE || v >= 0)).toBe(true);
  });

  it('a spike below the base changes nothing above it', () => {
    const block = box([-2, -2, 0], [2, 2, 3]);
    const spike = box([-0.1, -0.1, -4], [0.1, 0.1, 0.5]);
    const both: WeldedMesh = {
      positions: Float32Array.from([...block.positions, ...spike.positions]),
      indices: Uint32Array.from([...block.indices, ...Array.from(spike.indices, (v) => v + 8)]),
    };
    expect(rasterize(both, grid).values).toEqual(rasterize(block, grid).values);
  });

  it('refuses a triangle outside its domain instead of writing somewhere else', () => {
    expect(() => rasterize(triangle([[20, 0, 1], [21, 0, 1], [20, 1, 1]]), grid)).toThrow(/outside the field domain/);
  });
});
