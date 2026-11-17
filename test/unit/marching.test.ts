import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { clampFor, marchField, type Lattice } from '../../src/core/mesh/marching';
import { asLoaded } from '../../src/core/mesh/repairImport';
import { importSolid } from '../../src/core/mesh/shells';
import { withArena } from '../../src/core/solid/arena';
import { loadManifold } from '../fixtures/loadExamples';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

/** A lattice of cell h whose first node is `o` and which runs to past `max` on each axis. */
function lattice(o: [number, number, number], max: number, h: number): Lattice {
  const n = o.map((a) => Math.floor((max - a) / h) + 2) as [number, number, number];
  return { h, o, n };
}

const sphere = (r: number) => (x: number, y: number, z: number): number => r - Math.sqrt(x * x + y * y + z * z);

/** Positive inside, the exact distance to an axis-aligned box's surface. */
function boxField(lo: number[], hi: number[]) {
  return (x: number, y: number, z: number): number => {
    const p = [x, y, z];
    const d = [0, 1, 2].map((k) => Math.max(lo[k] - p[k], p[k] - hi[k]));
    const outside = Math.sqrt(Math.max(d[0], 0) ** 2 + Math.max(d[1], 0) ** 2 + Math.max(d[2], 0) ** 2);
    return -(outside + Math.min(0, Math.max(d[0], d[1], d[2])));
  };
}

const closed = (mesh: Parameters<typeof auditEdges>[0]): [number, number, number] => {
  const audit = auditEdges(mesh);
  return [audit.openEdges, audit.nonManifoldEdges, audit.misorientedEdges];
};

describe('RM: marching tetrahedra on the Kuhn split', () => {
  it('a sphere of r 10 at h 0.5 comes out closed and wound outwards, Manifold takes it, and its volume is within 1%', () => {
    const lat = lattice([-11.37, -11.37, -11.37], 11.5, 0.5);
    const { mesh } = marchField(lat, sphere(10));
    expect(closed(mesh)).toEqual([0, 0, 0]);
    // As its STL loads again: no two vertices round to one float32.
    expect(asLoaded(mesh).positions.length).toBe(mesh.positions.length);
    const report = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report);
    expect(report.route).toBe('manifold');
    expect(report.flipped).toBe(false);
    expect(report.folds).toBe(0);
    const exact = (4 / 3) * Math.PI * 1000;
    expect(Math.abs(report.solidVolume - exact) / exact).toBeLessThan(0.01);
  });

  it('a field whose faces lie on the nodes themselves still closes, as f = 0 counts as outside', () => {
    // A slab from z = 0 to z = 2 on a lattice with nodes at every 0.5, so both faces are node planes.
    const lat: Lattice = { h: 0.5, o: [-2, -2, -2], n: [17, 17, 13] };
    const { mesh } = marchField(lat, boxField([0, 0, 0], [6, 6, 2]));
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(closed(mesh)).toEqual([0, 0, 0]);
    expect(asLoaded(mesh).positions.length).toBe(mesh.positions.length);
  });

  it('a box\'s faces come out where they are, to 1e-4 mm, away from its edges', () => {
    const lo = [1.21, 2.33, 0.77], hi = [9.04, 7.46, 5.58];
    const lat = lattice([-1.37, -0.21, -1.79], 11, 0.5);
    const { mesh } = marchField(lat, boxField(lo, hi));
    expect(closed(mesh)).toEqual([0, 0, 0]);
    const P = mesh.positions;
    let checked = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      // A vertex two cells from every edge of the box lies on one face, exactly, as the field is linear there
      // (the faces lie between nodes, as one within the clamp of a node is moved by up to the clamp).
      const inner = [0, 1, 2].filter((k) => p[k] > lo[k] + 1 && p[k] < hi[k] - 1).length;
      if (inner < 2) continue;
      const off = Math.min(...[0, 1, 2].map((k) => Math.min(Math.abs(p[k] - lo[k]), Math.abs(p[k] - hi[k]))));
      expect(off).toBeLessThan(1e-4);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('control: a lattice with no outside layer leaves the surface open where the field is positive at its edge', () => {
    // The sphere cut by the lattice's own faces: the closedness assertion above would fail on this.
    const lat = lattice([-9, -9, -9], 9, 0.5);
    const { mesh } = marchField(lat, sphere(10));
    expect(auditEdges(mesh).openEdges).toBeGreaterThan(0);
  });

  it('keeps vertices on different edges of one node apart in float32, far from the origin too', () => {
    // At 318 mm, where the oil barrel's coordinates lie, 1e-4 of a 0.1 mm edge is under a float32 step.
    const lat: Lattice = { h: 0.1, o: [310, 310, 310], n: [40, 40, 40] };
    expect(clampFor(lat) * lat.h).toBeGreaterThanOrEqual(16 * 2 ** (8 - 23));
    const { mesh } = marchField(lat, (x, y, z) => 1.5 - Math.sqrt((x - 312) ** 2 + (y - 312) ** 2 + (z - 312) ** 2), clampFor(lat));
    expect(closed(mesh)).toEqual([0, 0, 0]);
    expect(asLoaded(mesh).positions.length).toBe(mesh.positions.length);
  });
});
