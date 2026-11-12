import { PARAM_SCHEMA, type AutoDef, type NumberDef, type ParamDef } from '../core/params/schema';
import type { ParamPath } from '../app/stages';

/**
 * Where every parameter of PARAM_SCHEMA has its one control, in the sidebar's workflow order. Rarely
 * used ones sit in Advanced, under their schema group. test/unit/layout.test.ts checks that each
 * parameter is placed exactly once, so a parameter added to the schema cannot go without a control.
 */
export type SectionId = 'model' | 'base' | 'silicone' | 'cover' | 'pour' | 'grid' | 'advanced';

export const SECTION_PARAMS: Record<SectionId, readonly ParamPath[]> = {
  model: ['base.planeTol'],
  base: ['base.mode', 'base.thickness', 'print.layerHeight', 'base.pocketDepth', 'base.pocketEnlarge'],
  silicone: ['silicone.t', 'silicone.baseLayer', 'silicone.wallDraftDeg', 'silicone.density'],
  // The bolts close the section as a group of their own, and their rows show only once the toggle is on.
  cover: [
    'cover.wall', 'cover.topCap', 'joint.taperDeg', 'joint.taperClearance', 'joint.grooveClearance', 'joint.ridgeWidth', 'joint.ridgeHeight', 'joint.pryNotches',
    'bolts.enabled', 'bolts.size', 'bolts.length', 'bolts.holeClearance', 'bolts.nutClearance', 'bolts.minWall',
  ],
  pour: ['pour.perModel', 'pour.diameter', 'vents.enabled', 'vents.diameter', 'seat.enabled', 'seat.depth', 'funnel.generate', 'funnel.topDiameter', 'funnel.height', 'funnel.flangeWidth'],
  grid: ['grid.nx', 'grid.ny', 'grid.spacing', 'grid.edge'],
  advanced: [
    'base.minIsland', 'base.cornerRadius', 'base.bedReliefHeight', 'base.bedReliefRun',
    'silicone.baseLayerSlopeDeg', 'silicone.closeWidth', 'silicone.printMargin',
    'cover.topChamfer',
    'joint.landInner', 'joint.landOuter', 'joint.ridgeDraftDeg', 'joint.grooveExtraDepth', 'joint.baseProud', 'joint.pryWidth', 'joint.pryHeight',
    'pour.minLand', 'vents.persistence', 'seat.halfAngleDeg',
    'funnel.neckHeight', 'funnel.wall', 'funnel.tipWall', 'funnel.seatClearance', 'funnel.flangeThickness',
    'print.nozzle', 'print.bedX', 'print.bedY', 'print.bedZ', 'print.infill', 'print.density', 'print.tapeStrip',
    'quality.cellFinal', 'quality.cellPreview', 'quality.analysisCell', 'quality.tinTolFinal', 'quality.tinTolPreview',
    'reports.minVolumeMl', 'reports.undersidePersistence',
  ],
};

/** Advanced's sub-headings, by schema group, which README.txt's list of settings uses too. */
export { GROUP_TITLES } from '../core/params/schema';

/** Advanced groups whose settings feed a report rather than a part, said where they sit so a maker knows where to look. */
export const GROUP_NOTES: Partial<Record<string, string>> = {
  print: 'Bed X, Y and Z are checked against the cover and base as they print. Infill and Plastic density give the plastic estimate in Diagnostics, and Tape strip holds the tape advice under Cover & joint.',
  reports: 'These filter the Demold report and its air traps: smaller silicone, air and sealed space is left out as noise.',
};

/**
 * The slider's travel where the schema states no range. The number box still takes any value the
 * schema allows, past the slider's ends, as only the schema's own range is a rule.
 */
const SLIDER_RANGES: Partial<Record<ParamPath, [number, number]>> = {
  'base.pocketDepth': [0.05, 1],
  'base.planeTol': [0.01, 0.5],
  'base.cornerRadius': [0, 10],
  'base.bedReliefHeight': [0, 1],
  'base.bedReliefRun': [0, 1],
  'silicone.density': [0.9, 1.6],
  'silicone.printMargin': [0, 0.5],
  'cover.wall': [1.2, 10],
  'cover.topChamfer': [0, 2],
  'joint.taperClearance': [0, 0.5],
  'joint.landInner': [0.8, 6],
  'joint.landOuter': [0.8, 6],
  'joint.ridgeWidth': [0.8, 4],
  'joint.ridgeHeight': [0.4, 4],
  'joint.ridgeDraftDeg': [0, 30],
  'joint.grooveClearance': [0, 0.8],
  'joint.grooveExtraDepth': [0, 2],
  'joint.baseProud': [0, 1],
  'joint.pryWidth': [4, 30],
  'joint.pryHeight': [0.4, 3],
  'pour.minLand': [0.5, 5],
  'vents.persistence': [0, 10],
  'funnel.topDiameter': [10, 80],
  'funnel.height': [10, 80],
  'funnel.neckHeight': [2, 30],
  'funnel.wall': [0.8, 3],
  'funnel.tipWall': [0.4, 2],
  'funnel.seatClearance': [0, 0.5],
  'grid.spacing': [0, 60],
  'grid.edge': [0, 60],
  'print.layerHeight': [0.05, 0.4],
  'print.nozzle': [0.2, 1],
  'print.bedX': [100, 500],
  'print.bedY': [100, 500],
  'print.bedZ': [100, 500],
  'print.infill': [0, 1],
  'print.density': [0.9, 1.6],
  'print.tapeStrip': [1, 50],
  'quality.cellPreview': [0.25, 2],
  'quality.analysisCell': [0.1, 1],
  'quality.tinTolFinal': [0.01, 0.2],
  'quality.tinTolPreview': [0.02, 0.5],
  'reports.minVolumeMl': [0, 1],
  'reports.undersidePersistence': [0, 2],
};

/**
 * What a typed entry means: a value to use, or why it cannot be one. The rule is the schema's range,
 * with the floor of entryDef standing in where a quantity must be above 0 and the schema states none.
 */
export function parseEntry(text: string, def: NumberDef | AutoDef): { value: number } | { error: string } {
  const trimmed = text.trim().replace(',', '.');
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) return { error: 'Enter a number.' };
  if (def.kind === 'number' && def.integer && !Number.isInteger(value)) return { error: 'Enter a whole number.' };
  const low = def.min ?? 0, high = def.max;
  if (value < low || (high !== undefined && value > high)) {
    return { error: high === undefined ? `Enter a value of at least ${low}.` : `Enter a value from ${low} to ${high}.` };
  }
  return { value };
}

/** One step of the slider and of the wheel. Shift takes ten, Ctrl a tenth. */
const STEPS: Partial<Record<ParamPath, number>> = {
  'silicone.baseLayer': 0.1,
  'base.planeTol': 0.01,
  'base.pocketDepth': 0.01,
  'silicone.printMargin': 0.01,
  'vents.persistence': 0.1,
  'grid.spacing': 0.5,
  'grid.edge': 0.5,
  'quality.cellPreview': 0.05,
  'quality.cellFinal': 0.005,
  'silicone.density': 0.01,
  'print.density': 0.01,
};

/**
 * The least a control takes where the schema states no minimum but 0 has no meaning. A cell of 0 asks
 * for an endless lattice, a layer of 0 makes the pocket that follows it 0 deep, and a nozzle, wall or
 * TIN tolerance of 0 is no part anyone can print or build. The layer's floor is the pocket's own
 * minimum, so a pocket following the layer is always one the pocket's range allows.
 */
const ENTRY_FLOORS: Partial<Record<ParamPath, number>> = {
  'print.layerHeight': 0.05,
  'print.nozzle': 0.1,
  'cover.wall': 0.4,
  'quality.cellPreview': 0.05,
  'quality.analysisCell': 0.05,
  'quality.tinTolFinal': 0.01,
  'quality.tinTolPreview': 0.01,
  'print.tapeStrip': 0.1,
};

export function defOf(path: ParamPath): ParamDef {
  const [group, key] = path.split('.');
  return (PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>)[group][key];
}

/** The definition a control checks entries against: the schema's, with a floor where it has no minimum of its own. */
export function entryDef(path: ParamPath): ParamDef {
  const def = defOf(path);
  const floor = ENTRY_FLOORS[path];
  if (floor === undefined || (def.kind !== 'number' && def.kind !== 'auto') || def.min !== undefined) return def;
  return { ...def, min: floor };
}

export function sliderRange(path: ParamPath, def: ParamDef): [number, number] {
  if (def.kind !== 'number' && def.kind !== 'auto') return [0, 1];
  const set = SLIDER_RANGES[path];
  if (set) return [def.min ?? set[0], def.max ?? set[1]];
  if (def.min !== undefined && def.max !== undefined) return [def.min, def.max];
  throw new Error(`${path} has no slider range: give it one in SLIDER_RANGES.`);
}

export function stepOf(path: ParamPath, def: ParamDef): number {
  if (def.kind === 'number' && def.integer) return 1;
  const set = STEPS[path];
  if (set) return set;
  const typical = def.kind === 'number' ? def.default : 1;
  return typical < 1 ? 0.01 : typical < 20 ? 0.1 : 1;
}

/** Labels for a choice's options, as the user reads them. */
export const OPTION_LABELS: Record<string, string> = { glue: 'Glue in (A)', merged: 'Merged (B)' };

/** Tooltips: what each control does, where the label alone does not say. */
export const HINTS: Partial<Record<ParamPath, string>> = {
  'base.mode': 'A: print the model on its own and glue it into a pocket in the base. B: the model is part of the base.',
  'base.pocketDepth': 'Follows the layer height until you set it. Double-click to follow again.',
  'base.planeTol': 'Corners this close to the base plane count as standing on it.',
  'silicone.t': 'The least silicone between the model and the cover, everywhere.',
  'silicone.wallDraftDeg': 'Lets the silicone slide out of the cover.',
  'silicone.baseLayer': 'Silicone over the whole base plate inside the joint, which joins every copy and body into one mold. Follows the silicone thickness until you set it; 0 leaves it out. Double-click to follow again.',
  'silicone.baseLayerSlopeDeg': 'The top of the base layer rises towards the models by this angle, so air under it moves to them and out through their vents. 0 makes it flat.',
  'grid.spacing': 'Between the models\' bounding boxes. Auto keeps a printable wall between them.',
  'grid.edge': 'From the models to the outside of the box. A minimum: the joint may need more.',
  'pour.perModel': 'Pours for each separate body in the model. Parts that overlap or touch, as in a model split for multi-colour printing, are one body.',
  'bolts.enabled': 'Four countersunk screws up through the base\'s corners into hex nuts slid into the cover\'s sides, in place of most of the tape. The box grows to hold them.',
  'bolts.size': 'Metric countersunk screws (ISO 10642 or DIN 7991; ISO 14581 for M2.5) and ISO 4032 hex nuts.',
  'bolts.length': 'Over the head, as countersunk screws are sold. Auto takes the shortest that passes the nut by 2 threads.',
  'bolts.holeClearance': 'Added to the screw\'s radius in the holes and countersinks. 0.2 suits a 0.4 mm nozzle, which prints holes about 0.1 mm small per side.',
  'bolts.nutClearance': 'Added to each side of the nut in its slot. 0.15 lets a nut slide in by hand on a 0.4 mm nozzle and stay.',
  'bolts.minWall': 'The least plastic between the bolts\' holes and slots and the cavity, the groove and the outside.',
  'funnel.flangeWidth': 'A flat ring round the foot of the funnel, this far past the seat\'s edge. It rests flat on the cover\'s top, so the funnel stands steady and seals there. Vents keep clear of it. 0 leaves it out.',
  'funnel.flangeThickness': 'The height of the flange\'s outer edge. Above it a 45 degree chamfer runs in to the neck, so it prints without supports.',
};
