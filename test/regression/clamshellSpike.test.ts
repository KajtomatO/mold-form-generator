import { describe, it } from 'vitest';
import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { buildField } from '../../src/core/field/build';
import { fieldSettings, planField } from '../../src/core/field/grid';
import { frameInverse, pullOf, seamEps, type SeamAxis } from '../../src/core/field/side';
import { orientSolid } from '../../src/core/base/orient';
import { importSolid } from '../../src/core/mesh/shells';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { orientedSolid } from '../../src/core/parts/base';
import { withArena } from '../../src/core/solid/arena';
import { buildToolMesh, toolSolid } from '../../src/core/solid/tool';
import { chooseFor, fineSplit, prepareClamshell } from '../fixtures/clamshell';
import { loadExample, loadManifold, skipWithout } from '../fixtures/loadExamples';

/**
 * G13.16's gate at the end of MP1: VIS-35 at cellFinal on both axes, on what MP1 builds (the side fields, two TINs, two
 * toolSolids and minGap(model, tool) for each), heap and time recorded, against the one-piece's field, TIN, toolSolid
 * and minGap. Each case reads the process's peak RSS, so run each in a process of its own:
 *   CFG_MEASURE=1 npx vitest run test/regression/clamshellSpike.test.ts -t "<case>"
 */
const MEASURE = process.env.CFG_MEASURE === '1';
const SEARCH = 8;
const MiB = 1024 * 1024;

const peak = (): string => `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`;

describe.runIf(MEASURE)('G13.16 spike, VIS-35 at cellFinal', () => {
  it('one-piece', async (ctx) => {
    skipWithout(ctx, 'vis35');
    const api = await loadManifold();
    const { welded, audit, options } = loadExample('vis35');
    const t0 = performance.now();
    const [top] = findBaseCandidates(welded, options);
    const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
    const params = defaultParams();
    const bounds = meshBounds(oriented.mesh.positions);
    const settings = fieldSettings(params, bounds);
    const plan = planField(bounds, settings);
    const { field } = buildField(oriented.mesh, plan, settings);
    const t1 = performance.now();
    const mesh = buildToolMesh(field, { raise: plan.raise, tol: settings.tinTol });
    const t2 = performance.now();
    const gap = withArena(api, (arena) => {
      const tool = toolSolid(arena, mesh);
      const model = orientedSolid(arena, importSolid(arena, welded, audit), oriented)!;
      // The tool holds the model, so the gap is read to the box less the tool: the cover's cavity wall.
      const d = mesh.domain;
      const block = arena.track(arena.track(arena.api.Manifold.cube([d.x1 - d.x0 + 2, d.y1 - d.y0 + 2, bounds.max[2] + 20])).translate([d.x0 - 1, d.y0 - 1, -1]));
      return model.minGap(arena.track(block.subtract(tool)), SEARCH);
    });
    const t3 = performance.now();
    console.log(`one-piece: field ${(t1 - t0).toFixed(0)} ms, TIN ${(t2 - t1).toFixed(0)} ms (${mesh.tinTriangles} triangles), toolSolid and minGap ${(t3 - t2).toFixed(0)} ms, gap ${gap.toFixed(3)} mm, JS heap ${(process.memoryUsage().heapUsed / MiB).toFixed(0)} MiB, ${peak()}`);
  }, 1_800_000);

  for (const axis of ['x', 'y'] as const satisfies readonly SeamAxis[]) {
    it(`two-part ${axis}`, async (ctx) => {
      skipWithout(ctx, 'vis35');
      const api = await loadManifold();
      const { welded, audit, options } = loadExample('vis35');
      const t0 = performance.now();
      const [top] = findBaseCandidates(welded, options);
      const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
      const params = defaultParams('clamshell');
      params.clamshell.axis = axis;
      params.print.bedX = 300;
      params.print.bedY = 300;
      const prep = prepareClamshell(oriented.mesh, params);
      const choice = chooseFor(prep, params.clamshell.ceilingDeg);
      const fine = fineSplit(prep, choice.axis, choice.xs, params.quality.cellFinal);
      const t1 = performance.now();
      const lines: string[] = [];
      withArena(api, (arena) => {
        const model = orientedSolid(arena, importSolid(arena, welded, audit), oriented)!;
        for (const [sign, side] of [[1, fine.plus], [-1, fine.minus]] as const) {
          const s0 = performance.now();
          const eps = seamEps(prep.settings.tinTol);
          const mesh = buildToolMesh(side.field, { raise: side.side.plan.raise, tol: prep.settings.tinTol, seam: { hs: side.hs, eps } });
          const s1 = performance.now();
          const tool = orientSolid(arena, toolSolid(arena, mesh), frameInverse(side.side.frame));
          // The half's box, trimmed at P to its own side, less its tool: its cavity wall, which G4 is read against.
          const O = fine.rim.O;
          const box = arena.track(arena.track(arena.api.Manifold.cube([O.x1 - O.x0, O.y1 - O.y0, fine.rim.Zt + 1])).translate([O.x0, O.y0, -1]));
          const normal: [number, number, number] = axis === 'x' ? [sign, 0, 0] : [0, sign, 0];
          const half = arena.track(arena.track(box.trimByPlane(normal, sign * choice.xs)).subtract(tool));
          const gap = model.minGap(half, SEARCH);
          lines.push(`${pullOf(axis, sign)}: TIN ${(s1 - s0).toFixed(0)} ms (${mesh.tinTriangles} triangles), toolSolid and minGap ${(performance.now() - s1).toFixed(0)} ms, gap ${gap.toFixed(3)} mm`);
        }
      });
      console.log(`two-part ${axis} at ${choice.xs}: coarse and fine fields ${(t1 - t0).toFixed(0)} ms (${fine.plus.field.nx} x ${fine.plus.field.ny} and ${fine.minus.field.nx} x ${fine.minus.field.ny}); ${lines.join('; ')}; JS heap ${(process.memoryUsage().heapUsed / MiB).toFixed(0)} MiB, ${peak()}`);
    }, 1_800_000);
  }
});
