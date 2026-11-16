import { BOLT_LENGTHS, BOLT_SIZES } from '../parts/fasteners';
// The attribute lets Node load it too, as the browser tests do through Playwright.
import DEFAULTS from './defaults.json' with { type: 'json' };

/**
 * The parameter table of docs/PLAN.md, as data, so the sidebar and project files can both be
 * driven from it. Ranges appear only where the plan states them, and for the bolts of M10.
 *
 * Every default value lives in defaults.json beside this file, and nothing else does: a builder can tune
 * them there (README.md, "Tuning the defaults"), and the build checks the file first (src/app/defaultsCheck.ts).
 * JSON holds no comments, so where a value has a recorded reason, it is in a comment beside its row here, or in
 * docs/PLAN.md (the Parameters table and the milestone that set it).
 * This table, not the file, gives the settings their order, which project.json and README.txt keep.
 *
 * An `auto` parameter stores null until the user types a value, and that null is its edited flag:
 * it keeps following its rule until edited, and reset is just setting it back to null. So its default in
 * defaults.json is null, and its rule stays in the code.
 */

/**
 * The version of project.json, which holds these parameters with the plane, pins and removed vents.
 * Version 1 came with M6b's export ZIP; 2 added the STL's hash and the base plane itself (M9); 3 the bolts
 * (M10); 4 changes no field but says that the pins and removed vents number bodies as joined parts (M11c's
 * rule, R1), which the app once told by the app version; 5 the silicone base layer, which a file of an older
 * format opens without; 6 the funnel's flange, which a file of an older format opens without too. An older
 * file is migrated one version at a time, by src/app/projectFile.ts.
 */
export const SCHEMA_VERSION = 6;

export interface NumberDef {
  kind: 'number';
  label: string;
  default: number;
  unit?: string;
  min?: number;
  max?: number;
  integer?: boolean;
}
export interface AutoDef {
  kind: 'auto';
  label: string;
  /** The rule, for the tooltip. The code for it is resolveAuto, or the milestone that owns it. */
  rule: string;
  default: null;
  unit?: string;
  min?: number;
  max?: number;
  /** The only values it takes once set, such as the lengths screws are sold in. */
  options?: readonly number[];
}
export interface FlagDef {
  kind: 'flag';
  label: string;
  default: boolean;
}
export interface ChoiceDef<T extends string = string> {
  kind: 'choice';
  label: string;
  options: readonly T[];
  default: T;
}
export type ParamDef = NumberDef | AutoDef | FlagDef | ChoiceDef;

type Range = { unit?: string; min?: number; max?: number; integer?: boolean };

function num(label: string, value: number, range: Range = {}): NumberDef {
  return { kind: 'number', label, default: value, unit: 'mm', ...range };
}
function auto(label: string, value: null, rule: string, range: Range = {}): AutoDef {
  return { kind: 'auto', label, rule, default: value, unit: 'mm', ...range };
}
function flag(label: string, value: boolean): FlagDef {
  return { kind: 'flag', label, default: value };
}
/** The file's value is any text to TypeScript; the build's check holds it to the options. */
function choice<T extends string>(label: string, options: readonly T[], value: string): ChoiceDef<T> {
  return { kind: 'choice', label, options, default: value as T };
}

/**
 * defaults.json, by group and key as this table has them. A group the file lacks, or holds as anything but an
 * object, reads as empty, so this module still loads with such a file, and the build's check, which loads it
 * too, can say what is wrong in its own words rather than stop on a TypeError here.
 */
const D = new Proxy({} as typeof DEFAULTS, {
  get(_, group) {
    const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
    const file: unknown = DEFAULTS;
    const given = object(file) && typeof group === 'string' && Object.hasOwn(file, group) ? file[group] : undefined;
    return object(given) ? given : {};
  },
});

const DEG = { unit: 'deg' };
const MM2 = { unit: 'mm2' };

export const PARAM_SCHEMA = {
  base: {
    mode: choice('Mode', ['glue', 'merged'] as const, D.base.mode),
    thickness: num('Thickness', D.base.thickness, { min: 3, max: 20 }),
    pocketDepth: auto('Pocket depth', D.base.pocketDepth, 'one layer', { min: 0.05, max: 2 }),
    pocketEnlarge: num('Pocket enlargement', D.base.pocketEnlarge, { min: 0, max: 1 }),
    planeTol: auto('Plane tolerance', D.base.planeTol, '0.0005 x model diagonal, kept within 0.05 to 0.2', { min: 0.01, max: 1 }),
    minIsland: num('Smallest island', D.base.minIsland, { ...MM2, min: 0, max: 100 }),
    cornerRadius: num('Corner radius', D.base.cornerRadius),
    bedReliefHeight: num('Bed relief height', D.base.bedReliefHeight),
    bedReliefRun: num('Bed relief run', D.base.bedReliefRun),
  },
  silicone: {
    t: num('Silicone thickness', D.silicone.t, { min: 1, max: 20 }),
    wallDraftDeg: num('Wall draft', D.silicone.wallDraftDeg, { ...DEG, min: 0, max: 5 }),
    closeWidth: num('Close fins under', D.silicone.closeWidth, { min: 0, max: 5 }),
    baseLayer: auto('Base layer', D.silicone.baseLayer, 'the silicone thickness', { min: 0, max: 20 }),
    baseLayerSlopeDeg: num('Base layer slope', D.silicone.baseLayerSlopeDeg, { ...DEG, min: 0, max: 10 }),
    density: num('Silicone density', D.silicone.density, { unit: 'g/cm3' }),
    printMargin: auto('Print margin', D.silicone.printMargin, 'half a layer'),
  },
  cover: {
    wall: num('Wall', D.cover.wall),
    topCap: num('Top cap', D.cover.topCap, { min: 3, max: 30 }),
    topChamfer: num('Top chamfer', D.cover.topChamfer),
  },
  joint: {
    taperDeg: num('Taper', D.joint.taperDeg, { ...DEG, min: 5, max: 30 }),
    taperClearance: num('Taper clearance per side', D.joint.taperClearance),
    landInner: num('Inner land', D.joint.landInner, { min: 0.8 }),
    landOuter: num('Outer land', D.joint.landOuter, { min: 0.8 }),
    ridgeWidth: num('Ridge width', D.joint.ridgeWidth),
    ridgeHeight: num('Ridge height', D.joint.ridgeHeight),
    ridgeDraftDeg: num('Ridge draft', D.joint.ridgeDraftDeg, DEG),
    grooveClearance: num('Groove clearance per side', D.joint.grooveClearance),
    grooveExtraDepth: num('Groove extra depth', D.joint.grooveExtraDepth),
    baseProud: num('Base proud', D.joint.baseProud),
    pryNotches: flag('Pry notches', D.joint.pryNotches),
    pryWidth: num('Pry notch width', D.joint.pryWidth),
    pryHeight: num('Pry notch height', D.joint.pryHeight),
  },
  // M10, off by default: tape stays the plain way. Clearances are per side, for a 0.4 mm nozzle (docs/PLAN.md, Measured at M10).
  bolts: {
    enabled: flag('Nuts and bolts', D.bolts.enabled),
    size: choice('Bolt size', BOLT_SIZES, D.bolts.size),
    length: { ...auto('Bolt length', D.bolts.length, 'the shortest standard length that reaches through the base and the nut, with 2 threads past it', { min: BOLT_LENGTHS[0], max: BOLT_LENGTHS[BOLT_LENGTHS.length - 1] }), options: BOLT_LENGTHS },
    holeClearance: num('Hole clearance per side', D.bolts.holeClearance, { min: 0, max: 1 }),
    nutClearance: num('Nut clearance per side', D.bolts.nutClearance, { min: 0, max: 2 }),
    minWall: num('Least wall round bolts', D.bolts.minWall, { min: 0.4, max: 5 }),
  },
  pour: {
    perModel: num('Pours per body', D.pour.perModel, { unit: '', min: 1, max: 16, integer: true }),
    diameter: num('Pour diameter', D.pour.diameter, { min: 4, max: 30 }),
    minLand: num('Land between openings', D.pour.minLand),
  },
  vents: {
    enabled: flag('Vents', D.vents.enabled),
    diameter: num('Vent diameter', D.vents.diameter, { min: 2, max: 6 }),
    persistence: auto('Smallest peak to vent', D.vents.persistence, 't / 2'),
  },
  seat: {
    enabled: flag('Funnel seat', D.seat.enabled),
    depth: num('Seat depth', D.seat.depth, { min: 1, max: 10 }),
    halfAngleDeg: num('Seat half angle', D.seat.halfAngleDeg, { ...DEG, min: 10, max: 45 }),
  },
  funnel: {
    generate: flag('Generate funnel', D.funnel.generate),
    topDiameter: num('Top diameter', D.funnel.topDiameter),
    height: num('Height', D.funnel.height),
    neckHeight: num('Neck height', D.funnel.neckHeight),
    wall: num('Wall', D.funnel.wall),
    tipWall: num('Tip wall', D.funnel.tipWall),
    seatClearance: num('Seat clearance', D.funnel.seatClearance),
    // FL: a flat ring round the spigot's root that rests on the cover's top, so the funnel stands square. 0 leaves it out.
    // D21: 2 mm, where FL had 4, the user's choice of 2026-11-16, so the vent beside a pour on a peak stands 2 mm nearer it.
    flangeWidth: num('Flange width', D.funnel.flangeWidth, { min: 0, max: 10 }),
    flangeThickness: num('Flange thickness', D.funnel.flangeThickness, { min: 0.6, max: 5 }),
  },
  grid: {
    nx: num('Columns', D.grid.nx, { unit: '', min: 1, max: 20, integer: true }),
    ny: num('Rows', D.grid.ny, { unit: '', min: 1, max: 20, integer: true }),
    spacing: auto('Spacing', D.grid.spacing, '2 r_eff + 2 Hmax tan(draft) + a wall of 2 lines plus 1.2 mm, or the closing width if wider, + 3 cells of rounding', { min: 0, max: 100 }),
    edge: auto('Edge distance', D.grid.edge, 'smallest that fits the joint', { min: 0, max: 100 }),
  },
  print: {
    layerHeight: num('Layer height', D.print.layerHeight),
    nozzle: num('Nozzle', D.print.nozzle),
    bedX: num('Bed X', D.print.bedX),
    bedY: num('Bed Y', D.print.bedY),
    bedZ: num('Bed Z', D.print.bedZ),
    // D19: the user prints these parts at 5 percent or less, as they carry little load (2026-11-12).
    infill: num('Infill', D.print.infill, { unit: '' }),
    density: num('Plastic density', D.print.density, { unit: 'g/cm3' }),
    tapeStrip: num('Tape strip holds', D.print.tapeStrip, { unit: 'N' }),
  },
  quality: {
    cellFinal: num('Export cell', D.quality.cellFinal, { min: 0.05, max: 0.5 }),
    cellPreview: auto('Preview cell', D.quality.cellPreview, 'max(0.5, L / 1024)'),
    analysisCell: num('Analysis cell', D.quality.analysisCell),
    tinTolFinal: num('Export TIN tolerance', D.quality.tinTolFinal),
    tinTolPreview: num('Preview TIN tolerance', D.quality.tinTolPreview),
  },
  reports: {
    minVolumeMl: num('Smallest reported volume', D.reports.minVolumeMl, { unit: 'ml' }),
    undersidePersistence: num('Smallest air pocket depth', D.reports.undersidePersistence),
  },
} as const satisfies Record<string, Record<string, ParamDef>>;

/** Each group of PARAM_SCHEMA by the name the sidebar's Advanced section and README.txt give it. */
export const GROUP_TITLES: Record<string, string> = {
  base: 'Base',
  silicone: 'Silicone',
  cover: 'Cover',
  joint: 'Joint',
  bolts: 'Bolts',
  pour: 'Pour',
  vents: 'Vents',
  seat: 'Seat',
  funnel: 'Funnel',
  grid: 'Grid',
  print: 'Printer',
  quality: 'Quality',
  reports: 'Reports',
} satisfies Record<keyof typeof PARAM_SCHEMA, string>;

type ValueOf<D> = D extends AutoDef ? number | null : D extends NumberDef ? number : D extends FlagDef ? boolean : D extends ChoiceDef<infer T> ? T : never;

export type Params = {
  -readonly [G in keyof typeof PARAM_SCHEMA]: { -readonly [K in keyof (typeof PARAM_SCHEMA)[G]]: ValueOf<(typeof PARAM_SCHEMA)[G][K]> };
};
