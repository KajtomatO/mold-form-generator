import { expect } from '@playwright/test';
import Module from 'manifold-3d';
import type { Params } from '../src/core/params/schema';
import { fitRim, fitVariants } from '../src/core/parts/fitTest';
import { basePose, coverPose } from '../src/core/parts/poses';
import { auditOverhang } from '../src/core/report/overhang';
import { withArena } from '../src/core/solid/arena';
import { parseStl } from '../src/core/stl/parse';
import { readPart, splitShells, unpose } from '../test/fixtures/solidChecks';

/** What arrived is checked here in Node, against the same rim, so the browser's result stands on its own. */
export async function checkPieces(files: Record<string, Uint8Array>, params: Params): Promise<void> {
  const variants = fitVariants(params);
  const expected = [...variants.flatMap((v) => [`fit_test/${v.id}_base.stl`, `fit_test/${v.id}_cover.stl`]), 'fit_test/README.txt'];
  expect(Object.keys(files).sort()).toEqual(expected.sort());
  expect(new TextDecoder().decode(files['fit_test/README.txt'])).toContain('How to read the result');

  const api = await Module();
  api.setup();
  for (const variant of variants) {
    const coverBytes = files[`fit_test/${variant.id}_cover.stl`];
    const baseBytes = files[`fit_test/${variant.id}_base.stl`];
    expect(parseStl(coverBytes).format).toBe('binary');
    for (const bytes of [coverBytes, baseBytes]) {
      const { mesh, audit } = readPart(bytes);
      expect(audit, variant.id).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      expect(auditOverhang(mesh, { bedZ: 0 }).steepCount, variant.id).toBe(0);
    }
    withArena(api, (arena) => {
      const rim = fitRim(params, variant);
      const cover = unpose(arena, coverBytes, coverPose(rim));
      const base = unpose(arena, baseBytes, basePose(rim));
      expect(splitShells(arena, cover).bodies, variant.id).toHaveLength(1);
      expect(splitShells(arena, base).bodies, variant.id).toHaveLength(1);
      expect(arena.track(cover.intersect(base)).volume(), variant.id).toBeLessThan(0.1);
      expect(cover.boundingBox().min[2] - base.boundingBox().min[2], variant.id).toBeCloseTo(params.joint.baseProud, 3);
      const flank = arena.track(base.trimByPlane([0, 0, -1], 1));
      expect(Math.abs(flank.minGap(cover, 1) - variant.cT * rim.cosTaper), variant.id).toBeLessThanOrEqual(0.01);
    });
  }
}
