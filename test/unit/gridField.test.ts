import { describe, expect, it } from 'vitest';
import { buildField, conditionField } from '../../src/core/field/build';
import { countCavities, tileWalls } from '../../src/core/field/cavities';
import { compositeTiles, NO_OWNER } from '../../src/core/field/composite';
import { dilate } from '../../src/core/field/dilate';
import { emptyField, fieldSettings, NODE_CAP, planField, type Field, type FieldSettings } from '../../src/core/field/grid';
import { rasterize } from '../../src/core/field/raster';
import { siliconeVolume, volumeAbovePlane } from '../../src/core/field/silicone';
import { meshBounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { axisRotation, box, inverted, join, rotated, signedVolume } from '../fixtures/synthetic';

const blockMesh = box([0, 0, 0], [20, 10, 8]);
const bounds = meshBounds(blockMesh.positions);

function settings(overrides: Partial<FieldSettings> = {}): FieldSettings {
  return { ...fieldSettings(defaultParams(), bounds), ...overrides };
}

describe('G4 margin', () => {
  it('gives the plan default of 3.366 and a raise of 0.05', () => {
    const plan = planField(bounds, settings());
    expect(plan.rEff).toBeCloseTo(3.366, 3);
    expect(plan.raise).toBe(0.05);
    expect(plan.hMax).toBeCloseTo(8 + 3.36625 + 0.05, 9);
  });

  it('follows t, the export cell and the print margin, and a preview keeps the export radius', () => {
    expect(planField(bounds, settings({ t: 5, printMargin: 0.15 })).rEff).toBeCloseTo(5 + 2.13 * 0.125 + 0.15, 9);
    expect(planField(bounds, settings({ cellFinal: 0.25 })).rEff).toBeCloseTo(3 + 2.13 * 0.25 + 0.1, 9);
    expect(planField(bounds, settings({ cell: 0.5 })).rEff).toBeCloseTo(3.36625, 9);
  });

  it('with the margin off is the bare formula', () => {
    const plan = planField(bounds, settings({ margin: false }));
    expect(plan.rEff).toBe(3);
    expect(plan.raise).toBe(0);
  });
});

describe('G6 plan', () => {
  it('snaps the pitch to whole export cells, never below what was typed', () => {
    for (const spacing of [0, 1, 7.31, 10, 33.333]) {
      const plan = planField(bounds, settings({ nx: 3, ny: 2, spacing }));
      for (const [pitch, size] of [[plan.pitchXmm, 20], [plan.pitchYmm, 10]]) {
        expect(Number.isInteger(pitch / 0.125)).toBe(true);
        expect(pitch).toBeGreaterThanOrEqual(size + spacing);
        expect(pitch - size - spacing).toBeLessThan(0.125);
      }
      expect(plan.pitchX).toBe(plan.pitchXmm / 0.125);
    }
  });

  it('keeps a typed spacing that is already whole cells exactly', () => {
    const plan = planField(bounds, settings({ nx: 2, spacing: 5 }));
    expect(plan.pitchXmm).toBe(25);
  });

  it('auto spacing follows the plan rule, plus the 3 cells of rounding that keep it safe', () => {
    const plan = planField(bounds, settings({ nx: 2 }));
    const expected = 2 * 3.36625 + 2 * plan.hMax * Math.tan(Math.PI / 180) + 2 + 3 * 0.125;
    expect(plan.autoSpacing).toBeCloseTo(expected, 9);
    expect(plan.spacing).toBe(plan.autoSpacing);
    // A wider nozzle needs a wider wall.
    const wide = planField(bounds, settings({ nx: 2, nozzle: 0.6 }));
    expect(wide.requiredWall).toBeCloseTo(2.4, 9);
    expect(wide.autoSpacing).toBeGreaterThan(plan.autoSpacing);
  });

  it('auto spacing widens the wall only once closing would otherwise fill it', () => {
    const plan = planField(bounds, settings({ nx: 2 }));
    // At 1.2 mm the element spans 1.25 mm, under the 2 mm wall.
    expect(planField(bounds, settings({ nx: 2, closeWidth: 0 })).autoSpacing).toBeCloseTo(plan.autoSpacing, 9);
    // At 3 mm it spans 3 mm, so the wall aims for that plus a cell: 1.125 mm more than the 2 mm wall.
    expect(planField(bounds, settings({ nx: 2, closeWidth: 3 })).autoSpacing).toBeCloseTo(plan.autoSpacing + 1.125, 9);
    // At 2.2 mm a preview's own element would span 3 mm, but it keeps the export's rule: 2.25 mm plus a cell.
    expect(planField(bounds, settings({ nx: 2, closeWidth: 2.2 })).autoSpacing).toBeCloseTo(plan.autoSpacing + 0.375, 9);
    expect(planField(bounds, settings({ nx: 2, closeWidth: 2.2, cell: 0.5 })).autoSpacing).toBeCloseTo(plan.autoSpacing + 0.375, 9);
  });

  it('a preview field reports the pitch it really uses, never below the export pitch', () => {
    for (const spacing of [0, 5, 7.31, 12.3, null]) {
      const grid = { nx: 3, ny: 2, spacing };
      const finished = planField(bounds, settings(grid));
      const preview = planField(bounds, settings({ ...grid, cell: 0.5 }));
      expect(finished.pitchX * 0.125).toBe(finished.pitchXmm);
      expect(finished.pitchY * 0.125).toBe(finished.pitchYmm);
      expect(preview.pitchX * 0.5).toBe(preview.pitchXmm);
      expect(preview.pitchY * 0.5).toBe(preview.pitchYmm);
      for (const [wide, narrow] of [[preview.pitchXmm, finished.pitchXmm], [preview.pitchYmm, finished.pitchYmm]]) {
        expect(wide).toBeGreaterThanOrEqual(narrow);
        expect(wide - narrow).toBeLessThan(0.5);
      }
    }
  });

  it('a preview composite puts its tiles where its plan says, so parts placed from the plan line up', () => {
    // Spacing 7.31 makes the export pitch 27.375, which no whole number of 0.5 mm cells reaches.
    const s = settings({ nx: 3, ny: 2, spacing: 7.31, cell: 0.5, draftDeg: 0, closeWidth: 0 });
    const plan = planField(bounds, s);
    expect(planField(bounds, { ...s, cell: 0.125 }).pitchXmm).toBe(27.375);
    expect(plan.pitchXmm).toBe(27.5);
    const { field } = compositeTiles(dilate(rasterize(blockMesh, plan.tile), plan.rEff), plan);
    const copies: WeldedMesh[] = [];
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        copies.push(box([tx * plan.pitchXmm, ty * plan.pitchYmm, 0], [20 + tx * plan.pitchXmm, 10 + ty * plan.pitchYmm, 8]));
      }
    }
    const independent = dilate(rasterize(join(...copies), plan.composite), plan.rEff);
    let worst = 0;
    for (let n = 0; n < field.values.length; n++) worst = Math.max(worst, Math.abs(field.values[n] - independent.values[n]));
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('pads the domain so draft and closing fit, at any draft', () => {
    for (const draftDeg of [0, 1, 5]) {
      const s = settings({ draftDeg });
      const plan = planField(bounds, s);
      const built = buildField(blockMesh, plan, s);
      const { nx, ny, values } = built.field;
      for (let x = 0; x < nx; x++) expect(values[x]).toBe(0);
      for (let x = 0; x < nx; x++) expect(values[x + (ny - 1) * nx]).toBe(0);
      for (let y = 0; y < ny; y++) expect(values[y * nx]).toBe(0);
      for (let y = 0; y < ny; y++) expect(values[nx - 1 + y * nx]).toBe(0);
    }
  });

  it('pads a tall model at the steepest draft enough to keep all of its widening', () => {
    // The draft loop never writes the outer ring, so a ring of zeros cannot show that a wall was cut
    // off. Only a run with far more room can: at 100 mm and 5 degrees it would lose about 30%.
    const tall = box([0, 0, 0], [20, 10, 100]);
    const tallBounds = meshBounds(tall.positions);
    const s = { ...fieldSettings(defaultParams(), tallBounds), draftDeg: 5 };
    const plan = planField(tallBounds, s);
    const extra = 120;
    const tile = { ...plan.tile, nx: plan.tile.nx + 2 * extra, ny: plan.tile.ny + 2 * extra, x0: plan.tile.x0 - extra * plan.cell, y0: plan.tile.y0 - extra * plan.cell };
    const total = (field: Field): number => field.values.reduce((sum, v) => sum + v, 0);
    const padded = total(buildField(tall, plan, s).field);
    const roomy = total(buildField(tall, { ...plan, tile }, s).field);
    expect(padded).toBeGreaterThan(0);
    expect(Math.abs(padded - roomy) / roomy).toBeLessThanOrEqual(1e-6);
  });

  it('raises the cell above the node cap, with a warning, and stays within the cap', () => {
    const big = { min: [0, 0, 0] as [number, number, number], max: [100, 100, 50] as [number, number, number] };
    const plain = planField(big, fieldSettings(defaultParams(), big));
    expect(plain.diagnostics).toEqual([]);
    const s = { ...fieldSettings(defaultParams(), big), nx: 8, ny: 8, spacing: 10 };
    const plan = planField(big, s);
    expect(plan.composite.nx * plan.composite.ny).toBeLessThanOrEqual(NODE_CAP);
    expect(plan.cell).toBeGreaterThan(0.125);
    expect(plan.diagnostics.map((d) => d.code)).toEqual(['cell-raised']);
    expect(plan.diagnostics[0].message).toContain(String(plan.cell));
    // The pitch and margin follow the raised cell, so the guarantee is for the cell in use.
    expect(plan.rEff).toBeCloseTo(3 + 2.13 * plan.cell + 0.1, 9);
    expect(Number.isInteger(Math.round((plan.pitchXmm / plan.cell) * 1e6) / 1e6)).toBe(true);
  });
});

describe('composite', () => {
  const s = settings({ nx: 2, ny: 3, spacing: 4, draftDeg: 0, closeWidth: 0 });
  const plan = planField(bounds, s);
  const tile = dilate(rasterize(blockMesh, plan.tile), plan.rEff);

  it('hands back the tile for a single model, with no copy', () => {
    const one = settings();
    const single = planField(bounds, one);
    const t = emptyField(single.tile);
    const { field, owners } = compositeTiles(t, single);
    expect(field).toBe(t);
    expect(owners).toBeNull();
  });

  it('conditioning leaves the tile alone, so a lower draft starts from it and not from the last run', () => {
    const one = settings();
    const single = planField(bounds, one);
    const t = dilate(rasterize(blockMesh, single.tile), single.rEff);
    const before = t.values.slice();
    const { field: composite } = compositeTiles(t, single);
    const steep = conditionField(composite, { draftDeg: 3, closeWidth: 1.2 }).field;
    expect(t.values).toEqual(before);
    const gentle = conditionField(composite, { draftDeg: 1, closeWidth: 1.2 }).field;
    expect(t.values).toEqual(before);
    expect(gentle.values).toEqual(buildField(blockMesh, single, { ...one, draftDeg: 1 }).field.values);
    const total = (field: Field): number => field.values.reduce((sum, v) => sum + v, 0);
    expect(total(gentle)).toBeLessThan(total(steep));
  });

  it('conditioning leaves a real composite alone as well', () => {
    const { field: composite } = compositeTiles(tile, plan);
    const before = composite.values.slice();
    const { field } = conditionField(composite, { draftDeg: 3, closeWidth: 1.2 });
    expect(composite.values).toEqual(before);
    expect(field.values).not.toEqual(before);
  });

  it('equals evaluating every copy of the model on the whole domain', () => {
    const { field } = compositeTiles(tile, plan);
    const copies: WeldedMesh[] = [];
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        copies.push(box([tx * plan.pitchXmm, ty * plan.pitchYmm, 0], [20 + tx * plan.pitchXmm, 10 + ty * plan.pitchYmm, 8]));
      }
    }
    const independent = dilate(rasterize(join(...copies), plan.composite), plan.rEff);
    expect(independent.values.length).toBe(field.values.length);
    let worst = 0;
    for (let n = 0; n < field.values.length; n++) worst = Math.max(worst, Math.abs(field.values[n] - independent.values[n]));
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('says which tile owns each node, with no owner outside any cavity', () => {
    const { field, owners } = compositeTiles(tile, plan);
    const at = (x: number, y: number): number => Math.round((x - field.x0) / field.cell) + Math.round((y - field.y0) / field.cell) * field.nx;
    expect(owners![at(10, 5)]).toBe(0);
    expect(owners![at(10 + plan.pitchXmm, 5)]).toBe(1);
    expect(owners![at(10, 5 + plan.pitchYmm)]).toBe(2);
    expect(owners![at(10 + plan.pitchXmm, 5 + 2 * plan.pitchYmm)]).toBe(5);
    expect(owners![0]).toBe(NO_OWNER);
  });

  it('counts a model once per tile', () => {
    // Far enough apart that the tiles do not overlap, unlike the spacing above.
    const apart = planField(bounds, settings({ nx: 2, ny: 3, spacing: 10, draftDeg: 0, closeWidth: 0 }));
    const { field } = compositeTiles(tile, apart);
    const one = siliconeVolume(tile, { exteriorVolume: 1600, tiles: 1, sealedAir: 0, raise: 0 });
    const six = siliconeVolume(field, { exteriorVolume: 1600, tiles: 6, sealedAir: 0, raise: 0 });
    expect(six.ml).toBeCloseTo(6 * one.ml, 6);
    expect(six.area).toBeCloseTo(6 * one.area, 6);
  });

  it('merges into one cavity at spacing 0, and stays separate with room', () => {
    const run = (spacing: number): number => {
      const grid = settings({ nx: 3, ny: 2, spacing });
      return buildField(blockMesh, planField(bounds, grid), grid).cavities.count;
    };
    expect(run(0)).toBe(1);
    expect(run(20)).toBe(6);
  });
});

describe('cavities', () => {
  const grid = { nx: 12, ny: 10, cell: 0.5, x0: 0, y0: 0 };
  const field = (cells: [number, number][]): Field => {
    const f = emptyField(grid);
    for (const [x, y] of cells) f.values[x + y * grid.nx] = 3;
    return f;
  };

  it('counts connected parts of H > 0, with their areas', () => {
    const result = countCavities(field([[1, 1], [2, 1], [2, 2], [8, 8], [9, 8]]));
    expect(result.count).toBe(2);
    expect(result.areas).toEqual([0.75, 0.5]);
  });

  it('joins parts that meet only through a later row, whichever way round', () => {
    const u = field([[1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [6, 1], [6, 2], [6, 3], [7, 3], [8, 3], [8, 2], [8, 1], [8, 4], [8, 5], [6, 5], [7, 5]]);
    expect(countCavities(u).count).toBe(2);
    const twoRuns = field([[1, 1], [3, 1], [1, 2], [2, 2], [3, 2]]);
    expect(countCavities(twoRuns).count).toBe(1);
  });

  it('does not join cells that touch only at a corner, along either diagonal', () => {
    expect(countCavities(field([[1, 1], [2, 2]])).count).toBe(2);
    expect(countCavities(field([[2, 1], [1, 2]])).count).toBe(2);
  });

  it('is 0 on an empty field', () => {
    expect(countCavities(emptyField(grid)).count).toBe(0);
  });
});

describe('minimum wall between tiles', () => {
  /** Two 8 mm tall blocks in a row, a known distance apart once dilated. */
  const pair = (spacing: number, draftDeg = 0, closeWidth = 0): ReturnType<typeof buildField> & { rEff: number; pitch: number } => {
    const s = settings({ nx: 2, spacing, draftDeg, closeWidth });
    const plan = planField(bounds, s);
    return { ...buildField(blockMesh, plan, s), rEff: plan.rEff, pitch: plan.pitchXmm };
  };

  it('reads the wall between two blocks, within the 3 cells of rounding', () => {
    const { minWall, rEff } = pair(10);
    const nominal = 10 - 2 * rEff;
    expect(minWall).toBeLessThanOrEqual(nominal + 0.125);
    expect(minWall).toBeGreaterThanOrEqual(nominal - 3 * 0.125);
  });

  it('reads a wall between rows the same way as one between columns', () => {
    const s = settings({ ny: 2, spacing: 10, draftDeg: 0, closeWidth: 0 });
    const { minWall } = buildField(blockMesh, planField(bounds, s), s);
    const nominal = 10 - 2 * planField(bounds, s).rEff;
    expect(minWall).toBeLessThanOrEqual(nominal + 0.125);
    expect(minWall).toBeGreaterThanOrEqual(nominal - 3 * 0.125);
  });

  it('a ledge on the way down to a wall is not a wall', () => {
    const f = emptyField({ nx: 30, ny: 3, cell: 0.5, x0: 0, y0: 0 });
    const owners = new Uint16Array(f.values.length).fill(NO_OWNER);
    const set = (from: number, to: number, value: number, owner: number): void => {
      for (let x = from; x <= to; x++) {
        f.values[x + 30] = value;
        owners[x + 30] = owner;
      }
    };
    set(2, 6, 9, 0);
    // One step down with no plastic at all, then the real wall of nodes 10 to 15, then tile 1.
    set(7, 9, 4, 0);
    set(16, 25, 9, 1);
    expect(tileWalls(f, owners)).toEqual({ minWall: 2.5, merged: false });
  });

  it('warns below 2 lines plus margin and names the spacing that fixes it', () => {
    const thin = pair(8);
    expect(thin.minWall).toBeLessThan(2);
    expect(thin.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
    expect(thin.diagnostics[0].message).toContain(thin.minWall!.toFixed(2));
    const plan = planField(bounds, settings({ nx: 2, spacing: 8, draftDeg: 0, closeWidth: 0 }));
    expect(thin.diagnostics[0].message).toContain(plan.autoSpacing.toFixed(1));
    expect(pair(12).diagnostics).toEqual([]);
  });

  it('draft thins the wall, and the auto rule pays for that', () => {
    expect(pair(10, 3).minWall!).toBeLessThan(pair(10, 0).minWall! - 2 * 8 * Math.tan((3 * Math.PI) / 180) + 0.3);
    const s = settings({ nx: 2, draftDeg: 3 });
    expect(buildField(blockMesh, planField(bounds, s), s).diagnostics).toEqual([]);
  });

  it('auto spacing passes on tall blocks at any draft and cell, as rounding is paid for', () => {
    let seed = 7;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    // Blocks are the hard case: their full height stands right at the bounding box. Draft 0 and no
    // closing take away the slack draft otherwise leaves, and these sizes hit every rounding.
    for (const [cell, draftDeg, closeWidth] of [[0.125, 1, 1.2], [0.125, 0, 0], [0.25, 0, 0], [0.1, 0.5, 1.2], [0.5, 2, 1.2]]) {
      for (let k = 0; k < 12; k++) {
        const mesh = box([next() * 3, next() * 3, 0], [8 + next() * 20, 8 + next() * 20, 5 + next() * 60]);
        const b = meshBounds(mesh.positions);
        const s = { ...fieldSettings(defaultParams(), b, cell), cellFinal: cell, draftDeg, closeWidth, nx: 2, ny: 2, spacing: null };
        const plan = planField(b, s);
        const built = buildField(mesh, plan, s);
        expect(built.minWall, `cell ${cell}, draft ${draftDeg}, block ${k}`).toBeGreaterThanOrEqual(plan.requiredWall);
        expect(built.diagnostics).toEqual([]);
      }
    }
  });

  it('auto spacing keeps the tiles apart at any closeWidth, where closing would fill a thinner wall', () => {
    for (const closeWidth of [0, 1.2, 2.5, 3, 5]) {
      const s = settings({ nx: 2, ny: 2, closeWidth });
      const plan = planField(bounds, s);
      const built = buildField(blockMesh, plan, s);
      const name = `closeWidth ${closeWidth}`;
      expect(built.cavities.count, name).toBe(4);
      expect(built.tilesMerged, name).toBe(false);
      expect(built.minWall!, name).toBeGreaterThanOrEqual(Math.max(plan.requiredWall, closeWidth));
      expect(built.diagnostics, name).toEqual([]);
    }
  });

  it('auto spacing keeps the tiles apart in a preview too', () => {
    let seed = 11;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (const cell of [0.25, 0.5, 1]) {
      for (let k = 0; k < 12; k++) {
        const mesh = box([next() * 3, next() * 3, 0], [8 + next() * 20, 8 + next() * 20, 5 + next() * 60]);
        const b = meshBounds(mesh.positions);
        const s = { ...fieldSettings(defaultParams(), b, cell), nx: 2, ny: 2, spacing: null };
        const built = buildField(mesh, planField(b, s), s);
        expect(built.cavities.count, `cell ${cell}, block ${k}`).toBe(4);
        expect(built.diagnostics, `cell ${cell}, block ${k}`).toEqual([]);
      }
    }
  });

  it('a fin on merged cavities is not a wall: closing fills the wall, and the warning says they joined', () => {
    const open = pair(7.5);
    expect(open.minWall).toBeLessThan(1.25);
    expect(open.cavities.count).toBe(2);
    expect(open.tilesMerged).toBe(false);
    expect(open.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
    // The middle of the wall goes and the cavities join. Wedges of plastic stay at the blocks' round
    // corners, at the element's width, and they separate nothing.
    const closed = pair(7.5, 0, 1.2);
    expect(closed.cavities.count).toBe(1);
    expect(closed.tilesMerged).toBe(true);
    expect(closed.minWall).toBeNull();
    expect(closed.diagnostics.map((d) => d.code)).toEqual(['tiles-merged']);
    expect(closed.diagnostics[0].message).toContain('join');
    const plan = planField(bounds, settings({ nx: 2, spacing: 7.5, draftDeg: 0, closeWidth: 1.2 }));
    expect(closed.diagnostics[0].message).toContain(plan.autoSpacing.toFixed(1));
    expect(closed.diagnostics[0].message).not.toContain('wall of');
  });

  it('warns of a merge at any closeWidth, where a wall reading would look wide enough', () => {
    for (const closeWidth of [1.2, 2, 3, 5]) {
      const built = pair(7.5, 0, closeWidth);
      expect(built.cavities.count, `closeWidth ${closeWidth}`).toBe(1);
      expect(built.minWall, `closeWidth ${closeWidth}`).toBeNull();
      expect(built.diagnostics.map((d) => d.code), `closeWidth ${closeWidth}`).toEqual(['tiles-merged']);
    }
  });

  it('warns of a merge where tiles simply overlap', () => {
    const built = pair(0);
    expect(built.cavities.count).toBe(1);
    expect(built.tilesMerged).toBe(true);
    expect(built.diagnostics.map((d) => d.code)).toEqual(['tiles-merged']);
  });

  it('reports a merge and a thin wall together when each is somewhere in the grid', () => {
    const f = emptyField({ nx: 30, ny: 3, cell: 0.5, x0: 0, y0: 0 });
    const owners = new Uint16Array(f.values.length).fill(NO_OWNER);
    const set = (from: number, to: number, owner: number): void => {
      for (let x = from; x <= to; x++) {
        f.values[x + 30] = 9;
        owners[x + 30] = owner;
      }
    };
    // Tiles 0 and 1 touch, then a 1 mm wall from first to last node, then tile 2.
    set(2, 8, 0);
    set(9, 14, 1);
    set(18, 25, 2);
    expect(tileWalls(f, owners)).toEqual({ minWall: 1, merged: true });
  });

  it('a line through a sliver of raised nodes does not borrow a tile from across the plastic', () => {
    // Conditioning raised nodes 9 and 10, so they have no tile. On this line nothing says which they
    // belong to, and the tiles at either end are on the far side of plastic, so it reads no wall.
    const f = emptyField({ nx: 30, ny: 3, cell: 0.5, x0: 0, y0: 0 });
    const owners = new Uint16Array(f.values.length).fill(NO_OWNER);
    const set = (from: number, to: number, owner: number): void => {
      for (let x = from; x <= to; x++) {
        f.values[x + 30] = 9;
        owners[x + 30] = owner;
      }
    };
    set(2, 6, 0);
    set(9, 10, NO_OWNER);
    set(14, 20, 1);
    expect(tileWalls(f, owners)).toEqual({ minWall: null, merged: false });
  });

  it('a tile\'s own fin stays out of it, even once one of its cavities has joined the next tile', () => {
    // Tile 0 has cavities at 2 to 6 and from 10, and that second one runs on into tile 1, as does a third.
    const f = emptyField({ nx: 40, ny: 3, cell: 0.5, x0: 0, y0: 0 });
    const owners = new Uint16Array(f.values.length).fill(NO_OWNER);
    const set = (from: number, to: number, owner: number): void => {
      for (let x = from; x <= to; x++) {
        f.values[x + 40] = 9;
        owners[x + 40] = owner;
      }
    };
    set(2, 6, 0);
    set(10, 15, 0);
    set(16, 22, 1);
    set(25, 30, 1);
    expect(tileWalls(f, owners)).toEqual({ minWall: null, merged: true });
  });

  it('a model\'s own fin is not a wall between tiles, however thin', () => {
    // Two towers on a shared low plinth, with a narrow slot between them. Each pair is one tile.
    const twin = join(box([0, 0, 0], [8, 10, 30]), box([8, 0, 0], [14, 10, 2]), box([14, 0, 0], [22, 10, 30]));
    const twinBounds = meshBounds(twin.positions);
    const s = { ...fieldSettings(defaultParams(), twinBounds), t: 2.5, printMargin: 0, draftDeg: 0, closeWidth: 0, nx: 2, spacing: 20 };
    const plan = planField(twinBounds, s);
    const built = buildField(twin, plan, s);
    // The slot is left with a plastic fin 6 - 2 r wide, and that is not reported.
    expect(built.minWall).toBeGreaterThan(10);
    expect(built.tilesMerged).toBe(false);
    expect(built.diagnostics).toEqual([]);
  });

  describe('at an angle', () => {
    /** Prism over a counter-clockwise outline, standing on z=0. */
    function prism(outline: [number, number][], height: number): WeldedMesh {
      const positions = outline.flatMap(([x, y]) => [x, y, 0]).concat(outline.flatMap(([x, y]) => [x, y, height]));
      const n = outline.length;
      const indices: number[] = [];
      for (let k = 1; k + 1 < n; k++) indices.push(0, k + 1, k, n, n + k, n + k + 1);
      for (let k = 0; k < n; k++) {
        const next = (k + 1) % n;
        indices.push(k, next, n + next, k, n + next, n + k);
      }
      return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    }

    /**
     * The wall as a straight measurement gives it: closest cavity nodes of the two tiles, without the
     * cell each loses to the first plastic node. Slow and exact, so it can referee the line scans.
     */
    function trueWall(field: Field): number {
      const { nx, ny, cell, values } = field;
      const side = new Int8Array(values.length);
      let seeds = 0;
      for (let start = 0; start < values.length; start++) {
        if (values[start] <= 0 || side[start] !== 0) continue;
        seeds++;
        const stack = [start];
        side[start] = seeds;
        while (stack.length > 0) {
          const at = stack.pop()!;
          for (const next of [at - 1, at + 1, at - nx, at + nx]) {
            if (next >= 0 && next < values.length && values[next] > 0 && side[next] === 0) {
              side[next] = seeds;
              stack.push(next);
            }
          }
        }
      }
      expect(seeds).toBe(2);
      const edges: [number[], number[]] = [[], []];
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const n = x + y * nx;
          if (values[n] > 0 && (values[n - 1] <= 0 || values[n + 1] <= 0 || values[n - nx] <= 0 || values[n + nx] <= 0)) edges[side[n] - 1].push(x, y);
        }
      }
      let closest = Infinity;
      for (let a = 0; a < edges[0].length; a += 2) {
        for (let b = 0; b < edges[1].length; b += 2) {
          const d = (edges[0][a] - edges[1][b]) ** 2 + (edges[0][a + 1] - edges[1][b + 1]) ** 2;
          if (d < closest) closest = d;
        }
      }
      return (Math.sqrt(closest) - 2) * cell;
    }

    const run = (mesh: WeldedMesh, overrides: Partial<FieldSettings>): ReturnType<typeof buildField> => {
      const b = meshBounds(mesh.positions);
      const s = { ...fieldSettings(defaultParams(), b), nx: 2, ...overrides };
      return buildField(mesh, planField(b, s), s);
    };

    // Rows and columns read 2.6 mm here where the wall is 1.8. Each turn and layout needs its own set of
    // diagonal lines: one direction, starting from the top edge or the side edge of the domain.
    it.each([[45, 2, 1], [-45, 2, 1], [45, 1, 2], [-45, 1, 2]])('warns of a rectangle turned %s degrees, %i x %i, by its true width', (degrees, nx, ny) => {
      const built = run(rotated(box([0, 0, 0], [30, 20, 10]), axisRotation([0, 0, 1], degrees)), { nx, ny, spacing: 6 });
      expect(built.cavities.count).toBe(2);
      expect(built.minWall).toBeGreaterThan(1.6);
      expect(built.minWall).toBeLessThan(1.9);
      expect(built.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
    });

    it('warns of parallel faces at 45 degrees, with and without conditioning', () => {
      const slanted = prism([[0, 0], [10, 0], [16.57, 6.57], [6.57, 6.57]], 6);
      const drafted = run(slanted, { spacing: 5.9 });
      expect(drafted.cavities.count).toBe(2);
      expect(drafted.minWall).toBeLessThan(2);
      expect(drafted.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
      const bare = run(slanted, { spacing: 5.4, draftDeg: 0, closeWidth: 0 });
      expect(bare.cavities.count).toBe(2);
      expect(bare.minWall).toBeLessThan(2);
      expect(bare.diagnostics.map((d) => d.code)).toEqual(['thin-tile-wall']);
    });

    // Pins what is left of the over-read: 8% on parallel faces, and most between rounded corners, as at
    // 40 degrees. Rows and columns alone read up to 48% wide here, so this fails without the diagonals.
    it.each([0, 10, 22.5, 30, 40, 45, 60, 67.5, 80])('reads a wall at %s degrees within 16% wide and a cell thin', (degrees) => {
      const built = run(rotated(box([0, 0, 0], [30, 20, 10]), axisRotation([0, 0, 1], degrees)), { spacing: 10 });
      const exact = trueWall(built.field);
      expect(built.minWall!).toBeLessThanOrEqual(exact * 1.16);
      expect(built.minWall!).toBeGreaterThanOrEqual(exact - 0.125);
    });
  });

  it('is null for one tile', () => {
    const one = settings();
    expect(buildField(blockMesh, planField(bounds, one), one).minWall).toBeNull();
  });

  it('a wall between tiles is found even when a line crosses other cavities first', () => {
    const f = emptyField({ nx: 30, ny: 3, cell: 0.5, x0: 0, y0: 0 });
    const owners = new Uint16Array(f.values.length).fill(NO_OWNER);
    const set = (from: number, to: number, value: number, owner: number): void => {
      for (let x = from; x <= to; x++) {
        f.values[x + 30] = value;
        owners[x + 30] = owner;
      }
    };
    set(2, 6, 9, 0);
    // Tile 0's own valley: 2 nodes, not a tile wall.
    set(9, 12, 9, 0);
    set(18, 25, 9, 1);
    // Between tiles: nodes 13 to 17 are plastic, a 2 mm wall from first to last node.
    expect(tileWalls(f, owners)).toEqual({ minWall: 2, merged: false });
  });
});

describe('volume above the plane', () => {
  it('is the signed volume when nothing is below', () => {
    const solid = box([1, 2, 0], [11, 7, 3]);
    expect(volumeAbovePlane(solid)).toBeCloseTo(signedVolume(solid), 6);
  });

  it('leaves out what lies below, including a whole shell', () => {
    expect(volumeAbovePlane(box([0, 0, -2], [10, 10, 3]))).toBeCloseTo(300, 6);
    expect(volumeAbovePlane(box([0, 0, -5], [10, 10, -1]))).toBe(0);
    expect(volumeAbovePlane(join(box([0, 0, 0], [10, 10, 3]), box([20, 0, -6], [24, 4, -1])))).toBeCloseTo(300, 6);
  });

  it('cuts through slanted faces: half of a cube turned 45 degrees about its centre', () => {
    const cube = rotated(box([-5, -5, -5], [5, 5, 5]), axisRotation([1, 0, 0], 45));
    expect(volumeAbovePlane(cube)).toBeCloseTo(500, 3);
  });

  it('takes a void off, with the winding telling which is which', () => {
    const hollow = join(box([0, 0, 0], [20, 20, 20]), inverted(box([5, 5, 5], [15, 15, 15])));
    expect(volumeAbovePlane(hollow)).toBeCloseTo(7000, 6);
  });

  it('needs no cap at z = 0, so an open mesh lacking only its flat base still reads true', () => {
    const solid = box([0, 0, 0], [10, 10, 3]);
    const { positions, indices } = solid;
    const kept: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      if (positions[indices[t] * 3 + 2] === 0 && positions[indices[t + 1] * 3 + 2] === 0 && positions[indices[t + 2] * 3 + 2] === 0) continue;
      kept.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    expect(kept.length).toBeLessThan(indices.length);
    expect(volumeAbovePlane({ positions, indices: Uint32Array.from(kept) })).toBeCloseTo(300, 6);
  });
});

describe('silicone volume', () => {
  it('is the integral under H, less the model and sealed air, plus the raise', () => {
    const f = emptyField({ nx: 4, ny: 1, cell: 0.5, x0: 0, y0: 0 });
    f.values.set([0, 2, 4, 0]);
    const cellArea = 0.25;
    const volume = siliconeVolume(f, { exteriorVolume: 0.5, tiles: 1, sealedAir: 0.1, raise: 0.05 });
    expect(volume.integral).toBeCloseTo((2 + 4 + 2 * 0.05) * cellArea, 9);
    expect(volume.area).toBeCloseTo(2 * cellArea, 9);
    expect(volume.ml).toBeCloseTo(((2 + 4 + 0.1) * cellArea - 0.6) / 1000, 9);
    const doubled = siliconeVolume(f, { exteriorVolume: 0.5, tiles: 2, sealedAir: 0.1, raise: 0 });
    expect(doubled.ml).toBeCloseTo(((6 * cellArea) - 1.2) / 1000, 9);
  });
});
