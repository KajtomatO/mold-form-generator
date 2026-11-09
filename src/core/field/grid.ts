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
  /** The silicone base layer's least depth in mm, 0 or absent for none, and its slope. See baseLayer.ts. */
  baseLayer?: number;
  baseLayerSlopeDeg?: number;
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
    baseLayer: resolveAuto(params, bounds).baseLayer,
    baseLayerSlopeDeg: params.silicone.baseLayerSlopeDeg,
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
  /**
   * Where each column and each row of tiles starts, in whole nodes of this field. At the export cell these
   * are whole multiples of the pitch. A preview cell may not divide the pitch, so each preview tile sits
   * at the export's offset rounded to its own nearest node: at most half a preview cell off the parts,
   * which stand on the export's pitch, on every tile, however long the row.
   */
  shiftsX: number[];
  shiftsY: number[];
  /**
   * The export's pitch in mm, a whole number of export cells, at any cell of this field. It is the
   * effective pitch the UI shows, and the one every part and opening is placed on.
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

function layout(bounds: Bounds, settings: FieldSettings, cell: number, cellFinal: number, exportPitch: [number, number] | null): FieldPlan {
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

  // Rounding up means a typed spacing is never quietly reduced. The small slack stops a pitch that is
  // already a whole multiple from gaining a cell through float noise.
  const snap = (mm: number, to: number): number => Math.ceil(mm / to - 1e-9);
  const pitchOf = (size: number): number => snap(size + spacing, cellFinal) * cellFinal;
  const pitchXmm = exportPitch ? exportPitch[0] : pitchOf(bounds.max[0] - bounds.min[0]);
  const pitchYmm = exportPitch ? exportPitch[1] : pitchOf(bounds.max[1] - bounds.min[1]);
  // Rounded per tile, not as one pitch in this field's nodes, so the drift of a preview tile from the
  // export's never adds up along a row. At the export cell the quotient is whole and nothing moves.
  const shifts = (count: number, pitch: number): number[] => Array.from({ length: count }, (_, k) => Math.round((k * pitch) / cell));
  const shiftsX = shifts(nx, pitchXmm);
  const shiftsY = shifts(ny, pitchYmm);
  const composite: Grid = { ...tile, nx: tile.nx + shiftsX[nx - 1], ny: tile.ny + shiftsY[ny - 1] };

  return { cell, rEff, raise, hMax, tile, composite, shiftsX, shiftsY, pitchXmm, pitchYmm, autoSpacing, requiredWall, spacing, nx, ny, diagnostics: [] };
}

/** G4 and G6: the radius, the domain and the pitch. Pure arithmetic, so the UI can show it at once. */
export function planField(bounds: Bounds, settings: FieldSettings): FieldPlan {
  // A preview stands its tiles on the export's pitch, and widens its margin as the export does, both of
  // which a raise of the export's own cell past the node cap moves too. Snapped to the cell it was given
  // instead, a preview of a big grid drifted from the export by up to a raised cell per tile, and its
  // cavity came out narrower than the export's in the export's box.
  const exported = settings.cell === settings.cellFinal ? null : planField(bounds, { ...settings, cell: settings.cellFinal });
  const pitch: [number, number] | null = exported ? [exported.pitchXmm, exported.pitchYmm] : null;
  let cell = settings.cell, cellFinal = exported ? exported.cell : settings.cellFinal;
  let plan = layout(bounds, settings, cell, cellFinal, pitch);
  // Padding and the margin both grow with the cell, so this checks again after each raise. A preview's
  // margin stays the export's, even where the cap raises the preview's own cell too, to a rounding past it.
  while (plan.composite.nx * plan.composite.ny > NODE_CAP) {
    const needed = cell * Math.sqrt((plan.composite.nx * plan.composite.ny) / NODE_CAP);
    cell = Math.ceil(needed * 1000) / 1000;
    if (!exported) cellFinal = Math.max(cellFinal, cell);
    plan = layout(bounds, settings, cell, cellFinal, pitch);
  }
  if (cell !== settings.cell) {
    plan.diagnostics.push({
      code: 'cell-raised',
      severity: 'warning',
      message: `This mold would need more than ${NODE_CAP / 1_000_000} million field nodes, so the cell was raised from ${settings.cell} to ${cell} mm.`,
    });
  }
  // The export's own raise, which the preview's margin already follows, is said in the preview too.
  if (exported) plan.diagnostics.push(...exported.diagnostics.map((d) => (d.code === 'cell-raised' ? { ...d, code: 'export-cell-raised', message: `At full detail this mold would need more than ${NODE_CAP / 1_000_000} million field nodes, so the export's cell is raised from ${settings.cellFinal} to ${exported.cell} mm, which widens the safety margin, as the preview shows.` } : d)));
  return plan;
}

/**
 * The plan of the export field, whatever cell a preview is running at. Anything placed on the tiles,
 * and the rim around them, takes its offsets from here: a preview tile can sit half a preview cell off.
 */
export function exportPlan(bounds: Bounds, settings: FieldSettings): FieldPlan {
  return planField(bounds, { ...settings, cell: settings.cellFinal });
}

/** The shift of each tile in mm, row by row. Pass the export plan. */
export function tileOffsets(plan: FieldPlan): [number, number][] {
  const offsets: [number, number][] = [];
  for (let ty = 0; ty < plan.ny; ty++) {
    for (let tx = 0; tx < plan.nx; tx++) offsets.push([tx * plan.pitchXmm, ty * plan.pitchYmm]);
  }
  return offsets;
}
