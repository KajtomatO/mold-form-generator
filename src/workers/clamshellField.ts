import type { OpeningPin } from '../core/analysis/placement';
import { primeSpace } from '../core/analysis/validate';
import type { RigidTransform } from '../core/base/orient';
import { chooseFor, clipHold, exactFootprint, exactRim, fineSplit, placeSeam, prepareClamshell, seamHold, sideField, type ClamshellPrep, type FineSplit, type SeamStage } from '../core/field/clamshell';
import { pullOf, splitAxes, sideRows, topMap, type Pull, type SeamAxis, type SideRows, type SplitChoice } from '../core/field/side';
import type { Field } from '../core/field/grid';
import type { Params } from '../core/params/schema';
import type { ClipLayout } from '../core/parts/clips';
import type { CutOpening } from '../core/parts/openings';
import { coverBottom } from '../core/parts/cover';
import type { ClamRim, MoldBounds } from '../core/parts/rim';
import type { SeamBoltLayout } from '../core/parts/seamBolts';
import { seamBelts, type Belts, type ClipAdvice, type HalfForces, type SeamBoltAdvice } from '../core/report/clamp';
import type { Diagnostic } from '../core/report/diagnostics';
import type { SeamOpening, SeamRoom } from '../core/analysis/placement';
import type { StageId } from '../app/stages';
import type { OrientedStage, PlacementOutput } from './fieldStages';

/**
 * MP5: the two-part cover's field rows in field.worker (G13.15): S3x, S4x, S6c, S10c, S6x and S7c, each kept under the
 * key the pipeline gave it, the coarse fields one slot per pull and the fine pair one per tier. Pure JS on
 * src/core/field/clamshell.ts, as MP1 to MP4's tests call it, so Node runs the same code.
 */

/** One half's fine side field as main draws it and the solid worker cuts it: the field in its pull's frame. */
export interface ClamSide {
  pull: Pull;
  field: Field;
  /** From the mold's (x, y, z) to the field's (u, v, h). */
  frame: RigidTransform;
  /** The seam's h in this frame: the half's cavity is where the field stands past it. */
  hs: number;
}

/** What the two-part cover adds to the field main receives at the end of T1. */
export interface ClamField {
  axis: SeamAxis;
  xs: number;
  betaDeg: number;
  /** The - half's (neg) first. */
  sides: [ClamSide, ClamSide];
  /** G13.3's outcome at this split: the bed footprint with the fastener, and what fits where none did. */
  bed: { width: number; length: number; depth: number; fits: boolean; fitted: boolean; fitsAtBeta: number | null; fitsWith: SplitChoice['fitsWith'] };
  /** The silicone at the fine cell, in ml, less the model above the plane, before the bores and the sealed air. */
  siliconeMl: number;
  forces: [HalfForces, HalfForces];
  filmN: number;
  holdN: number;
  bolts: SeamBoltLayout | null;
  boltAdvice: SeamBoltAdvice | null;
  clips: ClipLayout | null;
  clipAdvice: ClipAdvice | null;
  /** G13.10.9: with Seam fasteners None, the tape belts round the four walls. */
  belts: Belts | null;
}

/** What the two-part cover adds to placement: the seam's room, the openings as the halves cut them, and the pins' fate. */
export interface ClamPlacement {
  axis: SeamAxis;
  xs: number;
  room: SeamRoom;
  /** Each with its own zb, a hidden leaf's vent marked `hidden`. */
  cuts: CutOpening[];
  pinsKept: boolean;
  plateau: { b0: number; b1: number } | null;
  /** A hidden leaf's vent's own H_top, by its id, which S7c checks it on, so a drag on main checks it there too. */
  hiddenTops: Record<string, Field>;
}

interface Entry<T> {
  key: string;
  value: T;
}

/** How many fine pairs are kept, the preview's and one more, so a setting tried and put back builds nothing. */
const FINE_SLOTS = 2;

/** The cell the preview's fine fields are built at, as previewCell has it for one model, times the crash's or tuning's factor. */
export type CellOf = (oriented: OrientedStage) => number;

export class ClamFieldStages {
  private prep: Entry<ClamshellPrep> | null = null;
  private coarse = new Map<string, SideRows>();
  private choice: Entry<SplitChoice> | null = null;
  private rim: Entry<ClamRim> | null = null;
  /** Each fine pair with G13.3's choice it was built at, so a pair found again carries its own bed line. */
  private fine: Entry<{ fine: FineSplit; field: ClamField; choice: SplitChoice }>[] = [];
  private seam: Entry<{ stage: SeamStage; output: PlacementOutput }> | null = null;

  cached(): Partial<Record<StageId, string>> {
    const out: Partial<Record<StageId, string>> = {};
    if (this.prep) out.S3x = this.prep.key;
    if (this.choice) out.S6c = this.choice.key;
    if (this.rim) out.S10c = this.rim.key;
    if (this.fine[0]) out.S6x = this.fine[0].key;
    if (this.seam) out.S7c = this.seam.key;
    return out;
  }

  heldArrays(): unknown[] {
    return [this.prep, [...this.coarse.values()], this.fine, this.seam];
  }

  clear(): void {
    this.prep = this.choice = this.rim = this.seam = null;
    this.coarse.clear();
    this.fine = [];
  }

  /** S3x: the model cut at z = 0 and what no beta, bed or fastener changes. */
  private prepFor(keys: Record<StageId, string>, params: Params, oriented: OrientedStage): ClamshellPrep {
    if (this.prep?.key === keys.S3x) {
      // What S3x built stands for any setting its row does not read; the rows after it read the settings of this job,
      // through the prep as MP1's run has them, so those are this job's.
      const prep = this.prep.value;
      prep.params = { ...params, quality: { ...params.quality, cellFinal: prep.params.quality.cellFinal } };
      prep.ctx = { ...prep.ctx, params: prep.params };
      return prep;
    }
    // A model's own frames, so the turned meshes and every row built on them go with the old prep.
    this.clear();
    this.prep = { key: keys.S3x, value: prepareClamshell(oriented.oriented.mesh, params) };
    return this.prep.value;
  }

  /** S6x: the fine pair at the split, at the preview's cell or the export's, with what it gives. */
  fieldFor(keys: Record<StageId, string>, params: Params, oriented: OrientedStage, cell: number, timed: <T>(stage: string, build: () => T) => T): { fine: FineSplit; field: ClamField; choice: SplitChoice; prep: ClamshellPrep } {
    const prep = this.prepFor(keys, params, oriented);
    const known = this.fine.find((entry) => entry.key === keys.S6x);
    if (known) return { ...known.value, prep };
    const beta = params.clamshell.ceilingDeg;
    // S4x, one slot per pull the axis allows.
    const rows: Partial<Record<Pull, SideRows>> = {};
    for (const axis of splitAxes(prep.params)) {
      for (const sign of [1, -1] as const) {
        const pull = pullOf(axis, sign);
        const slot = `${keys.S4x}|${pull}`;
        let found = this.coarse.get(slot);
        if (!found) {
          found = timed('S4x', () => sideRows(sideField(prep, pull, 1, beta, null).field, pull, prep.bounds));
          this.coarse.set(slot, found);
        }
        rows[pull] = found;
      }
    }
    // Slots of an older S4x go once a new one is in.
    for (const slot of [...this.coarse.keys()]) if (!slot.startsWith(`${keys.S4x}|`)) this.coarse.delete(slot);
    if (this.choice?.key !== keys.S6c) this.choice = { key: keys.S6c, value: timed('S6c', () => chooseFor(prep, beta, rows)) };
    const choice = this.choice.value;
    if (this.rim?.key !== keys.S10c) this.rim = { key: keys.S10c, value: timed('S10c', () => exactRim(prep, choice.axis, choice.xs, beta)) };
    const value = timed('S6x', () => {
      const fine = fineSplit(prep, choice.axis, choice.xs, cell, beta);
      return { fine, field: clamField(prep, fine, choice), choice };
    });
    this.fine = [{ key: keys.S6x, value }, ...this.fine].slice(0, FINE_SLOTS);
    return { ...value, prep };
  }

  /** S7c: the openings on P at the fine pair of S6x, as S7's placement output, with the seam's own. */
  placementFor(keys: Record<StageId, string>, params: Params, oriented: OrientedStage, cell: number, pins: OpeningPin[], removed: string[], timed: <T>(stage: string, build: () => T) => T): PlacementOutput {
    if (this.seam?.key === keys.S7c) return this.seam.value.output;
    const { fine, prep } = this.fieldFor(keys, params, oriented, cell, timed);
    const value = timed('S7c', () => {
      const stage = placeSeam(prep, fine, { pins, removed });
      const placed = stage.placement;
      // The distance map and fit boxes, built here as S7 builds its own, so a drop on main never waits for them.
      primeSpace(stage.space);
      const output: PlacementOutput = {
        placement: { openings: placed.openings, bodies: [], uncovered: placed.uncovered, ceilingLeaves: placed.ceilingLeaves, diagnostics: placed.diagnostics },
        clearance: stage.space.clearance!,
        fits: stage.space.fits,
        seam: { axis: fine.axis, xs: fine.xs, room: stage.room, cuts: stage.openings, pinsKept: placed.pinsKept, plateau: placed.plateau, hiddenTops: hiddenTops(prep, fine, placed.openings) },
      };
      return { stage, output };
    });
    this.seam = { key: keys.S7c, value };
    return value.output;
  }
}

/** Each hidden leaf's vent's H_top from the rows at or under its run's top, as placeSeamOpenings reads it. */
function hiddenTops(prep: ClamshellPrep, fine: FineSplit, openings: readonly SeamOpening[]): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const o of openings) if (o.hidden && o.under !== undefined) out[o.id] = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs, o.under);
  return out;
}

/** What main is sent of a fine pair: the two fields with their frames, the bed, the silicone, the forces and the hold. */
export function clamField(prep: ClamshellPrep, fine: FineSplit, choice: SplitChoice): ClamField {
  const { params } = prep;
  const side = (run: FineSplit['plus']): ClamSide => ({ pull: run.side.pull, field: run.field, frame: run.side.frame, hs: run.hs });
  const fp = exactFootprint(prep, fine);
  const fastener = params.clamshell.fastener;
  const bolts = fastener === 'bolts' ? seamHold(prep, fine) : null;
  const clips = fastener === 'clips' ? clipHold(prep, fine) : null;
  return {
    axis: fine.axis,
    xs: fine.xs,
    betaDeg: params.clamshell.ceilingDeg,
    sides: [side(fine.minus), side(fine.plus)],
    bed: { width: fp.width, length: fp.length, depth: fp.depth, fits: fp.fits, fitted: choice.fitted, fitsAtBeta: choice.fitsAtBeta, fitsWith: choice.fitsWith },
    siliconeMl: fine.siliconeMl,
    forces: fine.forces,
    filmN: fine.filmN,
    holdN: fine.holdN,
    bolts: bolts?.bolts ?? null,
    boltAdvice: bolts?.advice ?? null,
    clips: clips?.clips ?? null,
    clipAdvice: clips?.advice ?? null,
    belts: fastener === 'none' ? seamBelts(fine.holdN, params.print.tapeStrip, coverBottom(fine.rim), fine.rim.Zt) : null,
  };
}

/** The diagnostics a fine pair gives besides the rim's: G13.3's bed line, and the fasteners' and the hold's. */
export function clamDiagnostics(choice: SplitChoice, field: ClamField): Diagnostic[] {
  return [...choice.diagnostics, ...(field.bolts?.diagnostics ?? []), ...(field.boltAdvice?.diagnostics ?? []), ...(field.clips?.diagnostics ?? []), ...(field.clipAdvice?.diagnostics ?? [])];
}

/** The mold's box for one model at the split, as S10 has it for a tile: G8's D grown to the rim's, one tile at the origin. */
export function clamMold(prep: ClamshellPrep, rim: ClamRim): MoldBounds {
  return { ...prep.mold, D: rim.D, offsets: [[0, 0]] };
}

