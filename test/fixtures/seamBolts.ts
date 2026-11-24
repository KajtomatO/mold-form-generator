import type { Manifold } from 'manifold-3d';
import { orientSolid } from '../../src/core/base/orient';
import { frameInverse, halfFrame } from '../../src/core/field/frames';
import { column } from '../../src/core/parts/bolts';
import { lugAxis, seamBoltCuts, type SeamBoltLayout, type SeamBoltSpot } from '../../src/core/parts/seamBolts';
import type { Arena } from '../../src/core/solid/arena';

/**
 * MP3's readings of the seam bolts' cuts off the built solids, a half's or a coupon's (docs/PLAN.md, MP3's checks;
 * G13.10.4): small probes in the half's pull frame (u, v, h), v = z and h from P, turned back to the mold and met with
 * the solid. A probe that must be open reads the solid's volume in it, in mm3; one that must be solid reads the share of
 * it that is.
 */

/** How far each probe keeps from the faces it is read between, so float rounding on a face never counts. */
const INSET = 0.05;

export interface CutReading {
  /** Solid in the hole's probe, from the relieved face to the countersink (neg) or to the membrane (pos). */
  hole: number;
  /** neg: solid in the countersink's probe, the cone shrunk by 0.1 mm. */
  sink?: number;
  /** neg: the share of the ring beside the cone's narrow end that is solid: 1 with a cone, 0 with a counterbore. */
  sinkWall?: number;
  /** neg: solid in the access bore's probe, from the head's face out through the gusset and the back face. */
  bore?: number;
  /** pos: the share of the membrane's probe, one layer under the slot's face, that is solid. */
  membrane?: number;
  /** pos: solid in the slot's probe, from the axis out through the lug's top face. */
  slot?: number;
  /** pos: solid in the hole's probe past the slot, out of the back face. */
  beyond?: number;
}

function box(arena: Arena, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Manifold {
  return arena.track(arena.track(arena.api.Manifold.cube([x1 - x0, y1 - y0, z1 - z0])).translate([x0, y0, z0]));
}

/** The cuts of one lug pair read off a half: `sign` -1 for neg, the head side, +1 for pos, the nut side. */
export function readCuts(arena: Arena, half: Manifold, layout: SeamBoltLayout, sign: 1 | -1, spot: SeamBoltSpot): CutReading {
  const back = frameInverse(halfFrame(layout.axis, layout.xs, sign));
  const [u, v] = lugAxis(layout, spot, sign);
  const { relief: r, holeRadius: rh, sinkRadius: rk, sinkDepth, tn, f, layer, slotWidth: s, slotHeight, height: hL } = layout;
  const depth = layout.depths[sign > 0 ? 1 : 0];
  const met = (probe: Manifold): number => arena.track(half.intersect(orientSolid(arena, probe, back))).volume();
  const share = (probe: Manifold): number => met(probe) / probe.volume();
  if (sign < 0) {
    const n0 = tn - sinkDepth;
    return {
      hole: met(column(arena, u, v, r + INSET, n0 - INSET, rh - 0.1, rh - 0.1)),
      sink: met(column(arena, u, v, n0 + 0.1, tn - INSET, rh, rk - 0.15)),
      sinkWall: share(arena.track(column(arena, u, v, n0 + INSET, n0 + 0.3, rh + 0.4 + 0.5, rh + 0.4 + 0.5).subtract(column(arena, u, v, n0, n0 + 0.4, rh + 0.4, rh + 0.4)))),
      bore: met(column(arena, u, v, tn + INSET, depth + 1, rk - 0.1, rk - 0.1)),
    };
  }
  return {
    hole: met(column(arena, u, v, r + INSET, f - layer - INSET, rh - 0.1, rh - 0.1)),
    membrane: share(column(arena, u, v, f - layer + 0.02, f - 0.02, rh - 0.1, rh - 0.1)),
    slot: met(box(arena, u - s / 2 + 0.1, v, f + INSET, u + s / 2 - 0.1, v + hL / 2 + 0.5, f + slotHeight - INSET)),
    beyond: met(column(arena, u, v, f + slotHeight + INSET, depth + 1, rh - 0.1, rh - 0.1)),
  };
}

/** Whether a reading is the one G13.10.4 builds: every open probe at most `open` mm3, every solid one at least 0.99. */
export function cutsAsBuilt(reading: CutReading, open = 1e-3): boolean {
  const opens = [reading.hole, reading.sink, reading.bore, reading.slot, reading.beyond].filter((x): x is number => x !== undefined);
  const solids = [reading.sinkWall, reading.membrane].filter((x): x is number => x !== undefined);
  return opens.every((x) => x <= open) && solids.every((x) => x >= 0.99);
}

/** The spot's end face as O's b there and the sign of w, outward along b. */
function endFace(layout: SeamBoltLayout, spot: SeamBoltSpot): { b: number; out: 1 | -1 } {
  return spot.end === 'b0' ? { b: spot.b + layout.c, out: -1 } : { b: spot.b - layout.c, out: 1 };
}

/** A box in mold coordinates over a in [a0, a1], w in [w0, w1] at the spot's end face, and z in [z0, z1]. */
export function boxAW(arena: Arena, layout: SeamBoltLayout, spot: SeamBoltSpot, a: [number, number], w: [number, number], z: [number, number]): Manifold {
  const face = endFace(layout, spot);
  const p = face.b + face.out * w[0], q = face.b + face.out * w[1];
  const [b0, b1] = [Math.min(p, q), Math.max(p, q)];
  return layout.axis === 'x' ? box(arena, a[0], b0, z[0], a[1], b1, z[1]) : box(arena, b0, a[0], z[0], b1, a[1], z[1]);
}

/**
 * G13.10.2's walls read off the cutters of one lug: what of them lies within minWall of O's face, of the lug's tip, or of
 * its bottom or top face over its flat part (the slot excepted at the top, which it leaves through), in mm3. All 0.
 */
export function cutWalls(arena: Arena, layout: SeamBoltLayout, sign: 1 | -1, spot: SeamBoltSpot): { face: number; tip: number; bottom: number; top: number } {
  const { xs, tn, tp, p, minWall, height: hL, depths } = layout;
  const one = { ...layout, spots: [spot] };
  const cuts = seamBoltCuts(arena, one, sign);
  // seamBoltCuts' order per lug: neg the hole, the cone and the bore; pos the hole, the slot and the hole past it.
  const holes = sign > 0 ? [cuts[0], cuts[2]] : cuts;
  const all = arena.track(arena.api.Manifold.union(cuts));
  const round = arena.track(arena.api.Manifold.union(holes));
  const side: [number, number] = sign > 0 ? [xs, xs + depths[1] + 2] : [xs - depths[0] - 2, xs];
  const flat: [number, number] = sign > 0 ? [xs, xs + tp] : [xs - tn, xs];
  const lug: [number, number] = [spot.z - hL / 2 - 1, spot.z + hL / 2 + 1];
  const met = (cut: Manifold, zone: Manifold): number => arena.track(cut.intersect(zone)).volume();
  return {
    face: met(all, boxAW(arena, layout, spot, side, [-10, minWall - 0.01], lug)),
    tip: met(all, boxAW(arena, layout, spot, flat, [p - minWall + 0.01, p + 10], lug)),
    bottom: met(all, boxAW(arena, layout, spot, flat, [0, p], [spot.z - hL / 2 - 10, spot.z - hL / 2 + minWall - 0.01])),
    top: met(round, boxAW(arena, layout, spot, flat, [0, p], [spot.z + hL / 2 - minWall + 0.01, spot.z + hL / 2 + 10])),
  };
}

/**
 * G13.10.2: the interlayer section of the pos lug at the slot's middle, in mm2: the half's section there, in its pull
 * frame, outside O, over the lug's height. A layer in the pose is a plane of h.
 */
export function slotSection(arena: Arena, half: Manifold, layout: SeamBoltLayout, spot: SeamBoltSpot): number {
  const frame = halfFrame(layout.axis, layout.xs, 1);
  const slice = arena.track(orientSolid(arena, half, frame).slice(layout.f + layout.slotHeight / 2));
  const [u, v] = lugAxis(layout, spot, 1);
  // Along u, w grows away from O: pos's frame has u = b with an x seam and -b with a y seam.
  const face = endFace(layout, spot);
  const dir = face.out * (layout.axis === 'x' ? 1 : -1);
  const uEnd = u - dir * layout.c;
  const [u0, u1] = [uEnd + dir * 0.01, uEnd + dir * (layout.p + 0.5)].sort((x, y) => x - y);
  const hL = layout.height;
  const rect = arena.crossSection([[[u0, v - hL / 2 - 0.5], [u1, v - hL / 2 - 0.5], [u1, v + hL / 2 + 0.5], [u0, v + hL / 2 + 0.5]]]);
  return arena.track(slice.intersect(rect)).area();
}
