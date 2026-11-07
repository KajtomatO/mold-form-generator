import type { Bounds } from '../mesh/weld';
import { resolveAuto } from '../params/defaults';
import type { Params } from '../params/schema';
import type { Diagnostic } from '../report/diagnostics';
import { closingHalfWidth } from './closing';

/** Node (i, j) sits at (x0 + i * cell, y0 + j * cell). A raster cell is centred on its node. */
export interface Grid {
  nx: number;
  ny: number;
  cell: number;
  x0: number;
  y0: number;
}

/** A plain object over a typed array, so a worker can post it and transfer the buffer. */
export interface Field extends Grid {
  values: Float32Array;
}

export function emptyField(grid: Grid, fill = 0): Field {
  const values = new Float32Array(grid.nx * grid.ny);
  if (fill !== 0) values.fill(fill);
  return { nx: grid.nx, ny: grid.ny, cell: grid.cell, x0: grid.x0, y0: grid.y0, values };
}

/** G6: above this many nodes the cell is raised, because memory and time follow the node count. */
export const NODE_CAP = 16_000_000;

/** G4, from the worst case for the distance between a source point and the grid nodes around it. */
export const MARGIN_CELLS = 2.13;

/** Added to the 2 lines a tile wall needs, in mm. At a 0.4 mm nozzle that makes the plan's 2 mm wall. */
const WALL_MARGIN = 1.2;
/**
 * What a measured wall can fall short of its nominal width, in cells: half a cell per side where the
 * raster centres a source past the wall, and up to one more per side where the cliff falls between nodes.
 */
const WALL_ROUNDING_CELLS = 3;

export interface FieldSettings {
  /** Cell of this field, which is the preview cell during a preview. */
  cell: number;
  /** The margin always uses this, so a preview has the same outer shape as the export. */
  cellFinal: number;
  t: number;
  printMargin: number;
  tinTol: number;
  /** False gives r = t with no vertical raise: the bare formula the volume oracles describe. */
  margin: boolean;
  draftDeg: number;
  closeWidth: number;
  nx: number;
  ny: number;
  /** Between model bounding boxes. Null follows the auto rule. */
  spacing: number | null;
  nozzle: number;
  /** Columns of the sealed air analysis. */
  analysisCell: number;
  /** A sealed domain below this volume is not reported, nor taken off the silicone. */
  minVolumeMl: number;
}

export function fieldSettings(params: Params, bounds: Bounds, cell: number = params.quality.cellFinal): FieldSettings {
  return {
    cell,
    cellFinal: params.quality.cellFinal,
    t: params.silicone.t,
    printMargin: resolveAuto(params, bounds).printMargin,
    tinTol: params.quality.tinTolFinal,
    margin: true,
    draftDeg: params.silicone.wallDraftDeg,
    closeWidth: params.silicone.closeWidth,
    nx: params.grid.nx,
    ny: params.grid.ny,
    spacing: params.grid.spacing,
    nozzle: params.print.nozzle,
    analysisCell: params.quality.analysisCell,
    minVolumeMl: params.reports.minVolumeMl,
  };
}

export interface FieldPlan {
  cell: number;
  rEff: number;
  /** Added to nodes above 0 by the tool builder in G7. It is not in the field itself. */
  raise: number;
  /** Highest possible cavity ceiling, from the vertices alone. */
  hMax: number;
  /** Domain of one tile, padded so that dilation, draft and closing all stay inside. */
  tile: Grid;
  /** Domain of the whole mold, with the same origin as tile (0, 0). */
  composite: Grid;
  /** Tile offsets in whole cells of this field. */
  pitchX: number;
  pitchY: number;
  /**
   * The pitch this field really uses, in mm, so anything placed on its tiles lines up with them. It
   * is a multiple of the export cell at the export cell, and that is the effective pitch the UI
   * shows. A preview cell may not divide it, so a preview's pitch can be up to a cell wider per tile.
   */
  pitchXmm: number;
  pitchYmm: number;
  /** What the auto rule asks for. A wall measured below the limit reports this as the fix. */
  autoSpacing: number;
  /** The wall the check asks for between tiles: 2 lines plus margin. */
  requiredWall: number;
  /** Spacing that was asked for, before snapping. */
  spacing: number;
  nx: number;
  ny: number;
  diagnostics: Diagnostic[];
}

function layout(bounds: Bounds, settings: FieldSettings, cell: number, cellFinal: number): FieldPlan {
  const { t, printMargin, tinTol, margin, draftDeg, closeWidth, nx, ny } = settings;
  const rEff = margin ? t + MARGIN_CELLS * cellFinal + printMargin : t;
  const raise = margin ? tinTol : 0;
  const hMax = bounds.max[2] + rEff + raise;
  const widening = hMax * Math.tan((draftDeg * Math.PI) / 180);
  const requiredWall = 2 * settings.nozzle + WALL_MARGIN;
  // Closing fills any wall narrower than its element, so a wide element needs a wider wall than
  // printing does, or auto spacing would merge the tiles it is there to keep apart.
  const closingSpan = 2 * closingHalfWidth(closeWidth, cellFinal) * cellFinal;
  const autoWall = Math.max(requiredWall, closingSpan + cellFinal);
  const autoSpacing = 2 * rEff + 2 * widening + autoWall + WALL_ROUNDING_CELLS * cellFinal;
  const spacing = settings.spacing ?? autoSpacing;

  const pad = Math.ceil((rEff + widening + closeWidth) / cell) + 4;
  const i0 = Math.floor(bounds.min[0] / cell) - pad;
  const j0 = Math.floor(bounds.min[1] / cell) - pad;
  const i1 = Math.ceil(bounds.max[0] / cell) + pad;
  const j1 = Math.ceil(bounds.max[1] / cell) + pad;
  const tile: Grid = { nx: i1 - i0 + 1, ny: j1 - j0 + 1, cell, x0: i0 * cell, y0: j0 * cell };

  // Rounding up means a typed spacing is never quietly reduced, at either cell. The small slack
  // stops a pitch that is already a whole multiple from gaining a cell through float noise.
  const snap = (mm: number, to: number): number => Math.ceil(mm / to - 1e-9);
  const pitchOf = (size: number): number => snap(snap(size + spacing, cellFinal) * cellFinal, cell);
  const pitchX = pitchOf(bounds.max[0] - bounds.min[0]);
  const pitchY = pitchOf(bounds.max[1] - bounds.min[1]);
  const pitchXmm = pitchX * cell;
  const pitchYmm = pitchY * cell;
  const composite: Grid = { ...tile, nx: tile.nx + (nx - 1) * pitchX, ny: tile.ny + (ny - 1) * pitchY };

  return { cell, rEff, raise, hMax, tile, composite, pitchX, pitchY, pitchXmm, pitchYmm, autoSpacing, requiredWall, spacing, nx, ny, diagnostics: [] };
}

/** G4 and G6: the radius, the domain and the pitch. Pure arithmetic, so the UI can show it at once. */
export function planField(bounds: Bounds, settings: FieldSettings): FieldPlan {
  let plan = layout(bounds, settings, settings.cell, settings.cellFinal);
  let cell = settings.cell, cellFinal = settings.cellFinal;
  // Padding and the margin both grow with the cell, so this checks again after each raise.
  while (plan.composite.nx * plan.composite.ny > NODE_CAP) {
    const needed = cell * Math.sqrt((plan.composite.nx * plan.composite.ny) / NODE_CAP);
    cell = Math.ceil(needed * 1000) / 1000;
    cellFinal = Math.max(cellFinal, cell);
    plan = layout(bounds, settings, cell, cellFinal);
  }
  if (cell !== settings.cell) {
    plan.diagnostics.push({
      code: 'cell-raised',
      severity: 'warning',
      message: `This mold would need more than ${NODE_CAP / 1_000_000} million field nodes, so the cell was raised from ${settings.cell} to ${cell} mm.`,
    });
  }
  return plan;
}
