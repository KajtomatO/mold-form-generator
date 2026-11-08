import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertRigid, determinant, transformPositions } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import { buildBaseBody, buildGlueBase, layerDiagnostics, pocketOutline, triangleContour } from '../../src/core/parts/base';
import { buildFitPiece, fitRim, fitTestFiles, fitVariants } from '../../src/core/parts/fitTest';
import { grooveResidualVolume, ringArea } from '../../src/core/parts/joint';
import { basePose, coverPose, inversePose, modelOrientedStl, poseToStl } from '../../src/core/parts/poses';
import { auditOverhang } from '../../src/core/report/overhang';
import { withArena } from '../../src/core/solid/arena';
import { outset } from '../../src/core/solid/rect';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { loadManifold } from '../fixtures/loadExamples';
import { boxSolid, compareVoids, readPart, splitShells, unpose } from '../fixtures/solidChecks';
import { box, lShape, ring, signedVolume, sphere, withoutTriangles } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

describe('print poses', () => {
  const rim = { Zt: 41.5, Tb: 4 };

  it('have determinant +1, and the cover pose is a half turn, never a mirror', () => {
    expect(determinant(coverPose(rim))).toBe(1);
    expect(determinant(basePose(rim))).toBe(1);
    expect(() => assertRigid({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, -1], translation: [0, 0, 41.5] })).toThrow(/not a pure rotation/);
  });

  it('send a point where the plan says', () => {
    const point = new Float32Array([3, 7, 11]);
    expect(Array.from(transformPositions(point, coverPose(rim)))).toEqual([3, -7, 30.5]);
    expect(Array.from(transformPositions(point, basePose(rim)))).toEqual([3, 7, 15]);
  });

  it('put a part\'s flat top on the bed and its opening upward', () => {
    const corners = new Float32Array([0, 0, 41.5, 0, 0, -3.8]);
    const posed = transformPositions(corners, coverPose(rim));
    expect(posed[2]).toBe(0);
    expect(posed[5]).toBeCloseTo(45.3, 5);
  });

  it('can be undone exactly', () => {
    const point = new Float32Array([3, -7.5, 11.25]);
    for (const pose of [coverPose(rim), basePose(rim)]) {
      const back = transformPositions(transformPositions(point, pose), inversePose(pose));
      expect(Array.from(back)).toEqual(Array.from(point));
    }
  });
});

describe('exporting a solid whose walls pass within a float step', () => {
  /** Two 10 mm cubes meeting along a vertical edge, apart in doubles and together once rounded to float32. */
  const pinched = (arena: Parameters<Parameters<typeof withArena>[1]>[0]) => {
    const a = boxSolid(arena, [0, 0, 0], [10, 10, 10]);
    const b = boxSolid(arena, [10 + 1e-7, 10 + 1e-7, 0], [20, 20, 10]);
    return arena.track(a.add(b));
  };

  it('negative control: written as it comes, the two edges read back as one with 4 faces', () => {
    withArena(api, (arena) => {
      const mesh = pinched(arena).getMesh();
      const { audit } = readPart(writeBinaryStl(mesh.vertProperties, mesh.triVerts));
      expect(audit.nonManifoldEdges).toBe(1);
    });
  });

  it('reads back with the solid\'s own topology and the same volume', () => {
    withArena(api, (arena) => {
      const solid = pinched(arena);
      const { audit, mesh } = readPart(poseToStl(api, solid, basePose({ Tb: 0 })));
      expect(audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0, vertexCount: 16, triangleCount: 24 });
      expect(signedVolume(mesh)).toBeCloseTo(2000, 2);
      // The same goes for a trimmed model, which leaves through the other door.
      const trimmed = readPart(modelOrientedStl({ needsTrim: true } as never, solid));
      expect(trimmed.audit.nonManifoldEdges).toBe(0);
    });
  });

  it('leaves a solid with nothing to separate exactly as it is', () => {
    withArena(api, (arena) => {
      const solid = boxSolid(arena, [1, 2, 3], [4, 6, 8]);
      const mesh = solid.getMesh();
      expect(poseToStl(api, solid, { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] })).toEqual(writeBinaryStl(mesh.vertProperties, mesh.triVerts));
    });
  });
});

describe('the pocket when there is nothing to cut', () => {
  it('an open mesh with no wall at the height asked for has an empty outline, not a crash', () => {
    withArena(api, (arena) => {
      const thin = withoutTriangles(box([0, 0, 0], [20, 20, 0.1]), [2, 3]);
      expect(triangleContour(arena, thin, 0.2).isEmpty()).toBe(true);
    });
  });

  it('an empty outline leaves the plate whole, with pocketVolume 0 and a warning', () => {
    withArena(api, (arena) => {
      const params = defaultParams();
      const rim = fitRim(params, fitVariants()[0]);
      const body = buildBaseBody(arena, rim);
      const empty = { components: [], islands: [], area: 0, rawArea: 0, projectedArea: 0, diagnostics: [] };
      const outline = pocketOutline(arena, empty, arena.crossSection([]), 0.2);
      expect(outline.isEmpty()).toBe(true);
      const glue = buildGlueBase(arena, body, outline, 0.2, [[0, 0]]);
      expect(glue.base.volume()).toBeCloseTo(body.volume(), 6);
      expect(glue.pocketVolume).toBe(0);
      expect(glue.diagnostics.map((d) => [d.code, d.severity])).toEqual([['pocket-empty', 'warning']]);
    });
  });
});

describe('whole layers', () => {
  it('warns on a base or pocket a slicer would round, and not on whole layers', () => {
    expect(layerDiagnostics(4, 0.2, 0.2)).toEqual([]);
    expect(layerDiagnostics(4.2, 0.6, 0.3)).toEqual([]);
    expect(layerDiagnostics(4, 0.1, 0.2).map((d) => [d.code, d.severity])).toEqual([['pocket-layers', 'warning']]);
    expect(layerDiagnostics(3.1, 0.2, 0.2).map((d) => d.code)).toEqual(['base-layers']);
    expect(layerDiagnostics(3.1, 0.1, 0.2).map((d) => d.code)).toEqual(['base-layers', 'pocket-layers']);
  });
});

describe('the outline of an open mesh, from its triangles', () => {
  it('gives the same section as a solid does', () => {
    withArena(api, (arena) => {
      for (const mesh of [sphere(api, 12, 64), ring(api, 40, 10, 8), lShape(api)]) {
        const solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
        const { min, max } = solid.boundingBox();
        const z = min[2] + (max[2] - min[2]) * 0.37;
        const direct = triangleContour(arena, mesh, z);
        const sliced = arena.track(solid.slice(z));
        expect(direct.area()).toBeCloseTo(sliced.area(), 3);
        expect(direct.numContour()).toBe(sliced.numContour());
      }
    });
  });

  it('closes a run with two ends straight across, so a hole in a wall still leaves an outline', () => {
    withArena(api, (arena) => {
      // The box's front wall is gone, so its section is a U of three sides.
      const open = withoutTriangles(box([0, 0, 0], [20, 10, 8]), [4, 5]);
      const section = triangleContour(arena, open, 4);
      expect(section.area()).toBeCloseTo(200, 3);
    });
  });
});

describe('the fit-test piece of G12', () => {
  const params = defaultParams();
  const variants = fitVariants();

  it('steps cT with the groove generous, then cG, by 0.1 mm', () => {
    const taper = variants.filter((v) => v.series === 'taper');
    const groove = variants.filter((v) => v.series === 'groove');
    expect(taper.map((v) => v.cT)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(groove.map((v) => v.cG)).toEqual([0.25, 0.35, 0.45, 0.55]);
    expect(groove.every((v) => v.cT === params.joint.taperClearance)).toBe(true);
    // Generous means the ridge stays clear of the groove at every taper clearance in the series.
    expect(taper.every((v) => v.cG >= v.cT + 0.15)).toBe(true);
    expect(new Set(variants.map((v) => v.id)).size).toBe(variants.length);
  });

  describe.each([
    [0.2, [0.35, 0.45, 0.55, 0.65]],
    [0.4, [0.55, 0.65, 0.75, 0.85]],
  ])('at a taper clearance of %f', (cT, grooves) => {
    const chosen = defaultParams();
    chosen.joint.taperClearance = cT;
    const series = fitVariants(chosen);

    it('builds the groove series at that value, so its pairs can seat, and keeps cG 0.15 over it', () => {
      const groove = series.filter((v) => v.series === 'groove');
      expect(groove.map((v) => v.cT)).toEqual([cT, cT, cT, cT]);
      expect(groove.map((v) => v.cG)).toEqual(grooves);
      expect(groove.every((v) => v.id.includes(cT.toFixed(2)))).toBe(true);
    });

    it('leaves the taper series alone, as that is how the value gets found', () => {
      expect(series.filter((v) => v.series === 'taper')).toEqual(variants.filter((v) => v.series === 'taper'));
    });

    it('really cuts that gap into the groove pieces, with no joint warning', () => {
      withArena(api, (arena) => {
        const variant = series.find((v) => v.series === 'groove')!;
        const { rim, cover, base } = buildFitPiece(arena, chosen, variant);
        expect(rim.diagnostics).toEqual([]);
        expect(Math.abs(arena.track(base.trimByPlane([0, 0, -1], 1)).minGap(cover, 1) - cT * rim.cosTaper)).toBeLessThanOrEqual(0.01);
        expect(arena.track(base.trimByPlane([0, 0, 1], 0.02)).minGap(cover, 1)).toBeGreaterThanOrEqual(Math.min(variant.cG * rim.cosRidge, rim.grooveExtra) - 0.005);
      });
    });
  });

  it('says in its README which taper clearance the groove series has, how to change it, and what to do if nothing seats', () => {
    const chosen = defaultParams();
    chosen.joint.taperClearance = 0.3;
    const raw = new TextDecoder().decode(fitTestFiles(api, chosen)['fit_test/README.txt']);
    // Notepad's rules, as README.txt keeps them: plain ASCII, CRLF line endings and lines of at most 76.
    expect([...raw].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\r' && c !== '\n'))).toEqual([]);
    expect(/[^\r]\n|\r[^\n]/.test(raw)).toBe(false);
    expect(raw.split('\r\n').filter((line) => line.length > 76)).toEqual([]);
    const readme = raw.replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('builds it at a taper clearance of 0.30 mm');
    expect(readme).toContain('diag.html');
    expect(readme).toContain('If no pair seats');
  });

  it('is about 40 mm square, from the real rim derivation', () => {
    const rim = fitRim(params, variants[0]);
    expect(rim.O.x1 - rim.O.x0).toBeGreaterThan(38);
    expect(rim.O.x1 - rim.O.x0).toBeLessThan(44);
    expect(rim.O.x1 - rim.O.x0).toBeCloseTo(rim.O.y1 - rim.O.y0, 9);
    expect(rim.Zt).toBeCloseTo(6 + params.cover.topCap, 9);
    expect(rim.diagnostics).toEqual([]);
  });

  it.each(variants)('$id passes the joint checks with the real builders', (variant) => {
    withArena(api, (arena) => {
      const { track } = arena;
      const { rim, cover, base } = buildFitPiece(arena, params, variant);
      expect(splitShells(arena, cover).bodies).toHaveLength(1);
      expect(splitShells(arena, base).bodies).toHaveLength(1);
      expect(cover.boundingBox().min[2] - base.boundingBox().min[2]).toBeCloseTo(params.joint.baseProud, 5);
      expect(track(cover.intersect(base)).volume()).toBeLessThan(0.01);

      expect(Math.abs(track(base.trimByPlane([0, 0, -1], 1)).minGap(cover, 1) - variant.cT * rim.cosTaper)).toBeLessThanOrEqual(0.01);
      // The groove's roof sits grooveExtra above the ridge, which is the nearer face once cG grows past it.
      expect(track(base.trimByPlane([0, 0, 1], 0.02)).minGap(cover, 1)).toBeGreaterThanOrEqual(Math.min(variant.cG * rim.cosRidge, rim.grooveExtra) - 0.005);

      // Open at the pour and vent, so as M4 asks of the real thing: only the groove is left as a void.
      const raised = track(cover.add(buildFitPiece(arena, params, variant).base).add(track(arena.track(api.Manifold.cube([40, 40, 0.02])).translate([-20, -20, -0.01]))));
      const { voids } = splitShells(arena, raised);
      const { D, e2, e3, ridgeHeight, grooveExtra } = rim;
      const problems = compareVoids(voids, [{ name: 'groove', volume: grooveResidualVolume(rim, 0.01), fraction: 0.02, probe: [(e2 + e3) / 2 + D.x1, 0, ridgeHeight + grooveExtra / 2] }]);
      expect(problems).toEqual([]);
    });
  });

  /** Area of one of the 48-sided openings. */
  const polygonArea = (radius: number): number => (48 / 2) * radius ** 2 * Math.sin((2 * Math.PI) / 48);

  it.each([[3, 30], [4, 20], [2, 45]])('has a seat cone of depth %i at half angle %i, by the formula', (depth, halfAngle) => {
    const custom = defaultParams();
    custom.seat.depth = depth;
    custom.seat.halfAngleDeg = halfAngle;
    withArena(api, (arena) => {
      const { track } = arena;
      const variant = variants[0];
      const { rim, cover } = buildFitPiece(arena, custom, variant);
      const box = (rim.O.x1 - rim.O.x0) * (rim.O.y1 - rim.O.y0);
      const marks = variant.notches * 0.8 * 1;
      const r = custom.pour.diameter / 2;
      const vent = polygonArea(custom.vents.diameter / 2);
      // The cone widens from the bore at the seat's floor towards the flat top.
      for (const above of [0.5, depth - 0.5]) {
        const seat = r + above * Math.tan((halfAngle * Math.PI) / 180);
        const section = track(cover.slice(rim.Zt - depth + above));
        expect(section.area(), `${above} over the floor`).toBeCloseTo(box - marks - polygonArea(seat) - vent, 3);
      }
      // Under the floor it is the straight bore. A counterbore would show here as a step.
      expect(track(cover.slice(rim.Zt - depth - 0.1)).area()).toBeCloseTo(box - marks - polygonArea(r) - vent, 3);
    });
  });

  it('has a pour bore and a vent reaching the cavity from the flat top', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      const variant = variants[0];
      const { rim, cover } = buildFitPiece(arena, params, variant);
      // Over the box tool and under the seat, the only holes are the bore and the vent.
      const section = track(cover.slice(rim.Zt - params.seat.depth - 0.5));
      expect(section.numContour()).toBe(3);
      const circle = (d: number): number => (48 / 2) * (d / 2) ** 2 * Math.sin((2 * Math.PI) / 48);
      const box = (rim.O.x1 - rim.O.x0) * (rim.O.y1 - rim.O.y0);
      const marks = variant.notches * 0.8 * 1;
      expect(section.area()).toBeCloseTo(box - marks - circle(params.pour.diameter) - circle(params.vents.diameter), 3);
      // Under the top of the box tool it is open all across, and over it plastic starts.
      expect(track(cover.slice(5)).area()).toBeLessThan(track(cover.slice(7)).area() - 200);
    });
  });

  it('marks each variant on its own side, with as many notches as its place in the series', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      const holes = variants.map((variant) => {
        const { rim, cover } = buildFitPiece(arena, params, variant);
        const section = track(cover.slice(rim.Zt - 1));
        const contours = arena.polygons(section);
        const on = (axis: 0 | 1, value: number): number => contours.flat().filter((p) => Math.abs((p as [number, number])[axis] - value) < 1e-6).length;
        // A notch's floor is set 0.8 in from the wall, on the side that names its series.
        const own = variant.series === 'taper' ? on(0, rim.O.x1 - 0.8) : on(1, rim.O.y1 - 0.8);
        const other = variant.series === 'taper' ? on(1, rim.O.y1 - 0.8) : on(0, rim.O.x1 - 0.8);
        expect(own, variant.id).toBeGreaterThanOrEqual(2 * variant.notches);
        expect(other, variant.id).toBe(0);
        return (rim.O.x1 - rim.O.x0) * (rim.O.y1 - rim.O.y0) - section.area() - variant.notches * 0.8 * 1;
      });
      // With each one's notches taken off, all are left with the seat and vent, by hand: a wrong count shows as 0.8 mm2.
      const seat = params.pour.diameter / 2 + (params.seat.depth - 1) * Math.tan((params.seat.halfAngleDeg * Math.PI) / 180);
      const openings = polygonArea(seat) + polygonArea(params.vents.diameter / 2);
      for (const area of holes) expect(area).toBeCloseTo(openings, 3);
    });
  });

  it('marks the base the same way as the cover, so a pair can be told apart in the hand', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      for (const variant of variants) {
        const { rim, base } = buildFitPiece(arena, params, variant);
        // Below the joint, a plain rounded rectangle at this height, less the notches.
        const z = -1;
        const by = -z * rim.tanTaper;
        const section = track(base.slice(z));
        const contours = arena.polygons(section);
        const on = (axis: 0 | 1, value: number): number => contours.flat().filter((p) => Math.abs((p as [number, number])[axis] - value) < 1e-6).length;
        const own = variant.series === 'taper' ? on(0, rim.B.x1 - 0.8) : on(1, rim.B.y1 - 0.8);
        const other = variant.series === 'taper' ? on(1, rim.B.y1 - 0.8) : on(0, rim.B.x1 - 0.8);
        expect(own, variant.id).toBeGreaterThanOrEqual(2 * variant.notches);
        expect(other, variant.id).toBe(0);
        // A wrong count shows here, as a notch is about 1 mm2.
        const plain = ringArea(outset(rim.B, by), rim.cornerRadius + by);
        expect(section.area(), variant.id).toBeCloseTo(plain - variant.notches * 1 * (0.8 + by), 3);
      }
    });
  });

  it('prints with no support in its print pose, even the seat cone and the vent chamfer', () => {
    withArena(api, (arena) => {
      const { rim, cover, base } = buildFitPiece(arena, params, variants[0]);
      const posed = cover.getMesh();
      const audit = auditOverhang({ positions: transformPositions(posed.vertProperties, coverPose(rim)), indices: posed.triVerts }, { bedZ: 0 });
      expect(audit.steepCount).toBe(0);
      // The vent's mouth chamfer sets this. The test can fail: left unflipped, its ceiling is at 90.
      expect(audit.worstDeg).toBeCloseTo(45, 0);
      expect(auditOverhang({ positions: posed.vertProperties, indices: posed.triVerts }).steepCount).toBeGreaterThan(0);
      const plate = base.getMesh();
      expect(auditOverhang({ positions: transformPositions(plate.vertProperties, basePose(rim)), indices: plate.triVerts }, { bedZ: 0 }).steepCount).toBe(0);
    });
  });

  it('exports closed STLs in print pose that fit back together, named for what they are', () => {
    const files = fitTestFiles(api, params);
    const names = Object.keys(files).sort();
    expect(names).toEqual([...variants.flatMap((v) => [`fit_test/${v.id}_base.stl`, `fit_test/${v.id}_cover.stl`]), 'fit_test/README.txt'].sort());
    const readme = new TextDecoder().decode(files['fit_test/README.txt']);
    expect(readme).toContain('How to read the result');
    for (const v of variants) expect(readme).toContain(v.id);

    for (const variant of variants) {
      const coverBytes = files[`fit_test/${variant.id}_cover.stl`];
      const baseBytes = files[`fit_test/${variant.id}_base.stl`];
      expect(String.fromCharCode(...coverBytes.slice(0, 5))).not.toBe('solid');
      expect(parseStl(coverBytes).format).toBe('binary');
      const cover = readPart(coverBytes);
      const base = readPart(baseBytes);
      for (const part of [cover, base]) {
        expect(part.audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      }
      expect(auditOverhang(cover.mesh, { bedZ: 0 }).steepCount).toBe(0);
      expect(auditOverhang(base.mesh, { bedZ: 0 }).steepCount).toBe(0);

      withArena(api, (arena) => {
        const rim = fitRim(params, variant);
        const coverBack = unpose(arena, coverBytes, coverPose(rim));
        const baseBack = unpose(arena, baseBytes, basePose(rim));
        expect(coverBack.boundingBox().max[2]).toBeCloseTo(rim.Zt, 3);
        expect(arena.track(coverBack.intersect(baseBack)).volume()).toBeLessThan(0.1);
        expect(baseBack.boundingBox().min[2]).toBeCloseTo(-rim.Tb, 3);
      });
    }
  });

  it('frees every handle', async () => {
    const counted = await loadManifold();
    const { countHandles } = await import('../fixtures/handles');
    const ledger = countHandles(counted);
    fitTestFiles(counted, params);
    expect(ledger.created()).toBeGreaterThan(20);
    expect(ledger.live()).toEqual([]);
  });
});
