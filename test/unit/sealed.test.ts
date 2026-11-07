import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { countBodies, exteriorMesh, sealedDomains } from '../../src/core/field/sealed';
import { cupAir } from '../fixtures/fieldOracles';
import { loadManifold } from '../fixtures/loadExamples';
import { axisRotation, box, cup, hollowCone, holedBlock, inverted, invertedCup, join, notchedBlock, recessedBlock, ring, rotated, signedVolume, ventedInvertedCup } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const CELL = 0.25;
const NO_FILTER = 0;

describe('sealed air', () => {
  it('finds the inside of an inverted cup, standing on the plane, at 130.5 ml within 3%', () => {
    const domains = sealedDomains(invertedCup(api), CELL, 50);
    expect(domains).toHaveLength(1);
    expect(domains[0].onPlane).toBe(true);
    expect(cupAir()).toBeCloseTo(130.5, 1);
    expect(Math.abs(domains[0].volume / 1000 - 130.5)).toBeLessThanOrEqual(130.5 * 0.03);
    expect(domains[0].max[2]).toBeCloseTo(57, 1);
  });

  it('finds none in the upright cup, whose inside is open to the top', () => {
    expect(sealedDomains(cup(api), CELL, NO_FILTER)).toEqual([]);
  });

  it('a hole in the inverted cup wall opens it: a 2D look at the footprint alone would say sealed', () => {
    expect(sealedDomains(ventedInvertedCup(api, 6), CELL, 50)).toEqual([]);
  });

  it('a horizontal hole through a block is open at both ends', () => {
    expect(sealedDomains(holedBlock(api), CELL, NO_FILTER)).toEqual([]);
  });

  it('a recess under a block is sealed by the plate, and a recess running out the side is not', () => {
    const sealed = sealedDomains(recessedBlock(api, 2), CELL, NO_FILTER);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].onPlane).toBe(true);
    expect(Math.abs(sealed[0].volume - 10 * 10 * 2)).toBeLessThanOrEqual(200 * 0.03);
    expect(sealedDomains(notchedBlock(api, 2), CELL, NO_FILTER)).toEqual([]);
  });

  it('a recess running out through any side is open, whichever way the model faces', () => {
    const notched = notchedBlock(api, 2);
    for (const degrees of [0, 90, 180, 270]) {
      expect(sealedDomains(rotated(notched, axisRotation([0, 0, 1], degrees)), CELL, NO_FILTER), `${degrees} degrees`).toEqual([]);
    }
  });

  it('a steep wall does not leak: neighbouring columns overlap by less than a cell across it', () => {
    // Slope 5 and a wall 1.2 mm thick measured upward, so columns one cell apart either side of the
    // wall overlap by up to 5 * 0.25 - 1.2 = 0.05 mm. Open space must not join through that.
    const domains = sealedDomains(hollowCone(api, 100, 20, 1.2), CELL, 50);
    expect(domains).toHaveLength(1);
    const inner = 20 - 1.2 / 5;
    const expected = (Math.PI * inner * inner * (100 - 1.2)) / 3;
    expect(Math.abs(domains[0].volume - expected)).toBeLessThanOrEqual(expected * 0.03);
  });

  it('a column exactly on a triangle edge counts that surface once, even with chambers stacked', () => {
    // Columns stand at odd multiples of 0.125 here, so these walls and every box diagonal run right
    // through them. A hit missed or doubled at any edge would lose the chamber above it in that column.
    const low = 5.125, high = 14.875;
    const mesh = join(box([0, 0, 0], [20, 20, 20]), inverted(box([low, low, 0], [high, high, 4])), inverted(box([low, low, 8], [high, high, 12])));
    // The same triangles starting from each corner, so each edge takes each role in the test.
    for (const turn of [0, 1, 2]) {
      const indices = mesh.indices.slice();
      for (let t = 0; t < indices.length; t += 3) {
        for (let c = 0; c < 3; c++) indices[t + c] = mesh.indices[t + ((c + turn) % 3)];
      }
      const domains = sealedDomains({ positions: mesh.positions, indices }, CELL, NO_FILTER);
      expect(domains.map((d) => d.onPlane).sort()).toEqual([false, true]);
      for (const domain of domains) {
        expect(domain.area).toBe((high - low) ** 2);
        expect(domain.volume).toBe((high - low) ** 2 * 4);
      }
    }
  });

  it('a film under the model thinner than a cell is no domain, sealed or otherwise', () => {
    const plate = join(box([0, 0, 0.1], [20, 20, 5]), box([9, 9, 0], [11, 11, 0.2]));
    expect(sealedDomains(plate, CELL, NO_FILTER)).toEqual([]);
  });

  it('what lies below the plane does not reach the air above it', () => {
    const body = join(box([0, 0, 0], [20, 20, 10]), inverted(box([5, 5, 0], [15, 15, 2])));
    const withSpike = join(body, box([8, 8, -3], [12, 12, -1]));
    const domains = sealedDomains(withSpike, CELL, NO_FILTER);
    expect(domains).toHaveLength(1);
    expect(domains[0].onPlane).toBe(true);
    expect(domains[0].min[2]).toBe(0);
    expect(domains[0].volume).toBe(sealedDomains(body, CELL, NO_FILTER)[0].volume);
  });

  it('a straight hole through a plate is open to the sky', () => {
    expect(sealedDomains(ring(api, 40, 10, 5), CELL, NO_FILTER)).toEqual([]);
  });

  it('applies the volume filter by domain', () => {
    const recess = recessedBlock(api, 2);
    expect(sealedDomains(recess, CELL, 150)).toHaveLength(1);
    expect(sealedDomains(recess, CELL, 250)).toEqual([]);
  });

  describe('a hollow box', () => {
    const outer = box([0, 0, 0], [20, 20, 20]);
    const hollow = inverted(box([5, 5, 5], [15, 15, 15]));
    const mesh = join(outer, hollow);

    it('reads its void as sealed but off the plane, when the void shell is kept', () => {
      const domains = sealedDomains(mesh, CELL, NO_FILTER);
      expect(domains).toHaveLength(1);
      expect(domains[0].onPlane).toBe(false);
      expect(Math.abs(domains[0].volume - 1000)).toBeLessThanOrEqual(30);
    });

    it('exteriorMesh drops that shell, as the model volume already includes it', () => {
      const exterior = exteriorMesh(mesh);
      expect(exterior.indices.length).toBe(outer.indices.length);
      expect(signedVolume(exterior)).toBeCloseTo(8000, 1);
      expect(sealedDomains(exterior, CELL, NO_FILTER)).toEqual([]);
    });

    it('exteriorMesh hands back the same mesh when there is nothing to drop', () => {
      expect(exteriorMesh(outer)).toBe(outer);
    });

    it('a void is not a body, and a separate block is', () => {
      expect(countBodies(mesh)).toBe(1);
      expect(countBodies(join(mesh, box([40, 0, 0], [45, 5, 5])))).toBe(2);
    });
  });

  it('counts a floating object inside an open space once, not as sealed', () => {
    // A small block hovering above a larger one: air all round it, so no domain and two bodies.
    const mesh = join(box([0, 0, 0], [20, 20, 5]), box([5, 5, 10], [15, 15, 15]));
    expect(sealedDomains(mesh, CELL, NO_FILTER)).toEqual([]);
    expect(countBodies(mesh)).toBe(2);
  });
});
