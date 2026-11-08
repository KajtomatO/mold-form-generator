import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BaseCandidate } from '../../src/core/base/candidates';
import { classifyLevels } from '../../src/core/base/footprint';
import { mapCavities } from '../../src/core/field/cavities';
import { buildField } from '../../src/core/field/build';
import { exportPlan, planField, fieldSettings } from '../../src/core/field/grid';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase, footprintSection, triangleContour } from '../../src/core/parts/base';
import { boltBridges, boltCavityWall, slotOutline } from '../../src/core/parts/bolts';
import { buildCoverBody, coverBottom, toolDiagnostics } from '../../src/core/parts/cover';
import { BRIDGE_LIMIT } from '../../src/core/parts/fasteners';
import { grooveResidualVolume, ringArea, wallRing } from '../../src/core/parts/joint';
import { basePose, coverPose, modelOrientedStl, poseToStl } from '../../src/core/parts/poses';
import { boltWalls, deriveRim, maskOverrun, moldBounds, rebateOutset } from '../../src/core/parts/rim';
import { importSolid } from '../../src/core/mesh/shells';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena, checked, withArena } from '../../src/core/solid/arena';
import { outset } from '../../src/core/solid/rect';
import { buildToolMesh, toolSolid } from '../../src/core/solid/tool';
import { recordSection } from '../fixtures/benchmarks';
import { countHandles } from '../fixtures/handles';
import { EXAMPLE_IDS, loadExample, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { buildMold, type Mold, type MoldOptions } from '../fixtures/mold';
import { boxSolid, cavitySection, clipToBox, compareVoids, contourArea, contourDistance, CRUMB_MM3, holeCentres, insideOutline, mirroredCoverStl, outlineArea, polygonArea, readPart, splitShells, unpose, type ExpectedVoid, type VoidShell } from '../fixtures/solidChecks';
import { BOX_BOTTOM, BOX_TOP, MUSHROOM, blockOnFeet, box, boxWithTopHole, join, lShape, mushroom, recessedBlock, signedVolume, withoutTriangles } from '../fixtures/synthetic';
import { BOLT_GOLDEN, FIELD_GOLDEN, SOLID_GOLDEN } from './golden';

/** minGap on Benchy takes 30 s at the plan's search length, and every model gets several runs of the rest. */
const FULL = process.env.CFG_FULL === '1';
const SLOW = 600_000;
/** Plate top in the closed-volume check: a hair above the shelf, so the union overlaps instead of touching. */
const RAISED = 0.01;
/** G10: a stub's top is this far over planeTol. Faces below it lie on the plate, not over air. */
const STUB_RISE = 0.05;

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

interface Ctx {
  arena: Arena;
  m: Mold;
  params: Params;
}

/** A plan parameter set: the copy keeps one test's values out of the others. */
function paramsWith(change: (p: Params) => void = () => {}): Params {
  const params = defaultParams();
  change(params);
  return params;
}

function bases(m: Mold): { name: string; base: Manifold }[] {
  const found = [{ name: 'glue', base: m.glue!.base }];
  if (m.merged?.base) found.push({ name: 'merged', base: m.merged.base });
  return found;
}

/** The smallest gap from any copy of the model, one at a time, as all at once would hold them all in memory. */
function gapToCover({ m }: Ctx, cover: Manifold, offsets: readonly [number, number][], search: number): number {
  let gap = Infinity;
  for (const [x, y] of offsets) {
    gap = Math.min(gap, withArena(api, (local) => local.track(m.model!.translate([x, y, 0])).minGap(cover, search)));
  }
  return gap;
}

function checkBodies({ arena, m }: Ctx): void {
  expect(m.tool.status()).toBe('NoError');
  expect(m.tool.volume()).toBeGreaterThan(0);
  expect(splitShells(arena, m.tool).bodies, 'tool bodies').toHaveLength(1);
  expect(m.toolMesh.clippedNodes).toBe(0);
  expect(m.toolMesh.diagnostics).toEqual([]);
  expect(m.cover.status()).toBe('NoError');
  expect(m.cover.volume()).toBeGreaterThan(0);
  const cover = splitShells(arena, m.cover);
  expect(cover.bodies, 'cover bodies').toHaveLength(1);
  expect(cover.voids.filter((shell) => shell.volume >= CRUMB_MM3), 'cover voids').toEqual([]);
  for (const { name, base } of bases(m)) {
    expect(base.status(), name).toBe('NoError');
    expect(base.volume(), name).toBeGreaterThan(0);
    expect(splitShells(arena, base).bodies, `${name} bodies`).toHaveLength(1);
  }
}

interface Clearance {
  /** minGap at the set draft. */
  gap: number;
  /** minGap with draft 0. */
  straight: number;
}

/** Kept per mold, as minGap is the slowest step of all and the golden test reads the same numbers. */
const clearances = new WeakMap<Mold, Clearance>();

function measureClearance(ctx: Ctx): Clearance {
  const { arena, m, params } = ctx;
  const { t } = params.silicone;
  // On one tile the plan's 8 mm is affordable. A grid takes that times its tiles, and any search past
  // t + 0.7 gives the same answer here: minGap is the smaller of the true gap and the search length.
  const search = m.mold.offsets.length === 1 ? Math.max(8, t + 0.7) : t + 0.7;
  const gap = gapToCover(ctx, m.cover, m.mold.offsets, search);

  // With draft 0 nothing widens the cavity, so the gap should be close to the margin above t.
  const params0: Params = { ...params, silicone: { ...params.silicone, wallDraftDeg: 0 } };
  const settings = fieldSettings(params0, m.bounds);
  const plan = planField(m.bounds, settings);
  const built = buildField(m.oriented.mesh, plan, settings);
  const tool = toolSolid(arena, buildToolMesh(built.field, { raise: plan.raise, tol: params.quality.tinTolFinal }));
  // Auto spacing follows the draft, so at draft 0 the tiles sit closer together.
  const bounds0 = moldBounds(m.oriented.mesh, m.bounds, settings);
  const cover = buildCoverBody(arena, deriveRim(bounds0, params0), tool);
  const clearance = { gap, straight: gapToCover(ctx, cover, bounds0.offsets, t + 0.7) };
  clearances.set(m, clearance);
  return clearance;
}

/** Plan G4: at least t everywhere, measured between the real solids. Search length is the plan's 8 where that can see t. */
function checkClearance(ctx: Ctx): void {
  const { t } = ctx.params.silicone;
  const { gap, straight } = measureClearance(ctx);
  expect(gap, 'minGap at the set draft').toBeGreaterThanOrEqual(t);
  expect(straight, 'minGap with draft 0').toBeGreaterThanOrEqual(t);
  expect(straight, 'minGap with draft 0').toBeLessThanOrEqual(t + 0.6);
}

function checkIntersection({ arena, m }: Ctx): void {
  for (const { name, base } of bases(m)) {
    expect(arena.track(m.cover.intersect(base)).volume(), name).toBeLessThan(0.01);
  }
}

/** The joint's gaps, measured between the solids with what touches on purpose cut away. */
function checkJointGaps({ arena, m }: Ctx): void {
  const { rim, cover } = m;
  const base = m.glue!.base;
  // Above the plate only the ridge is left.
  const ridge = arena.track(base.trimByPlane([0, 0, 1], 0.02));
  // The groove's roof sits grooveExtra above the ridge, which is the nearer face once cG grows past it.
  const nominal = Math.min(rim.cG * rim.cosRidge, rim.grooveExtra);
  const ridgeGap = ridge.minGap(cover, 1);
  expect(ridgeGap).toBeGreaterThanOrEqual(nominal - 0.005);
  expect(ridgeGap).toBeLessThanOrEqual(nominal + 0.01);
  // Well below the shelf, so only the taper faces something this close.
  const flank = arena.track(base.trimByPlane([0, 0, -1], 1));
  expect(Math.abs(flank.minGap(cover, 1) - rim.cT * rim.cosTaper)).toBeLessThanOrEqual(0.01);
}

function checkBox({ arena, m, params }: Ctx): void {
  const { rim, cover, mold } = m;
  const { track } = arena;
  const box3 = cover.boundingBox();
  expect(box3.min[0]).toBeCloseTo(rim.O.x0, 4);
  expect(box3.min[1]).toBeCloseTo(rim.O.y0, 4);
  expect(box3.max[0]).toBeCloseTo(rim.O.x1, 4);
  expect(box3.max[1]).toBeCloseTo(rim.O.y1, 4);
  expect(box3.max[2]).toBeCloseTo(rim.Zt, 4);
  expect(box3.min[2]).toBeCloseTo(coverBottom(rim), 4);

  const { thickness: Tb } = params.base;
  const { taperDeg, taperClearance: cT, baseProud } = params.joint;
  const toBox = cT + (Tb - baseProud) * Math.tan((taperDeg * Math.PI) / 180) + params.cover.wall;
  expect(rim.O.x1).toBeCloseTo(rim.B.x1 + toBox, 6);
  expect(rim.O.y0).toBeCloseTo(rim.B.y0 - toBox, 6);
  // M10: on a model too low for the bolts, the shortest bolt and its slot raise the top.
  expect(rim.Zt).toBeCloseTo(Math.max(rim.hMax + params.cover.topCap, params.joint.ridgeHeight + params.joint.grooveExtraDepth + params.cover.topCap, rim.bolts?.coverHeight ?? -Infinity), 6);
  const { edge } = params.grid;
  if (edge !== null && edge >= rim.edge.minimum) {
    expect(rim.O.x1 - mold.model.x1).toBeCloseTo(edge, 6);
    expect(mold.model.x0 - rim.O.x0).toBeCloseTo(edge, 6);
    expect(rim.O.y1 - mold.model.y1).toBeCloseTo(edge, 6);
    expect(mold.model.y0 - rim.O.y0).toBeCloseTo(edge, 6);
  }

  // Flat top: under the chamfer the section is the whole box, so nothing has reached up into the cap.
  const w = rim.O.x1 - rim.O.x0, h = rim.O.y1 - rim.O.y0;
  within(track(cover.slice(rim.Zt - rim.topChamfer - 0.01)).area(), w * h, 1e-9);
  // Just below the top it is the box less the chamfer still left at that height.
  const shy = rim.topChamfer - 0.01;
  within(track(cover.slice(rim.Zt - 0.01)).area(), (w - 2 * shy) * (h - 2 * shy), 1e-9);

  for (const { name, base } of bases(m)) {
    const b = base.boundingBox();
    expect(box3.min[2] - b.min[2], `${name}: proud`).toBeCloseTo(baseProud, 5);
    expect(b.min[2], name).toBeCloseTo(-Tb, 6);
  }

  // Plan G8: the cavity keeps inside D at the export cell, and the tool domain inside the rebate.
  expect(maskOverrun(m.built.field, rim.D)).toBe(0);
  expect(toolDiagnostics(rim, m.toolMesh)).toEqual([]);
}

/** The shelf between the cavity and the groove: at least s1 by true distance, read off the cover's own section. */
function checkLand({ arena, m, params }: Ctx): void {
  const { rim, cover } = m;
  const z = 0.01;
  const contours = arena.polygons(arena.track(cover.slice(z)));
  const wall = wallRing(rim, rim.e1, rim.tanRidge, z);
  const ring = wall.rect;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
  const boundsOf = (contour: SimplePolygon): { x0: number; y0: number; x1: number; y1: number } => {
    const xs = contour.map((p) => (p as [number, number])[0]), ys = contour.map((p) => (p as [number, number])[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const outlines = contours.filter((contour) => {
    const b = boundsOf(contour);
    return near(b.x0, ring.x0) && near(b.y0, ring.y0) && near(b.x1, ring.x1) && near(b.y1, ring.y1);
  });
  expect(outlines).toHaveLength(1);
  // A cavity that reaches the groove bites into this contour and stops being a hole, and other cavities
  // can still hold its bounding box out to the ring. So it is the area that shows the outline is unbroken.
  expect(Math.abs(contourArea(outlines[0]) - ringArea(wall.rect, wall.radius)), 'land outline area').toBeLessThan(0.01);
  const holes = contours.filter((contour) => {
    const b = boundsOf(contour);
    return !outlines.includes(contour) && b.x0 > ring.x0 && b.y0 > ring.y0 && b.x1 < ring.x1 && b.y1 < ring.y1;
  });
  expect(holes.length).toBeGreaterThan(0);
  let land = Infinity;
  for (const hole of holes) land = Math.min(land, contourDistance(outlines[0], hole));
  expect(land, 'land width').toBeGreaterThanOrEqual(params.joint.landInner);
}

/** D1: the cavity never narrows towards the base, read from slices of the real cover. */
function checkNesting({ arena, m }: Ctx): void {
  const { track } = arena;
  const { rim, cover } = m;
  const inner = outset(rim.D, rim.e1 / 2);
  const levels = 12;
  const sections = Array.from({ length: levels }, (_, k) => cavitySection(arena, cover, inner, 0.05 + ((rim.hMax - 0.1) * k) / (levels - 1)));
  for (let k = 0; k + 1 < levels; k++) {
    const sticking = track(sections[k + 1].subtract(sections[k]));
    expect(sticking.area(), `level ${k}`).toBeLessThan(1);
  }
  // The levels have to be cutting through a real cavity for this to mean anything.
  expect(sections[0].area()).toBeGreaterThan(sections[levels - 1].area());
}

function checkOverhang({ arena, m }: Ctx): void {
  const { rim, cover } = m;
  const parsed = readPart(poseToStl(api, cover, coverPose(rim))).mesh;
  // M10: the nut slots' ceilings are bridges in print pose, listed apart, and nothing else may overhang.
  const bridges = rim.bolts ? boltBridges(rim.bolts) : [];
  const onBridge = (x: number, y: number, z: number): boolean => bridges.some((b) => Math.abs(z - (rim.Zt - b.z)) < 1e-3 && insideOutline(x, -y, b.outline));
  const coverAudit = auditOverhang(parsed, { bedZ: 0, only: (x, y, z) => !onBridge(x, y, z) });
  expect(coverAudit, 'cover').toMatchObject({ steepCount: 0, steepArea: 0 });
  expect(coverAudit.ignoredArea, 'cover').toBeLessThan(0.05);
  if (rim.bolts) {
    // What was left out is the bridges and no more: each slot's outline inside the box, flat over the bed.
    const listed = auditOverhang(parsed, { bedZ: 0, only: onBridge });
    const area = bridges.reduce((sum, b) => sum + outlineArea(clipToBox(b.outline, rim.O)), 0);
    within(listed.steepArea, area, 0.01);
    expect(listed.worstDeg).toBeCloseTo(90, 3);
    expect(Math.max(...bridges.map((b) => b.span))).toBeLessThanOrEqual(BRIDGE_LIMIT);
  }
  const plate = readPart(poseToStl(api, m.glue!.base, basePose(rim))).mesh;
  const plateAudit = auditOverhang(plate, { bedZ: 0 });
  expect(plateAudit, 'plate').toMatchObject({ steepCount: 0, steepArea: 0 });
  expect(plateAudit.ignoredArea, 'plate').toBeLessThan(0.05);
  // The relief is the one face of the plate that leans out over the bed, so it sets the worst angle. With
  // bolts, the countersinks' facets lean further, just inside 45 degrees: a 48-gon's flat is cos(pi / 48) in.
  const reliefDeg = (Math.atan(rim.reliefRun / rim.reliefHeight) * 180) / Math.PI;
  const sinkDeg = (Math.atan(Math.cos(Math.PI / 48)) * 180) / Math.PI;
  expect(plateAudit.worstDeg, rim.bolts ? 'plate: the countersinks' : 'plate: the relief').toBeCloseTo(rim.bolts ? sinkDeg : reliefDeg, 1);
  if (!m.merged?.base) return;
  // Mode B: the model's own faces are reported apart. What is left must be plate and ridge.
  const { D, Tb } = rim;
  const isModel = (x: number, y: number, z: number): boolean => z > Tb - m.planeTol && x > D.x0 && x < D.x1 && y > D.y0 && y < D.y1;
  const merged = readPart(poseToStl(api, m.merged.base, basePose(rim))).mesh;
  const mergedPlate = auditOverhang(merged, { bedZ: 0, only: (x, y, z) => !isModel(x, y, z) });
  expect(mergedPlate, 'merged plate').toMatchObject({ steepCount: 0, steepArea: 0 });
  expect(mergedPlate.ignoredArea, 'merged plate').toBeLessThan(0.05);
  // Read from the bytes, against what the part reports. The tiny faces skipped are the model's own, on Benchy 0.2 mm2.
  const own = auditOverhang(merged, { bedZ: 0, only: (x, y, z) => isModel(x, y, z) && z > Tb + m.planeTol + STUB_RISE });
  within(own.steepArea, m.merged.modelOverhangArea * m.mold.offsets.length, 0.01);
  expect(own.ignoredArea, 'model').toBeLessThan(Math.max(0.05, own.steepArea * 0.01));
  const note = m.merged.diagnostics.find((d) => d.code === 'model-overhang');
  if (m.merged.modelOverhangArea > 0) {
    expect(note?.severity).toBe('info');
    expect(note?.message).toContain(`${m.merged.modelOverhangArea.toFixed(0)} mm2`);
  } else {
    expect(note).toBeUndefined();
  }
}

/** STL round trip, the bytes a slicer gets: a clean edge audit, and the volume within 0.1% as triangles and as a re-imported solid. */
function checkRoundTrip({ arena, m }: Ctx): void {
  const parts: [string, Manifold, ReturnType<typeof coverPose>][] = [['cover', m.cover, coverPose(m.rim)]];
  for (const { name, base } of bases(m)) parts.push([name, base, basePose(m.rim)]);
  for (const [name, solid, pose] of parts) {
    const { mesh, audit } = readPart(poseToStl(api, solid, pose));
    expect(audit.openEdges, `${name}: open edges`).toBe(0);
    expect(audit.nonManifoldEdges, `${name}: non-manifold edges`).toBe(0);
    expect(audit.misorientedEdges, `${name}: misoriented edges`).toBe(0);
    within(signedVolume(mesh), solid.volume(), 1e-3);
    // The app's own way in: the first route takes it, with nothing left to repair.
    const back = importSolid(arena, mesh, audit);
    expect(back.report.route, name).toBe('manifold');
    within(back.solid!.volume(), solid.volume(), 1e-3);
  }
}

function expectedVoids(m: Mold, mode: 'glue' | 'merged', arena: Arena): ExpectedVoid[] {
  const { cavities, at } = mapCavities(m.built.field, m.toolMesh.raise);
  const change = new Float64Array(cavities.length);
  if (mode === 'glue') {
    // Each pocket opens into the cavity above it, so its volume belongs to that cavity's void.
    for (const part of arena.trackAll(m.outline.decompose())) {
      const [x, y] = arena.polygons(part)[0][0] as [number, number];
      for (const [ox, oy] of m.mold.offsets) change[at(x + ox, y + oy)] += part.area() * (m.pocketDepth + RAISED);
    }
  } else {
    for (const part of arena.trackAll(m.model!.decompose())) {
      if (part.volume() <= 0) continue;
      // The raised plate takes the part of the model below it too, and the filled void stays filled.
      const above = arena.track(part.trimByPlane([0, 0, 1], RAISED)).volume();
      const vertex = part.getMesh().vertProperties;
      for (const [ox, oy] of m.mold.offsets) change[at(vertex[0] + ox, vertex[1] + oy)] -= above;
    }
  }
  const voids: ExpectedVoid[] = cavities.map((cavity, k) => ({
    name: `cavity ${k}`,
    volume: cavity.volume - RAISED * cavity.area + change[k],
    fraction: 0.02,
    probe: [cavity.peak[0], cavity.peak[1], mode === 'glue' ? cavity.peak[2] / 2 : cavity.peak[2] - m.plan.rEff / 2],
  }));
  const { rim } = m;
  voids.push({
    name: 'groove',
    volume: grooveResidualVolume(rim, RAISED),
    fraction: 0.01,
    probe: [rim.D.x1 + (rim.e2 + rim.e3) / 2, (rim.D.y0 + rim.D.y1) / 2, rim.ridgeHeight + rim.grooveExtra / 2],
  });
  return voids;
}

interface ClosedResult {
  voids: VoidShell[];
  problems: string[];
}

/** The closed-volume check: the union of cover and base, with the plate raised a hair. */
function closedVolume(ctx: Ctx, mode: 'glue' | 'merged', cover: Manifold = ctx.m.cover): ClosedResult {
  const { arena, m } = ctx;
  const body = buildBaseBody(arena, m.rim, { plateTop: RAISED });
  const base = mode === 'glue' ? buildGlueBase(arena, body, m.outline, m.pocketDepth, m.mold.offsets).base : buildMergedBase(arena, body, m.model, m.footprint, { planeTol: m.planeTol, offsets: m.mold.offsets }).base!;
  const { voids, bodies } = splitShells(arena, arena.track(cover.add(base)));
  expect(bodies, 'union bodies').toHaveLength(1);
  return { voids, problems: compareVoids(voids, expectedVoids(m, mode, arena)) };
}

function checkClosedVolume(ctx: Ctx): void {
  expect(closedVolume(ctx, 'glue').problems, 'glue').toEqual([]);
  if (ctx.m.merged?.base) expect(closedVolume(ctx, 'merged').problems, 'merged').toEqual([]);
}

/** Mode B leaves no sealed air in the part: what it filled is the model's voids plus recesses, from M1's own figures. */
function checkFilledVoids({ arena, m, params }: Ctx): void {
  if (!m.merged?.base) return;
  const { levels } = classifyLevels(m.oriented.mesh, m.candidate, m.footprint, m.planeTol);
  const sealed = levels.filter((level) => level.exposedArea < params.base.minIsland);
  const recess = sealed.reduce((sum, level) => sum + level.enclosedArea * level.gap, 0);
  const expected = (m.imported.report.voidVolume + recess) * m.mold.offsets.length;
  expect(splitShells(arena, m.merged.base).voids).toEqual([]);
  if (expected === 0) expect(m.merged.filledVoid).toBeLessThan(0.1);
  else within(m.merged.filledVoid, expected, 0.03);
}

/** A pocket's fit is a matter of hundredths of a mm, over a perimeter of a few hundred at most. */
const POCKET_SLACK_MM2 = 0.01;

/** G10: the pocket really is cut where the model stands, wide enough for it, by the set enlargement and no more. */
function checkPocket({ arena, m, params }: Ctx): void {
  const { track } = arena;
  const { offsets } = m.mold;
  const enlarge = params.base.pocketEnlarge;
  const removed = m.baseBody.volume() - m.glue!.base.volume();
  within(removed, m.glue!.pocketVolume * offsets.length, 0.02);
  // Read back from the solid: the section halfway down the pocket is the plate less the pockets.
  const level = -m.pocketDepth / 2;
  const pockets = track(track(m.baseBody.slice(level)).subtract(track(m.glue!.base.slice(level))));
  within(pockets.area(), m.outline.area() * offsets.length, 0.02);

  // What has to drop in, from the footprint and the model, not from the outline being checked.
  const section = m.model ? track(m.model.slice(m.pocketDepth)) : triangleContour(arena, m.oriented.mesh, m.pocketDepth);
  const model = track(footprintSection(arena, m.footprint).add(section));
  expect(model.area()).toBeGreaterThan(0);
  const shrunk = track(pockets.offset(-enlarge));
  let widest = track(arena.api.CrossSection.compose([]));
  for (const [x, y] of offsets) {
    const here = track(model.translate([x, y]));
    expect(track(here.subtract(pockets)).area(), `the model sticks out of the pocket at ${x}, ${y}`).toBeLessThan(POCKET_SLACK_MM2);
    expect(track(here.subtract(shrunk)).area(), `under ${enlarge} of room at ${x}, ${y}`).toBeLessThan(POCKET_SLACK_MM2);
    widest = track(widest.add(track(here.offset(enlarge + 0.005, 'Round', undefined, 64))));
  }
  expect(track(pockets.subtract(widest)).area(), `more than ${enlarge} of room`).toBeLessThan(POCKET_SLACK_MM2);
}

/** G9: two notches at mid long sides, through the wall, with the wall at that height by hand. */
function checkNotches({ arena, m }: Ctx): void {
  const { track, trackAll } = arena;
  const { rim, cover } = m;
  if (rim.pryHeight === 0) return;
  const z = coverBottom(rim) + rim.pryHeight / 2;
  const by = rebateOutset(rim, z);
  const wall = rim.O.x1 - (rim.B.x1 + by);
  const w = rim.O.x1 - rim.O.x0, h = rim.O.y1 - rim.O.y0;
  const plain = w * h - ringArea(outset(rim.B, by), rim.cornerRadius + by);
  const section = track(cover.slice(z));
  within(section.area(), plain - 2 * rim.pryWidth * wall, 1e-5);
  expect(trackAll(section.decompose()), 'the wall splits in two').toHaveLength(2);
  const cx = (rim.O.x0 + rim.O.x1) / 2, cy = (rim.O.y0 + rim.O.y1) / 2;
  const at = (x: number, y: number): number => {
    const probe = arena.crossSection([[[x - 0.1, y - 0.1], [x + 0.1, y - 0.1], [x + 0.1, y + 0.1], [x - 0.1, y + 0.1]]]);
    return track(section.intersect(probe)).area();
  };
  const notched = w >= h ? [[cx, rim.O.y1 - wall / 2], [cx, rim.O.y0 + wall / 2]] : [[rim.O.x1 - wall / 2, cy], [rim.O.x0 + wall / 2, cy]];
  const solid = w >= h ? [[rim.O.x1 - wall / 2, cy], [rim.O.x0 + wall / 2, cy]] : [[cx, rim.O.y1 - wall / 2], [cx, rim.O.y0 + wall / 2]];
  for (const [x, y] of notched) expect(at(x, y), 'a notch at mid long side').toBe(0);
  for (const [x, y] of solid) expect(at(x, y), 'no notch at mid short side').toBeGreaterThan(0);
}

/** G9 and G10: corners and bed relief, from the plan's formulas. Nothing else would notice them gone. */
function checkPlate({ arena, m, params }: Ctx): void {
  const { track } = arena;
  const { rim, cover } = m;
  const { B, D, Tb, tanTaper, reliefHeight, reliefRun } = rim;
  // By hand: the set radius, unless it had to give way to the room around the cavity, or to the bolts' edge.
  const radius = Math.min(params.base.cornerRadius, D.x0 - B.x0, D.y0 - B.y0, B.x1 - D.x1, B.y1 - D.y1, rim.bolts?.edge ?? Infinity);
  // Under the pocket and the joint, and over the notches and the relief: a plain rounded rectangle.
  const z = -m.pocketDepth - 0.5;
  const by = -z * tanTaper;
  const cut = rebateOutset(rim, z);
  const box = (rim.O.x1 - rim.O.x0) * (rim.O.y1 - rim.O.y0);
  within(track(cover.slice(z)).area(), box - ringArea(outset(B, cut), radius + cut), 1e-5);
  const spread = (Tb - reliefHeight) * tanTaper;
  // Just over the underside, where the relief has almost all of its run left to go.
  const lift = 1e-3;
  const foot = outset(B, spread - reliefRun + (lift * reliefRun) / reliefHeight);
  // M10: at this height the bolts' holes pass the plate at their own radius, as 48-gons.
  const holes = rim.bolts ? rim.bolts.spots.length * polygonArea(rim.bolts.holeRadius) : 0;
  for (const { name, base } of bases(m)) {
    within(track(base.slice(z)).area(), ringArea(outset(B, by), radius + by) - holes, 1e-5);
    const underside = track(base.slice(-Tb + lift)).bounds();
    expect(underside.min[0], name).toBeCloseTo(foot.x0, 5);
    expect(underside.min[1], name).toBeCloseTo(foot.y0, 5);
    expect(underside.max[0], name).toBeCloseTo(foot.x1, 5);
    expect(underside.max[1], name).toBeCloseTo(foot.y1, 5);
  }
}

const CHECKS: [string, (ctx: Ctx) => void][] = [
  ['tool, cover and base are closed, positive and one body', checkBodies],
  ['intersection of cover and base is about 0', checkIntersection],
  ['the ridge and taper gaps are as designed', checkJointGaps],
  ['the box, proud and flat top match the formulas', checkBox],
  ['the land at z=0 is at least s1', checkLand],
  ['cavity slices at 12 levels are nested', checkNesting],
  ['nothing overhangs past 45 degrees in print pose', checkOverhang],
  ['exported STLs round trip closed, within 0.1% in volume', checkRoundTrip],
  ['the Mode A pocket is where the model stands, by the set enlargement', checkPocket],
  ['the pry notches are through the wall at mid long sides', checkNotches],
  ['plate and rebate have their corners, and the plate its bed relief', checkPlate],
  ['the closed-volume list is exact', checkClosedVolume],
  ['Mode B fills what it seals off, by M1\'s figures', checkFilledVoids],
  ['clearance by minGap is at least t, and at most t+0.6 with draft 0', checkClearance],
];

/** A check's own solids go when it ends: on a big grid they add up to the whole 4 GB of WASM. */
function inOwnArena(ctx: Ctx, check: (ctx: Ctx) => void): void {
  withArena(api, (arena) => check({ ...ctx, arena }));
}

/** Every check on one mold, for the parameter matrix and the grids. */
function checkAll(ctx: Ctx): void {
  for (const [, check] of CHECKS) inOwnArena(ctx, check);
}

function onModel(id: ExampleId, params: Params, options: MoldOptions, run: (ctx: Ctx) => void): void {
  withArena(api, (arena) => run({ arena, m: buildMold(arena, loadExample(id).welded, params, options), params }));
}

/** Holds one built mold across a describe's tests, as building it again per test would be most of the run. */
function sharedMold(id: ExampleId, params: Params = paramsWith()): () => Ctx {
  let ctx: Ctx;
  beforeAll(() => {
    const arena = new Arena(api);
    ctx = { arena, m: buildMold(arena, loadExample(id).welded, params), params };
  });
  afterAll(() => ctx.arena.dispose());
  return () => ctx;
}

describe.each(FULL ? EXAMPLE_IDS : (['jersey', 'barrel'] as ExampleId[]))('%s at defaults', (id) => {
  const ctx = sharedMold(id);
  it.each(CHECKS)('%s', (_, check) => inOwnArena(ctx(), check), SLOW);

  it('uses at most 1.25 times the silicone M2 measured, and matches its own golden numbers', () => {
    const { m } = ctx();
    const { gap, straight } = clearances.get(m) ?? measureClearance(ctx());
    const { voids } = closedVolume(ctx(), 'merged');
    const ml = (voids.reduce((sum, shell) => sum + shell.volume, 0) - grooveResidualVolume(m.rim, RAISED)) / 1000;
    expect(ml).toBeLessThanOrEqual(FIELD_GOLDEN[id].silicone * 1.25);
    // Cover, base and silicone should barely move once reviewed.
    const golden = SOLID_GOLDEN[id];
    within(ml, golden.silicone, 0.01);
    within(m.cover.volume(), golden.cover, 0.01);
    within(m.glue!.base.volume(), golden.glue, 0.01);
    within(m.merged!.base!.volume(), golden.merged, 0.01);
    within(gap, golden.gap, 0.01);
    within(straight, golden.gapDraft0, 0.01);
    expect(m.toolMesh.tinTriangles).toBeLessThan(golden.tinTriangles * 1.05);
    within(m.rim.O.x1 - m.rim.O.x0, golden.boxX, 1e-3);
    within(m.rim.O.y1 - m.rim.O.y0, golden.boxY, 1e-3);
    within(m.rim.Zt, golden.Zt, 1e-3);
  }, SLOW);
});

/** M10: the cuts are where the layout says, at its heights: the hole, the membrane, the slot, the hole over the nut, the countersink. */
function checkBoltCuts({ arena, m }: Ctx): void {
  const { track } = arena;
  const { rim, cover } = m;
  const b = rim.bolts!;
  const at = (solid: Manifold, z: number, r: number): ([number, number] | null)[] => holeCentres(arena, solid, z, b.spots, r);
  const on = (found: ([number, number] | null)[], what: string): void => b.spots.forEach((spot, k) => {
    expect(found[k], `${what} at ${spot.x.toFixed(2)}, ${spot.y.toFixed(2)}`).not.toBeNull();
    expect(Math.hypot(found[k]![0] - spot.x, found[k]![1] - spot.y), what).toBeLessThan(1e-6);
  });
  // A 0.2 mm square at each axis, filled with plastic or not.
  const filled = (z: number, x: number, y: number, side = 0.2): number => track(track(cover.slice(z)).intersect(arena.crossSection([[[x - side / 2, y - side / 2], [x + side / 2, y - side / 2], [x + side / 2, y + side / 2], [x - side / 2, y + side / 2]]]))).area() / (side * side);
  on(at(cover, (b.slotFloor - b.layer) / 2, b.holeRadius), 'the hole under the membrane');
  on(at(cover, (b.slotTop + b.holeTop) / 2, b.holeRadius), 'the hole over the nut');
  for (const spot of b.spots) {
    // The membrane is exactly one layer: plastic through it, the hole just under it and the slot just over it.
    expect(filled(b.slotFloor - b.layer + 0.005, spot.x, spot.y)).toBeCloseTo(1, 6);
    expect(filled(b.slotFloor - 0.005, spot.x, spot.y)).toBeCloseTo(1, 6);
    expect(filled(b.slotFloor - b.layer - 0.005, spot.x, spot.y)).toBe(0);
    expect(filled(b.slotFloor + 0.005, spot.x, spot.y)).toBe(0);
    // The hole runs up to its end, with plastic over it, a wall at least under the flat top, so nothing reaches Zt.
    if (b.holeTop > b.slotTop) expect(filled(b.holeTop - 0.005, spot.x, spot.y)).toBe(0);
    expect(filled(b.holeTop + 0.005, spot.x, spot.y)).toBeCloseTo(1, 6);
    expect(filled(rim.Zt - b.minWall + 0.005, spot.x, spot.y)).toBeCloseTo(1, 6);
    expect(rim.Zt - b.holeTop).toBeGreaterThanOrEqual(b.minWall - 1e-9);
    // The slot is empty through its height, out through the wall, and plastic under its floor.
    const outline = arena.crossSection([clipToBox(slotOutline(b, spot), rim.O)]);
    const area = outline.area();
    const inSlot = (z: number): number => track(track(cover.slice(z)).intersect(outline)).area();
    expect(inSlot((b.slotFloor + b.slotTop) / 2)).toBeLessThan(1e-6);
    within(inSlot(b.slotFloor - 0.005), area, 1e-4);
    within(inSlot(b.slotTop + 0.005), area - polygonArea(b.holeRadius), 1e-3);
  }
  // In print pose the cover's layers start at the flat top: the bridge sits on a layer boundary.
  const layers = (rim.Zt - b.slotFloor) / b.layer;
  expect(Math.abs(layers - Math.round(layers))).toBeLessThan(1e-9);
  expect(b.slotFloor).toBeGreaterThanOrEqual(rim.ridgeHeight + rim.grooveExtra + b.minWall - 1e-9);
  // The base: the countersink at 45 degrees from the underside, then the hole.
  for (const { name, base } of bases(m)) {
    on(at(base, b.bed + 0.01, b.sinkRadius - 0.01), `${name}: the countersink at the underside`);
    on(at(base, b.bed + b.sinkDepth / 2, b.sinkRadius - b.sinkDepth / 2), `${name}: the countersink half way up`);
    on(at(base, (b.bed + b.sinkDepth) / 2, b.holeRadius), `${name}: the hole over the countersink`);
  }
}

/** M10: every wall the bolts leave is at least the least wall: to the groove, outside, plate, notches, and to the cavity by the field in 3D. */
function checkBoltWalls({ m }: Ctx): void {
  const b = m.rim.bolts!;
  const walls = boltWalls(m.rim)!;
  for (const [what, wall] of Object.entries(walls)) expect(wall.wall, what).toBeGreaterThanOrEqual(b.minWall - 1e-9);
  // The hole is held to exactly its wall on the groove's corner and the countersink at the underside: that is what sets the land.
  expect(walls.groove.wall).toBeCloseTo(b.minWall, 9);
  expect(walls.plate.wall).toBeCloseTo(b.minWall, 9);
  expect(boltCavityWall(b, m.built.field, m.toolMesh.raise, m.rim.D, 30).wall).toBeGreaterThanOrEqual(b.minWall);
  expect(m.rim.diagnostics.filter((d) => d.code.startsWith('bolt-') && d.code !== 'bolt-land')).toEqual([]);
}

/** M10: reassembled from the STL bytes of both print poses, the bolt axes in base and cover coincide, where the layout put them. */
function checkBoltAxes({ arena, m }: Ctx): void {
  const { rim } = m;
  const b = rim.bolts!;
  const cPose = coverPose(rim), bPose = basePose(rim);
  const cover = unpose(arena, poseToStl(api, m.cover, cPose), cPose);
  const inCover = holeCentres(arena, cover, (b.slotFloor - b.layer) / 2, b.spots, b.holeRadius);
  for (const { name, base } of bases(m)) {
    const back = unpose(arena, poseToStl(api, base, bPose), bPose);
    const inBase = holeCentres(arena, back, (b.bed + b.sinkDepth) / 2, b.spots, b.holeRadius);
    b.spots.forEach((spot, k) => {
      const c = inCover[k], s = inBase[k];
      expect(c && s, `${name}: both holes of the bolt at ${spot.x.toFixed(2)}, ${spot.y.toFixed(2)}`).toBeTruthy();
      expect(Math.hypot(c![0] - s![0], c![1] - s![1]), name).toBeLessThan(1e-3);
      expect(Math.hypot(c![0] - spot.x, c![1] - spot.y), name).toBeLessThan(1e-3);
    });
  }
}

const BOLT_CHECKS: [string, (ctx: Ctx) => void][] = [
  ['the bolts\' cuts are where the layout says, with a membrane of one layer and nothing up to Zt', checkBoltCuts],
  ['the bolts leave at least the least wall to the groove, the outside, the plate, the notches and the cavity', checkBoltWalls],
  ['the bolt axes in the base and the cover coincide, reassembled from both print poses', checkBoltAxes],
];

describe('with bolts on (M10)', () => {
  const bolted = (change: (p: Params) => void = () => {}): Params => paramsWith((p) => {
    p.bolts.enabled = true;
    change(p);
  });

  describe.each(FULL ? EXAMPLE_IDS : (['jersey'] as ExampleId[]))('%s at defaults', (id) => {
    const ctx = sharedMold(id, bolted());
    it.each([...CHECKS, ...BOLT_CHECKS])('%s', (_, check) => inOwnArena(ctx(), check), SLOW);

    it('grows the box by the outer land the bolts add and no more, keeps Zt, and matches its golden numbers', () => {
      const { m } = ctx();
      const { rim } = m;
      const b = rim.bolts!;
      const golden = SOLID_GOLDEN[id], bolts = BOLT_GOLDEN[id];
      const grow = 2 * (b.land - b.jointLand);
      // M3's goldens are to 3 places, as its own test reads them.
      within(rim.O.x1 - rim.O.x0, golden.boxX + grow, 1e-4);
      within(rim.O.y1 - rim.O.y0, golden.boxY + grow, 1e-4);
      within(rim.Zt, golden.Zt, 1e-4);
      expect(grow).toBeCloseTo(8.292, 3);
      within(rim.O.x1 - rim.O.x0, bolts.boxX, 1e-4);
      within(rim.O.y1 - rim.O.y0, bolts.boxY, 1e-4);
      within(m.cover.volume(), bolts.cover, 0.01);
      within(m.glue!.base.volume(), bolts.glue, 0.01);
      within(m.merged!.base!.volume(), bolts.merged, 0.01);
      within(b.slotFloor, bolts.slotFloor, 1e-4);
      within(boltCavityWall(b, m.built.field, m.toolMesh.raise, rim.D, 30).wall, bolts.cavity, 0.01);
      within(boltWalls(rim)!.notches.wall, bolts.notches, 0.01);
    }, SLOW);
  });

  // The plan's grid with bolts: the four bolts stand at the corners of the whole box, whatever the tiles.
  it.runIf(FULL)('jersey 2 x 3 passes every check, the bolts at the outer corners', () => {
    const params = bolted((p) => {
      p.grid.nx = 2;
      p.grid.ny = 3;
    });
    onModel('jersey', params, {}, (ctx) => {
      for (const [, check] of [...CHECKS, ...BOLT_CHECKS]) inOwnArena(ctx, check);
      const { B } = ctx.m.rim;
      const edge = ctx.m.rim.bolts!.edge;
      expect(ctx.m.rim.bolts!.spots.map((s) => [s.x, s.y])).toEqual([[B.x0 + edge, B.y0 + edge], [B.x1 - edge, B.y0 + edge], [B.x0 + edge, B.y1 - edge], [B.x1 - edge, B.y1 - edge]]);
    });
  }, SLOW);

  // Nothing reaches Zt, on the solids: a screw too long for jersey's cover gets its hole stopped a wall under the
  // top, and a model too low for the bolts gets a top raised over them. Both checked as built, with the top's slices.
  it('a 40 mm screw on jersey: its hole stops a wall under Zt, the flat top is whole, and a cutter that ignored that is caught', () => {
    const params = bolted((p) => (p.bolts.length = 40));
    onModel('jersey', params, { modes: { glue: true } }, (ctx) => {
      const { m, arena } = ctx;
      const b = m.rim.bolts!;
      // The screw would end at 37.2, past jersey's top; the hole stops 1.2 under it.
      expect(b.wantedTop).toBeCloseTo(40 - 4 + 0.2 + 1, 9);
      expect(b.wantedTop).toBeGreaterThan(m.rim.Zt);
      expect(b.holeTop).toBeCloseTo(m.rim.Zt - b.minWall, 9);
      expect(m.rim.diagnostics.map((d) => d.code)).toContain('bolt-long');
      for (const check of [checkBodies, checkBox, checkBoltCuts, checkBoltAxes]) inOwnArena(ctx, check);
      // Negative control: the hole cut on to where the screw would end breaks through the top.
      const through = buildCoverBody(arena, { ...m.rim, bolts: { ...b, holeTop: b.wantedTop } }, m.tool);
      expect(() => checkBox({ ...ctx, m: { ...m, cover: through } })).toThrow();
      expect(() => checkBoltCuts({ ...ctx, m: { ...m, cover: through, merged: null } })).toThrow();
    });
  }, SLOW);

  it('a 1 mm block with a 3 mm cap: the top is raised over the shortest bolt and its slot, and every check holds', () => {
    const params = bolted((p) => (p.cover.topCap = 3));
    withArena(api, (arena) => {
      const m = buildMold(arena, box([-10, -5, 0], [10, 5, 1]), params, { pick: facingDown });
      const ctx = { arena, m, params };
      const b = m.rim.bolts!;
      expect(m.rim.Zt).toBeCloseTo(b.coverHeight, 9);
      expect(m.rim.Zt).toBeGreaterThan(m.rim.hMax + 3);
      expect(m.rim.diagnostics.filter((d) => d.code.startsWith('bolt-')).map((d) => [d.code, d.severity])).toEqual([['bolt-land', 'info'], ['bolt-cover-raised', 'info']]);
      checkAll(ctx);
      for (const check of [checkBoltCuts, checkBoltAxes]) inOwnArena(ctx, check);
      for (const [what, wall] of Object.entries(boltWalls(m.rim)!)) expect(wall.wall, what).toBeGreaterThanOrEqual(b.minWall - 1e-9);
      expect(boltCavityWall(b, m.built.field, m.toolMesh.raise, m.rim.D, 30).wall).toBeGreaterThanOrEqual(b.minWall);
    });
  }, SLOW);

  it('negative control: a bolt hole moved off its axis in the cover breaks the axis check', () => {
    onModel('jersey', bolted(), { modes: { glue: true } }, (ctx) => {
      const { m, arena } = ctx;
      const b = m.rim.bolts!;
      // The cover built from a layout with its first bolt 0.01 mm over in x, the base from the real one.
      const moved = { ...m.rim, bolts: { ...b, spots: b.spots.map((s, k) => (k === 0 ? { ...s, x: s.x + 0.01 } : s)) } };
      const cover = buildCoverBody(arena, moved, m.tool);
      expect(() => checkBoltAxes({ ...ctx, m: { ...m, cover, merged: null } })).toThrow();
      // And a cover with no membrane, its hole cut on up into the slot, fails the cut check.
      const open = buildCoverBody(arena, { ...m.rim, bolts: { ...b, layer: 0 } }, m.tool);
      expect(() => checkBoltCuts({ ...ctx, m: { ...m, cover: open, merged: null } })).toThrow();
    });
  });
});

describe('plan facts on the examples', () => {
  it.runIf(FULL)('x8 in Mode B is one body, with 8 bodies in the model and 2 cavities', () => {
    onModel('x8', paramsWith(), { modes: { merged: true } }, ({ arena, m }) => {
      expect(m.imported.report.bodies).toBe(8);
      expect(m.built.cavities.count).toBe(2);
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(1);
    });
  }, SLOW);

  it('the barrel void is filled in Mode B and reported', () => {
    onModel('barrel', paramsWith(), { modes: { merged: true } }, ({ m }) => {
      within(m.imported.report.voidVolume, 3432, 0.01);
      within(m.merged!.filledVoid, 3432, 0.01);
      expect(m.merged!.diagnostics.find((d) => d.code === 'void-filled')!.message).toContain(m.merged!.filledVoid.toFixed(0));
      // The merged part is solid where the void was: the model's outer shell, plus the plate and ridge.
      const outer = m.model!.volume() + m.imported.report.voidVolume;
      within(m.merged!.base!.volume() - m.baseBody.volume(), outer, 0.01);
    });
  });

  it.runIf(FULL)('VIS-35 on its upper level: solid area at +0.02 is about 1128 mm2, Mode B trims, and every check holds', () => {
    onModel('vis35', paramsWith(), { useUpper: true }, (ctx) => {
      const { arena, m } = ctx;
      const { track } = arena;
      expect(m.oriented.needsTrim).toBe(true);
      expect(m.bounds.min[2]).toBeCloseTo(-0.41, 2);
      expect(m.model!.boundingBox().min[2]).toBeGreaterThanOrEqual(0);
      // M1 measured this at 1134.6, 0.6% high, as the plan's figure allows.
      within(track(m.model!.slice(0.02)).area(), 1128, 0.01);
      within(m.footprint.area, 1128, 0.015);
      // And the merged part holds the same section: the pad is gone from under it.
      const base = m.merged!.base!;
      const section = track(track(base.slice(0.02)).intersect(arena.crossSection([[[m.rim.D.x0, m.rim.D.y0], [m.rim.D.x1, m.rim.D.y0], [m.rim.D.x1, m.rim.D.y1], [m.rim.D.x0, m.rim.D.y1]]])));
      within(section.area(), 1128, 0.01);
      expect(base.boundingBox().min[2]).toBeCloseTo(-m.rim.Tb, 6);
      checkAll(ctx);
    });
  }, SLOW);

  it.each(FULL ? EXAMPLE_IDS : (['jersey', 'barrel'] as ExampleId[]))('%s: model_oriented.stl comes from the original soup, with its flat face at z=0 and no reflection', (id) => {
    onModel(id, paramsWith(), { modes: {} }, ({ m }) => {
      const { parsed, welded } = loadExample(id);
      const { mesh, audit } = readPart(modelOrientedStl(m.oriented, m.model));
      expect(mesh.indices.length / 3).toBe(parsed.triangleCount);
      expect(audit.openEdges).toBe(0);
      const { min } = meshBounds(mesh.positions);
      expect(min[2]).toBeGreaterThanOrEqual(-m.planeTol);
      expect(min[2]).toBeLessThanOrEqual(m.planeTol);
      within(signedVolume(mesh), signedVolume(welded), 1e-3);
    });
  }, SLOW);

  it.runIf(FULL)('VIS-35 on its upper level: model_oriented.stl has the pad trimmed off, from the solid', () => {
    onModel('vis35', paramsWith(), { useUpper: true, modes: {} }, ({ m }) => {
      const { mesh, audit } = readPart(modelOrientedStl(m.oriented, m.model));
      expect(audit.openEdges).toBe(0);
      expect(meshBounds(mesh.positions).min[2]).toBeCloseTo(0, 4);
      within(signedVolume(mesh), m.model!.volume(), 1e-3);
    });
  }, SLOW);
});

describe('negative controls: these checks can fail', () => {
  const ctx = sharedMold('jersey');

  it('a slot through the wall changes the closed-volume list: the cavity is gone from it', () => {
    const c = ctx();
    const { arena, m } = c;
    expect(closedVolume(c, 'glue').problems).toEqual([]);
    const peak = mapCavities(m.built.field, m.toolMesh.raise).cavities[0].peak;
    const z = peak[2] / 2;
    const slot = boxSolid(arena, [peak[0] - 1, peak[1], z - 0.5], [peak[0] + 1, m.rim.O.y1 + 1, z + 0.5]);
    const opened = checked(arena.track(m.cover.subtract(slot)), 'slotted cover');
    const { problems } = closedVolume(c, 'glue', opened);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^cavity 0: no void encloses/);
    expect(closedVolume(c, 'merged', opened).problems).not.toEqual([]);
  });

  it('a slot through the inner land joins the cavity to the groove, so the groove leaves the list', () => {
    const c = ctx();
    const { arena, m } = c;
    const { rim } = m;
    const midX = (rim.D.x0 + rim.D.x1) / 2;
    const slot = boxSolid(arena, [midX - 1, rim.D.y1 - 2, -0.5], [midX + 1, rim.D.y1 + rim.e1 + 0.3, 0.3]);
    const { problems } = closedVolume(c, 'glue', checked(arena.track(m.cover.subtract(slot)), 'slotted cover'));
    expect(problems.length).toBeGreaterThan(0);
  });

  it('a ledge cut into the cavity wall breaks nesting', () => {
    const c = ctx();
    const { arena, m } = c;
    const { rim } = m;
    const z = rim.hMax * 0.75;
    const ledge = boxSolid(arena, [-5, rim.D.y1 - 1, z - 2], [5, rim.D.y1 + rim.e1 / 3, z + 2]);
    const broken = checked(arena.track(m.cover.subtract(ledge)), 'ledged cover');
    expect(() => checkNesting({ ...c, m: { ...m, cover: broken } })).toThrow();
  });

  it('the cover left unflipped overhangs: its ceiling faces the bed', () => {
    const { m } = ctx();
    const mesh = m.cover.getMesh();
    const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts });
    expect(audit.steepCount).toBeGreaterThan(0);
    expect(audit.steepArea).toBeGreaterThan(100);
  });

  it('a radius short of t fails the clearance check', () => {
    const c = ctx();
    const { arena, m, params } = c;
    const thin = paramsWith((p) => (p.silicone.t = 2.5));
    const settings = fieldSettings(thin, m.bounds);
    const plan = planField(m.bounds, settings);
    const built = buildField(m.oriented.mesh, plan, settings);
    const tool = toolSolid(arena, buildToolMesh(built.field, { raise: plan.raise, tol: params.quality.tinTolFinal }));
    const rim = deriveRim(moldBounds(m.oriented.mesh, m.bounds, settings), thin);
    const cover = buildCoverBody(arena, rim, tool);
    expect(m.model!.minGap(cover, 8)).toBeLessThan(params.silicone.t);
    expect(() => checkClearance({ ...c, m: { ...m, cover } })).toThrow();
  });

  it('a pocket cut 1 mm to the side fails, though it keeps its volume, area and void', () => {
    const c = ctx();
    const { arena, m } = c;
    const shifted = arena.track(m.outline.translate([1, 0]));
    const glue = buildGlueBase(arena, m.baseBody, shifted, m.pocketDepth, m.mold.offsets);
    expect(() => checkPocket({ ...c, m: { ...m, glue, outline: shifted } })).toThrow(/sticks out/);
  });

  it('a pocket at another enlargement than the one set fails, tighter and wider', () => {
    const c = ctx();
    const { arena, m } = c;
    const model = arena.track(footprintSection(arena, m.footprint).add(arena.track(m.model!.slice(m.pocketDepth))));
    for (const [enlarge, expected] of [[0.1, /under 0.2 of room/], [0.4, /more than 0.2 of room/]] as const) {
      const outline = arena.track(model.offset(enlarge, 'Round', undefined, 32));
      const glue = buildGlueBase(arena, m.baseBody, outline, m.pocketDepth, m.mold.offsets);
      expect(() => checkPocket({ ...c, m: { ...m, glue, outline } })).toThrow(expected);
    }
  });

  it('a pocket outline that leaves out part of the model fails, though its area is enough', () => {
    const c = ctx();
    const { arena, m } = c;
    const { min, max } = m.outline.bounds();
    const half = arena.crossSection([[[min[0] - 1, min[1] - 1], [(min[0] + max[0]) / 2, min[1] - 1], [(min[0] + max[0]) / 2, max[1] + 1], [min[0] - 1, max[1] + 1]]]);
    const outline = arena.track(m.outline.intersect(half));
    const glue = buildGlueBase(arena, m.baseBody, outline, m.pocketDepth, m.mold.offsets);
    expect(() => checkPocket({ ...c, m: { ...m, glue, outline } })).toThrow(/sticks out/);
  });

  it('a cover without its notches fails', () => {
    const c = ctx();
    const { arena, m } = c;
    const cover = buildCoverBody(arena, { ...m.rim, pryHeight: 0 }, m.tool);
    expect(() => checkNotches({ ...c, m: { ...m, cover } })).toThrow();
  });

  it('a plate without its relief or corners fails, even with a rebate that follows it', () => {
    const c = ctx();
    const { arena, m } = c;
    const noRelief = buildBaseBody(arena, { ...m.rim, reliefRun: 0 });
    expect(() => checkPlate({ ...c, m: { ...m, glue: { ...m.glue!, base: noRelief }, merged: null } })).toThrow();
    const sharp = { ...m.rim, cornerRadius: 0 };
    const sharpBase = buildBaseBody(arena, sharp);
    expect(() => checkPlate({ ...c, m: { ...m, cover: buildCoverBody(arena, sharp, m.tool), glue: { ...m.glue!, base: sharpBase }, merged: null } })).toThrow();
  });

  it('a land bitten through at one cavity fails, on a mold whose other cavities keep the bounding box', () => {
    const params = paramsWith();
    onModel('x8', params, { modes: {} }, (c) => {
      const { arena, m } = c;
      const { rim } = m;
      expect(m.built.cavities.count).toBeGreaterThan(1);
      checkLand(c);
      const midX = (rim.D.x0 + rim.D.x1) / 2;
      const slot = boxSolid(arena, [midX - 1, rim.D.y1 - 2, -0.5], [midX + 1, rim.D.y1 + rim.e1 + 0.3, 0.3]);
      const bitten = checked(arena.track(m.cover.subtract(slot)), 'bitten cover');
      expect(() => checkLand({ ...c, m: { ...m, cover: bitten } })).toThrow(/land outline area/);
    });
  });

  it('a cover and base built from different rims intersect', () => {
    const c = ctx();
    const { arena, m } = c;
    const offRim = deriveRim({ ...m.mold, D: outset(m.mold.D, 0.5) }, c.params);
    const base = buildBaseBody(arena, offRim);
    expect(arena.track(m.cover.intersect(base)).volume()).toBeGreaterThan(1);
  });
});

function checkReassembly(ctx: Ctx): void {
  const { arena, m, params } = ctx;
  const { track } = arena;
  const { rim, cover } = m;
  const cPose = coverPose(rim);
  const coverBack = unpose(arena, poseToStl(api, cover, cPose), cPose);
  const bPose = basePose(rim);
  const { t } = params.silicone;
  // Benchy takes half a minute at this search length.
  expect(m.model!.minGap(coverBack, 8)).toBeGreaterThanOrEqual(t);
  for (const { name, base } of bases(m)) {
    const baseBack = unpose(arena, poseToStl(api, base, bPose), bPose);
    // float32 can put the shelf a rounding step into the plate: over this shelf, a few 1e-6 mm.
    expect(track(coverBack.intersect(baseBack)).volume(), name).toBeLessThan(0.1);
  }
}

describe('reassembly from exported STL bytes', () => {
  it('an L-shaped fixture: minGap at least t, no overlap, and a mirrored cover fails on both', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const ctx = { arena, m: buildMold(arena, lShape(api), params), params };
      checkReassembly(ctx);
      const { m } = ctx;
      // Read through the very same steps. The L's whole low arm falls outside the mirrored cavity,
      // so this is no near miss: the model runs into the plastic, and the rim misses the base.
      const mirrored = unpose(arena, mirroredCoverStl(m.cover, m.rim.Zt), coverPose(m.rim));
      expect(m.model!.minGap(mirrored, 8)).toBe(0);
      expect(arena.track(mirrored.intersect(m.glue!.base)).volume()).toBeGreaterThan(10);
    });
  });

  /**
   * The plan expects a mirrored cover to fail here as well, and a plain z flip cannot: it reflects the
   * cavity in y, and Benchy's hull is symmetric in y to well within its margin. Its gap reads 3.2178
   * either way, and such a cover would truly fit. So the z flip is caught by comparing the two
   * surfaces, and a reflection along the axis where the model has a front and a back fails by gap.
   */
  it.runIf(FULL)('Benchy: minGap at least t, no overlap, and mirrored covers are caught', () => {
    onModel('benchy', paramsWith(), {}, (ctx) => {
      checkReassembly(ctx);
      const { arena, m, params } = ctx;
      const { track } = arena;
      const back = unpose(arena, poseToStl(api, m.cover, coverPose(m.rim)), coverPose(m.rim));
      const flipped = unpose(arena, mirroredCoverStl(m.cover, m.rim.Zt), coverPose(m.rim));
      expect(m.model!.minGap(flipped, params.silicone.t + 0.7)).toBeGreaterThanOrEqual(params.silicone.t);
      // The real export comes back as the cover itself, but the flipped one does not.
      expect(track(back.subtract(m.cover)).volume() + track(m.cover.subtract(back)).volume()).toBeLessThan(1);
      expect(track(flipped.subtract(m.cover)).volume() + track(m.cover.subtract(flipped)).volume()).toBeGreaterThan(10);
      const reversed = unpose(arena, mirroredCoverStl(m.cover, m.rim.Zt, true), coverPose(m.rim));
      expect(m.model!.minGap(reversed, params.silicone.t + 0.7)).toBeLessThan(params.silicone.t);
    });
  }, SLOW);
});

describe('parameter matrix', () => {
  const MATRIX: [string, (p: Params) => void][] = [
    ['t=1', (p) => (p.silicone.t = 1)],
    ['t=5', (p) => (p.silicone.t = 5)],
    ['t=10', (p) => (p.silicone.t = 10)],
    ['Tb=3', (p) => (p.base.thickness = 3)],
    ['pocket 0.1, enlarge 0.4', (p) => ((p.base.pocketDepth = 0.1), (p.base.pocketEnlarge = 0.4))],
    ['edge 30', (p) => (p.grid.edge = 30)],
    // Past the room around the cavity, as nothing in the schema stops it. The plan's matrix does not list this one.
    ['corner radius 15', (p) => (p.base.cornerRadius = 15)],
  ];
  const models: ExampleId[] = FULL ? ['jersey', 'barrel', 'wolf'] : ['jersey'];
  describe.each(models)('%s', (id) => {
    it.each(MATRIX)('%s passes every check', (_, change) => {
      const params = paramsWith(change);
      onModel(id, params, {}, checkAll);
    }, SLOW);
  });

  it('edge 30 gives O = half + 30, and edge 1 says it was raised', () => {
    onModel('jersey', paramsWith((p) => (p.grid.edge = 30)), { modes: {} }, ({ m }) => {
      expect(m.rim.O.x1 - m.mold.model.x1).toBeCloseTo(30, 6);
      expect(m.rim.diagnostics).toEqual([]);
    });
    onModel('jersey', paramsWith((p) => (p.grid.edge = 1)), { modes: {} }, ({ m }) => {
      const [raised] = m.rim.diagnostics;
      expect(raised.code).toBe('edge-raised');
      expect(raised.message).toContain('from 1.0');
      expect(raised.message).toContain(`to ${m.rim.edge.minimum.toFixed(1)}`);
      expect(m.rim.edge.minimum).toBeGreaterThan(1);
      expect(Math.max(m.rim.O.x1 - m.mold.model.x1, m.mold.model.y0 - m.rim.O.y0)).toBeCloseTo(m.rim.edge.minimum, 6);
    });
  });
});

describe('grids', () => {
  const GRIDS: [ExampleId, number, number, number | null, number][] = [
    ['benchy', 2, 3, null, 6],
    ['jersey', 3, 3, null, 9],
    ['goddess', 2, 1, null, 2],
    ['vis35', 2, 1, null, 2],
    // Spacing 10 on this one has closing fill the wall: the set has to hold with the tiles merged too.
    ['goddess', 2, 1, 10, 1],
  ];
  const run = FULL ? GRIDS : GRIDS.filter(([id]) => id === 'jersey');
  it.each(run)('%s %i x %i at spacing %s: every check, with %i cavities', (id, nx, ny, spacing, cavities) => {
    const params = paramsWith((p) => {
      p.grid.nx = nx;
      p.grid.ny = ny;
      p.grid.spacing = spacing;
    });
    onModel(id, params, {}, (ctx) => {
      const { m } = ctx;
      expect(m.built.cavities.count).toBe(cavities);
      if (cavities < nx * ny) expect(m.built.diagnostics.map((d) => d.code)).toContain('tiles-merged');
      else expect(m.built.tilesMerged).toBe(false);
      checkAll(ctx);
    });
  }, SLOW);
});

describe('placing parts: the pitch always comes from the export plan', () => {
  const previewCell = 0.5;

  it('x8 2 x 1: a preview field sits wider than the export, and parts follow the export', () => {
    onModel('x8', paramsWith((p) => (p.grid.nx = 2)), { modes: {} }, ({ m, params }) => {
      const preview = fieldSettings(params, m.bounds, previewCell);
      expect(planField(m.bounds, preview).pitchXmm).toBe(125);
      expect(exportPlan(m.bounds, preview).pitchXmm).toBe(124.75);
      const bounds = moldBounds(m.oriented.mesh, m.bounds, preview);
      expect(bounds.offsets).toEqual([[0, 0], [124.75, 0]]);
      // The very same bounds and box as the export, whichever cell is running.
      expect(bounds).toEqual(m.mold);
      expect(deriveRim(bounds, params)).toEqual(m.rim);
    });
  });

  it('no preview cell moves the box', () => {
    const params = paramsWith();
    onModel('barrel', params, { modes: {} }, ({ m }) => {
      for (const cell of [0.25, 0.5, 1]) {
        const bounds = moldBounds(m.oriented.mesh, m.bounds, fieldSettings(params, m.bounds, cell));
        expect(deriveRim(bounds, params).O).toEqual(m.rim.O);
        expect(deriveRim(bounds, params).Zt).toBe(m.rim.Zt);
      }
    });
  });

  it('a preview at the preview cell builds real parts in the same box, and 8 x 1 stays inside the rim by the clip', () => {
    const params = paramsWith((p) => (p.grid.nx = 8));
    onModel('x8', params, { cell: previewCell, tinTol: params.quality.tinTolPreview, modes: { glue: true } }, ({ arena, m }) => {
      const plan = m.plan;
      const finalPitch = exportPlan(m.bounds, m.settings).pitchXmm;
      expect(plan.pitchXmm).toBeGreaterThan(finalPitch);
      // Over 8 tiles the preview's cavity runs 1.75 mm past the rim's own bound. Left alone that eats
      // most of the 2 mm land, though it stops short of the groove, and that is what the clip is for.
      expect(maskOverrun(m.built.field, m.rim.D)).toBeGreaterThan(1);
      expect(() => checkLand({ arena, m, params })).toThrow(/land width/);
      const clipped = buildToolMesh(m.built.field, { raise: params.quality.tinTolPreview, tol: params.quality.tinTolPreview, clip: m.rim.D });
      expect(clipped.clippedNodes).toBeGreaterThan(0);
      const cover = buildCoverBody(arena, m.rim, toolSolid(arena, clipped));
      expect(toolDiagnostics(m.rim, clipped).map((d) => d.code)).toEqual(['preview-cropped']);
      checkLand({ arena, m: { ...m, cover }, params });
      expect(splitShells(arena, cover).bodies).toHaveLength(1);
      const box3 = cover.boundingBox();
      expect(box3.max[0]).toBeCloseTo(m.rim.O.x1, 4);
      expect(arena.track(cover.intersect(m.glue!.base)).volume()).toBeLessThan(0.01);
    });
  });

  it('the coarsest export cell still keeps the cavity inside the rim, with the land whole', () => {
    onModel('jersey', paramsWith((p) => (p.quality.cellFinal = 0.5)), { modes: { glue: true } }, (ctx) => {
      expect(maskOverrun(ctx.m.built.field, ctx.m.rim.D)).toBe(0);
      checkLand(ctx);
      checkBodies(ctx);
    });
  });

  it.each(['jersey', 'barrel'] as ExampleId[])('%s: the clip does nothing to an export field', (id) => {
    onModel(id, paramsWith(), { modes: {} }, ({ m }) => {
      const clipped = buildToolMesh(m.built.field, { raise: m.plan.raise, tol: 0.05, clip: m.rim.D });
      expect(clipped.clippedNodes).toBe(0);
      expect(clipped.positions).toEqual(m.toolMesh.positions);
    });
  });
});

const facingDown = (candidates: BaseCandidate[]): BaseCandidate => candidates.find((c) => c.normal[2] < -0.99)!;

describe('a model standing only on feet under the island limit (G2.5)', () => {
  /** 2.4 x 1.9 with rounded corners: one 2 x 1.5 foot, enlarged by the default 0.2. */
  const foot = 2.4 * 1.9 - (4 - Math.PI) * 0.2 ** 2;

  it('warns, and builds both modes: the pocket from its section, and the stubs from the islands', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, blockOnFeet(api), params, { pick: facingDown });
      expect(m.footprint.components).toEqual([]);
      expect(m.footprint.islands).toHaveLength(2);
      expect(m.footprint.diagnostics.map((d) => [d.code, d.severity])).toContainEqual(['footprint-empty', 'warning']);
      within(m.outline.area(), 2 * foot, 0.002);
      expect(m.glue!.diagnostics).toEqual([]);
      expect(m.merged!.diagnostics.map((d) => d.code)).not.toContain('merged-bodies');
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(1);
      checkAll({ arena, m, params });
    });
  }, SLOW);

  it.each([
    ['a 2 x 2 x 2 cube at the default limit', box([0, 0, 0], [2, 2, 2]), 5],
    ['an 8 x 8 x 8 cube at the highest limit', box([0, 0, 0], [8, 8, 8]), 100],
  ] as const)('%s has its pocket from the section', (_, mesh, minIsland) => {
    withArena(api, (arena) => {
      const params = paramsWith((p) => (p.base.minIsland = minIsland));
      const m = buildMold(arena, mesh, params, { pick: facingDown });
      expect(m.footprint.components).toEqual([]);
      const side = meshBounds(mesh.positions).max[0];
      within(m.outline.area(), (side + 0.4) ** 2 - (4 - Math.PI) * 0.2 ** 2, 0.002);
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(1);
      checkAll({ arena, m, params });
    });
  }, SLOW);

  it('ties a post standing a hair above the plate to it, which the plate alone would not', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      // Two separate posts, the second 0.03 above the plane and so within planeTol of it.
      const posts = join(box([0, 0, 0], [2, 1.5, 10]), box([8, 0, 0.03], [10, 1.5, 10]));
      const m = buildMold(arena, posts, params, { pick: facingDown });
      expect(m.footprint.components).toEqual([]);
      expect(m.footprint.islands).toHaveLength(2);
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(1);
      expect(m.merged!.diagnostics.map((d) => d.code)).not.toContain('merged-bodies');
      // Negative control: with no islands to tie, the second post comes loose.
      const loose = buildMergedBase(arena, m.baseBody, m.model, { ...m.footprint, islands: [] }, { planeTol: m.planeTol, offsets: m.mold.offsets });
      expect(splitShells(arena, loose.base!).bodies).toHaveLength(2);
      expect(loose.diagnostics.map((d) => d.code)).toContain('merged-bodies');
    });
  }, SLOW);

  it('a model with no footprint and no section at the pocket depth gets no pocket, and is told so', () => {
    withArena(api, (arena) => {
      // 0.1 thin, with the pocket's top at 0.2.
      const m = buildMold(arena, box([0, 0, 0], [2, 2, 0.1]), paramsWith(), { pick: facingDown });
      expect(m.outline.isEmpty()).toBe(true);
      expect(m.glue!.pocketVolume).toBe(0);
      expect(m.glue!.diagnostics.map((d) => [d.code, d.severity])).toEqual([['pocket-empty', 'warning']]);
      within(m.glue!.base.volume(), m.baseBody.volume(), 1e-9);
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(1);
    });
  }, SLOW);
});

describe('Mode B on models with a known answer', () => {
  it('a part that does not touch the plate is warned about, and stays in the file as a second body', () => {
    withArena(api, (arena) => {
      const m = buildMold(arena, join(box([0, 0, 0], [20, 10, 10]), box([5, 2, 15], [15, 8, 20])), paramsWith(), { pick: facingDown });
      expect(splitShells(arena, m.merged!.base!).bodies).toHaveLength(2);
      const note = m.merged!.diagnostics.find((d) => d.code === 'merged-bodies');
      expect(note?.severity).toBe('warning');
      expect(note?.message).toContain('One part');
      within(m.merged!.base!.volume(), m.baseBody.volume() + 2000 + 300, 1e-3);
    });
  }, SLOW);

  it('the underside of a mushroom\'s dome is reported as its overhang, by hand', () => {
    withArena(api, (arena) => {
      const m = buildMold(arena, mushroom(api), paramsWith(), { pick: facingDown });
      const { stemRadius, capRadius } = MUSHROOM;
      const underside = Math.PI * (capRadius ** 2 - stemRadius ** 2);
      // Round parts are polygons, a little under their circles.
      expect(m.merged!.modelOverhangArea).toBeLessThanOrEqual(underside);
      within(m.merged!.modelOverhangArea, underside, 0.01);
      expect(m.merged!.diagnostics.find((d) => d.code === 'model-overhang')?.message).toContain(`${m.merged!.modelOverhangArea.toFixed(0)} mm2`);
    });
  }, SLOW);

  it('a recess the plate closes off leaves no ceiling to report, as Mode B filled it', () => {
    withArena(api, (arena) => {
      const m = buildMold(arena, recessedBlock(api, 0.5), paramsWith(), { pick: facingDown });
      within(m.merged!.filledVoid, 10 * 10 * 0.5, 0.01);
      expect(m.merged!.modelOverhangArea).toBe(0);
      expect(m.merged!.diagnostics.map((d) => d.code)).not.toContain('model-overhang');
    });
  }, SLOW);
});

describe('the Mode A pocket, by hand', () => {
  it('a 20 x 20 box at enlarge 0.4 has its pocket in place, at the area of the enlarged outline', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      const params = paramsWith((p) => (p.base.pocketEnlarge = 0.4));
      const m = buildMold(arena, box([3, 5, 0], [23, 25, 8]), params, { pick: facingDown });
      const area = 20.8 ** 2 - (4 - Math.PI) * 0.4 ** 2;
      const level = -m.pocketDepth / 2;
      const cut = track(track(m.baseBody.slice(level)).subtract(track(m.glue!.base.slice(level))));
      within(cut.area(), area, 0.002);
      within(m.baseBody.volume() - m.glue!.base.volume(), area * m.pocketDepth, 0.002);
      const { min, max } = cut.bounds();
      expect(min[0]).toBeCloseTo(m.bounds.min[0] - 0.4, 4);
      expect(min[1]).toBeCloseTo(m.bounds.min[1] - 0.4, 4);
      expect(max[0]).toBeCloseTo(m.bounds.max[0] + 0.4, 4);
      expect(max[1]).toBeCloseTo(m.bounds.max[1] + 0.4, 4);
      checkPocket({ arena, m, params });
    });
  }, SLOW);
});

describe('soup mode', () => {
  const OPEN_TOP = boxWithTopHole(6);

  it('an open mesh still gets a cover and a Mode A base from the raster, and Mode B is refused with a clear error', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, OPEN_TOP, params);
      expect(m.imported.solid).toBeNull();
      expect(m.imported.report.modeBAvailable).toBe(false);
      expect(m.model).toBeNull();

      expect(splitShells(arena, m.cover).bodies).toHaveLength(1);
      expect(arena.track(m.cover.intersect(m.glue!.base)).volume()).toBeLessThan(0.01);
      // The cavity follows the raster: the open box's outside plus r_eff.
      const box3 = m.tool.boundingBox();
      expect(box3.max[2]).toBeCloseTo(20 + m.plan.rEff + m.plan.raise, 2);

      // The 20 x 20 outline enlarged by 0.2, rounded corners and all.
      const area = (20 + 0.4) ** 2 - (4 - Math.PI) * 0.2 ** 2;
      within(m.outline.area(), area, 0.002);
      within(m.baseBody.volume() - m.glue!.base.volume(), area * m.pocketDepth, 0.02);
      checkPocket({ arena, m, params });

      expect(m.merged!.base).toBeNull();
      const [error] = m.merged!.diagnostics;
      expect(error.code).toBe('mode-b-disabled');
      expect(error.severity).toBe('error');
      expect(error.message).toContain('glue mode');
    });
  });

  it('a mesh with no underside at all still gets its pocket, from the hole', () => {
    withArena(api, (arena) => {
      const pickHole = (candidates: BaseCandidate[]): BaseCandidate => candidates.find((c) => c.holes.length > 0)!;
      const m = buildMold(arena, withoutTriangles(box([0, 0, 0], [30, 30, 20]), BOX_BOTTOM), paramsWith(), { pick: pickHole });
      expect(m.imported.solid).toBeNull();
      expect(m.candidate.source).toBe('hole');
      const area = (30 + 0.4) ** 2 - (4 - Math.PI) * 0.2 ** 2;
      within(m.outline.area(), area, 0.002);
      expect(splitShells(arena, m.glue!.base).bodies).toHaveLength(1);
      expect(splitShells(arena, m.cover).bodies).toHaveLength(1);
    });
  });

  it('a hole in the top lowers the cavity there: that is the warning M1 gives, and it is reported', () => {
    withArena(api, (arena) => {
      const m = buildMold(arena, withoutTriangles(box([0, 0, 0], [30, 30, 20]), BOX_TOP), paramsWith());
      expect(m.imported.solid).toBeNull();
      expect(m.oriented.diagnostics.map((d) => d.code)).toContain('missing-top-surface');
      expect(splitShells(arena, m.cover).bodies).toHaveLength(1);
    });
  });
});

describe('handles', () => {
  // With the bolts on too: their cutters, the slots' outlines and their extrusions go through the arena.
  it.each([false, true])('every Manifold and CrossSection of a whole mold is freed, bolts %s', async (bolts) => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    withArena(counted, (arena) => {
      const m = buildMold(arena, loadExample('jersey').welded, paramsWith((p) => (p.bolts.enabled = bolts)));
      poseToStl(api, m.cover, coverPose(m.rim));
      poseToStl(api, m.glue!.base, basePose(m.rim));
    });
    expect(ledger.created()).toBeGreaterThan(bolts ? 60 : 30);
    expect(ledger.live()).toEqual([]);
    expect(ledger.deleted()).toBe(ledger.created());
  });
});

describe('Delatin stays within the risk table on the heaviest grids', () => {
  it.runIf(FULL).each([['wolf', 3, 3], ['x8', 3, 3]] as [ExampleId, number, number][])('%s %i x %i stays under 1.5M triangles and reports it', (id, nx, ny) => {
    const params = paramsWith((p) => {
      p.grid.nx = nx;
      p.grid.ny = ny;
    });
    onModel(id, params, { modes: {} }, ({ m }) => {
      expect(m.toolMesh.diagnostics).toEqual([]);
      expect(m.toolMesh.tinTriangles).toBeLessThan(1_500_000);
      gridRows.push(`| ${id} ${nx} x ${ny} | ${m.built.field.nx * m.built.field.ny} | ${m.toolMesh.tinTriangles} | ${round(m.timings.field)} | ${round(m.timings.tin)} | ${round(m.timings.toolSolid)} | ${round(m.timings.cover)} |`);
    });
  }, SLOW);
});

const round = (ms: number): number => Math.round(ms * 10) / 10;
const gridRows: string[] = [];

describe.runIf(FULL)('timing, for the budgets of M5', () => {
  const finalRows: string[] = [];
  const previewRows: string[] = [];
  const header = '| Model | Nodes | TIN triangles | Field | TIN | Tool solid | Rim | Cover body | Base body | Mode A | Mode B | Cover STL | Base STL | minGap | Total |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

  const rowOf = (id: string, arena: Arena, m: Mold, gap: number): string => {
    const t = m.timings;
    const t0 = performance.now();
    poseToStl(api, m.cover, coverPose(m.rim));
    const t1 = performance.now();
    poseToStl(api, m.glue!.base, basePose(m.rim));
    const t2 = performance.now();
    const total = t.field + t.tin + t.toolSolid + t.rim + t.cover + t.baseBody + t.glue + t.merged + (t1 - t0) + (t2 - t1) + gap;
    return `| ${id} | ${m.built.field.nx * m.built.field.ny} | ${m.toolMesh.tinTriangles} | ${round(t.field)} | ${round(t.tin)} | ${round(t.toolSolid)} | ${round(t.rim)} | ${round(t.cover)} | ${round(t.baseBody)} | ${round(t.glue)} | ${round(t.merged)} | ${round(t1 - t0)} | ${round(t2 - t1)} | ${round(gap)} | ${round(total)} |`;
  };

  it.each(EXAMPLE_IDS)('%s', (id) => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, loadExample(id).welded, params);
      const t0 = performance.now();
      const gap = m.model!.minGap(m.cover, 8);
      const gapMs = performance.now() - t0;
      expect(gap).toBeGreaterThanOrEqual(3);
      finalRows.push(rowOf(id, arena, m, gapMs));
    });
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, loadExample(id).welded, params, { cell: 0.5, tinTol: params.quality.tinTolPreview });
      previewRows.push(rowOf(id, arena, m, 0));
    });
  }, SLOW);

  afterAll(() => {
    const text = [
      'Export: plan defaults at cell 0.125 and TIN tolerance 0.05, in ms, with one tile. minGap is the plan\'s `model.minGap(cover, 8)` against the full model, and an export will run it on a decimated copy (G4), so it is the worst case. Mode A and Mode B each include their share of the same plate and ridge, from the base body.',
      '',
      header,
      ...finalRows,
      '',
      'Preview (tier T2): cell 0.5 and TIN tolerance 0.1, no minGap.',
      '',
      header,
      ...previewRows,
      '',
      'Heaviest grids: TIN size and the stages it drives, in ms. The risk table asks for a warning above 1.5M triangles, and past that the tool builder raises its tolerance.',
      '',
      '| Mold | Nodes | TIN triangles | Field | TIN | Tool solid | Cover body |',
      '|---|---|---|---|---|---|---|',
      ...gridRows,
    ].join('\n');
    console.log(text);
    if (process.env.CFG_RECORD === '1') recordSection('Solid stages', `Node on the server. Written by \`scripts/ci.sh --full --record\`, as it needs all 7 models.\n\n${text}`);
  });
});
