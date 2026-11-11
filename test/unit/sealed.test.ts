import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { countBodies, exteriorMesh, plateSealedAir, sealedDomains } from '../../src/core/field/sealed';
import { windingNumber } from '../../src/core/mesh/shells';
import { cupAir } from '../fixtures/fieldOracles';
import { orientedExample } from '../fixtures/fieldRuns';
import { hasExample, loadManifold } from '../fixtures/loadExamples';
import { axisRotation, box, cup, engravedBlock, hollowCone, holedBlock, inverted, invertedCup, join, notchedBlock, recessedBlock, ring, rotated, signedVolume, ventedInvertedCup, withoutTriangles } from '../fixtures/synthetic';
import type { WeldedMesh } from '../../src/core/mesh/weld';

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

/** The winding number of a closed surface at a point, as the section's stencil count reads it. */
const windingAt = (surface: WeldedMesh, at: [number, number, number]): number => Math.round(windingNumber({ numProp: 3, vertProperties: surface.positions, triVerts: surface.indices } as never, ...at)) + 0;

describe('air the plate seals under the model, from its faces', () => {
  it('a recess under a block: its air exactly, and nothing in the block or round it', () => {
    const { surface, recesses } = plateSealedAir(recessedBlock(api, 2));
    expect(recesses).toHaveLength(1);
    expect(recesses[0].volume).toBeCloseTo(200, 6);
    expect(windingAt(surface!, [20, 20, 1])).toBe(1);
    // In the block over it, in the block beside it, and outside the block, where silicone is.
    expect(windingAt(surface!, [20, 20, 2.5])).toBe(0);
    expect(windingAt(surface!, [14, 20, 1])).toBe(0);
    expect(windingAt(surface!, [-2, 20, 1])).toBe(0);
    expect(windingAt(surface!, [20, 20, 12])).toBe(0);
    // Under the plane the fan's cone is the only thing it holds, and never less than 0.
    expect(windingAt(surface!, [20, 20, -0.5])).toBe(1);
    expect(windingAt(surface!, [5, 5, -0.5])).toBe(0);
  });

  it('a recess running out through the side, which silicone reaches, is none, and nor is any closed piece off the plane', () => {
    expect(plateSealedAir(notchedBlock(api, 2))).toEqual({ surface: null, recesses: [] });
    expect(plateSealedAir(cup(api)).recesses).toEqual([]);
    expect(plateSealedAir(holedBlock(api)).recesses).toEqual([]);
    expect(plateSealedAir(ring(api, 40, 10, 5)).recesses).toEqual([]);
    // A void shell has no edge on the plane: it is the model's own, which the silicone's count already fills.
    expect(plateSealedAir(join(box([0, 0, 0], [20, 20, 20]), inverted(box([5, 5, 5], [15, 15, 15])))).recesses).toEqual([]);
  });

  it('an engraved ring round an island, as the inside of a letter: the ring\'s air and not the island, and with a channel out none', () => {
    const { surface, recesses } = plateSealedAir(engravedBlock(api, false));
    expect(recesses).toHaveLength(1);
    // 10 x 10 less the 4 x 4 island, 0.5 deep.
    expect(recesses[0].volume).toBeCloseTo((100 - 16) * 0.5, 5);
    expect(windingAt(surface!, [11, 10, 0.25])).toBe(1);
    expect(windingAt(surface!, [15, 10, 0.25])).toBe(0);
    expect(windingAt(surface!, [15, 10, -0.5])).toBe(0);
    expect(plateSealedAir(engravedBlock(api, true)).recesses).toEqual([]);
  });

  it('an inverted cup\'s air, to the closed form, where S8\'s columns read it within 3%', () => {
    const { surface, recesses } = plateSealedAir(invertedCup(api));
    expect(recesses).toHaveLength(1);
    // The 256-gon's air, which the closed form for the circle overstates by 0.01%.
    expect(Math.abs(recesses[0].volume / 1000 - cupAir())).toBeLessThanOrEqual(cupAir() * 2e-4);
    expect(windingAt(surface!, [0, 0, 30])).toBe(1);
    expect(windingAt(surface!, [28.5, 0, 30])).toBe(0);
    expect(windingAt(surface!, [0, 0, 58.5])).toBe(0);
    expect(plateSealedAir(ventedInvertedCup(api, 6)).recesses).toEqual([]);
  });

  it('works in the file\'s own coordinates, given the plane, as the view has the model', () => {
    // Turned a quarter about x and moved: the plane z = 0 is now y = 7, facing -y.
    const turn = axisRotation([1, 0, 0], 90);
    const turned = rotated(recessedBlock(api, 2), turn);
    const moved: WeldedMesh = { positions: turned.positions.map((v, k) => (k % 3 === 1 ? v + 7 : v)), indices: turned.indices };
    // Height over the plane is the old z, the third row of the turn undone: up . (p - (0, 7, 0)).
    const up: [number, number, number] = [turn[2], turn[5], turn[8]];
    const { surface, recesses } = plateSealedAir(moved, up, -7 * turn[5]);
    expect(recesses).toHaveLength(1);
    expect(recesses[0].volume).toBeCloseTo(200, 4);
    const inAir = [20, 20, 1].map((_, k) => turn[3 * k] * 20 + turn[3 * k + 1] * 20 + turn[3 * k + 2] * 1 + (k === 1 ? 7 : 0)) as [number, number, number];
    expect(windingAt(surface!, inAir)).toBe(1);
  });

  it('a hole in a recess\'s faces leaves that recess out, as an open piece encloses nothing', () => {
    const block = recessedBlock(api, 2);
    // A face of the recess's ceiling, the only faces at z = 2 that face down.
    const ceiling = [...Array(block.indices.length / 3).keys()].find((t) => [0, 1, 2].every((c) => block.positions[block.indices[t * 3 + c] * 3 + 2] === 2))!;
    expect(plateSealedAir(withoutTriangles(block, [ceiling])).recesses).toEqual([]);
  });

  it('Benchy\'s 8 sealed letters and wolf\'s 13 recesses, as G2.6 and S8 find them, and none on the other five', () => {
    const benchy = plateSealedAir(orientedExample('benchy').mesh, [0, 0, 1], 0, 0.05);
    // G2.6's level of the lettering is 78.1 mm2 at 0.30 mm, and S8 reads 8 letters of 3 to 5 mm3.
    expect(benchy.recesses).toHaveLength(8);
    const sum = (found: { recesses: { volume: number }[] }): number => found.recesses.reduce((total, r) => total + r.volume, 0);
    // Measured: 23.43 mm3, the level's area times its depth to 0.1%, and the largest letter 4.49.
    expect(Math.abs(sum(benchy) - 78.1 * 0.3)).toBeLessThanOrEqual(78.1 * 0.3 * 0.002);
    for (const r of benchy.recesses) expect(r.max[2]).toBeCloseTo(0.3, 3);
    // Wolf's 13 recesses at 0.917 mm, G2.6's 108.5 mm2 level: 99.53 mm3, the largest 12.53, S8's "up to 13".
    const wolf = plateSealedAir(orientedExample('wolf').mesh, [0, 0, 1], 0, 0.05);
    expect(wolf.recesses).toHaveLength(13);
    expect(Math.abs(sum(wolf) - 108.5 * 0.917)).toBeLessThanOrEqual(108.5 * 0.917 * 0.002);
    for (const id of (['jersey', 'x8', 'barrel', 'goddess', 'vis35'] as const).filter(hasExample)) expect(plateSealedAir(orientedExample(id).mesh, [0, 0, 1], 0, 0.05).recesses, id).toEqual([]);
  });
});
