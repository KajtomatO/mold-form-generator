import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Field } from '../../src/core/field/grid';
import { auditEdges } from '../../src/core/mesh/audit';
import { withArena } from '../../src/core/solid/arena';
import { buildToolMesh, toolSolid, TOOL_BOTTOM, TOOL_FLOOR, type ToolMesh } from '../../src/core/solid/tool';
import { loadManifold } from '../fixtures/loadExamples';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const CELL = 0.125;

/** A field with its node at (0, 0) in the corner, heights from a function of mm. 0 is outside the cavity. */
function fieldOf(nx: number, ny: number, height: (x: number, y: number) => number): Field {
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[i + j * nx] = height(i * CELL, j * CELL);
  return { nx, ny, cell: CELL, x0: 0, y0: 0, values };
}

/** A hill on a disc, with a cliff all round it, and ripples fine enough to make the TIN work. */
function hill(x: number, y: number): number {
  const r = Math.hypot(x - 15, y - 15);
  return r > 12 ? 0 : 6 + 4 * Math.cos((r * Math.PI) / 24) + 0.4 * Math.sin(x * 1.3) * Math.cos(y * 1.1);
}

/** Height of the top surface at a node, with the top triangles only: those wound upward over z > -2. */
function surfaceHeights(mesh: ToolMesh, field: Field): Float32Array {
  const heights = new Float32Array(field.values.length).fill(-Infinity);
  const { positions: p, indices } = mesh;
  for (let t = 0; t < mesh.tinTriangles * 3; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const i0 = Math.round(Math.min(ax, bx, cx) / CELL), i1 = Math.round(Math.max(ax, bx, cx) / CELL);
    const j0 = Math.round(Math.min(ay, by, cy) / CELL), j1 = Math.round(Math.max(ay, by, cy) / CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * CELL, y = j * CELL;
        const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / det;
        const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        heights[i + j * field.nx] = p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]);
      }
    }
  }
  return heights;
}

describe('the closed tool of G7', () => {
  const field = fieldOf(241, 241, hill);

  it('is closed and positive, with every open edge accounted for by the ring and the fan', () => {
    const mesh = buildToolMesh(field, { raise: 0.05, tol: 0.05 });
    const audit = auditEdges({ positions: mesh.positions, indices: mesh.indices });
    expect(audit.openEdges).toBe(0);
    expect(audit.nonManifoldEdges).toBe(0);
    expect(audit.misorientedEdges).toBe(0);
    withArena(api, (arena) => {
      const solid = toolSolid(arena, mesh);
      expect(solid.status()).toBe('NoError');
      expect(solid.volume()).toBeGreaterThan(0);
      expect(solid.boundingBox().min[2]).toBe(TOOL_BOTTOM);
      expect(solid.genus()).toBe(0);
    });
  });

  it('holds what the field and the raise say, within the tolerance at every node', () => {
    const tol = 0.05;
    const mesh = buildToolMesh(field, { raise: tol, tol });
    const heights = surfaceHeights(mesh, field);
    const { values, nx, ny } = field;
    let seen = 0;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const n = i + j * nx;
        if (values[n] <= 0) {
          // Outside the cavity it stays under the plane, so the cavity at z=0 has no stray patches.
          if (heights[n] !== -Infinity) expect(heights[n]).toBeLessThanOrEqual(TOOL_FLOOR + tol + 1e-3);
          continue;
        }
        seen++;
        // The point of the raise: the TIN may go under H + raise by tol, so never under H.
        expect(heights[n]).toBeGreaterThanOrEqual(values[n] - 1e-4);
        expect(heights[n]).toBeLessThanOrEqual(values[n] + 2 * tol + 1e-4);
      }
    }
    expect(seen).toBeGreaterThan(20000);
  });

  it('without the raise the TIN does fall below H, so that check is not empty', () => {
    const mesh = buildToolMesh(field, { raise: 0, tol: 0.05 });
    const heights = surfaceHeights(mesh, field);
    let below = 0;
    for (let n = 0; n < heights.length; n++) if (field.values[n] > 0 && heights[n] < field.values[n] - 0.01) below++;
    expect(below).toBeGreaterThan(100);
  });

  it('has one vertex per kept node at most, and far fewer than the grid', () => {
    const mesh = buildToolMesh(field, { raise: 0.05, tol: 0.05 });
    expect(mesh.tinTriangles).toBeLessThan((field.nx * field.ny) / 2);
    expect(mesh.tol).toBe(0.05);
    expect(mesh.maxError).toBeLessThanOrEqual(0.05);
    expect(mesh.diagnostics).toEqual([]);
    expect(mesh.raise).toBe(0.05);
  });

  it('crops to the cavity and one ring around it, however wide the field is', () => {
    const narrow = fieldOf(400, 300, (x, y) => (x >= 5 && x <= 10 && y >= 8 && y <= 20 ? 4 : 0));
    const mesh = buildToolMesh(narrow, { raise: 0.05, tol: 0.05 });
    expect(mesh.domain).toEqual({ x0: 5 - CELL, y0: 8 - CELL, x1: 10 + CELL, y1: 20 + CELL });
    withArena(api, (arena) => {
      const box = toolSolid(arena, mesh).boundingBox();
      expect(box.min[0]).toBeCloseTo(mesh.domain.x0, 5);
      expect(box.max[1]).toBeCloseTo(mesh.domain.y1, 5);
    });
  });

  it('measures the solid it says it is, on a block with a cliff all round', () => {
    const block = fieldOf(160, 160, (x, y) => (x >= 5 && x <= 15 && y >= 5 && y <= 15 ? 10 : 0));
    withArena(api, (arena) => {
      const solid = toolSolid(arena, buildToolMesh(block, { raise: 0.05, tol: 0.05 }));
      // Nodes span 10 mm, with a ramp of one cell outside on each side from 10.05 down to -1.
      const sum = block.values.reduce((total, v) => total + (v > 0 ? v + 0.05 : TOOL_FLOOR), 0);
      const nodes = block.values.reduce((total, v) => total + (v > 0 ? 1 : 0), 0);
      const domain = 10 + 2 * CELL;
      const mesh = buildToolMesh(block, { raise: 0.05, tol: 0.05 });
      expect(mesh.domain.x1 - mesh.domain.x0).toBeCloseTo(domain, 6);
      expect(nodes).toBe(81 * 81);
      expect(sum).toBeGreaterThan(0);
      const top = 10.05, floor = -1, bottom = -2, a = 10;
      const ramp = (top + floor) / 2 - bottom;
      const corners = (2 * top + floor) / 3 - bottom;
      const exact = a * a * (top - bottom) + 4 * a * CELL * ramp + 4 * CELL * CELL * corners;
      expect(Math.abs(solid.volume() - exact) / exact).toBeLessThan(1e-3);
    });
  });

  it('throws on a field with no cavity, rather than cutting nothing without a word', () => {
    expect(() => buildToolMesh(fieldOf(20, 20, () => 0), { raise: 0.05, tol: 0.05 })).toThrow(/no cavity/);
  });
});

describe('the triangle limit from the risk table', () => {
  const field = fieldOf(241, 241, hill);

  it('stops at the limit, says so, and lifts the surface by what the tolerance could not hold', () => {
    const limit = 300;
    const mesh = buildToolMesh(field, { raise: 0.05, tol: 0.05, triangleLimit: limit });
    expect(mesh.tinTriangles).toBeLessThanOrEqual(limit + 2);
    expect(mesh.tol).toBeGreaterThan(0.05);
    expect(mesh.maxError).toBeLessThanOrEqual(mesh.tol);
    expect(mesh.raise).toBeCloseTo(mesh.tol, 6);
    expect(mesh.diagnostics.map((d) => d.code)).toEqual(['tin-limit']);
    expect(mesh.diagnostics[0].severity).toBe('warning');
    expect(mesh.diagnostics[0].message).toContain(String(limit));

    // Clearance is what the raise is for: the surface still clears H at every node.
    const heights = surfaceHeights(mesh, field);
    let under = 0, checked = 0;
    for (let n = 0; n < heights.length; n++) {
      if (field.values[n] <= 0 || heights[n] === -Infinity) continue;
      checked++;
      if (heights[n] < field.values[n] - 1e-3) under++;
    }
    expect(checked).toBeGreaterThan(10000);
    expect(under).toBe(0);
    // And it is still a closed solid.
    withArena(api, (arena) => expect(toolSolid(arena, mesh).volume()).toBeGreaterThan(0));
  });
});

describe('the clip, for a preview that sits wider than its rim', () => {
  const block = fieldOf(160, 160, (x, y) => (x >= 5 && x <= 15 && y >= 5 && y <= 15 ? 10 : 0));

  it('keeps the surface under z=0 past the clip, cell included', () => {
    const clip = { x0: 0, y0: 0, x1: 12, y1: 20 };
    const mesh = buildToolMesh(block, { raise: 0.05, tol: 0.05, clip });
    expect(mesh.clippedNodes).toBeGreaterThan(0);
    withArena(api, (arena) => {
      const solid = toolSolid(arena, mesh);
      const section = arena.track(solid.slice(0));
      expect(section.bounds().max[0]).toBeLessThanOrEqual(12);
      expect(section.bounds().max[0]).toBeGreaterThan(11.5);
    });
  });

  it('does nothing when the clip has room for the cavity', () => {
    const clip = { x0: 0, y0: 0, x1: 20, y1: 20 };
    const mesh = buildToolMesh(block, { raise: 0.05, tol: 0.05, clip });
    expect(mesh.clippedNodes).toBe(0);
    expect(mesh.positions).toEqual(buildToolMesh(block, { raise: 0.05, tol: 0.05 }).positions);
  });
});
