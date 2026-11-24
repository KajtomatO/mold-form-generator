import { seamBOf, seamRoomFits, seamSpot } from '../core/analysis/placement';
import { checkOpening, type DropResult, type HardProblem, type OpeningKind, type OpeningSpot, type PlacementSpace } from '../core/analysis/validate';
import type { ClamPlacement } from '../workers/clamshellField';

/**
 * MP5: an opening of the two-part cover moves along P only (G13.5): the pointer's spot is taken to P, keeping its b, and
 * checked by S7's hard rules on H_top and by G13.5's room for the seal beside it. Pure, so the drag on main, the drop in
 * the pipeline and the tests share it.
 */

/** How far apart the spots along P are that a drop tries for room, and how far it looks each way, in mm. */
export const SEAM_DROP_STEP = 0.25;
export const SEAM_DROP_REACH = 40;

/** A spot taken to P: the same b, at a = xs. */
export function onSeam(seam: Pick<ClamPlacement, 'axis' | 'xs'>, kind: OpeningKind, x: number, y: number): OpeningSpot {
  return seamSpot(seam.axis, seam.xs, kind, seamBOf(seam.axis, { x, y }));
}

/**
 * The space an opening is checked in on P: H_top, or for a hidden leaf's vent its own run's (hiddenTops), as S7c checks
 * it, so its zb and its room are S7c's.
 */
export function seamSpace(space: PlacementSpace, seam: Pick<ClamPlacement, 'hiddenTops'>, id: string): PlacementSpace {
  const own = seam.hiddenTops[id];
  return own ? { ...space, field: own, clearance: null, fits: {} } : space;
}

/**
 * S7's hard rules there, and the seal's room beside it, which `seam-room` names: clear of the pins' sockets where the
 * seal keeps its pins, as S7c's own check of every opening placed or pinned has it.
 */
export function seamCheck(space: PlacementSpace, seam: Pick<ClamPlacement, 'room' | 'pinsKept' | 'axis' | 'xs'>, spot: OpeningSpot, others: readonly OpeningSpot[]): { valid: boolean; problems: HardProblem[]; zb: number } {
  const check = checkOpening(space, spot, others);
  const problems = [...check.problems];
  if (!seamRoomFits(seam.room, space.sizes, spot.kind, seamBOf(seam.axis, spot), check.zb, seam.pinsKept)) problems.push('seam-room');
  return { valid: problems.length === 0, problems, zb: check.zb };
}

/**
 * The drop on P: where the pointer let go, taken to P, or the nearest spot along P that passes, SEAM_DROP_STEP apart and
 * at most SEAM_DROP_REACH either way; with none, it stays where it was let go, invalid, as dropOpening leaves it.
 */
export function seamDrop(space: PlacementSpace, seam: Pick<ClamPlacement, 'room' | 'pinsKept' | 'axis' | 'xs'>, kind: OpeningKind, x: number, y: number, others: readonly OpeningSpot[]): DropResult {
  const spot = onSeam(seam, kind, x, y);
  const here = seamCheck(space, seam, spot, others);
  if (here.valid) return { x: spot.x, y: spot.y, snapped: false, valid: true, problems: [], refused: [], warnings: [] };
  const b = seamBOf(seam.axis, spot);
  for (let k = 1; k * SEAM_DROP_STEP <= SEAM_DROP_REACH + 1e-9; k++) {
    for (const sign of [-1, 1]) {
      const at = seamSpot(seam.axis, seam.xs, kind, b + sign * k * SEAM_DROP_STEP);
      if (seamCheck(space, seam, at, others).valid) return { x: at.x, y: at.y, snapped: true, valid: true, problems: [], refused: here.problems, warnings: [] };
    }
  }
  return { x: spot.x, y: spot.y, snapped: false, valid: false, problems: here.problems, refused: here.problems, warnings: [] };
}
