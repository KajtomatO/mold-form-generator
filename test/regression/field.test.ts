import type { ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateAtLevel, findBaseCandidates, upperLevel } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { buildField } from '../../src/core/field/build';
import { countCavities } from '../../src/core/field/cavities';
import { applyClosing } from '../../src/core/field/closing';
import { compositeTiles } from '../../src/core/field/composite';
import { dilate } from '../../src/core/field/dilate';
import { applyDraft } from '../../src/core/field/draft';
import { planField, type Field, type FieldSettings } from '../../src/core/field/grid';
import { NO_SOURCE, rasterize } from '../../src/core/field/raster';
import { countBodies, exteriorMesh, sealedDomains } from '../../src/core/field/sealed';
import { moldSilicone, siliconeVolume, volumeAbovePlane, type MoldSilicone } from '../../src/core/field/silicone';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid, type SolidReport } from '../../src/core/mesh/shells';
import { meshBounds, type Bounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { withArena } from '../../src/core/solid/arena';
import { recordSection } from '../fixtures/benchmarks';
import { bruteDilate } from '../fixtures/bruteDilate';
import { cornerRaster } from '../fixtures/cornerRaster';
import { ANALYTIC_SHAPES, cupAir, cupSilicone, holedBlockSilicone, invertedCupInterior, invertedCupSilicone, mushroomSilicone, voxelSilicone } from '../fixtures/fieldOracles';
import { bareSettings, defaultSettings, orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, loadExample, loadManifold, skipWithout, type ExampleId } from '../fixtures/loadExamples';
import { box, cup, HOLED_BLOCK, holedBlock, invertedCup, join, mushroom } from '../fixtures/synthetic';
import { FIELD_GOLDEN, GOLDEN } from './golden';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

function solidReport(id: ExampleId): SolidReport {
  const { welded, audit } = loadExample(id);
  return withArena(api, (arena) => importSolid(arena, welded, audit).report);
}

const { analysisCell: ANALYSIS_CELL } = defaultParams().quality;
const MIN_SEALED_MM3 = defaultParams().reports.minVolumeMl * 1000;
const NO_OVERLAP = { overlapVolume: 0 };

/** The real path to the silicone figure: moldSilicone, on the field that buildField gives. */
function siliconeOf(mesh: WeldedMesh, settings: FieldSettings, bounds: Bounds, report: Pick<SolidReport, 'overlapVolume'> = NO_OVERLAP): MoldSilicone & { field: Field } {
  const plan = planField(bounds, settings);
  const { field } = buildField(mesh, plan, settings);
  return { ...moldSilicone(mesh, plan, field, report, settings), field };
}

/** Every node of the grid square around (x, y): the theorem of G4 holds for all four. */
function lowestAround(field: Field, x: number, y: number): number {
  const i = Math.floor((x - field.x0) / field.cell), j = Math.floor((y - field.y0) / field.cell);
  const { values, nx } = field;
  return Math.min(values[i + j * nx], values[i + 1 + j * nx], values[i + (j + 1) * nx], values[i + 1 + (j + 1) * nx]);
}

/**
 * How far the field falls short of the ball of radius t around a model vertex, sampled at the vertex
 * itself and out to its rim. The ball's rim is where a shortfall shows: its top is nearly flat, so a
 * test at the vertex alone barely notices a radius that is too small.
 */
function worstShortfall(mesh: WeldedMesh, field: Field, t: number): number {
  const p = mesh.positions;
  let worst = -Infinity;
  const directions = 12;
  for (let v = 0; v < p.length; v += 3) {
    const x = p[v], y = p[v + 1], z = p[v + 2];
    if (z < 0) continue;
    worst = Math.max(worst, z + t - lowestAround(field, x, y));
    for (let a = 0; a < directions; a++) {
      const c = Math.cos((a * 2 * Math.PI) / directions), s = Math.sin((a * 2 * Math.PI) / directions);
      for (const d of [0.5 * t, 0.9 * t, 0.999 * t]) {
        worst = Math.max(worst, z + Math.sqrt(t * t - d * d) - lowestAround(field, x + c * d, y + s * d));
      }
    }
  }
  return worst;
}

/** Just below the whole r / cell ratio that t=3 makes at cells 0.25, 0.125 and 0.05. See FieldGolden.bare. */
const OFF_LATTICE_T = 2.9999;

describe('oracle fixtures at no margin, no draft, no closing', () => {
  // Closed forms, so these tests depend on no grid. The plan first gave figures measured with 0.5 mm
  // voxels, which read low. The voxel test below keeps that link, and checks the closed forms independently.
  const ALL = [
    { name: 'cup', make: cup, exact: cupSilicone(3) },
    { name: 'inverted cup', make: invertedCup, exact: invertedCupSilicone(3) },
    { name: 'mushroom', make: mushroom, exact: mushroomSilicone(3) },
    { name: 'block', make: holedBlock, exact: holedBlockSilicone(3) },
  ];
  const ROUND = ALL.slice(0, 3);

  const measure = (make: (api: ManifoldToplevel) => WeldedMesh, cell: number, t = 3): number => {
    const mesh = make(api);
    const bounds = meshBounds(mesh.positions);
    return siliconeOf(mesh, { ...bareSettings(bounds, cell), t }, bounds).ml;
  };

  it.each(ALL)('$name is within 2% of its closed form at the export cell, and 1% at the finest', ({ make, exact }) => {
    within(measure(make, 0.125), exact, 0.02);
    within(measure(make, 0.05), exact, 0.01);
  });

  it.each(ROUND)('$name stays above its closed form and comes down to it, on and off the lattice: the raster is conservative', ({ make, exact }) => {
    for (const t of [3, OFF_LATTICE_T]) {
      const coarse = measure(make, 0.25, t);
      const fine = measure(make, 0.05, t);
      expect(coarse, `t=${t}`).toBeGreaterThan(fine);
      expect(fine, `t=${t}`).toBeGreaterThan(exact);
    }
  });

  it('the block has no such direction: its error is the row a whole r / cell adds to its straight walls', () => {
    const { side, height } = HOLED_BLOCK;
    const exact = holedBlockSilicone(3);
    const off = [0.25, 0.125, 0.05].map((cell) => measure(holedBlock, cell, OFF_LATTICE_T));
    // Off the lattice it comes up to the closed form from below.
    expect(off[0]).toBeLessThan(off[1]);
    expect(off[1]).toBeLessThan(off[2]);
    expect(off[2]).toBeLessThan(exact);
    // On the lattice it sits one row higher: the walls' area times the cell.
    for (const [k, cell] of [0.25, 0.125, 0.05].entries()) {
      within(measure(holedBlock, cell) - off[k], (4 * side * height * cell) / 1000, 0.02);
    }
    // And between whole ratios t=3 reads on either side of the closed form, so the series is not monotone.
    expect(measure(holedBlock, 0.09)).toBeLessThan(exact);
    expect(measure(holedBlock, 0.12)).toBeGreaterThan(measure(holedBlock, 0.14));
  });

  it('voxel integration, a separate method, climbs to the closed forms as the voxels shrink', () => {
    const shapes: [(typeof ANALYTIC_SHAPES)[keyof typeof ANALYTIC_SHAPES], number][] = [
      [ANALYTIC_SHAPES.cup, cupSilicone(3)],
      [ANALYTIC_SHAPES.mushroom, mushroomSilicone(3)],
      [ANALYTIC_SHAPES.holedBlock, holedBlockSilicone(3)],
    ];
    for (const [shape, exact] of shapes) {
      const coarse = voxelSilicone(shape, 0.5, 3).silicone;
      const fine = voxelSilicone(shape, 0.25, 3).silicone;
      expect(coarse).toBeLessThan(fine);
      expect(fine).toBeLessThan(exact);
      within(fine, exact, 0.03);
    }
    const inverted = voxelSilicone(ANALYTIC_SHAPES.invertedCup, 0.25, 3, invertedCupInterior);
    within(inverted.silicone, invertedCupSilicone(3), 0.03);
    within(inverted.air, cupAir(), 0.01);
  });

  it('sealed air of the inverted cup is 130.5 ml within 3%, and is not counted as silicone', () => {
    const mesh = invertedCup(api);
    const bounds = meshBounds(mesh.positions);
    const { ml, sealedAir } = siliconeOf(mesh, bareSettings(bounds, 0.125), bounds);
    within(sealedAir / 1000, 130.5, 0.03);
    // With the air left in, this would read about 176 ml, four times the jacket.
    within(ml, invertedCupSilicone(3), 0.02);
  });
});

describe.each(EXAMPLE_IDS)('field of %s', (id) => {
  const golden = FIELD_GOLDEN[id];

  it('matches the plan: t=3, no margin, no draft, no closing, cell 0.25, within 5%', () => {
    const { mesh, bounds } = orientedExample(id);
    const { ml, domains } = siliconeOf(mesh, bareSettings(bounds, 0.25), bounds, solidReport(id));
    // The plan has no figure for the chick, added at M11c: its own golden number still holds it.
    if (golden.planBare !== null) within(ml, golden.planBare, 0.05);
    within(ml, golden.bare, 0.01);
    // Benchy's and wolf's sealed letters stay below the filter, so no air comes off any of these.
    expect(domains).toEqual([]);
  });

  it('has its pinned number just off that whole r / cell, where x8 and jersey leave the plan\'s 5%', () => {
    const { mesh, bounds } = orientedExample(id);
    const { ml } = siliconeOf(mesh, { ...bareSettings(bounds, 0.25), t: OFF_LATTICE_T }, bounds, solidReport(id));
    within(ml, golden.bareOffLattice, 0.01);
    expect(ml).toBeLessThan(golden.bare);
    if (golden.planBare !== null) expect(Math.abs(ml / golden.planBare - 1) > 0.05).toBe(id === 'x8' || id === 'jersey');
  });

  it('matches its golden number at plan defaults, with barely a change off the lattice', () => {
    const { mesh, bounds } = orientedExample(id);
    const report = solidReport(id);
    const { ml } = siliconeOf(mesh, defaultSettings(bounds), bounds, report);
    within(ml, golden.silicone, 0.01);
    within(siliconeOf(mesh, { ...defaultSettings(bounds), t: OFF_LATTICE_T }, bounds, report).ml, ml, 1e-3);
  });

  it('clears every vertex by t: margin on, including with no print margin to help', () => {
    const { mesh, bounds } = orientedExample(id);
    const plan = planField(bounds, defaultSettings(bounds));
    const raster = rasterize(mesh, plan.tile);
    const field = dilate(raster, plan.rEff);
    expect(worstShortfall(mesh, field, 3)).toBeLessThanOrEqual(0);
    // G4's theorem alone: t + 2.13 cells, with nothing left over but float rounding.
    expect(worstShortfall(mesh, dilate(raster, 3 + 2.13 * 0.125), 3)).toBeLessThanOrEqual(2e-5);
  });

  it('never lowers H in draft or closing, and leaves closing idempotent on the final field', () => {
    const { mesh, bounds } = orientedExample(id);
    const settings = defaultSettings(bounds);
    const plan = planField(bounds, settings);
    const field = dilate(rasterize(mesh, plan.tile), plan.rEff);
    const dilated = field.values.slice();
    applyDraft(field, settings.draftDeg);
    const drafted = field.values.slice();
    applyClosing(field, settings.closeWidth);
    let loweredByDraft = 0, loweredByClosing = 0, raisedByClosing = 0;
    for (let n = 0; n < dilated.length; n++) {
      if (drafted[n] < dilated[n]) loweredByDraft++;
      if (field.values[n] < drafted[n]) loweredByClosing++;
      if (field.values[n] > drafted[n] + 0.01) raisedByClosing++;
    }
    expect(loweredByDraft).toBe(0);
    expect(loweredByClosing).toBe(0);
    expect(raisedByClosing).toBeGreaterThan(0);

    // buildField must be this same chain, with draft first.
    const final = field.values.slice();
    expect(buildField(mesh, plan, settings).field.values).toEqual(final);
    applyClosing(field, settings.closeWidth);
    let worst = 0;
    for (let n = 0; n < final.length; n++) worst = Math.max(worst, Math.abs(field.values[n] - final[n]));
    expect(worst).toBeLessThanOrEqual(0.01);
  });

  it('has the planned cavity and body counts', () => {
    const { mesh, bounds } = orientedExample(id);
    const settings = defaultSettings(bounds);
    const { cavities } = buildField(mesh, planField(bounds, settings), settings);
    expect(cavities.count).toBe(id === 'x8' ? 2 : 1);
    const bodies = countBodies(mesh);
    expect(bodies).toBe(id === 'x8' ? 8 : 1);
    expect(bodies).toBe(GOLDEN[id].bodies);
  });

  it('agrees with the M1 record on the model volume, void left out', () => {
    const { mesh } = orientedExample(id);
    within(volumeAbovePlane(exteriorMesh(mesh)), solidReport(id).solidVolume, 1e-3);
  });

  it('clips no higher than the corner formula, and covers the same cells bar ties at their edges', () => {
    const { mesh, bounds } = orientedExample(id);
    const plan = planField(bounds, defaultSettings(bounds));
    const clipped = rasterize(mesh, plan.tile).values;
    const corners = cornerRaster(mesh, plan.tile).values;
    let above = 0, cellsOnlyOneSees = 0, cells = 0;
    for (let n = 0; n < clipped.length; n++) {
      if (clipped[n] === NO_SOURCE && corners[n] === NO_SOURCE) continue;
      cells++;
      if (clipped[n] === NO_SOURCE || corners[n] === NO_SOURCE) cellsOnlyOneSees++;
      else if (clipped[n] > corners[n] + 1e-3) above++;
    }
    expect(above).toBe(0);
    expect(cellsOnlyOneSees / cells).toBeLessThan(1e-3);
  });

  it('dilating leaves the source raster untouched, so a stage cache can keep it', () => {
    const { mesh, bounds } = orientedExample(id);
    const plan = planField(bounds, defaultSettings(bounds));
    const raster = rasterize(mesh, plan.tile);
    const before = raster.values.slice();
    dilate(raster, plan.rEff);
    expect(raster.values).toEqual(before);
  });
});

describe('dilation against brute force on real fields', () => {
  it.for([['benchy', 0.125], ['goddess', 0.125], ['jersey', 0.25], ['barrel', 0.125]] as const)('%s at cell %s', ([id, cell], ctx) => {
    skipWithout(ctx, id);
    const { mesh, bounds } = orientedExample(id);
    const settings = { ...defaultSettings(bounds, cell), cellFinal: cell };
    const plan = planField(bounds, settings);
    const raster = rasterize(mesh, plan.tile);
    const reference = bruteDilate(raster, plan.rEff);
    const out = dilate(raster, plan.rEff).values;
    let worst = 0;
    for (let n = 0; n < out.length; n++) worst = Math.max(worst, Math.abs(out[n] - reference[n]));
    expect(worst).toBeLessThanOrEqual(1e-4);
  });
});

describe('plan facts on the field', () => {
  it('a radius short of the margin fails the clearance test, so that test has teeth', () => {
    for (const id of ['benchy', 'wolf'] as const) {
      const { mesh, bounds } = orientedExample(id);
      const plan = planField(bounds, defaultSettings(bounds));
      const raster = rasterize(mesh, plan.tile);
      expect(worstShortfall(mesh, dilate(raster, 3 + 0.125), 3)).toBeGreaterThan(0.01);
      expect(worstShortfall(mesh, dilate(raster, 3), 3)).toBeGreaterThan(0.05);
    }
  });

  it('x8 with no margin and no closing gives 8 cavities, with or without draft', () => {
    const { mesh, bounds } = orientedExample('x8');
    const bare = bareSettings(bounds);
    expect(buildField(mesh, planField(bounds, bare), bare).cavities.count).toBe(8);
    const drafted = { ...bare, draftDeg: 1 };
    expect(buildField(mesh, planField(bounds, drafted), drafted).cavities.count).toBe(8);
  });

  it('x8 at defaults gets 2 cavities from closing alone: 8 bodies still need 8 pours', () => {
    const { mesh, bounds } = orientedExample('x8');
    const settings = defaultSettings(bounds);
    const plan = planField(bounds, settings);
    const field = dilate(rasterize(mesh, plan.tile), plan.rEff);
    applyDraft(field, settings.draftDeg);
    expect(countCavities(field).count).toBe(8);
    applyClosing(field, settings.closeWidth);
    expect(countCavities(field).count).toBe(2);
    expect(countBodies(mesh)).toBe(8);
  });

  it('VIS-35 2x1 at spacing 10 warns of a thin wall, which it measures', (ctx) => {
    skipWithout(ctx, 'vis35');
    const { mesh, bounds } = orientedExample('vis35');
    const thin = { ...defaultSettings(bounds), nx: 2, ny: 1, spacing: 10 };
    const plan = planField(bounds, thin);
    const built = buildField(mesh, plan, thin);
    expect(built.cavities.count).toBe(2);
    expect(built.minWall).toBeLessThan(plan.requiredWall);
    expect(built.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
    expect(built.diagnostics[0].message).toContain(plan.autoSpacing.toFixed(1));
  });

  it('Goddess 2x1 at spacing 10 has no wall left to be thin: closing filled it, so the warning says they joined', () => {
    const { mesh, bounds } = orientedExample('goddess');
    const thin = { ...defaultSettings(bounds), nx: 2, ny: 1, spacing: 10 };
    const plan = planField(bounds, thin);
    const built = buildField(mesh, plan, thin);
    expect(built.cavities.count).toBe(1);
    expect(built.tilesMerged).toBe(true);
    expect(built.minWall).toBeNull();
    expect(built.diagnostics.map((d) => d.code)).toEqual(['tiles-merged']);
    expect(built.diagnostics[0].message).toContain(plan.autoSpacing.toFixed(1));

    // Closing did that: before it, the same spacing leaves a wall under the limit.
    const unclosed = { ...thin, closeWidth: 0 };
    const open = buildField(mesh, planField(bounds, unclosed), unclosed);
    expect(open.cavities.count).toBe(2);
    expect(open.minWall).toBeLessThan(plan.requiredWall);
    expect(open.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
  });

  it('Goddess 2x1 at spacing 11 keeps a wall, and warns that it is thin', () => {
    const { mesh, bounds } = orientedExample('goddess');
    const thin = { ...defaultSettings(bounds), nx: 2, ny: 1, spacing: 11 };
    const built = buildField(mesh, planField(bounds, thin), thin);
    expect(built.cavities.count).toBe(2);
    expect(built.minWall).toBeLessThan(2);
    expect(built.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
  });

  it.each([[1.9, 6], [1.9, 10], [2, 6], [2, 10]])('Goddess 2x1 at closeWidth %s, spacing %s reports the merge, though the fin left reads wide enough', (closeWidth, spacing) => {
    const { mesh, bounds } = orientedExample('goddess');
    const s = { ...defaultSettings(bounds), nx: 2, ny: 1, spacing, closeWidth };
    const built = buildField(mesh, planField(bounds, s), s);
    expect(built.cavities.count).toBe(1);
    expect(built.minWall).toBeNull();
    expect(built.diagnostics.map((d) => d.code)).toEqual(['tiles-merged']);
  });

  it.for(['goddess', 'vis35'] as const)('auto spacing passes on %s 2x1', (id, ctx) => {
    skipWithout(ctx, id);
    const { mesh, bounds } = orientedExample(id);
    const auto = { ...defaultSettings(bounds), nx: 2, ny: 1 };
    const autoPlan = planField(bounds, auto);
    const passed = buildField(mesh, autoPlan, auto);
    expect(passed.minWall).toBeGreaterThanOrEqual(autoPlan.requiredWall);
    expect(passed.diagnostics).toEqual([]);
    expect(passed.cavities.count).toBe(2);
    expect(autoPlan.spacing).toBeGreaterThan(10);
  });

  it.each(EXAMPLE_IDS)('auto spacing keeps %s apart with closing at 3 and 5 mm, the widest the schema allows', (id) => {
    const { mesh, bounds } = orientedExample(id);
    for (const closeWidth of [3, 5]) {
      const s = { ...defaultSettings(bounds), nx: 2, ny: 1, closeWidth };
      const plan = planField(bounds, s);
      const built = buildField(mesh, plan, s);
      expect(built.tilesMerged, `closeWidth ${closeWidth}`).toBe(false);
      expect(built.minWall!, `closeWidth ${closeWidth}`).toBeGreaterThanOrEqual(Math.max(plan.requiredWall, closeWidth));
      expect(built.diagnostics, `closeWidth ${closeWidth}`).toEqual([]);
      expect(built.cavities.count, `closeWidth ${closeWidth}`).toBe(id === 'x8' ? 4 : 2);
    }
  });

  it.each(EXAMPLE_IDS)('auto spacing leaves %s a printable wall both ways', (id) => {
    const { mesh, bounds } = orientedExample(id);
    const settings = { ...defaultSettings(bounds), nx: 2, ny: 2 };
    const plan = planField(bounds, settings);
    const built = buildField(mesh, plan, settings);
    expect(built.minWall).toBeGreaterThanOrEqual(plan.requiredWall);
    expect(built.diagnostics).toEqual([]);
    expect(built.cavities.count).toBe(id === 'x8' ? 8 : 4);
  });

  it.for(['jersey', 'barrel'] as const)('spacing 0 merges %s into one cavity', (id, ctx) => {
    skipWithout(ctx, id);
    const { mesh, bounds } = orientedExample(id);
    const settings = { ...defaultSettings(bounds), nx: 2, ny: 2, spacing: 0 };
    const built = buildField(mesh, planField(bounds, settings), settings);
    expect(built.cavities.count).toBe(1);
    expect(built.tilesMerged).toBe(true);
    expect(built.diagnostics.map((d) => d.code)).toEqual(['tiles-merged']);
  });

  // Shifting float32 vertices rounds them, and steep facets turn that into height. It grows with the
  // model's size, so each bound sits just above what that model measures, and any other error fails.
  it.each([['jersey', 2, 3, 6, 1e-4], ['goddess', 2, 1, 6, 5e-4]] as const)('the composite of a real %s tile equals evaluating every real copy, %i x %i', (id, nx, ny, spacing, bound) => {
    const { mesh, bounds } = orientedExample(id);
    const settings: FieldSettings = { ...defaultSettings(bounds), nx, ny, spacing, draftDeg: 0, closeWidth: 0 };
    const plan = planField(bounds, settings);
    const tile = dilate(rasterize(mesh, plan.tile), plan.rEff);
    const { field } = compositeTiles(tile, plan);
    const copies: WeldedMesh[] = [];
    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        const positions = mesh.positions.slice();
        for (let p = 0; p < positions.length; p += 3) {
          positions[p] += tx * plan.pitchXmm;
          positions[p + 1] += ty * plan.pitchYmm;
        }
        copies.push({ positions, indices: mesh.indices });
      }
    }
    const independent = dilate(rasterize(join(...copies), plan.composite), plan.rEff);
    let worst = 0;
    for (let n = 0; n < field.values.length; n++) worst = Math.max(worst, Math.abs(field.values[n] - independent.values[n]));
    expect(worst).toBeLessThanOrEqual(bound);
  });

  it('the barrel void is excluded: its 3.43 ml is neither silicone nor sealed air', (ctx) => {
    skipWithout(ctx, 'barrel');
    const { mesh, bounds } = orientedExample('barrel');
    const report = solidReport('barrel');
    within(report.voidVolume, 3432, 0.01);
    const { ml, sealedAir, modelVolume, field } = siliconeOf(mesh, bareSettings(bounds, 0.25), bounds, report);
    expect(sealedAir).toBe(0);
    within(modelVolume, report.solidVolume, 1e-3);
    within(ml, FIELD_GOLDEN.barrel.bare, 0.01);

    // Without exteriorMesh the void does show up: as sealed air at the M1 volume within 3%.
    const seen = sealedDomains(mesh, ANALYSIS_CELL, MIN_SEALED_MM3);
    expect(seen).toHaveLength(1);
    expect(seen[0].onPlane).toBe(false);
    within(seen[0].volume, report.voidVolume, 0.03);
    // And taking the volume from the whole mesh is the error the plan's table once had: it counts the
    // void as silicone, so the golden number tells the two apart.
    const wrong = siliconeVolume(field, { exteriorVolume: volumeAbovePlane(mesh), tiles: 1, sealedAir: 0, raise: 0 }).ml;
    expect(wrong).toBeGreaterThan(FIELD_GOLDEN.barrel.bare * 1.3);
    within(wrong, FIELD_GOLDEN.barrel.bare + 3.43, 0.01);
  });

  describe('silicone with geometry below the plane, which the raster clips', () => {
    const report = (mesh: WeldedMesh): SolidReport => withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report);
    const plain = box([0, 0, 0], [30, 30, 20]);
    const ml = (mesh: WeldedMesh): number => {
      const bounds = meshBounds(mesh.positions);
      return siliconeOf(mesh, defaultSettings(bounds), bounds, report(mesh)).ml;
    };

    it('a stray running down through the base changes nothing, counted neither below the plane nor twice in the block', () => {
      const stray = join(plain, box([13, 13, -30], [17, 17, 1]));
      expect(report(stray).overlapVolume).toBeCloseTo(16, 3);
      // Without this the figure falls 496 mm3, 3.7%: 480 below the plane and 16 counted twice.
      expect(Math.abs(ml(stray) - ml(plain))).toBeLessThanOrEqual(1e-4);
    });

    it('a separate body wholly below the plane changes nothing', () => {
      const stray = join(plain, box([40, 40, -5], [44, 44, -1]));
      expect(Math.abs(ml(stray) - ml(plain))).toBeLessThanOrEqual(1e-4);
    });

    it('VIS-35 on its upper level leaves out the pad below z=0.41, which is about 361 x 0.405 mm3', (ctx) => {
      skipWithout(ctx, 'vis35');
      const { welded, options } = loadExample('vis35');
      const [lower] = findBaseCandidates(welded, options);
      const upper = candidateAtLevel(welded, lower, upperLevel(lower, options.planeTol)!.offset, options);
      const { mesh } = orientToBase(welded, upper, { planeTol: options.planeTol, soup: false });
      const bounds = meshBounds(mesh.positions);
      expect(bounds.min[2]).toBeCloseTo(-0.41, 2);
      const whole = solidReport('vis35');
      const { modelVolume } = siliconeOf(mesh, defaultSettings(bounds), bounds, whole);
      within(whole.solidVolume - modelVolume, 361 * 0.405, 0.02);
    });
  });

  it('no example has a sealed domain above the filter except where M1 found a void', () => {
    for (const id of EXAMPLE_IDS) {
      const { mesh } = orientedExample(id);
      expect(sealedDomains(exteriorMesh(mesh), ANALYSIS_CELL, MIN_SEALED_MM3), id).toEqual([]);
    }
  });

  it('Benchy and wolf keep small sealed letters under the base, each below the filter', () => {
    const benchy = sealedDomains(exteriorMesh(orientedExample('benchy').mesh), ANALYSIS_CELL, 0.5);
    expect(benchy.length).toBeGreaterThan(5);
    expect(benchy.every((d) => d.onPlane && d.volume < MIN_SEALED_MM3)).toBe(true);
    within(benchy.reduce((sum, d) => sum + d.area, 0), 78.1, 0.05);
    const wolf = sealedDomains(exteriorMesh(orientedExample('wolf').mesh), ANALYSIS_CELL, 0.5);
    expect(wolf.length).toBeGreaterThan(5);
    within(wolf.reduce((sum, d) => sum + d.area, 0), 108.5, 0.05);
  });
});

describe('timing', () => {
  const round = (ms: number): number => Math.round(ms * 10) / 10;
  const stages: string[] = [];
  const grids: string[] = [];
  const rasters: string[] = [];

  it.each(EXAMPLE_IDS)('%s builds its field in under 5 s at cell 0.125', (id) => {
    const { mesh, bounds } = orientedExample(id);
    const settings = defaultSettings(bounds);
    const plan = planField(bounds, settings);
    expect(plan.cell).toBe(0.125);
    const started = performance.now();
    const { timings: t } = buildField(mesh, plan, settings, () => performance.now());
    const afterField = performance.now();
    sealedDomains(exteriorMesh(mesh), ANALYSIS_CELL, MIN_SEALED_MM3);
    const finished = performance.now();
    stages.push(`| ${id} | ${plan.tile.nx * plan.tile.ny} | ${round(t.raster)} | ${round(t.dilate)} | ${round(t.draft)} | ${round(t.closing)} | ${round(t.cavities)} | ${round(finished - afterField)} | ${round(finished - started)} |`);
    expect(finished - started).toBeLessThan(5000);
  });

  it.each(EXAMPLE_IDS)('%s at 2 x 2, where composite and the wall check run too, also stays under 5 s', (id) => {
    const { mesh, bounds } = orientedExample(id);
    const settings = { ...defaultSettings(bounds), nx: 2, ny: 2 };
    const plan = planField(bounds, settings);
    const started = performance.now();
    const { timings: t } = buildField(mesh, plan, settings, () => performance.now());
    const total = performance.now() - started;
    grids.push(`| ${id} | ${plan.composite.nx * plan.composite.ny} | ${round(t.composite)} | ${round(t.draft)} | ${round(t.closing)} | ${round(t.cavities)} | ${round(t.wall)} | ${round(total)} |`);
    expect(total).toBeLessThan(5000);
  });

  // The plan's estimates at defaults are the one figure on this chain from outside this code. The
  // corner formula reproduces them within 2%, so what is left between them and the golden numbers is
  // what clipping saves, and the plan gave no figure for that.
  it.each(EXAMPLE_IDS)('%s: the corner formula gives the plan estimate within 2%, and clipping costs little and saves at most 5.5%', (id) => {
    const { mesh, bounds } = orientedExample(id);
    const settings = defaultSettings(bounds);
    const plan = planField(bounds, settings);
    const run = (raster: Field): number => {
      const field = dilate(raster, plan.rEff);
      applyDraft(field, settings.draftDeg);
      applyClosing(field, settings.closeWidth);
      return moldSilicone(mesh, plan, field, solidReport(id), settings).ml;
    };
    const t0 = performance.now();
    const clipped = rasterize(mesh, plan.tile);
    const t1 = performance.now();
    const corners = cornerRaster(mesh, plan.tile);
    const t2 = performance.now();
    const withClip = run(clipped), withCorners = run(corners);
    const saved = (withCorners - withClip) / withCorners;
    rasters.push(`| ${id} | ${round(t1 - t0)} | ${round(t2 - t1)} | ${withClip.toFixed(2)} | ${withCorners.toFixed(2)} | ${(saved * 100).toFixed(1)}% |`);
    const estimate = FIELD_GOLDEN[id].planEstimate;
    if (estimate !== null) within(withCorners, estimate, 0.02);
    expect(withClip).toBeLessThanOrEqual(withCorners);
    expect(saved).toBeLessThanOrEqual(0.055);
    // The cost that matters is against the 5 s budget, not against the formula.
    expect(t1 - t0).toBeLessThan(1000);
  });

  afterAll(() => {
    const tables = [
      ['One tile, in ms. Sealed air runs at the 0.25 mm analysis cell.', '', '| Model | Nodes | Raster | Dilate | Draft | Closing | Cavities | Sealed air | Total |', '|---|---|---|---|---|---|---|---|---|', ...stages],
      ['2 x 2 at auto spacing, in ms. Raster and dilate are per tile, so they are as above.', '', '| Model | Nodes | Composite | Draft | Closing | Cavities | Wall check | Total |', '|---|---|---|---|---|---|---|---|', ...grids],
      ['Raster choice: clipping each triangle to each cell against the plan formula, in ms and ml. Clipping was chosen: it stays far inside the budget, needs no special case for vertical triangles, and lowers silicone with no loss of clearance, since the margin proof needs only an upper bound on what is inside the cell.', '', '| Model | Clip ms | Corner ms | Clip ml | Corner ml | Saved |', '|---|---|---|---|---|---|', ...rasters],
    ];
    const text = tables.map((lines) => lines.join('\n')).join('\n\n');
    console.log(text);
    if (process.env.CFG_RECORD !== '1') return;
    recordSection('Field stages', `Node on the server, plan defaults at cell 0.125 mm. Written by \`scripts/ci.sh --record\`.\n\n${text}`);
  });
});
