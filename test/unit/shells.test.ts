import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid, type ImportedSolid } from '../../src/core/mesh/shells';
import { DISPLAY_TRIANGLE_LIMIT, displayProxy, MANIFOLD_TRIANGLE_LIMIT, simplifyForManifold } from '../../src/core/mesh/simplify';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { Arena, withArena } from '../../src/core/solid/arena';
import { loadExample, loadManifold } from '../fixtures/loadExamples';
import { BOX_BOTTOM_FIRST, BOX_TOP, box, boxWithTopHole, cracked, flatTetrahedron, inverted, join, seamBox, signedVolume, withoutTriangles } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});

/** The reports are plain data, so they stay valid after the arena frees the solid. */
function run(mesh: WeldedMesh): ImportedSolid {
  return withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
}
const codes = (imported: ImportedSolid): string[] => imported.report.diagnostics.map((d) => d.code);

describe('repair ladder', () => {
  it('takes a closed box straight through with nothing to report', () => {
    const { report } = run(box([0, 0, 0], [10, 20, 30]));
    expect(report).toMatchObject({ route: 'manifold', failure: null, flipped: false, bodies: 1, modeBAvailable: true, overlapVolume: 0, voidVolume: 0 });
    expect(report.solidVolume).toBeCloseTo(6000, 3);
    expect(report.shells.map((s) => s.kind)).toEqual(['solid']);
    expect(report.diagnostics).toEqual([]);
  });

  it.each([[1], [2], [4], [64]])('closes a seam %i float steps wide with Mesh.merge, the second rung', (ulps) => {
    const seam = seamBox(ulps);
    expect(auditEdges(seam).openEdges).toBeGreaterThan(0);
    const imported = run(seam);
    expect(imported.report.route).toBe('merged');
    expect(imported.report.failure).toBe('NotManifold');
    expect(imported.report.solidVolume).toBeCloseTo(1000, 1);
    expect(imported.report.modeBAvailable).toBe(true);
    expect(codes(imported)).toContain('mesh-merged');
  });

  it('closes a crack of 0.001 mm, the rounding of a file with 3 decimals', () => {
    const imported = run(cracked(box([0, 0, 0], [20, 20, 20]), 0.001));
    expect(imported.report.route).toBe('merged');
    expect(imported.report.solidVolume).toBeCloseTo(8000, 0);
  });

  it('negative control: a crack of 0.01 mm is a real opening, and stays open', () => {
    const imported = run(cracked(box([0, 0, 0], [20, 20, 20]), 0.01));
    expect(imported.report.route).toBe('soup');
  });

  it('flips an inverted seam mesh, which needs the merge vectors a second time', () => {
    const imported = run(inverted(seamBox()));
    expect(imported.report.route).toBe('merged');
    expect(imported.report.flipped).toBe(true);
    expect(imported.report.solidVolume).toBeCloseTo(1000, 2);
    expect(signedVolume(imported.mesh)).toBeGreaterThan(0);
  });

  it('sends a box missing one triangle to soup mode, the last rung', () => {
    const mesh = withoutTriangles(box([0, 0, 0], [10, 10, 10]), [BOX_BOTTOM_FIRST]);
    const imported = run(mesh);
    expect(imported.solid).toBeNull();
    expect(imported.report).toMatchObject({ route: 'soup', failure: 'NotManifold', flipped: false, modeBAvailable: false, clearanceVerified: false });
    expect(codes(imported)).toContain('soup-mode');
    expect(imported.mesh).toBe(mesh);
  });

  it('marks clearance as verified only where there is a solid to measure', () => {
    expect(run(box([0, 0, 0], [10, 10, 10])).report.clearanceVerified).toBe(true);
    expect(run(seamBox()).report.clearanceVerified).toBe(true);
    expect(run(withoutTriangles(box([0, 0, 0], [10, 10, 10]), [0])).report.clearanceVerified).toBe(false);
  });

  it('flips an open mesh wound inside out, so its normals point outward again', () => {
    const open = withoutTriangles(box([0, 0, 0], [20, 20, 10]), BOX_TOP);
    const imported = run(inverted(open));
    expect(imported.report.route).toBe('soup');
    expect(imported.report.flipped).toBe(true);
    expect(codes(imported)).toContain('mesh-flipped');
    expect(signedVolume({ positions: imported.mesh.positions, indices: imported.mesh.indices })).toBeCloseTo(signedVolume(open), 3);
    // The hole's cap keeps pointing out of the model, which is up here, after the flip.
    expect(imported.openLoops[0].capNormal[2]).toBeCloseTo(1, 6);
  });

  it('negative control: an open mesh wound correctly is left alone', () => {
    const open = withoutTriangles(box([0, 0, 0], [20, 20, 10]), BOX_TOP);
    const imported = run(open);
    expect(imported.report.flipped).toBe(false);
    expect(imported.mesh).toBe(open);
    expect(codes(imported)).not.toContain('mesh-flipped');
  });

  it('counts the connected pieces of an open mesh as bodies, with bounds and unverified volume', () => {
    const open = join(withoutTriangles(box([0, 0, 0], [10, 10, 10]), BOX_TOP), box([20, 0, 0], [25, 5, 5]));
    const { report } = run(open);
    expect(report.route).toBe('soup');
    expect(report.bodies).toBe(2);
    expect(report.shells.map((s) => s.kind)).toEqual(['unverified', 'unverified']);
    expect(report.shells[0].min).toEqual([0, 0, 0]);
    expect(report.shells[1].max).toEqual([25, 5, 5]);
    expect(report.shells.map((s) => s.triangleCount)).toEqual([10, 12]);
    // A closed piece gets its true volume, and the open one an estimate of the right size.
    expect(report.shells[1].volume).toBeCloseTo(125, 3);
    expect(report.shells[0].volume).toBeGreaterThan(500);
    expect(report.shells[0].volume).toBeLessThan(1000);
    expect(report.solidVolume).toBe(0);
  });

  it('does not count a sealed void in an open mesh as a body, since it needs no pour', () => {
    const open = join(withoutTriangles(box([0, 0, 0], [30, 30, 30]), BOX_TOP), inverted(box([5, 5, 5], [25, 25, 25])));
    const { report } = run(open);
    expect(report.route).toBe('soup');
    expect(report.bodies).toBe(1);
    expect(report.shells.map((s) => s.kind)).toEqual(['unverified', 'void']);
    expect(report.shells[1].volume).toBeCloseTo(-8000, 1);
  });

  it('negative control: a separate body beside it stays a body, even wound inside out', () => {
    const open = join(withoutTriangles(box([0, 0, 0], [30, 30, 30]), BOX_TOP), inverted(box([40, 5, 5], [50, 25, 25])));
    const { report } = run(open);
    expect(report.bodies).toBe(2);
    expect(report.shells.map((s) => s.kind)).toEqual(['unverified', 'unverified']);
  });

  it('reports a large missing cap, disables Mode B and states the hole size', () => {
    const imported = run(withoutTriangles(box([0, 0, 0], [20, 20, 10]), BOX_TOP));
    expect(imported.report.route).toBe('soup');
    expect(imported.report.modeBAvailable).toBe(false);
    expect(codes(imported)).toEqual(['soup-mode', 'missing-surface']);
    const message = imported.report.diagnostics[1].message;
    expect(message).toContain('400.0 mm2');
  });

  it('reports a hole of 50 mm2 too', () => {
    expect(codes(run(withoutTriangles(box([0, 0, 0], [10, 10, 10]), [BOX_BOTTOM_FIRST])))).toEqual(['soup-mode', 'missing-surface']);
  });

  // Legs of a right triangle: leg^2 / 2 gives 0.125, 0.9 and 1.1 mm2, around the 1 mm2 threshold.
  it.each([
    [0.5, false],
    [Math.sqrt(1.8), false],
    [Math.sqrt(2.2), true],
  ])('with a triangular hole of leg %f, reports the missing surface: %s', (leg, reported) => {
    const imported = run(boxWithTopHole(leg));
    expect(imported.report.route).toBe('soup');
    expect(codes(imported)).toEqual(reported ? ['soup-mode', 'missing-surface'] : ['soup-mode']);
  });

  it('sends a closed mesh that encloses nothing to soup mode, though Manifold accepts it', () => {
    const imported = run(flatTetrahedron());
    expect(imported.solid).toBeNull();
    expect(imported.report.route).toBe('soup');
    expect(imported.report.failure).toBeNull();
    expect(imported.report.modeBAvailable).toBe(false);
  });

  it('sends two triangles back to back to soup mode too, because Manifold refuses them', () => {
    const imported = run({ positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 1]) });
    expect(imported.report.route).toBe('soup');
    expect(imported.report.failure).toBe('NotManifold');
  });

  it('rethrows a non-Manifold failure, because the worker must die and respawn on it', () => {
    const arena = new Arena(api);
    const crash = new Error('memory access out of bounds');
    arena.manifold = () => {
      throw crash;
    };
    const mesh = box([0, 0, 0], [1, 1, 1]);
    expect(() => importSolid(arena, mesh, auditEdges(mesh))).toThrow(crash);
    arena.dispose();
  });
});

describe('shell analysis', () => {
  it('flips an inverted mesh, so volume and winding both come out positive', () => {
    const mesh = inverted(box([0, 0, 0], [10, 20, 30]));
    expect(signedVolume(mesh)).toBeCloseTo(-6000, 3);
    const imported = run(mesh);
    expect(imported.report.flipped).toBe(true);
    expect(imported.report.solidVolume).toBeCloseTo(6000, 3);
    expect(signedVolume(imported.mesh)).toBeCloseTo(6000, 3);
    expect(codes(imported)).toContain('mesh-flipped');
  });

  it('records overlapping shells with the overlap volume', () => {
    // 10 mm cubes offset by 5 mm in x overlap in a 5 x 10 x 10 block.
    const imported = run(join(box([0, 0, 0], [10, 10, 10]), box([5, 0, 0], [15, 10, 10])));
    expect(imported.report.bodies).toBe(2);
    expect(imported.report.solidVolume).toBeCloseTo(2000, 2);
    expect(imported.report.overlapVolume).toBeCloseTo(500, 2);
    expect(codes(imported)).toContain('shell-overlap');
  });

  it('negative control: separate shells report no overlap', () => {
    const imported = run(join(box([0, 0, 0], [10, 10, 10]), box([11, 0, 0], [21, 10, 10])));
    expect(imported.report.bodies).toBe(2);
    expect(imported.report.overlapVolume).toBe(0);
    expect(codes(imported)).not.toContain('shell-overlap');
  });

  it('records a negative shell inside a positive one as a void, not a body', () => {
    const imported = run(join(box([0, 0, 0], [10, 10, 10]), inverted(box([2, 2, 2], [8, 8, 8]))));
    expect(imported.report.bodies).toBe(1);
    expect(imported.report.solidVolume).toBeCloseTo(1000, 2);
    expect(imported.report.voidVolume).toBeCloseTo(216, 2);
    expect(imported.report.shells.map((s) => s.kind)).toEqual(['solid', 'void']);
    expect(imported.report.flipped).toBe(false);
    expect(codes(imported)).toContain('shell-void');
  });

  it('treats a whole hollow model turned inside out as the same void after flipping', () => {
    const imported = run(inverted(join(box([0, 0, 0], [10, 10, 10]), inverted(box([2, 2, 2], [8, 8, 8])))));
    expect(imported.report.flipped).toBe(true);
    expect(imported.report.solidVolume).toBeCloseTo(1000, 2);
    expect(imported.report.voidVolume).toBeCloseTo(216, 2);
  });

  it('flips one inverted body that is inside nothing, leaving the other alone', () => {
    const mesh = join(box([0, 0, 0], [10, 10, 10]), inverted(box([20, 0, 0], [25, 10, 10])));
    const imported = withArena(api, (arena) => {
      const result = importSolid(arena, mesh, auditEdges(mesh));
      expect(result.solid?.volume()).toBeCloseTo(1500, 2);
      return result;
    });
    expect(imported.report.flipped).toBe(false);
    expect(imported.report.bodies).toBe(2);
    expect(imported.report.shells.map((s) => s.kind)).toEqual(['solid', 'inverted']);
    expect(imported.report.solidVolume).toBeCloseTo(1500, 2);
    expect(signedVolume(imported.mesh)).toBeCloseTo(1500, 2);
    expect(codes(imported)).toContain('shell-inverted');
  });

  it('sees no overlap for a body sitting inside a sealed void, which touches nothing', () => {
    const imported = run(join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([10, 10, 10], [20, 20, 20])));
    expect(imported.report.bodies).toBe(2);
    expect(imported.report.shells.map((s) => s.kind)).toEqual(['solid', 'solid', 'void']);
    expect(imported.report.overlapVolume).toBe(0);
    expect(imported.report.diagnostics.map((d) => d.code)).toEqual(['shell-void']);
  });

  it('negative control: a body reaching through the void into the solid does overlap, by that much', () => {
    // A 10 mm cube sticking 2 mm out of the 20 mm void, into the wall: 2 x 10 x 10.
    const imported = run(join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([3, 10, 10], [13, 20, 20])));
    expect(imported.report.overlapVolume).toBeCloseTo(200, 1);
    expect(codes(imported)).toContain('shell-overlap');
  });

  it('accepts negative genus with no diagnostics', () => {
    const imported = run(join(box([0, 0, 0], [1, 1, 1]), box([3, 0, 0], [4, 1, 1]), box([6, 0, 0], [7, 1, 1])));
    expect(imported.report.bodies).toBe(3);
    expect(imported.report.diagnostics).toEqual([]);
  });
});

/** Distance from a point to a triangle, by the closest-point regions of Ericson's book. */
function pointTriangleDistance(p: number[], a: number[], b: number[], c: number[]): number {
  const sub = (u: number[], v: number[]): number[] => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: number[], v: number[]): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = (u: number[], v: number[], s: number): number[] => [u[0] + v[0] * s, u[1] + v[1] * s, u[2] + v[2] * s];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let closest: number[];
  if (d1 <= 0 && d2 <= 0) closest = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) closest = b;
    else if (d6 >= 0 && d5 <= d6) closest = c;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) closest = along(a, ab, d1 / (d1 - d3));
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) closest = along(a, ac, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) closest = along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    else {
      const denom = 1 / (va + vb + vc);
      closest = along(along(a, ab, vb * denom), ac, vc * denom);
    }
  }
  const gap = sub(p, closest);
  return Math.sqrt(dot(gap, gap));
}

describe('simplification for heavy input (G1.8, thresholds lowered here; the 3M run is M11)', () => {
  it('uses the limits in the plan: 2M for the Manifold path, 300k for the display proxy', () => {
    expect(MANIFOLD_TRIANGLE_LIMIT).toBe(2_000_000);
    expect(DISPLAY_TRIANGLE_LIMIT).toBe(300_000);
  });

  it('leaves a mesh under the limit alone', () => {
    const { welded } = loadExample('jersey');
    expect(simplifyForManifold(welded, MeshoptSimplifier)).toBeNull();
    expect(displayProxy(welded, MeshoptSimplifier)).toBeNull();
  });

  it('simplifies to a compact, valid solid and reports the error it measured', () => {
    const { welded } = loadExample('goddess');
    const simplified = simplifyForManifold(welded, MeshoptSimplifier, 5000);
    expect(simplified).not.toBeNull();
    const { mesh, errorMm, diagnostics } = simplified!;
    expect(mesh.indices.length / 3).toBeLessThanOrEqual(5000);
    expect(new Set(mesh.indices).size).toBe(mesh.positions.length / 3);
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['mode-b-simplified', 'warning']]);
    expect(diagnostics[0].message).toContain(`${errorMm.toFixed(3)} mm`);

    // Checks the error in mm against the real distance from the original surface to the simplified
    // one, on a sample of vertices. The reported figure is an estimate, so only its size must
    // match, and a relative error, 100 times too small here, would fail this.
    const { positions: p, indices } = welded;
    const corner = (i: number): number[] => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    let measured = 0;
    for (let v = 0; v < p.length / 3; v += 40) {
      const point = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
      let nearest = Infinity;
      for (let t = 0; t < mesh.indices.length; t += 3) nearest = Math.min(nearest, pointTriangleDistance(point, corner(mesh.indices[t]), corner(mesh.indices[t + 1]), corner(mesh.indices[t + 2])));
      measured = Math.max(measured, nearest);
    }
    console.log(`simplify: reported ${errorMm.toFixed(4)} mm, measured ${measured.toFixed(4)} mm on ${Math.ceil(p.length / 3 / 40)} vertices of ${indices.length / 3} triangles`);
    expect(errorMm).toBeGreaterThan(measured / 5);
    expect(errorMm).toBeLessThan(measured * 5);

    const original = withArena(api, (arena) => importSolid(arena, welded, auditEdges(welded)).report.solidVolume);
    const reduced = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report);
    expect(reduced.route).toBe('manifold');
    expect(Math.abs(reduced.solidVolume - original) / original).toBeLessThan(0.02);
  });

  it('builds a display proxy under its limit', () => {
    const { welded } = loadExample('goddess');
    const proxy = displayProxy(welded, MeshoptSimplifier, 2000);
    expect(proxy).not.toBeNull();
    expect(proxy!.indices.length / 3).toBeLessThanOrEqual(2000);
    expect(proxy!.indices.length / 3).toBeGreaterThan(200);
    expect(new Set(proxy!.indices).size).toBe(proxy!.positions.length / 3);
  });
});
