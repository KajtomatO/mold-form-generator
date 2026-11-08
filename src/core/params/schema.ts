/**
 * The parameter table of docs/PLAN.md, as data, so the sidebar and project files can both be
 * driven from it. Ranges appear only where the plan states them. Bolts arrive with M10.
 *
 * An `auto` parameter stores null until the user types a value, and that null is its edited flag:
 * it keeps following its rule until edited, and reset is just setting it back to null.
 */
export const SCHEMA_VERSION = 1;

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
function auto(label: string, rule: string, range: Range = {}): AutoDef {
  return { kind: 'auto', label, rule, default: null, unit: 'mm', ...range };
}
function flag(label: string, value: boolean): FlagDef {
  return { kind: 'flag', label, default: value };
}
function choice<T extends string>(label: string, options: readonly T[], value: T): ChoiceDef<T> {
  return { kind: 'choice', label, options, default: value };
}

const DEG = { unit: 'deg' };
const MM2 = { unit: 'mm2' };

export const PARAM_SCHEMA = {
  base: {
    mode: choice('Mode', ['glue', 'merged'] as const, 'glue'),
    thickness: num('Thickness', 4, { min: 3, max: 20 }),
    pocketDepth: auto('Pocket depth', 'one layer', { min: 0.05, max: 2 }),
    pocketEnlarge: num('Pocket enlargement', 0.2, { min: 0, max: 1 }),
    planeTol: auto('Plane tolerance', '0.0005 x model diagonal, kept within 0.05 to 0.2', { min: 0.01, max: 1 }),
    minIsland: num('Smallest island', 5, { ...MM2, min: 0, max: 100 }),
    cornerRadius: num('Corner radius', 3),
    bedReliefHeight: num('Bed relief height', 0.4),
    bedReliefRun: num('Bed relief run', 0.3),
  },
  silicone: {
    t: num('Silicone thickness', 3, { min: 1, max: 20 }),
    wallDraftDeg: num('Wall draft', 1, { ...DEG, min: 0, max: 5 }),
    closeWidth: num('Close fins under', 1.2, { min: 0, max: 5 }),
    density: num('Silicone density', 1.1, { unit: 'g/cm3' }),
    printMargin: auto('Print margin', 'half a layer'),
  },
  cover: {
    wall: num('Wall', 3),
    topCap: num('Top cap', 5, { min: 3, max: 30 }),
    topChamfer: num('Top chamfer', 0.4),
  },
  joint: {
    taperDeg: num('Taper', 15, { ...DEG, min: 5, max: 30 }),
    taperClearance: num('Taper clearance per side', 0.1),
    landInner: num('Inner land', 2, { min: 0.8 }),
    landOuter: num('Outer land', 2, { min: 0.8 }),
    ridgeWidth: num('Ridge width', 1.6),
    ridgeHeight: num('Ridge height', 1.2),
    ridgeDraftDeg: num('Ridge draft', 10, DEG),
    grooveClearance: num('Groove clearance per side', 0.25),
    grooveExtraDepth: num('Groove extra depth', 0.3),
    baseProud: num('Base proud', 0.2),
    pryNotches: flag('Pry notches', true),
    pryWidth: num('Pry notch width', 12),
    pryHeight: num('Pry notch height', 1.2),
  },
  pour: {
    perModel: num('Pours per body', 1, { unit: '', min: 1, max: 16, integer: true }),
    diameter: num('Pour diameter', 10, { min: 4, max: 30 }),
    minLand: num('Land between openings', 1.5),
  },
  vents: {
    enabled: flag('Vents', true),
    diameter: num('Vent diameter', 2.5, { min: 2, max: 6 }),
    persistence: auto('Smallest peak to vent', 't / 2'),
  },
  seat: {
    enabled: flag('Funnel seat', true),
    depth: num('Seat depth', 3, { min: 1, max: 10 }),
    halfAngleDeg: num('Seat half angle', 30, { ...DEG, min: 10, max: 45 }),
  },
  funnel: {
    generate: flag('Generate funnel', true),
    topDiameter: num('Top diameter', 40),
    height: num('Height', 30),
    neckHeight: num('Neck height', 10),
    wall: num('Wall', 1.2),
    tipWall: num('Tip wall', 0.86),
    seatClearance: num('Seat clearance', 0.1),
  },
  grid: {
    nx: num('Columns', 1, { unit: '', min: 1, max: 20, integer: true }),
    ny: num('Rows', 1, { unit: '', min: 1, max: 20, integer: true }),
    spacing: auto('Spacing', '2 r_eff + 2 Hmax tan(draft) + a wall of 2 lines plus 1.2 mm, or the closing width if wider, + 3 cells of rounding', { min: 0, max: 100 }),
    edge: auto('Edge distance', 'smallest that fits the joint', { min: 0, max: 100 }),
  },
  print: {
    layerHeight: num('Layer height', 0.2),
    nozzle: num('Nozzle', 0.4),
    bedX: num('Bed X', 220),
    bedY: num('Bed Y', 220),
    bedZ: num('Bed Z', 250),
    infill: num('Infill', 0.35, { unit: '' }),
    density: num('Plastic density', 1.24, { unit: 'g/cm3' }),
    tapeStrip: num('Tape strip holds', 10, { unit: 'N' }),
  },
  quality: {
    cellFinal: num('Export cell', 0.125, { min: 0.05, max: 0.5 }),
    cellPreview: auto('Preview cell', 'max(0.5, L / 1024)'),
    analysisCell: num('Analysis cell', 0.25),
    tinTolFinal: num('Export TIN tolerance', 0.05),
    tinTolPreview: num('Preview TIN tolerance', 0.1),
  },
  reports: {
    minVolumeMl: num('Smallest reported volume', 0.05, { unit: 'ml' }),
    undersidePersistence: num('Smallest air pocket depth', 0.3),
  },
} as const satisfies Record<string, Record<string, ParamDef>>;

/** Each group of PARAM_SCHEMA by the name the sidebar's Advanced section and README.txt give it. */
export const GROUP_TITLES: Record<string, string> = {
  base: 'Base',
  silicone: 'Silicone',
  cover: 'Cover',
  joint: 'Joint',
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
