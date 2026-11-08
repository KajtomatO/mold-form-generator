import { findBodies } from '../core/analysis/bodies';
import { placementSettings, placeOpenings, type OpeningPin, type Placement } from '../core/analysis/placement';
import { openingSizes, placementSpace, primeSpace, type OpeningKind } from '../core/analysis/validate';
import { candidateAtLevel, candidateFromPick, findBaseCandidates, levelNear, pickable, type BaseCandidate } from '../core/base/candidates';
import { orientToBase, type OrientedModel } from '../core/base/orient';
import { conditionField } from '../core/field/build';
import { compositeTiles } from '../core/field/composite';
import { dilate } from '../core/field/dilate';
import { emptyField, fieldSettings, planField, type Field, type FieldPlan, type FieldSettings, type Grid } from '../core/field/grid';
import { NO_SOURCE, rasterize } from '../core/field/raster';
import { exteriorMesh } from '../core/field/sealed';
import { volumeAbovePlane } from '../core/field/silicone';
import { auditEdges, type MeshAudit, type OpenLoop } from '../core/mesh/audit';
import { meshBounds, weld, type Bounds, type WeldedMesh } from '../core/mesh/weld';
import { baseOptions, resolveAuto } from '../core/params/defaults';
import type { Params } from '../core/params/schema';
import { deriveRim, moldBounds, type MoldBounds, type Rim } from '../core/parts/rim';
import type { Diagnostic } from '../core/report/diagnostics';
import type { Rect } from '../core/solid/rect';
import { parseStl } from '../core/stl/parse';
import type { StageId } from '../app/stages';

/**
 * Which base plane: one of the ranked candidates, or the plane through a clicked triangle. `upper` is
 * false, or the offset of the level to stand on instead, as the footprint's level report offered it. It
 * names the level, because only that report knows which level silicone can reach (G2.6).
 */
export type PlaneChoice = { rank: number; upper: number | false } | { pick: number; upper: number | false };

export const DEFAULT_PLANE: PlaneChoice = { rank: 0, upper: false };

export function samePlane(a: PlaneChoice, b: PlaneChoice): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What the import in solid.worker did to the mesh. Field.worker starts on the welded mesh at once, as
 * if the import changes nothing, which holds for every example. If it does change it, the pipeline
 * sends the new mesh with a new key and S2 runs again.
 */
export interface ImportInput {
  /** 'plain' for the welded mesh as it is. */
  key: string;
  soup: boolean;
  /** Only when the import flipped or recomposed it. */
  mesh: WeldedMesh | null;
  openLoops: OpenLoop[];
}

export const PLAIN_IMPORT: ImportInput = { key: 'plain', soup: false, mesh: null, openLoops: [] };

/** The rule of the parameter table: max(0.5, L / 1024), with L the longest side of the grid of models. */
export function previewCell(params: Params, bounds: Bounds): number {
  if (params.quality.cellPreview !== null) return params.quality.cellPreview;
  const { nx, ny } = params.grid;
  const span = Math.max(nx * (bounds.max[0] - bounds.min[0]), ny * (bounds.max[1] - bounds.min[1]));
  return Math.max(0.5, span / 1024);
}

export interface FieldInputs {
  /** The file, sent only while the worker does not hold S1. */
  file: ArrayBuffer | null;
  import: ImportInput;
  plane: PlaneChoice;
  cellScale: number;
  pins: OpeningPin[];
  removed: string[];
}

export interface ParsedModel {
  format: 'binary' | 'ascii';
  rawTriangles: number;
  triangles: number;
  degenerate: number;
  welded: WeldedMesh;
  audit: MeshAudit;
  diagnostics: Diagnostic[];
}

/** A candidate as the list shows it, with its triangles, so main can highlight one before it is chosen. */
export interface CandidateSummary {
  normal: [number, number, number];
  area: number;
  offset: number;
  /** With the levels, what a project file's saved plane is matched against when its choice no longer finds it. */
  support: number;
  levels: BaseCandidate['levels'];
  source: BaseCandidate['source'];
  members: Uint32Array;
}

export interface OrientedStage {
  candidates: CandidateSummary[];
  chosen: BaseCandidate;
  oriented: OrientedModel;
  bounds: Bounds;
  /** Of the whole mesh before orienting, as G2 detects the plane with it. */
  planeTol: number;
  /** The model above the plane in mm3, voids left out: what one tile takes off the silicone under H. */
  modelVolume: number;
  diagnostics: Diagnostic[];
}

/** The field on its own node lattice: node (i, j) of a grid is at ((i0 + i) * cell, (j0 + j) * cell). */
interface Lattice {
  field: Field;
  i0: number;
  j0: number;
}

interface ConditionedStage {
  plan: FieldPlan;
  settings: FieldSettings;
  /** The composite, conditioned. */
  field: Field;
  /** The one tile conditioned on its own, which placement works on. The same object as `field` for one tile. */
  tile: Field;
  diagnostics: Diagnostic[];
}

export interface MoldStage {
  mold: MoldBounds;
  rim: Rim;
}

/** What main receives at the end of T1: the field, its plan in brief, and the export plan's bounds. */
export interface FieldOutput {
  field: Field;
  cell: number;
  rEff: number;
  pitch: [number, number];
  mold: MoldBounds;
  rim: Rim;
  diagnostics: Diagnostic[];
}

export interface PlacementOutput {
  placement: Placement;
  /** The placement space's distance map and fit boxes, built here so a drop on main never waits for them. */
  clearance: Float32Array;
  fits: Partial<Record<OpeningKind, Rect | null>>;
}

export interface FieldOutputs {
  S1?: ParsedModel;
  S2?: OrientedStage;
  S6?: FieldOutput;
  S7?: PlacementOutput;
}

export type FieldWanted = keyof FieldOutputs;

/** The worker lacks a stage the job did not bring the inputs for. The pipeline sends it again with them. */
export class StageMiss extends Error {
  constructor(readonly stage: StageId) {
    super(`Stage ${stage} is not cached here and the job did not bring its inputs.`);
    this.name = 'StageMiss';
  }
}

interface Entry<T> {
  key: string;
  value: T;
}

export interface FieldTimings {
  [stage: string]: number;
}

/** Copies a field into a larger grid of the same cell, at whole-node offsets, filling the rest. */
function embed(from: Lattice, grid: Grid, fill: number): Field {
  const out = emptyField(grid, fill);
  const di = from.i0 - Math.round(grid.x0 / grid.cell), dj = from.j0 - Math.round(grid.y0 / grid.cell);
  const { nx, ny, values } = from.field;
  if (di < 0 || dj < 0 || di + nx > grid.nx || dj + ny > grid.ny) throw new Error('A field does not fit the domain it is copied into.');
  for (let j = 0; j < ny; j++) out.values.set(values.subarray(j * nx, (j + 1) * nx), (j + dj) * grid.nx + di);
  return out;
}

/** Nodes of `cell` around the bounding box, with one node of room on each side for the raster. */
function tightLattice(bounds: Bounds, cell: number, pad: number): { grid: Grid; i0: number; j0: number } {
  const i0 = Math.floor(bounds.min[0] / cell) - pad, j0 = Math.floor(bounds.min[1] / cell) - pad;
  const i1 = Math.ceil(bounds.max[0] / cell) + pad, j1 = Math.ceil(bounds.max[1] / cell) + pad;
  return { grid: { nx: i1 - i0 + 1, ny: j1 - j0 + 1, cell, x0: i0 * cell, y0: j0 * cell }, i0, j0 };
}

/**
 * S1 to S7 of the preview, one stage at a time, each kept under the key the pipeline gave it. Pure JS,
 * so this is all of field.worker, and Node tests run the same code. The raster covers the model alone
 * and the envelope reaches only as far as the radius, so moving t does not raster again and moving the
 * draft or the closing does not dilate again: each is copied into the wider domain of the step after.
 */
export class FieldStages {
  private s1: Entry<ParsedModel> | null = null;
  private s2: Entry<OrientedStage> | null = null;
  private s3: Entry<Lattice> | null = null;
  private s4: Entry<Lattice> | null = null;
  private s5: Entry<{ plan: FieldPlan; settings: FieldSettings; tile: Field; composite: Field }> | null = null;
  private s6: Entry<ConditionedStage> | null = null;
  private s10: Entry<MoldStage> | null = null;
  private s7: Entry<PlacementOutput> | null = null;

  constructor(private readonly now: () => number = () => 0) {}

  cached(): Partial<Record<StageId, string>> {
    const out: Partial<Record<StageId, string>> = {};
    const add = (id: StageId, entry: Entry<unknown> | null): void => {
      if (entry) out[id] = entry.key;
    };
    add('S1', this.s1);
    add('S2', this.s2);
    add('S3', this.s3);
    add('S4', this.s4);
    add('S5', this.s5);
    add('S6', this.s6);
    add('S7', this.s7);
    add('S10', this.s10);
    return out;
  }

  /** Drops everything, as loading another file does: the old model's arrays are the biggest thing here. */
  clear(): void {
    this.s1 = this.s2 = this.s3 = this.s4 = this.s5 = this.s6 = this.s10 = this.s7 = null;
  }

  /**
   * Builds what `want` asks for. field.worker asks for placement in a run of its own, after it has sent
   * the field, since the field is what T1 waits for.
   */
  run(keys: Record<StageId, string>, want: FieldWanted[], params: Params, inputs: FieldInputs, timings: FieldTimings = {}): FieldOutputs {
    const timed = <T>(stage: string, build: () => T): T => {
      const t0 = this.now();
      const value = build();
      timings[stage] = (timings[stage] ?? 0) + this.now() - t0;
      return value;
    };

    const s1 = (): ParsedModel => {
      if (this.s1?.key === keys.S1) return this.s1.value;
      if (!inputs.file) throw new StageMiss('S1');
      const value = timed('S1', () => {
        const parsed = parseStl(new Uint8Array(inputs.file!));
        const welded = weld(parsed.positions);
        return { format: parsed.format, rawTriangles: parsed.rawTriangleCount, triangles: parsed.triangleCount, degenerate: parsed.degenerateCount, welded, audit: auditEdges(welded), diagnostics: parsed.diagnostics };
      });
      this.s1 = { key: keys.S1, value };
      return value;
    };

    const s2 = (): OrientedStage => {
      if (this.s2?.key === keys.S2) return this.s2.value;
      const { welded } = s1();
      const value = timed('S2', () => {
        const { import: outcome, plane } = inputs;
        if (outcome.key !== 'plain' && !outcome.mesh) throw new StageMiss('S2');
        const mesh = outcome.mesh ?? welded;
        const whole = meshBounds(welded.positions);
        const planeTol = resolveAuto(params, whole).planeTol;
        const base = baseOptions(params, whole);
        const soup = outcome.soup ? { openLoops: outcome.openLoops } : undefined;
        const ranked = findBaseCandidates(mesh, base, soup);
        if (ranked.length === 0) throw new InlineError('no-base', 'This model has no flat face to stand on a base.');
        // A project file's pick can name a triangle this version's weld does not have. That is the file's
        // input, not a crash, and the pipeline then stands the model on a ranked face instead.
        if ('pick' in plane && !pickable(mesh, plane.pick)) throw new InlineError('plane-pick', `The face picked as the base, triangle ${plane.pick + 1}, is not a face of this model. Choose the base face again.`);
        let chosen = 'rank' in plane ? ranked[Math.min(plane.rank, ranked.length - 1)] : candidateFromPick(mesh, plane.pick, base, ranked);
        const diagnostics: Diagnostic[] = [];
        if (plane.upper !== false) {
          const level = levelNear(chosen, plane.upper, planeTol);
          if (level) chosen = candidateAtLevel(mesh, chosen, level.offset, base);
          else diagnostics.push({ code: 'upper-level-gone', severity: 'warning', message: `The upper level ${plane.upper.toFixed(2)} mm in is not found at this plane tolerance, so the model stands on the plane itself.` });
        }
        const oriented = orientToBase(mesh, chosen, { planeTol, soup: outcome.soup, openLoops: outcome.openLoops });
        const candidates = ranked.map((c): CandidateSummary => ({ normal: c.normal, area: c.area, offset: c.offset, support: c.support, levels: c.levels, source: c.source, members: c.members }));
        const modelVolume = volumeAbovePlane(exteriorMesh(oriented.mesh));
        return { candidates, chosen, oriented, bounds: meshBounds(oriented.mesh.positions), planeTol, modelVolume, diagnostics: [...diagnostics, ...oriented.diagnostics] };
      });
      this.s2 = { key: keys.S2, value };
      return value;
    };

    const cellOf = (oriented: OrientedStage): number => {
      const cell = previewCell(params, oriented.bounds) * inputs.cellScale;
      // A cell of 0, from a typed value or a project file, asks for an endless lattice. That is the
      // user's input and no crash, so it must not be retried at a coarser cell as one.
      if (!(cell > 0) || !Number.isFinite(cell)) throw new InlineError('cell', `A preview cell of ${cell} mm cannot be built: give it a value above 0.`);
      return cell;
    };
    const settingsOf = (oriented: OrientedStage, cell: number): FieldSettings => fieldSettings(params, oriented.bounds, cell);

    const s3 = (): Lattice => {
      if (this.s3?.key === keys.S3) return this.s3.value;
      const oriented = s2();
      const value = timed('S3', () => {
        const { grid, i0, j0 } = tightLattice(oriented.bounds, cellOf(oriented), 1);
        return { field: rasterize(oriented.oriented.mesh, grid), i0, j0 };
      });
      this.s3 = { key: keys.S3, value };
      return value;
    };

    const s4 = (): Lattice => {
      if (this.s4?.key === keys.S4) return this.s4.value;
      const raster = s3();
      const oriented = s2();
      const value = timed('S4', () => {
        const { cell } = raster.field;
        const { rEff } = planField(oriented.bounds, { ...settingsOf(oriented, cell), nx: 1, ny: 1 });
        // Room for the radius and a little more, which is all dilation needs.
        const pad = Math.ceil(rEff / cell) + 2;
        const grid: Grid = { nx: raster.field.nx + 2 * pad, ny: raster.field.ny + 2 * pad, cell, x0: (raster.i0 - pad) * cell, y0: (raster.j0 - pad) * cell };
        const lattice = { field: embed(raster, grid, NO_SOURCE), i0: raster.i0 - pad, j0: raster.j0 - pad };
        return { field: dilate(lattice.field, rEff), i0: lattice.i0, j0: lattice.j0 };
      });
      this.s4 = { key: keys.S4, value };
      return value;
    };

    const s5 = (): { plan: FieldPlan; settings: FieldSettings; tile: Field; composite: Field } => {
      if (this.s5?.key === keys.S5) return this.s5.value;
      const oriented = s2();
      const envelope = s4();
      const value = timed('S5', () => {
        const settings = settingsOf(oriented, envelope.field.cell);
        const plan = planField(oriented.bounds, settings);
        // Past the node cap the plan raises the cell, and then the raster and envelope are made again at it.
        const tile = plan.cell === envelope.field.cell ? embed(envelope, plan.tile, 0) : dilate(rasterize(oriented.oriented.mesh, plan.tile), plan.rEff);
        return { plan, settings: { ...settings, cell: plan.cell }, tile, composite: compositeTiles(tile, plan).field };
      });
      this.s5 = { key: keys.S5, value };
      return value;
    };

    const s6 = (): ConditionedStage => {
      if (this.s6?.key === keys.S6) return this.s6.value;
      const { plan, settings, tile, composite } = s5();
      const value = timed('S6', () => {
        const field = conditionField(composite, settings).field;
        const single = plan.nx === 1 && plan.ny === 1 ? field : conditionField(tile, settings).field;
        // G6: wall warnings come from the export field only. A coarse preview can read a wall a cell thinner.
        return { plan, settings, field, tile: single, diagnostics: plan.diagnostics };
      });
      this.s6 = { key: keys.S6, value };
      return value;
    };

    const s10 = (): MoldStage => {
      if (this.s10?.key === keys.S10) return this.s10.value;
      const oriented = s2();
      const value = timed('S10', () => {
        // Always the export plan's bounds and offsets, whatever cell the preview runs at.
        const mold = moldBounds(oriented.oriented.mesh, oriented.bounds, fieldSettings(params, oriented.bounds));
        return { mold, rim: deriveRim(mold, params) };
      });
      this.s10 = { key: keys.S10, value };
      return value;
    };

    const s7 = (): PlacementOutput => {
      if (this.s7?.key === keys.S7) return this.s7.value;
      const oriented = s2();
      const conditioned = s6();
      const { mold, rim } = s10();
      const value = timed('S7', () => {
        const { settings, field, tile } = conditioned;
        const single = { ...settings, nx: 1, ny: 1 };
        const tilePlan = planField(oriented.bounds, single);
        const opening = placementSettings(params, oriented.bounds);
        const search = findBodies(oriented.oriented.mesh, tilePlan, tile, single, opening);
        const space = placementSpace(field, rim, mold.offsets, openingSizes(params));
        const placement = placeOpenings({ bodies: search.bodies, tile, space, settings: opening, pins: inputs.pins, removed: inputs.removed });
        primeSpace(space);
        return { placement, clearance: space.clearance!, fits: space.fits };
      });
      this.s7 = { key: keys.S7, value };
      return value;
    };

    // Another file: nothing of the old model can be used again, and it would only hold memory.
    if (this.s1 && this.s1.key !== keys.S1) this.clear();
    const outputs: FieldOutputs = {};
    if (want.includes('S1')) outputs.S1 = s1();
    if (want.includes('S2')) outputs.S2 = s2();
    if (want.includes('S6')) {
      const conditioned = s6();
      const { mold, rim } = s10();
      outputs.S6 = {
        field: conditioned.field,
        cell: conditioned.plan.cell,
        rEff: conditioned.plan.rEff,
        pitch: [conditioned.plan.pitchXmm, conditioned.plan.pitchYmm],
        mold,
        rim,
        diagnostics: conditioned.diagnostics,
      };
    }
    if (want.includes('S7')) outputs.S7 = s7();
    return outputs;
  }
}

/** A problem with the user's input, shown as it is. Not a crash, so nothing is retried. */
export class InlineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InlineError';
  }
}
