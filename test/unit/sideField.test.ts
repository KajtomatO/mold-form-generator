import { describe, expect, it } from 'vitest';
import { assertRigid, determinant, transformPositions } from '../../src/core/base/orient';
import { conditionField } from '../../src/core/field/build';
import { dilate } from '../../src/core/field/dilate';
import { rasterize } from '../../src/core/field/raster';
import { applyLayerRows, applyPrismRows, applyRoof, buildSideField, floorRow, flattenFarSide, frameInverse, layerRows, LIFT_MAX, PULLS, sideFrame, topMap, seamEps, topRowClear, turnMesh, type Pull } from '../../src/core/field/side';
import type { Field } from '../../src/core/field/grid';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { buildToolMesh, TOOL_BOTTOM } from '../../src/core/solid/tool';
import { coarseRows, exactRim, fineSplit, orientedGallery, prepareClamshell, sideField, type ClamshellPrep } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, type ExampleId } from '../fixtures/loadExamples';
import { BAND_ROOM, hmaxClam, PRY_LEG } from '../../src/core/parts/rim';
import { box, join } from '../fixtures/synthetic';

/** MP1: G13.1's frames and G13.2's side fields (docs/PLAN.md, MP1's checks). */

/** A small seeded generator, so a failure names a case that comes back. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A few random triangles over z >= 0, which is all the raster reads. */
function randomMesh(seed: number, triangles = 6): WeldedMesh {
  const next = random(seed);
  const soup = new Float32Array(triangles * 9);
  for (let k = 0; k < triangles * 3; k++) {
    soup[k * 3] = next() * 12;
    soup[k * 3 + 1] = next() * 9;
    soup[k * 3 + 2] = next() * 10;
  }
  return weld(soup);
}

/**
 * The voxel envelope by brute force in the turned frame: points sampled on every triangle, each a sphere of rEff, the
 * reach at a node the highest h over the spheres that cover it. The points are a subset of the model, so this never
 * reads above the true envelope, which the field must hold.
 */
function bruteEnvelope(turned: WeldedMesh, field: Field, rEff: number, steps = 24): Float64Array {
  const { nx, ny, cell, x0, y0 } = field;
  const out = new Float64Array(nx * ny);
  const p = turned.positions, I = turned.indices;
  const r2 = rEff * rEff;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const s = i / steps, q = j / steps, w = 1 - s - q;
        const u = w * p[a] + s * p[b] + q * p[c], v = w * p[a + 1] + s * p[b + 1] + q * p[c + 1], h = w * p[a + 2] + s * p[b + 2] + q * p[c + 2];
        if (v < 0) continue;
        const i0 = Math.max(0, Math.floor((u - rEff - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((u + rEff - x0) / cell));
        const j0 = Math.max(0, Math.floor((v - rEff - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((v + rEff - y0) / cell));
        for (let jj = j0; jj <= j1; jj++) {
          for (let ii = i0; ii <= i1; ii++) {
            const d2 = (x0 + ii * cell - u) ** 2 + (y0 + jj * cell - v) ** 2;
            if (d2 > r2) continue;
            const reach = h + Math.sqrt(r2 - d2);
            if (reach > out[ii + jj * nx]) out[ii + jj * nx] = reach;
          }
        }
      }
    }
  }
  return out;
}

function prepOf(mesh: WeldedMesh, beta = 20): ClamshellPrep {
  const params = defaultParams('clamshell');
  params.clamshell.ceilingDeg = beta;
  return prepareClamshell(mesh, params);
}

describe('G13.1 frames', () => {
  const bounds = { min: [-7, -3, 0] as [number, number, number], max: [11, 5, 9] as [number, number, number] };
  it.each(PULLS)('the %s frame has determinant +1, h >= 0 over the model, and turns back exactly', (pull: Pull) => {
    const frame = sideFrame(pull, bounds);
    expect(determinant(frame)).toBe(1);
    expect(() => assertRigid(frame)).not.toThrow();
    const corners = new Float32Array([-7, -3, 0, 11, 5, 9, -7, 5, 9, 11, -3, 0, 2.5, 1.25, 4.75]);
    const turned = transformPositions(corners, frame);
    for (let k = 2; k < turned.length; k += 3) expect(turned[k]).toBeGreaterThanOrEqual(0);
    // v is z in every frame.
    for (let k = 1; k < turned.length; k += 3) expect(turned[k]).toBe(corners[k + 1]);
    const back = transformPositions(turned, frameInverse(frame));
    expect(Array.from(back)).toEqual(Array.from(corners));
  });
});

describe('G13.2 side fields', () => {
  it.each([1, 2, 3, 4, 5, 6])('each side field holds the brute-force voxel envelope on random mesh %i', (seed) => {
    const mesh = randomMesh(seed);
    const prep = prepOf(mesh);
    for (const pull of PULLS) {
      const { field, side } = sideField(prep, pull, 0.5, 20, null);
      // G4: the margin past t covers the raster's placing of a source at its node, so the envelope of radius t is what holds.
      const envelope = bruteEnvelope(turnMesh(prep.clipped, side.frame), field, prep.settings.t);
      let worst = Infinity;
      for (let n = 0; n < envelope.length; n++) if (envelope[n] > 0) worst = Math.min(worst, field.values[n] - envelope[n]);
      expect(worst, `${pull} reads under the envelope`).toBeGreaterThanOrEqual(-1e-4);
    }
  });

  it('the roof holds its property, and the top row of every roofed field is at or under hStop', () => {
    const prep = prepOf(orientedExample('goddess').mesh);
    for (const beta of [20, 45, 60]) {
      for (const pull of PULLS) {
        for (const xs of [null, 'mid'] as const) {
          const a = pull[1] === 'x' ? 0 : 1;
          const at = xs === null ? null : (prep.bounds.min[a] + prep.bounds.max[a]) / 2;
          const { field, hs } = sideField(prep, pull, 1, beta, at);
          expect(topRowClear(field, hs), `${pull} at beta ${beta}, xs ${at}`).toBe(true);
          if (at !== null) continue;
          const fall = field.cell / Math.tan((beta * Math.PI) / 180);
          let worst = Infinity;
          for (let j = 1; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
            const below = field.values[i + (j - 1) * field.nx];
            if (below > hs) worst = Math.min(worst, field.values[i + j * field.nx] - (below - fall));
          }
          expect(worst).toBeGreaterThanOrEqual(-1e-4);
        }
      }
    }
  });

  it('beta 0 builds no roof', () => {
    const f: Field = { nx: 1, ny: 3, cell: 1, x0: 0, y0: 0, values: new Float32Array([5, 0, 0]) };
    applyRoof(f, 0, 0);
    expect(Array.from(f.values)).toEqual([5, 0, 0]);
    applyRoof(f, 45, 0);
    expect(Array.from(f.values)).toEqual([5, 4, 3]);
  });

  it('prism rows only raise G, as a straight prism into the rebate down to -(Tb + 1)', () => {
    // With a base layer, so step 4's rows are under the prism too.
    const params = defaultParams('clamshell');
    params.silicone.baseLayer = 3;
    const prep = prepareClamshell(orientedExample('goddess').mesh, params);
    const pull = '+y';
    const { side } = sideField(prep, pull, 0.5, 20, null);
    // Steps 2 to 4 alone, as buildSideField runs them, and step 5 once on a copy.
    const { field } = conditionField(dilate(rasterize(turnMesh(prep.clipped, side.frame), side.grid), side.plan.rEff), prep.settings);
    applyRoof(field, 20, 0);
    const layer = layerRows(pull, prep.bounds, prep.mold.D, 3, field.cell);
    expect(layer).not.toBeNull();
    applyLayerRows(field, layer!);
    const before = field.values.slice();
    const Tb = prep.params.base.thickness;
    applyPrismRows(field, Tb);
    const { nx, cell, y0 } = field;
    const j0 = floorRow(field);
    let raised = 0;
    for (let n = 0; n < before.length; n++) expect(field.values[n]).toBeGreaterThanOrEqual(before[n]);
    for (let j = 0; j < j0; j++) {
      const v = y0 + j * cell;
      for (let i = 0; i < nx; i++) {
        const n = i + j * nx, floor = before[i + j0 * nx];
        if (v >= -(Tb + 1) - 1e-9) {
          // Every row of the prism takes G(u, 0) where that is larger, and keeps its own where it is not.
          expect(field.values[n]).toBe(Math.max(before[n], floor));
          if (floor > before[n]) raised++;
        } else {
          expect(field.values[n]).toBe(before[n]);
        }
      }
    }
    expect(raised).toBeGreaterThan(0);
  });

  it('the flatten touches only rows with no point of the dilated model past P', () => {
    const prep = prepOf(orientedExample('goddess').mesh);
    for (const pull of ['+y', '-y', '+x'] as const) {
      const a = pull[1] === 'x' ? 0 : 1;
      const xs = prep.bounds.min[a] + 0.6 * (prep.bounds.max[a] - prep.bounds.min[a]);
      const { field, side, hs } = sideField(prep, pull, 0.5, 20, xs);
      const plain = buildSideField(turnMesh(prep.clipped, side.frame), side, prep.settings, { betaDeg: 20, hStop: hs, flattenAt: null, layer: null, Tb: prep.params.base.thickness });
      const envelope = bruteEnvelope(turnMesh(prep.clipped, side.frame), plain, prep.settings.t, 4);
      let changed = 0;
      for (let n = 0; n < plain.values.length; n++) {
        if (field.values[n] === plain.values[n]) continue;
        changed++;
        expect(plain.values[n]).toBeLessThanOrEqual(hs);
        expect(envelope[n]).toBeLessThanOrEqual(hs);
        expect(field.values[n]).toBeCloseTo(hs - 1 - LIFT_MAX, 5);
      }
      expect(changed).toBeGreaterThan(0);
      // Rows past P are untouched.
      for (let n = 0; n < plain.values.length; n++) if (plain.values[n] > hs) expect(field.values[n]).toBe(plain.values[n]);
    }
    // A node next to one past hs stays as it was.
    const f: Field = { nx: 3, ny: 1, cell: 1, x0: 0, y0: 0, values: new Float32Array([1, 2, 9]) };
    flattenFarSide(f, 5);
    expect(Array.from(f.values)).toEqual([3.5, 2, 9]);
  });

  it("buildToolMesh's band holds: no final node in (hs - eps, hs + eps]", () => {
    const prep = prepOf(orientedExample('goddess').mesh);
    const fine = fineSplit(prep, 'y', 150, 0.5);
    for (const side of [fine.plus, fine.minus]) {
      const eps = seamEps(prep.settings.tinTol);
      const seam = { hs: side.hs, eps };
      const mesh = buildToolMesh(side.field, { raise: side.side.plan.raise, tol: prep.settings.tinTol, seam });
      let inside = 0;
      for (let k = 2; k < mesh.positions.length; k += 3) {
        const z = mesh.positions[k];
        if (z === TOOL_BOTTOM) continue;
        if (z > seam.hs - eps && z <= seam.hs + eps) inside++;
      }
      expect(inside).toBe(0);
      expect(mesh.raise).toBeLessThanOrEqual(LIFT_MAX);
      // Without the band, nodes do fall in it, so the check is not empty.
      const plain = buildToolMesh(side.field, { raise: side.side.plan.raise, tol: prep.settings.tinTol });
      let before = 0;
      for (let k = 2; k < plain.positions.length; k += 3) if (plain.positions[k] > seam.hs - eps && plain.positions[k] <= seam.hs + eps) before++;
      expect(before).toBeGreaterThan(0);
    }
  });

  it('a lift past LIFT_MAX is refused with the seam option', () => {
    const f: Field = { nx: 4, ny: 4, cell: 1, x0: 0, y0: 0, values: new Float32Array(16).fill(3) };
    expect(() => buildToolMesh(f, { raise: 0.6, tol: 0.05, seam: { hs: 1, eps: 0.05 } })).toThrow(/past the 0.5 mm/);
    expect(() => buildToolMesh(f, { raise: 0.6, tol: 0.05 })).not.toThrow();
    // A band at 0 still finds the first float past it.
    expect(() => buildToolMesh(f, { raise: 0.05, tol: 0.05, seam: { hs: 0, eps: 0 } })).not.toThrow();
  });

  it('H_top is the highest z whose row reaches each point, from both fields', () => {
    const cube = join(box([-10, -10, 0], [10, 10, 20]));
    const prep = prepOf(cube);
    const fine = fineSplit(prep, 'x', 0, 0.5);
    const top = topMap(fine.plus.field, fine.minus.field, prep.bounds, 'x', 0);
    const at = (x: number, y: number): number => top.values[Math.round((x - top.x0) / top.cell) + Math.round((y - top.y0) / top.cell) * top.nx];
    // Over the cube the cavity's top is its own top plus about rEff, on both sides of P alike.
    const rEff = fine.plus.side.plan.rEff;
    for (const x of [-8, -2, 2, 8]) expect(at(x, 0)).toBeGreaterThanOrEqual(20 + rEff - 0.5 - 1e-6);
    expect(Math.abs(at(-5, 3) - at(5, 3))).toBeLessThanOrEqual(0.5);
    // Past the dilated cube there is no cavity.
    expect(at(0, top.y0 + top.cell)).toBe(0);
    expect(at(10 + rEff + 0.6, 0)).toBe(0);
    expect(at(-10 - rEff - 0.6, 0)).toBe(0);
  });

  it('the sphere and the cube build on every pull, coarse and fine', () => {
    for (const id of ['sphere', 'cube']) {
      const prep = prepOf(orientedGallery(id));
      const rows = coarseRows(prep, 20);
      expect(Object.keys(rows).sort()).toEqual(['+x', '+y', '-x', '-y']);
    }
  });
});

describe('G13.6 the wall raise', () => {
  it('a model whose high plate overhangs far across b raises the wall for the seam seal, on all four sides', () => {
    // A stem under a plate 60 mm wide, 200 long along x, at a 3 degree draft: far from P the plate's D3 passes D_G8.
    const params = defaultParams('clamshell');
    params.silicone.wallDraftDeg = 3;
    const plain = prepareClamshell(join(box([-100, -5, 0], [100, 5, 30]), box([-100, -30, 30], [100, 30, 34])), params);
    const rim = exactRim(plain, 'x', -60);
    expect(rim.wallRaised).not.toBeNull();
    const d = rim.diagnostics.find((x) => x.code === 'seam-wall-raised');
    expect(d?.severity).toBe('info');
    expect(d?.also).toEqual(['cover.wall']);
    expect(d?.message).toContain(`Wall raised from 3.0 to ${rim.wall.toFixed(1)} mm for the seam seal`);
    const j = params.joint, room = params.clamshell.seamLand + j.ridgeWidth + 2 * j.grooveClearance + PRY_LEG + BAND_ROOM;
    expect(rim.O.y0).toBeLessThanOrEqual(rim.D3.y0 - room + 1e-9);
    expect(rim.O.y1).toBeGreaterThanOrEqual(rim.D3.y1 + room - 1e-9);
    // One wall round the box: O moves by the raise on every side, the edge's minimum with it, and D3 stays inside along a.
    const raise = rim.wallRaised!.to - rim.wallRaised!.from;
    const unraised = exactRim(prepareClamshell(join(box([-100, -5, 0], [100, 5, 30]), box([-100, -30, 30], [100, 30, 34])), { ...params, silicone: { ...params.silicone, wallDraftDeg: 1 } }), 'x', -60);
    expect(unraised.wallRaised).toBeNull();
    expect(rim.O.x1 - (rim.D.x1 + rim.e5)).toBeCloseTo(unraised.O.x1 - (unraised.D.x1 + unraised.e5) + raise, 9);
    // With the edge on auto the box is the smallest, so its minimum is O's farthest face from the model's extent.
    expect(rim.edge.minimum).toBeCloseTo(Math.max(rim.O.x1 - 100, rim.O.y1 - 30, -100 - rim.O.x0, -30 - rim.O.y0), 9);
    expect(rim.D3.x0).toBeGreaterThanOrEqual(rim.O.x0 + rim.wall - 1e-9);
    expect(rim.D3.x1).toBeLessThanOrEqual(rim.O.x1 - rim.wall + 1e-9);
  });
});

describe('G13.6 bounds', () => {
  // Every example under CFG_FULL=1, which MP1's exit was run green with; by default the wolf, which widened D_side's
  // filter, Benchy and Goddess, with the sphere.
  const FULL = process.env.CFG_FULL === '1';
  const ids: ExampleId[] = FULL ? EXAMPLE_IDS : ['goddess', 'wolf', 'benchy'];
  const models: [string, () => WeldedMesh][] = [...ids.map((id): [string, () => WeldedMesh] => [id, () => orientedExample(id).mesh]), ['sphere', () => orientedGallery('sphere')]];
  it.each(models)('D_side, D3 and Hmax_clam bound the built tool meshes of %s, at beta 20 and 60', (_id, mesh) => {
    for (const beta of [20, 60]) {
      const prep = prepOf(mesh(), beta);
      const cell = 0.5;
      for (const [axis, at] of [['x', 0.55], ['y', 0.55], ['x', 0.2], ['y', 0.8]] as const) {
        const a = axis === 'x' ? 0 : 1, b = 1 - a;
        const xs = Math.round((prep.bounds.min[a] + at * (prep.bounds.max[a] - prep.bounds.min[a])) / 0.125) * 0.125;
        const fine = fineSplit(prep, axis, xs, cell, beta);
        const { Dside, D3, zJ } = fine.rim;
        const hmax = hmaxClam(prep.vertices, axis, xs, beta, prep.ctx.raise, cell);
        const lo = (r: typeof D3, k: number): number => (k === 0 ? r.x0 : r.y0), hi = (r: typeof D3, k: number): number => (k === 0 ? r.x1 : r.y1);
        let top = -Infinity, checked = 0;
        for (const [sign, side] of [[1, fine.plus], [-1, fine.minus]] as const) {
          const tool = buildToolMesh(side.field, { raise: side.side.plan.raise, tol: prep.settings.tinTol, seam: { hs: side.hs, eps: seamEps(prep.settings.tinTol) } });
          const p = transformPositions(tool.positions, frameInverse(side.side.frame));
          for (let k = 0; k < p.length; k += 3) {
            const pa = p[k + a], pb = p[k + b], z = p[k + 2];
            // Only the cavity of this half: past P on its own side, at or above the base's top.
            if (z < 0 || sign * (pa - xs) <= 0.05 + 1e-6) continue;
            checked++;
            top = Math.max(top, z);
            expect(pb).toBeGreaterThanOrEqual(lo(D3, b) - 1e-3);
            expect(pb).toBeLessThanOrEqual(hi(D3, b) + 1e-3);
            expect(pa).toBeGreaterThanOrEqual(lo(D3, a) - 1e-3);
            expect(pa).toBeLessThanOrEqual(hi(D3, a) + 1e-3);
            if (z > zJ) continue;
            expect(pb).toBeGreaterThanOrEqual(lo(Dside, b) - 1e-3);
            expect(pb).toBeLessThanOrEqual(hi(Dside, b) + 1e-3);
            expect(pa).toBeGreaterThanOrEqual(lo(Dside, a) - 1e-3);
            expect(pa).toBeLessThanOrEqual(hi(Dside, a) + 1e-3);
          }
        }
        expect(checked).toBeGreaterThan(0);
        expect(top, `${axis} ${at} at beta ${beta}`).toBeLessThanOrEqual(hmax + 1e-3);
      }
    }
  }, 600_000);
});
