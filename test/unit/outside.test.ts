import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { SurfaceIndex } from '../../src/core/mesh/deviation';
import { farPrisms, fromRuns, runsOf, SolidPoints, splitLong } from '../../src/core/mesh/outside';
import { surfaceArea } from '../../src/core/mesh/repair';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { loadManifold } from '../fixtures/loadExamples';
import { bruteGap, bruteInside } from '../fixtures/repairChecks';
import { box, join, sphere, weldedFixture } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

/** A small fixed generator, so every run checks the same points. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('RM: the file cut into pieces for the bound', () => {
  it('cuts every triangle, needles too, until no edge passes the limit, keeping its area and its triangle', () => {
    const next = random(3);
    const P: number[] = [];
    for (let t = 0; t < 60; t++) for (let c = 0; c < 9; c++) P.push(next() * 40 - 20);
    // Needles: 70 mm long and 0.08 mm across, as a fan under a block.
    P.push(0, 0, 0, 70, 0.04, 0, 70, -0.04, 0, 0, 0, 5, 0.04, 30, 5, -0.04, 30, 5.01);
    const mesh: WeldedMesh = { positions: Float32Array.from(P), indices: Uint32Array.from({ length: P.length / 3 }, (_, k) => k) };
    const split = splitLong(mesh, 1.4);
    const Q = split.mesh.positions, J = split.mesh.indices;
    const areaOf = new Float64Array(mesh.indices.length / 3);
    for (let k = 0; k < J.length / 3; k++) {
      const v = [0, 1, 2].map((c) => J[k * 3 + c] * 3);
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        expect(Math.hypot(Q[a] - Q[b], Q[a + 1] - Q[b + 1], Q[a + 2] - Q[b + 2])).toBeLessThanOrEqual(1.4 + 1e-12);
      }
      const u = [Q[v[1]] - Q[v[0]], Q[v[1] + 1] - Q[v[0] + 1], Q[v[1] + 2] - Q[v[0] + 2]], w = [Q[v[2]] - Q[v[0]], Q[v[2] + 1] - Q[v[0] + 1], Q[v[2] + 2] - Q[v[0] + 2]];
      areaOf[split.parent[k]] += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    for (let t = 0; t < areaOf.length; t++) {
      const own = surfaceArea({ positions: mesh.positions, indices: mesh.indices.subarray(t * 3, t * 3 + 3) });
      expect(Math.abs(areaOf[t] - own)).toBeLessThan(1e-9 * Math.max(1, own));
    }
    // A needle in strips: about 120 pieces, where bisection alone made about 800.
    const needle = split.parent.filter((t) => t === 60).length;
    expect(needle).toBeLessThan(140);
    // Only the listed triangles, and their vertices alone.
    const two = splitLong(mesh, 1.4, [3, 5]);
    expect(new Set(two.parent)).toEqual(new Set([3, 5]));
  });

  it('turns a sorted list into runs and back', () => {
    const list = Int32Array.from([2, 3, 4, 9, 11, 12]);
    expect(runsOf(list)).toEqual([[2, 3], [9, 1], [11, 2]]);
    expect(Array.from(fromRuns(runsOf(list)))).toEqual(Array.from(list));
  });
});

describe('RM: whether a point lies inside the copy', () => {
  it('agrees with the generalised winding number on 2,000 points, under the mesh\'s own vertices too, where parts overlap', () => {
    const mesh = weldedFixture(join(sphere(api, 10, 24), box([0, -4, -4], [16, 4, 4])));
    const solid = new SolidPoints(mesh);
    const next = random(11);
    let checked = 0, unsure = 0, inside = 0;
    const P = mesh.positions;
    for (let k = 0; k < 2000; k++) {
      let x: number, y: number;
      if (k % 2 === 0) {
        // A column straight through a vertex, so through the edges round it: the top-left rule meets it once.
        const v = Math.floor(next() * (P.length / 3));
        x = P[v * 3];
        y = P[v * 3 + 1];
      } else {
        x = next() * 32 - 12;
        y = next() * 24 - 12;
      }
      const z = next() * 24 - 12;
      const answer = solid.inside(x, y, z);
      if (answer === null) {
        unsure++;
        continue;
      }
      expect(answer, `${x}, ${y}, ${z}`).toBe(bruteInside(mesh, x, y, z));
      if (answer) inside++;
      checked++;
    }
    expect(unsure).toBeLessThan(10);
    expect(inside).toBeGreaterThan(300);
    expect(checked).toBeGreaterThan(1900);
  });
});

describe('RM: the far part measured as prisms', () => {
  it('a prism\'s gap to a box is never more than its triangle\'s, and at most 0.02 mm less, on 500 triangles', () => {
    const next = random(5);
    const target = box([0, 0, 0], [10, 10, 10]);
    let checked = 0;
    withArena(api, (arena) => {
      const solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: target.positions, triVerts: target.indices }));
      for (let k = 0; k < 500; k++) {
        // A triangle of up to 6 mm near the box, some of them through it.
        const cx = next() * 20 - 5, cy = next() * 20 - 5, cz = next() * 20 - 5;
        const P = Float32Array.from({ length: 9 }, (_, i) => [cx, cy, cz][i % 3] + (next() - 0.5) * 6);
        const triangle: WeldedMesh = { positions: P, indices: Uint32Array.from([0, 1, 2]) };
        const prisms = farPrisms(triangle);
        expect(auditEdges(prisms).openEdges).toBe(0);
        const gap = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: prisms.positions, triVerts: prisms.indices })).minGap(solid, 30);
        const brute = bruteGap(triangle, target);
        expect(gap).toBeLessThanOrEqual(brute + 1e-6);
        // A corner inside the box puts the prism into the solid, whose gap is then 0 whatever the faces' distance.
        const outside = [0, 1, 2].every((c) => [0, 1, 2].some((d) => P[c * 3 + d] < 0 || P[c * 3 + d] > 10));
        if (outside) {
          expect(brute - gap).toBeLessThan(0.02);
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(300);
  });

  it('takes many triangles in one mesh, each a closed piece Manifold takes, and one with no normal as a box', () => {
    const mesh: WeldedMesh = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 6, 6, 7, 7, 7]), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]) };
    const prisms = farPrisms(mesh);
    expect(auditEdges(prisms)).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    const volume = withArena(api, (arena) => arena.manifold(new api.Mesh({ numProp: 3, vertProperties: prisms.positions, triVerts: prisms.indices })).volume());
    expect(volume).toBeGreaterThan(0);
  });
});

describe('RM: SurfaceIndex.bound keeping far points apart (isolate)', () => {
  it('a point past the limit does not raise the figure of the rest, where by default it raises the goal to the limit', () => {
    const mesh = box([0, 0, 0], [10, 10, 10]);
    // A triangle 0.05 mm over the top, and one 5 mm over it.
    const near: WeldedMesh = { positions: Float32Array.from([1, 1, 10.05, 9, 1, 10.05, 1, 9, 10.05]), indices: Uint32Array.from([0, 1, 2]) };
    const far: WeldedMesh = { positions: Float32Array.from([1, 1, 15, 9, 1, 15, 1, 9, 15]), indices: Uint32Array.from([0, 1, 2]) };
    // The far one first, as a file's order may put it.
    const both = join(far, near);
    const index = new SurfaceIndex(mesh, 0.5);
    const kept = index.bound(both, 0.5, undefined, undefined, undefined, true);
    expect(Array.from(kept.past)).toEqual([0]);
    expect(kept.bound).toBeCloseTo(0.05, 3);
    const plain = index.bound(both, 0.5);
    expect(Array.from(plain.past)).toEqual([0]);
    expect(plain.bound).toBeGreaterThanOrEqual(0.5 - 1e-9);
    // And on its own the near one gives the same figure as kept apart.
    expect(index.bound(near, 0.5).bound).toBeCloseTo(kept.bound, 9);
  });
});
