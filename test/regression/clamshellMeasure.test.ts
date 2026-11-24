import { describe, it } from 'vitest';
import { buildField } from '../../src/core/field/build';
import { fieldSettings, planField } from '../../src/core/field/grid';
import { moldSilicone, sealedAirOf } from '../../src/core/field/silicone';
import { meshBounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { GALLERY } from '../../src/gallery/catalogue';
import { chooseFor, clipHold, coarseRows, exactFootprint, fineSplit, orientedGallery, prepareClamshell, seamHold, type FineSplit } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS } from '../fixtures/loadExamples';
import { FIELD_GOLDEN, GOLDEN } from './golden';

/**
 * MP1's measurement, the design's MP0 (docs/PLAN.md, MP1): every test model and gallery model by G13.17's method at
 * cellFinal, the bed applied (the app's 220 x 220 x 250 and the user's 250 x 210 x 220), at beta 0, 20, 30 and 45, with
 * M3 lugs, with clip ears and with neither. It prints the table G13.17, G13.10.6, G13.10.8, G13.10.18 and G13.12 were
 * corrected from, and MP3b's clip rows for G13.10.17's, and checks nothing: run it with CFG_MEASURE=1.
 */
const MEASURE = process.env.CFG_MEASURE === '1';
const BETAS = [0, 20, 30, 45];
const BEDS = { app: { bedX: 220, bedY: 220, bedZ: 250 }, user: { bedX: 250, bedY: 210, bedZ: 220 } } as const;
const FASTENERS = ['bolts', 'clips', 'none'] as const;

function onePiece(mesh: WeldedMesh, params: Params, overlap: number): number {
  const bounds = meshBounds(mesh.positions);
  const settings = { ...fieldSettings(params, bounds), baseLayer: 0 };
  const plan = planField(bounds, settings);
  const built = buildField(mesh, plan, settings);
  return moldSilicone(mesh, plan, built.field, { overlapVolume: overlap }, settings).ml;
}

describe.runIf(MEASURE)('MP1 measurement', () => {
  const models: { id: string; mesh: () => WeldedMesh; overlap: number; onePiece: (p: Params) => number }[] = [
    ...EXAMPLE_IDS.map((id) => ({ id, mesh: () => orientedExample(id).mesh, overlap: GOLDEN[id].overlapVolume, onePiece: () => FIELD_GOLDEN[id].silicone })),
    ...GALLERY.map((g) => ({ id: g.id, mesh: () => orientedGallery(g.id), overlap: 0, onePiece: (p: Params) => onePiece(orientedGallery(g.id), p, 0) })),
  ];
  for (const model of models) {
    it(`measures ${model.id}`, () => {
      const base = defaultParams('clamshell');
      const mesh = model.mesh();
      const one = model.onePiece(base);
      // S8's sealed air, taken off both sides as moldSilicone takes it off the one-piece.
      const { sealedAir } = sealedAirOf(mesh, fieldSettings(base, meshBounds(mesh.positions)));
      const lines: string[] = [];
      for (const beta of BETAS) {
        const params0 = { ...base, clamshell: { ...base.clamshell, ceilingDeg: beta } };
        const prep0 = prepareClamshell(mesh, params0, { overlapVolume: model.overlap, sealedAir });
        const rows = coarseRows(prep0, beta);
        const fine = new Map<string, FineSplit>();
        for (const [bed, print] of Object.entries(BEDS)) {
          for (const fastener of FASTENERS) {
            const params = { ...params0, print: { ...params0.print, ...print }, clamshell: { ...params0.clamshell, fastener } };
            const prep = prepareClamshell(mesh, params, { overlapVolume: model.overlap, sealedAir });
            const choice = chooseFor(prep, beta, rows);
            const key = `${choice.axis} ${choice.xs}`;
            const split = fine.get(key) ?? fineSplit(prep, choice.axis, choice.xs, params.quality.cellFinal, beta);
            fine.set(key, split);
            const a = choice.axis === 'x' ? 0 : 1;
            const at = (100 * (choice.xs - prep.bounds.min[a])) / (prep.bounds.max[a] - prep.bounds.min[a]);
            const fp = exactFootprint(prep, split, fastener);
            const hold = fastener === 'bolts' ? seamHold(prep, split) : null;
            const clips = fastener === 'clips' ? clipHold(prep, split) : null;
            lines.push(
              `| ${model.id} | ${beta} | ${bed} | ${fastener} | ${split.siliconeMl.toFixed(1)} (${(100 * (split.siliconeMl / one - 1)).toFixed(0)}%) | ${choice.axis} ${at.toFixed(0)}% | ${split.rim.Zt.toFixed(1)} | ${fp.width.toFixed(1)} x ${fp.length.toFixed(1)}, ${fp.depth.toFixed(1)} | ${choice.fitted ? 'fits' : `misses${choice.fitsAtBeta !== null ? `, beta <= ${choice.fitsAtBeta}` : ''}${choice.fitsWith ? `, ${choice.fitsWith}` : ''}`} | ${split.forces[0].sideN.toFixed(1)}/${split.forces[1].sideN.toFixed(1)} (film ${split.filmN.toFixed(1)}) | ${split.forces[0].liftN.toFixed(2)}/${split.forces[1].liftN.toFixed(2)} | ${hold ? `${hold.bolts.perEnd} (${hold.bolts.length} mm, wedge ${hold.advice.wedgeN.toFixed(0)} N, span ${hold.advice.topSpan.toFixed(0)})` : ''}${clips ? `${clips.clips.placed.length} rows: ${clips.clips.placed.map((row) => row.kind).join(', ')} (${clips.clips.count} keys, ${clips.clips.clipsHoldN} N against ${split.holdN.toFixed(1)}, bottom ${clips.advice.bottomHoldN} N against a wedge of ${clips.advice.wedgeN.frictionless.toFixed(0)})` : ''} |`,
            );
          }
        }
      }
      console.log(`${model.id}: one-piece ${one.toFixed(1)} ml, sealed air ${(sealedAir / 1000).toFixed(2)} ml\n| model | beta | bed | fastener | silicone ml | split | Zt | pose WxL, depth | bed | side push N | net lift N | seam bolts per end, or clip rows |\n${lines.join('\n')}`);
    }, 1_800_000);
  }
});
