import type { Manifold } from 'manifold-3d';
import { chooseFor, fineSplit, prepareClamshell, type ClamshellPrep, type FineSplit } from '../../src/core/field/clamshell';
import { buildClamshell, seamOpening, type ClamshellBuild, type ClamshellBuildOptions } from '../../src/core/parts/clamshell';
import { topMap } from '../../src/core/field/side';
import { boreRadius, discMinimum, flangeOutreachesLand, flangeReach, openingSizes, topRadius, ventLand } from '../../src/core/analysis/validate';
import type { Params } from '../../src/core/params/schema';
import type { CutOpening } from '../../src/core/parts/openings';
import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { orientedSolid } from '../../src/core/parts/base';
import { BAND_ROOM } from '../../src/core/parts/rim';
import type { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { EXAMPLE_FILES, loadExample, type ExampleId } from './loadExamples';
import { loadGallery } from './loadGallery';

/**
 * MP1's run lives in src/core/field/clamshell.ts and MP2's parts in src/core/parts/clamshell.ts, which the tests and the
 * measurement call as MP5 will; this adds the gallery's models, oriented as fieldRuns.ts orients the test models, and
 * MP2's cases, each a model with its halves.
 */
export { chooseFor, coarseRows, exactFootprint, exactRim, fineSplit, prepareClamshell, seamHold, sideField, type ClamshellPrep, type FineSplit, type SeamHold } from '../../src/core/field/clamshell';

const galleryCache = new Map<string, WeldedMesh>();

/** A gallery model on its top ranked plane, as fieldRuns.ts gives the test models. */
export function orientedGallery(id: string): WeldedMesh {
  let mesh = galleryCache.get(id);
  if (!mesh) {
    const welded = weld(parseStl(loadGallery(id)).positions);
    const options = baseOptions(defaultParams(), meshBounds(welded.positions));
    const [top] = findBaseCandidates(welded, options);
    mesh = orientToBase(welded, top, { planeTol: options.planeTol, soup: false }).mesh;
    galleryCache.set(id, mesh);
  }
  return mesh;
}

export { buildClamshell, clamshellG4, seamOpening, siliconeSolid, type ClamshellBuild } from '../../src/core/parts/clamshell';

/** A model for MP2's builds: its oriented mesh, as fieldRuns.ts and orientedGallery give it, and its solid there. */
export interface ClamModel {
  mesh: WeldedMesh;
  solid: Manifold;
}

/**
 * A test model's or a gallery model's mesh, or a mesh made here, on its top ranked plane, with the oriented solid minGap
 * and the pull test read.
 */
export function clamModel(arena: Arena, source: ExampleId | string | WeldedMesh): ClamModel {
  const id = typeof source === 'string' ? source : 'the mesh';
  const welded = typeof source !== 'string' ? source : isExample(source) ? loadExample(source).welded : weld(parseStl(loadGallery(source)).positions);
  const options = baseOptions(defaultParams(), meshBounds(welded.positions));
  const [top] = findBaseCandidates(welded, options);
  const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
  const solid = orientedSolid(arena, importSolid(arena, welded, auditEdges(welded)), oriented);
  if (!solid) throw new Error(`${id} has no closed solid.`);
  return { mesh: oriented.mesh, solid };
}

function isExample(id: string): id is ExampleId {
  return id in EXAMPLE_FILES;
}

/** G13.5's 1D plateau: the stretch within this of the highest zb, whose middle the opening takes. */
const PLATEAU = 0.2;

/** G11's zb on P at each node of H_top along P: b from `first` by H's cell. */
function seamRow(prep: ClamshellPrep, fine: FineSplit, kind: 'pour' | 'vent'): { first: number; cell: number; zb: number[] } {
  const H = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs);
  const r = boreRadius(openingSizes(prep.params), kind);
  const [first, count] = fine.axis === 'x' ? [H.y0, H.ny] : [H.x0, H.nx];
  const zb = Array.from({ length: count }, (_, k) => {
    const b = first + k * H.cell;
    return discMinimum(H, fine.axis === 'x' ? fine.xs : b, fine.axis === 'x' ? b : fine.xs, r);
  });
  return { first, cell: H.cell, zb };
}

/**
 * Where on P a pour's bore stands highest, as b: the most of G11's zb, the lowest ceiling over its disc, over the nodes of
 * H_top along P, and on a plateau (the nodes either side within PLATEAU of it) the plateau's middle, as G13.5 places a
 * 1D plateau's opening. MP2's hand-placed pour goes there, until MP4 places the openings.
 */
export function highestOnSeam(prep: ClamshellPrep, fine: FineSplit, kind: 'pour' | 'vent' = 'pour'): number {
  const { first, cell, zb } = seamRow(prep, fine, kind);
  let top = 0;
  for (let k = 1; k < zb.length; k++) if (zb[k] > zb[top]) top = k;
  let lo = top, hi = top;
  while (lo > 0 && zb[lo - 1] >= zb[top] - PLATEAU) lo--;
  while (hi < zb.length - 1 && zb[hi + 1] >= zb[top] - PLATEAU) hi++;
  return first + ((lo + hi) / 2) * cell;
}

/**
 * A vent on P beside a pour at `pourB`, as MP4 will place one: at the nearest b either side, by 0.5 mm steps out from
 * the closest the flange rule allows (FL's flangeReach, or the land where the flange is narrower), whose bore stands in
 * the cavity (G11's zb over 0) and whose band beside it has G13.5's room inside O, the vent's top radius + seamLand +
 * gw + BAND_ROOM. Null where none fits, as on a coupon narrower than the flange.
 */
export function ventBeside(prep: ClamshellPrep, fine: FineSplit, pourB: number): CutOpening | null {
  const { params } = prep;
  const sizes = openingSizes(params);
  const { first, cell, zb } = seamRow(prep, fine, 'vent');
  const closest = (flangeOutreachesLand(sizes) ? flangeReach(sizes) : ventLand(sizes)) + 0.01;
  const room = topRadius(sizes, 'vent') + params.clamshell.seamLand + params.joint.ridgeWidth + 2 * params.joint.grooveClearance + BAND_ROOM;
  const { O } = fine.rim;
  const [o0, o1] = fine.axis === 'x' ? [O.y0, O.y1] : [O.x0, O.x1];
  for (let d = closest; d <= closest + 20; d += 0.5) {
    for (const b of [pourB + d, pourB - d]) {
      const k = Math.round((b - first) / cell);
      if (k < 0 || k >= zb.length || !(zb[k] > 0) || b - room < o0 || b + room > o1) continue;
      return seamOpening(prep, fine, 'vent', b);
    }
  }
  return null;
}

/** MP2's hand-placed openings on P: a pour where its bore stands highest, and a vent beside it where one fits. */
export function defaultOpenings(prep: ClamshellPrep, fine: FineSplit): CutOpening[] {
  const b = highestOnSeam(prep, fine);
  const vent = ventBeside(prep, fine, b);
  return [seamOpening(prep, fine, 'pour', b), ...(vent ? [vent] : [])];
}

/** One of MP2's builds: the model, its split, and the halves with a pour and a vent hand-placed on P. */
export interface ClamCase {
  model: ClamModel;
  params: Params;
  prep: ClamshellPrep;
  fine: FineSplit;
  build: ClamshellBuild;
}

export interface ClamCaseOptions extends Omit<ClamshellBuildOptions, 'openings'> {
  cell?: number;
  /** The openings on P; by default a pour at the seam's highest point and a vent beside it where one fits (ventBeside). */
  openings?: (prep: ClamshellPrep, fine: FineSplit) => CutOpening[];
}

/**
 * MP2's mold of a model at the two-part defaults with Seam fasteners None (the seal is proved before the lugs), G13.3's
 * choice at beta 20 and fine fields at the export cell. `change` edits the parameters first.
 */
export function clamCase(arena: Arena, source: ExampleId | string | WeldedMesh, change: (params: Params) => void = () => {}, options: ClamCaseOptions = {}): ClamCase {
  const model = clamModel(arena, source);
  const params = defaultParams('clamshell');
  params.clamshell.fastener = 'none';
  change(params);
  const prep = prepareClamshell(model.mesh, params);
  const choice = chooseFor(prep, params.clamshell.ceilingDeg);
  const fine = fineSplit(prep, choice.axis, choice.xs, options.cell ?? params.quality.cellFinal);
  const openings = options.openings ? options.openings(prep, fine) : defaultOpenings(prep, fine);
  return { model, params, prep, fine, build: buildClamshell(arena, prep, fine, { ...options, openings }) };
}
