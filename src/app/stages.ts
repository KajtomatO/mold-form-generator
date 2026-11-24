import type { OpeningPin } from '../core/analysis/placement';
import { isDefaultAt } from '../core/params/defaults';
import { effectiveParams, lockOf, moldTypeOf } from '../core/mold/types';
import { PARAM_SCHEMA, type ParamDef, type Params } from '../core/params/schema';
import { hashString } from './hash';

/**
 * The plan's pipeline stages as data. Each stage names the parameters it reads itself and the stages it
 * builds on, and a stage's key is a hash of exactly those, so changing a parameter invalidates that
 * stage and everything downstream of it, and nothing else. test/unit/stages.test.ts is generated from
 * this table, and checks against the real stage code that no stage reads anything it does not declare.
 */
export type StageId = OnePieceStageId | ClamStageId;

/** The one-piece cover's rows, S1 to S16, which the two-part cover's share up to S2 and from S16. */
export type OnePieceStageId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S13' | 'S14' | 'S15' | 'S16';

/** MP5: the two-part cover's own rows (G13.15), each keyed from what it reads, as the one-piece's are. */
export type ClamStageId = 'S3x' | 'S4x' | 'S6c' | 'S10c' | 'S6x' | 'S7c' | 'S11c' | 'S12c' | 'S13c' | 'S14c' | 'S15c';

export type ParamPath = { [G in keyof Params]: `${G & string}.${keyof Params[G] & string}` }[keyof Params];

/** What a stage depends on besides parameters. */
export interface StageInputs {
  /** One id per loaded file, so loading the same file again starts clean. */
  file: string;
  /** 'plain' while the import has not changed the mesh, which is the usual case and what field.worker assumes. */
  import: string;
  /** Which base plane, as PlaneChoice in JSON. */
  plane: string;
  tier: 'preview' | 'export';
  /** Factor on the field cell: above 1 after a crash, or on a machine too slow for the preview's budget. */
  cellScale: number;
  pins: OpeningPin[];
  /** Automatic vents the user deleted. */
  removed: string[];
  /** The opening being dragged and where it is now, or null between drags. */
  drag: { id: string; x: number; y: number } | null;
  /**
   * RM: 'glue' for a rebuilt model in glue mode, whose field and box hold the parts of the maker's file the repair
   * left out and whose margin is wider by how far the file lies outside the copy (D26); '' for every other model,
   * a repaired one in merged mode included, where the base carries the copy alone.
   */
  outside: '' | 'glue';
}

export type InputName = keyof StageInputs;

export interface StageDef {
  id: StageId;
  label: string;
  /** Where it runs. S1 and S2 have a part in each worker: parsing and orienting are pure, the import and footprint need Manifold. */
  runs: 'field' | 'solid' | 'both';
  deps: StageId[];
  params: ParamPath[];
  inputs: InputName[];
}

const JOINT: ParamPath[] = [
  'joint.taperDeg', 'joint.taperClearance', 'joint.landInner', 'joint.landOuter', 'joint.ridgeWidth', 'joint.ridgeHeight', 'joint.ridgeDraftDeg',
  'joint.grooveClearance', 'joint.grooveExtraDepth', 'joint.baseProud', 'joint.pryNotches', 'joint.pryWidth', 'joint.pryHeight',
];

/**
 * What sets the padded domain of a tile and the auto spacing: the radius, the widening by draft over the
 * highest ceiling, which includes the export's TIN raise, the closing element and the wall between tiles.
 */
const DOMAIN: ParamPath[] = ['silicone.wallDraftDeg', 'silicone.closeWidth', 'print.nozzle', 'quality.tinTolFinal'];

/** The radius of G4. */
const RADIUS: ParamPath[] = ['silicone.t', 'silicone.printMargin', 'print.layerHeight', 'quality.cellFinal'];

/** M10: the bolts live in the rim, as they grow its outer land and set their holes from the cover's top. */
const BOLTS: ParamPath[] = ['bolts.enabled', 'bolts.size', 'bolts.length', 'bolts.holeClearance', 'bolts.nutClearance', 'bolts.minWall'];

/** G8's rim from a box, which deriveRim reads, the two-part cover's through deriveClamRim. */
const RIM: ParamPath[] = ['grid.edge', 'base.thickness', 'base.cornerRadius', 'base.bedReliefHeight', 'base.bedReliefRun', 'cover.wall', 'cover.topCap', 'cover.topChamfer', ...JOINT];

/** G13.10.13: the bolt settings the seam bolts share with the corner bolts, whose toggle the two-part cover locks off. */
const SEAM_BOLTS: ParamPath[] = ['bolts.size', 'bolts.length', 'bolts.holeClearance', 'bolts.nutClearance', 'bolts.minWall', 'print.layerHeight'];

/** G13.10.19: the seam clips, sized from the print's layer and nozzle. */
const CLIPS: ParamPath[] = ['clips.clearance', 'clips.rows', 'print.layerHeight', 'print.nozzle'];

/** What the funnel is made of, and what the seat it sits in is. */
const FUNNEL: ParamPath[] = ['funnel.generate', 'funnel.topDiameter', 'funnel.height', 'funnel.neckHeight', 'funnel.wall', 'funnel.tipWall', 'funnel.seatClearance', 'funnel.flangeWidth', 'funnel.flangeThickness'];

/** S7's own settings, which S7c reads too, as it places the same openings on the seam. */
const PLACEMENT: ParamPath[] = [
      'pour.perModel', 'pour.diameter', 'pour.minLand', 'vents.enabled', 'vents.diameter', 'vents.persistence',
      'seat.enabled', 'seat.depth', 'seat.halfAngleDeg', 'funnel.generate', 'funnel.topDiameter', 'funnel.wall', 'funnel.seatClearance',
      // FL: no vent under a flange, and a pour's flange inside the top's chamfer.
      'funnel.flangeWidth', 'cover.topChamfer',
      // VN: the gap between a flange and a vent's mouth takes half a printed line, past the funnel's play in its
      // seat. S5 and S10 already read the nozzle (DOMAIN), and S7 depends on both, so no key changes for it.
      'print.nozzle',
      // t / 2 is the cover drop, and the vents' persistence until edited. Bodies stand within the plane tolerance.
      'silicone.t', 'base.planeTol',
];

export const STAGES: readonly StageDef[] = [
  { id: 'S1', label: 'parsed, audited, imported', runs: 'both', deps: [], params: [], inputs: ['file'] },
  { id: 'S2', label: 'oriented, footprint', runs: 'both', deps: ['S1'], params: ['base.planeTol', 'base.minIsland'], inputs: ['import', 'plane'] },
  // The preview cell's rule reads the size of the whole grid, so the grid's counts are here too.
  // RM: a rebuilt model's raster holds the file's left-out parts in glue mode, and its margin is wider there.
  { id: 'S3', label: 'raster', runs: 'field', deps: ['S2'], params: ['quality.cellPreview', 'quality.cellFinal', 'grid.nx', 'grid.ny'], inputs: ['tier', 'cellScale', 'outside'] },
  { id: 'S4', label: 'envelope', runs: 'field', deps: ['S3'], params: RADIUS, inputs: [] },
  { id: 'S5', label: 'composite', runs: 'field', deps: ['S4'], params: ['grid.nx', 'grid.ny', 'grid.spacing', ...DOMAIN], inputs: [] },
  // The base layer fills D, which follows from S5's own inputs, so S6 needs no S10.
  { id: 'S6', label: 'conditioned', runs: 'field', deps: ['S5'], params: ['silicone.wallDraftDeg', 'silicone.closeWidth', 'silicone.baseLayer', 'silicone.baseLayerSlopeDeg'], inputs: [] },
  {
    id: 'S7',
    label: 'peaks and placement',
    runs: 'field',
    deps: ['S6', 'S10'],
    params: PLACEMENT,
    inputs: ['pins', 'removed'],
  },
  // S8 and S9 run in a field.worker of their own, after the preview, so neither T1 nor T2 waits for them.
  { id: 'S8', label: 'intervals', runs: 'field', deps: ['S2'], params: ['quality.analysisCell'], inputs: [] },
  {
    id: 'S9',
    label: 'geometry reports',
    runs: 'field',
    deps: ['S6', 'S7', 'S8', 'S10'],
    params: [
      'silicone.density', 'print.tapeStrip', 'reports.minVolumeMl', 'reports.undersidePersistence',
      // The demold filter on footprint crumbs, and the lift's level and raise.
      'base.minIsland', 'funnel.generate', 'funnel.height', 'seat.enabled', 'quality.tinTolPreview',
    ],
    inputs: [],
  },
  {
    id: 'S10',
    label: 'rim and box',
    // Pure, as the plan has it, but in field.worker and not on main: the analytic bounds read every vertex
    // of the oriented mesh, which only field.worker holds. It goes to main with the field.
    runs: 'field',
    // The analytic bounds come from the oriented mesh, through the export plan's radius, pitch and spacing.
    deps: ['S2'],
    params: [
      ...RADIUS, ...DOMAIN, 'grid.nx', 'grid.ny', 'grid.spacing', 'grid.edge',
      'base.thickness', 'base.cornerRadius', 'base.bedReliefHeight', 'base.bedReliefRun', 'cover.wall', 'cover.topCap', 'cover.topChamfer', ...JOINT, ...BOLTS,
    ],
    // RM: the box of a rebuilt model in glue mode holds the file's left-out parts too, as S3's raster does.
    inputs: ['outside'],
  },
  { id: 'S11', label: 'tool', runs: 'solid', deps: ['S6', 'S10'], params: ['quality.tinTolPreview', 'quality.tinTolFinal'], inputs: ['tier'] },
  { id: 'S12', label: 'cover body', runs: 'solid', deps: ['S11', 'S10'], params: [], inputs: [] },
  { id: 'S13', label: 'cover final', runs: 'solid', deps: ['S12', 'S7'], params: [], inputs: ['drag'] },
  { id: 'S14', label: 'base body', runs: 'solid', deps: ['S10'], params: [], inputs: [] },
  { id: 'S15', label: 'base final', runs: 'solid', deps: ['S14', 'S2'], params: ['base.mode', 'base.pocketDepth', 'base.pocketEnlarge', 'print.layerHeight', 'base.planeTol'], inputs: [] },
  // FL: the spigot's relief under the flange is 2 layers.
  { id: 'S16', label: 'funnel', runs: 'solid', deps: [], params: [...FUNNEL, 'seat.enabled', 'seat.depth', 'seat.halfAngleDeg', 'pour.diameter', 'print.layerHeight'], inputs: [] },
  // MP5: the two-part cover's rows (G13.15). The one-piece's above keep their keys; these read the same oriented model
  // (S2) and give the same funnel (S16). Their caches hold a slot per pull and tier (src/workers/clamshellStages.ts).
  // The model cut at z = 0, turned into each pull's frame, its vertices' extremes and G8's box: what no beta changes.
  { id: 'S3x', label: 'side frames', runs: 'field', deps: ['S2'], params: [...RADIUS, ...DOMAIN, 'grid.spacing', 'joint.ridgeHeight', 'joint.grooveExtraDepth', 'clamshell.seamLand'], inputs: [] },
  // G13.2 step 8's coarse fields at 1 mm, one per pull the axis allows, which G13.3 scores.
  { id: 'S4x', label: 'coarse side fields', runs: 'field', deps: ['S3x'], params: ['clamshell.ceilingDeg', 'clamshell.axis', 'base.thickness', 'silicone.baseLayer'], inputs: [] },
  // G13.3: the axis and xs, filtered by the bed with the fastener's growth, from the O(1) rim.
  { id: 'S6c', label: 'parting plane', runs: 'field', deps: ['S3x', 'S4x'], params: ['clamshell.offset', 'clamshell.fastener', 'print.bedX', 'print.bedY', 'print.bedZ', ...SEAM_BOLTS, ...RIM], inputs: [] },
  // G13.6: the exact rim at the split, analytic and cell-independent.
  { id: 'S10c', label: 'two-part rim', runs: 'field', deps: ['S3x', 'S6c'], params: [...RIM, 'clamshell.ceilingDeg'], inputs: [] },
  // The chosen pair at the preview or export cell, stopped and flattened at the seam, with what they give: the
  // silicone, G13.9's forces and the seam bolts or clips placed for the hold.
  {
    id: 'S6x',
    label: 'fine side fields',
    runs: 'field',
    deps: ['S3x', 'S10c'],
    params: ['quality.cellPreview', 'clamshell.ceilingDeg', 'clamshell.fastener', 'silicone.baseLayer', 'silicone.density', 'base.thickness', ...FUNNEL, 'seat.enabled', 'print.tapeStrip', ...SEAM_BOLTS, ...CLIPS, ...RIM],
    inputs: ['tier', 'cellScale'],
  },
  // G13.5: the openings on P, with the room rule and the pins at (xs, pin.b).
  { id: 'S7c', label: 'seam openings', runs: 'field', deps: ['S6x', 'S10c'], params: [...PLACEMENT, 'clamshell.pins', 'clamshell.fastener', 'quality.analysisCell', ...SEAM_BOLTS, ...CLIPS, ...JOINT], inputs: ['pins', 'removed'] },
  // G13.7: each half's tool, its TIN freed once its solid stands.
  { id: 'S11c', label: 'half tools', runs: 'solid', deps: ['S6x'], params: ['quality.tinTolPreview', 'quality.tinTolFinal'], inputs: ['tier'] },
  // The seal from the cavity on P and the openings, the shared block with the lugs, and the halves cut.
  { id: 'S12c', label: 'halves', runs: 'solid', deps: ['S11c', 'S10c', 'S7c'], params: ['clamshell.pins', 'clamshell.fastener', ...SEAM_BOLTS, ...CLIPS, ...JOINT, 'cover.topChamfer'], inputs: [] },
  // The halves as the view draws them, with the clips at home. A drag moves only the ring on P until the drop.
  { id: 'S13c', label: 'halves final', runs: 'solid', deps: ['S12c'], params: [], inputs: [] },
  // G13.7 step 7: G10's base with its ridge as two bars along the pull.
  { id: 'S14c', label: 'two-part base', runs: 'solid', deps: ['S10c'], params: [], inputs: [] },
  { id: 'S15c', label: 'two-part base final', runs: 'solid', deps: ['S14c', 'S2'], params: ['base.mode', 'base.pocketDepth', 'base.pocketEnlarge', 'print.layerHeight', 'base.planeTol'], inputs: [] },
];

/**
 * Parameters no worker stage reads: main works out the plastic from the parts on screen, whenever it draws. So they
 * belong to no stage, and a change of one rebuilds nothing. MP5: the bed is the two-part cover's S6c's, whose choice of
 * split it filters (G13.3); the one-piece cover's parts are still checked against it on main.
 */
export const MAIN_ONLY: readonly ParamPath[] = ['print.infill', 'print.density'];

/**
 * MT: the mold type, which no stage reads. It reaches the stages only through the values its locks give
 * (effectiveParams, which the pipeline hashes the keys from) and through which rows build the mold (typedKeys).
 */
export const NO_STAGE: readonly ParamPath[] = ['mold.type'];

export const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

/** Every parameter by its path, in the schema's order, with its group, key and definition, split once. */
const PARAMS_BY_PATH = new Map(
  Object.entries(PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>).flatMap(([group, defs]) =>
    Object.entries(defs).map(([key, def]) => [`${group}.${key}` as ParamPath, { group: group as keyof Params, key, def }] as const),
  ),
);

/** Every parameter's path, in the schema's order. */
export const PARAM_PATHS: readonly ParamPath[] = [...PARAMS_BY_PATH.keys()];

/** A parameter's definition in the schema. */
export function paramDef(path: ParamPath): ParamDef {
  return PARAMS_BY_PATH.get(path)!.def;
}

/**
 * The paths among `paths` whose setting is not at its default in the type `params` are for (isDefaultAt), in their
 * own order: what the marks, the section resets and Reset in the header show and set back (CS, MT). A setting the
 * type does not use, hidden, or holds locked, is left out: it keeps the user's value for switching back, and a
 * Reset leaves it so. `mold.type` is never changed: Reset keeps the type.
 */
export function changedPaths(params: Params, paths: readonly ParamPath[] = PARAM_PATHS): ParamPath[] {
  const type = moldTypeOf(params);
  return paths.filter((path) => type.applies(path) && !lockOf(path, params) && !isDefaultAt(path, params));
}

export function paramValue(params: Params, path: ParamPath): unknown {
  const [group, key] = path.split('.') as [keyof Params, string];
  return (params[group] as Record<string, unknown>)[key];
}

/** Sets one parameter in place. The caller owns `params`, as Pipeline.setParams hands over a copy. */
export function setParamValue(params: Params, path: ParamPath, value: unknown): void {
  const [group, key] = path.split('.') as [keyof Params, string];
  (params[group] as Record<string, unknown>)[key] = value;
}

/**
 * Every stage's key. A key is a hash of the stage's own parameter values and inputs and of the keys of
 * the stages it builds on, so equal keys mean equal results.
 */
export function stageKeys(params: Params, inputs: StageInputs): Record<StageId, string> {
  const keys = {} as Record<StageId, string>;
  const keyOf = (id: StageId): string => {
    if (keys[id]) return keys[id];
    const stage = STAGE_BY_ID.get(id)!;
    const own = [id, stage.params.map((path) => paramValue(params, path)), stage.inputs.map((name) => inputs[name]), stage.deps.map(keyOf)];
    return (keys[id] = hashString(JSON.stringify(own)));
  };
  STAGES.forEach((stage) => keyOf(stage.id));
  return keys;
}

/**
 * MP5: the one-piece cover's rows that the two-part cover builds with rows of its own, and those rows. A key the
 * pipeline compares under the one-piece's id (the field on screen under S6, its rim under S10, the cover under S13)
 * is the two-part row's in that type, so every check of what shows, what is stale and what to ask for holds in both.
 */
export const CLAM_ROWS: Readonly<Partial<Record<OnePieceStageId, ClamStageId>>> = {
  S6: 'S6x',
  S7: 'S7c',
  S10: 'S10c',
  S11: 'S11c',
  S12: 'S12c',
  S13: 'S13c',
  S14: 'S14c',
  S15: 'S15c',
};

/**
 * The keys of the rows the type in `params` builds with: stageKeys of its effective settings, and for the two-part
 * cover each row of CLAM_ROWS under the one-piece's id too, with S9's, which reads that field, placement and rim,
 * hashed from its own key and theirs. The one-piece cover's keys are stageKeys' exactly.
 */
export function typedKeys(params: Params, inputs: StageInputs): Record<StageId, string> {
  const run = effectiveParams(params);
  const keys = stageKeys(run, inputs);
  if (moldTypeOf(run).id !== 'clamshell') return keys;
  for (const [id, row] of Object.entries(CLAM_ROWS) as [OnePieceStageId, ClamStageId][]) keys[id] = keys[row];
  keys.S9 = hashString(JSON.stringify(['S9c', keys.S9, keys.S6x, keys.S7c, keys.S10c]));
  return keys;
}

/** The stages that build on these, directly or through others, with the stages themselves. */
export function downstream(ids: Iterable<StageId>): Set<StageId> {
  const found = new Set<StageId>(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const stage of STAGES) {
      if (!found.has(stage.id) && stage.deps.some((dep) => found.has(dep))) {
        found.add(stage.id);
        grew = true;
      }
    }
  }
  return found;
}

/** The stages these build on, with the stages themselves. */
export function upstream(ids: Iterable<StageId>): Set<StageId> {
  const found = new Set<StageId>();
  const visit = (id: StageId): void => {
    if (found.has(id)) return;
    found.add(id);
    STAGE_BY_ID.get(id)!.deps.forEach(visit);
  };
  for (const id of ids) visit(id);
  return found;
}

/** What the table says a change of this parameter must invalidate. */
export function invalidatedBy(path: ParamPath): Set<StageId> {
  return downstream(STAGES.filter((stage) => stage.params.includes(path)).map((stage) => stage.id));
}

/** The same for a non-parameter input. */
export function invalidatedByInput(name: InputName): Set<StageId> {
  return downstream(STAGES.filter((stage) => stage.inputs.includes(name)).map((stage) => stage.id));
}
