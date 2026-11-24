import type { Manifold } from 'manifold-3d';
import { chooseFor, fineSplit, placeSeam, prepareClamshell, type ClamshellPrep, type FineSplit } from '../../src/core/field/clamshell';
import { buildClamshell, type ClamshellBuild, type ClamshellBuildOptions } from '../../src/core/parts/clamshell';
import type { Params } from '../../src/core/params/schema';
import type { CutOpening } from '../../src/core/parts/openings';
import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { orientedSolid } from '../../src/core/parts/base';
import type { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { EXAMPLE_FILES, loadExample, type ExampleId } from './loadExamples';
import { loadGallery } from './loadGallery';

/**
 * MP1's run lives in src/core/field/clamshell.ts and MP2's parts in src/core/parts/clamshell.ts, which the tests and the
 * measurement call as MP5 will; this adds the gallery's models, oriented as fieldRuns.ts orients the test models, and
 * MP2's cases, each a model with its halves.
 */
export { chooseFor, clipHold, coarseRows, exactFootprint, exactRim, fineSplit, placeSeam, prepareClamshell, seamHold, seamRoom, sideField, type ClamshellPrep, type ClipHold, type FineSplit, type SeamHold, type SeamStage } from '../../src/core/field/clamshell';

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

/**
 * MP4's openings on P (S7c, G13.5): the pour, the vent beside it and a vent at every other significant leaf of S, as
 * placeSeam places them, in place of MP2's hand-placed pour and vent.
 */
export function seamOpenings(prep: ClamshellPrep, fine: FineSplit): CutOpening[] {
  return placeSeam(prep, fine).openings;
}

/** One of MP2's builds: the model, its split, and the halves with the openings on P. */
export interface ClamCase {
  model: ClamModel;
  params: Params;
  prep: ClamshellPrep;
  fine: FineSplit;
  build: ClamshellBuild;
}

export interface ClamCaseOptions extends Omit<ClamshellBuildOptions, 'openings'> {
  cell?: number;
  /** The openings on P; by default MP4's, as placeSeam places them (seamOpenings). */
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
  // MP4's openings carry the placement's choice on the pins; hand-placed ones leave it to the seal's room.
  const stage = options.openings ? null : placeSeam(prep, fine);
  const openings = options.openings ? options.openings(prep, fine) : stage!.openings;
  const pinsKept = options.pinsKept ?? stage?.placement.pinsKept;
  return { model, params, prep, fine, build: buildClamshell(arena, prep, fine, { ...options, openings, pinsKept }) };
}
