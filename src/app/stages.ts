import type { OpeningPin } from '../core/analysis/placement';
import type { Params } from '../core/params/schema';
import { hashString } from './hash';

/**
 * The plan's pipeline stages as data. Each stage names the parameters it reads itself and the stages it
 * builds on, and a stage's key is a hash of exactly those, so changing a parameter invalidates that
 * stage and everything downstream of it, and nothing else. test/unit/stages.test.ts is generated from
 * this table, and checks against the real stage code that no stage reads anything it does not declare.
 */
export type StageId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S13' | 'S14' | 'S15' | 'S16';

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
  /** The milestone whose code fills it, where that is not this one. */
  from?: number;
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

/** What the funnel is made of, and what the seat it sits in is. */
const FUNNEL: ParamPath[] = ['funnel.generate', 'funnel.topDiameter', 'funnel.height', 'funnel.neckHeight', 'funnel.wall', 'funnel.tipWall', 'funnel.seatClearance'];

export const STAGES: readonly StageDef[] = [
  { id: 'S1', label: 'parsed, audited, imported', runs: 'both', deps: [], params: [], inputs: ['file'] },
  { id: 'S2', label: 'oriented, footprint', runs: 'both', deps: ['S1'], params: ['base.planeTol', 'base.minIsland'], inputs: ['import', 'plane'] },
  // The preview cell's rule reads the size of the whole grid, so the grid's counts are here too.
  { id: 'S3', label: 'raster', runs: 'field', deps: ['S2'], params: ['quality.cellPreview', 'quality.cellFinal', 'grid.nx', 'grid.ny'], inputs: ['tier', 'cellScale'] },
  { id: 'S4', label: 'envelope', runs: 'field', deps: ['S3'], params: RADIUS, inputs: [] },
  { id: 'S5', label: 'composite', runs: 'field', deps: ['S4'], params: ['grid.nx', 'grid.ny', 'grid.spacing', ...DOMAIN], inputs: [] },
  { id: 'S6', label: 'conditioned', runs: 'field', deps: ['S5'], params: ['silicone.wallDraftDeg', 'silicone.closeWidth'], inputs: [] },
  {
    id: 'S7',
    label: 'peaks and placement',
    runs: 'field',
    deps: ['S6', 'S10'],
    params: [
      'pour.perModel', 'pour.diameter', 'pour.minLand', 'vents.enabled', 'vents.diameter', 'vents.persistence',
      'seat.enabled', 'seat.depth', 'seat.halfAngleDeg', 'funnel.generate', 'funnel.topDiameter', 'funnel.wall', 'funnel.seatClearance',
      // t / 2 is the cover drop, and the vents' persistence until edited. Bodies stand within the plane tolerance.
      'silicone.t', 'base.planeTol',
    ],
    inputs: ['pins', 'removed'],
  },
  { id: 'S8', label: 'intervals', runs: 'field', deps: ['S2'], params: ['quality.analysisCell'], inputs: [], from: 7 },
  {
    id: 'S9',
    label: 'geometry reports',
    runs: 'field',
    deps: ['S6', 'S7', 'S8', 'S10'],
    params: ['silicone.density', 'print.bedX', 'print.bedY', 'print.bedZ', 'print.infill', 'print.density', 'print.tapeStrip', 'reports.minVolumeMl', 'reports.undersidePersistence'],
    inputs: [],
    from: 7,
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
      'base.thickness', 'base.cornerRadius', 'base.bedReliefHeight', 'base.bedReliefRun', 'cover.wall', 'cover.topCap', 'cover.topChamfer', ...JOINT,
    ],
    inputs: [],
  },
  { id: 'S11', label: 'tool', runs: 'solid', deps: ['S6', 'S10'], params: ['quality.tinTolPreview', 'quality.tinTolFinal'], inputs: ['tier'] },
  { id: 'S12', label: 'cover body', runs: 'solid', deps: ['S11', 'S10'], params: [], inputs: [] },
  { id: 'S13', label: 'cover final', runs: 'solid', deps: ['S12', 'S7'], params: [], inputs: ['drag'] },
  { id: 'S14', label: 'base body', runs: 'solid', deps: ['S10'], params: [], inputs: [] },
  { id: 'S15', label: 'base final', runs: 'solid', deps: ['S14', 'S2'], params: ['base.mode', 'base.pocketDepth', 'base.pocketEnlarge', 'print.layerHeight', 'base.planeTol'], inputs: [] },
  { id: 'S16', label: 'funnel', runs: 'solid', deps: [], params: [...FUNNEL, 'seat.enabled', 'seat.depth', 'seat.halfAngleDeg', 'pour.diameter'], inputs: [] },
];

export const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

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
