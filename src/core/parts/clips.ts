import type { Manifold, Vec3 } from 'manifold-3d';
import { assertRigid, type RigidTransform } from '../base/orient';
import { EAR_LENGTH } from '../field/side';
import type { Params } from '../params/schema';
import { SEAL_SPACING_MM } from '../report/clamp';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { CLIP_HOLD_N } from './fasteners';
import type { ClamRim, SeamAxis } from './rim';
import { PRY_RUN } from './seamBolts';

/**
 * G13.10.16 to G13.10.20: the two-part cover's seam clips, chosen by Seam fasteners Clips. Each half carries a pair of
 * ears on each end face per row, each ear with a female 40 degree dovetail socket that opens on its seam face and widens
 * away from P, so it prints on the half's back with no support; a printed bowtie key, tapered 4 degrees along its length,
 * slides in along -b across both ears of a pair and draws the halves together. No hardware.
 */

export { EAR_LENGTH };
/** G13.10.16: the socket's depth along a from the ear's face, and the floor web under it, each rounded up to whole layers. */
export const SOCKET_DEPTH = 3.2;
export const FLOOR = 2.0;
/** G13.10.16: the socket's flare, under the 45 degree limit in the pose, and its taper along b, per side. */
export const FLARE_DEG = 40;
export const TAPER_DEG = 4;
/** G13.10.16: the socket's neck at the ear's tip. */
export const NECK_TIP = 5;
/** G13.10.16: the socket stops this far short of the end face, so no cutter shares a plane with the wall. */
export const SOCKET_BACK = 0.5;
/** G13.10.16: the ear's overlap into the end wall, along b. */
export const EAR_OVERLAP = 0.5;
/** G13.10.16: the ear's wall beside the socket, in nozzles: three walls from each outline meet. */
export const EAR_WALL_NOZZLES = 6;
/** G13.10.16: a key's anchor ends stop this short of the socket floors, so a key never bottoms on one. */
export const KEY_FLOOR_GAP = 0.5;
/** G13.10.16: at home a key's tip is this far from the socket's bottom. */
export const HOME_FROM_BOTTOM = 3;
/** G13.10.16: a key's body is the socket's length and this, so bottomed its head stands this far off the ear's tip. */
export const HEAD_STANDOFF_MIN = 2;
/** G13.10.16: the head's thickness along the key, and its margin round the body's end section. */
export const HEAD_THICKNESS = 3;
export const HEAD_MARGIN = 1.5;
/** G13.10.16: the home marks' pitch along the key, and each groove's width and depth. */
export const MARK_PITCH = 1;
export const MARK_SIZE = 0.4;
/** G13.10.16: between the two grooves of the home line's double groove, in mm. */
export const DOUBLE_GAP = 0.2;
/** G13.10.16: the single marks either side of the home line's double groove. */
export const MARKS_EACH_SIDE = 3;
/** G13.10.16: what a key still holds engaged short of home, in mm along it. */
export const MIN_ENGAGED = 4;
/** G13.10.17: between two rows of ears, and between the top row and the pry chamfers' foot, in mm. */
export const ROW_GAP = 2;
export const PRY_CLEAR = 1;
/** G13.10.16: the plate's spare keys, and the gap between keys on it, in mm. */
export const SPARES = 2;
export const PLATE_GAP = 5;
/** How far a cutter runs past what it opens, as the bolts' PAST. */
const PAST = 1;
/** How far a socket's cutter runs above the ear's face, along its own flare, so its mouth shares no plane with the face. */
const MOUTH_PAST = 0.5;

const DEGREE = Math.PI / 180;

/** Whole layers at least `value` deep, or the value itself where the layer is no positive height. */
function wholeLayers(value: number, layer: number): number {
  return layer > 0 ? layer * Math.ceil(value / layer - 1e-9) : value;
}

/** G13.10.16 and G13.10.19's sizes, from the print's layer and nozzle and the clips' clearance. Lengths in mm. */
export interface ClipNeeds {
  layer: number;
  nozzle: number;
  /** r: each ear's seam face lies one layer back from P, so a pair keeps a 2r gap (G13.10.16). */
  relief: number;
  /** d and w_f: the socket's depth along a, and the floor web under it. */
  depth: number;
  floor: number;
  flareDeg: number;
  taperDeg: number;
  /** n at the ear's tip (w = Le) and at the socket's bottom (w = SOCKET_BACK). */
  neckTip: number;
  neckBottom: number;
  /** f = n + 2 d tan(flare), at the tip and at the bottom. */
  farTip: number;
  farBottom: number;
  /** w_e: the ear's wall beside the socket, in z. */
  wall: number;
  /** h_e = f at the tip + 2 w_e: the ear's height along z. */
  height: number;
  /** Le, out from the end face along b, and the socket's length along b. */
  earLength: number;
  socketLength: number;
  /** r + d + w_f + Le: how deep along a a half's ear reaches, its corbel included. */
  earDepth: number;
  /** clips.clearance, per side. */
  clearance: number;
  /** clips.rows, the user's, or null for auto. */
  asked: number | null;
  key: KeyNeeds;
}

/** G13.10.16's key, along its length u from its tip (u = 0). */
export interface KeyNeeds {
  /** The body's length, the socket's + HEAD_STANDOFF_MIN, and the head's thickness: the key is length + head long. */
  length: number;
  head: number;
  /** Where the anchors' ends stop along a, from P: r + d - KEY_FLOOR_GAP. */
  anchor: number;
  /** At home, the tip's distance from the socket's bottom, the length engaged, and the home line's u, level with the ear's tip. */
  home: number;
  engaged: number;
  homeLine: number;
  /** Travel past home before the tip bottoms, and short of home before the engagement falls to MIN_ENGAGED. */
  travelIn: number;
  travelOut: number;
  /** How much each mm of push closes per side, read in the key's section: tan(taper) cos(flare). */
  perMmPerSide: number;
  /**
   * The clearance as an offset in the key's section, a little over the clearance itself, as the taper tilts each flare out
   * of the section's plane: so the gap square to the flare is the clearance.
   */
  sectionClearance: number;
  /** The push past home that closes the clearance, so a key printed true touches both flares there. */
  seatTravel: number;
}

/** A clearance square to the flares as an offset in the key's section, which the flares cross at the taper's tilt. */
export function sectionOffset(needs: Pick<ClipNeeds, 'flareDeg' | 'taperDeg'>, clearance: number): number {
  const f = Math.tan(needs.flareDeg * DEGREE), t = Math.tan(needs.taperDeg * DEGREE);
  return clearance * Math.sqrt((1 + f * f + t * t) / (1 + f * f));
}

/** G13.10.16's sizes at these settings. Each length that faces up or down in a pose is a whole number of layers. */
export function clipNeeds(params: Params): ClipNeeds {
  const layer = params.print.layerHeight;
  const nozzle = params.print.nozzle;
  const relief = layer;
  const depth = wholeLayers(SOCKET_DEPTH, layer);
  const floor = wholeLayers(FLOOR, layer);
  const tanFlare = Math.tan(FLARE_DEG * DEGREE), tanTaper = Math.tan(TAPER_DEG * DEGREE);
  const earLength = EAR_LENGTH;
  const socketLength = earLength - SOCKET_BACK;
  const neckBottom = NECK_TIP - 2 * socketLength * tanTaper;
  const farTip = NECK_TIP + 2 * depth * tanFlare;
  const wall = EAR_WALL_NOZZLES * nozzle;
  const clearance = params.clips.clearance;
  const perMmPerSide = tanTaper * Math.cos(FLARE_DEG * DEGREE);
  const sectionClearance = sectionOffset({ flareDeg: FLARE_DEG, taperDeg: TAPER_DEG }, clearance);
  const home = HOME_FROM_BOTTOM;
  const engaged = socketLength - home;
  return {
    layer,
    nozzle,
    relief,
    depth,
    floor,
    flareDeg: FLARE_DEG,
    taperDeg: TAPER_DEG,
    neckTip: NECK_TIP,
    neckBottom,
    farTip,
    farBottom: neckBottom + 2 * depth * tanFlare,
    wall,
    height: farTip + 2 * wall,
    earLength,
    socketLength,
    earDepth: relief + depth + floor + earLength,
    clearance,
    asked: params.clips.rows === null ? null : Math.floor(params.clips.rows),
    key: {
      length: socketLength + HEAD_STANDOFF_MIN,
      head: HEAD_THICKNESS,
      anchor: relief + depth - KEY_FLOOR_GAP,
      home,
      engaged,
      homeLine: engaged,
      travelIn: home,
      travelOut: engaged - MIN_ENGAGED,
      perMmPerSide,
      sectionClearance,
      seatTravel: sectionClearance / perMmPerSide,
    },
  };
}

/** G13.3: the ears widen each half's pose by 2 Le across b, 20 mm. */
export function earBedGrowth(needs: Pick<ClipNeeds, 'earLength'>): number {
  return 2 * needs.earLength;
}

/** The socket's neck at w out from the end face: NECK_TIP at the ear's tip, narrowing by the taper toward the wall. */
export function neckAt(needs: Pick<ClipNeeds, 'earLength' | 'taperDeg'>, w: number): number {
  return NECK_TIP - 2 * (needs.earLength - w) * Math.tan(needs.taperDeg * DEGREE);
}

/** G13.10.17's rows: the bottom row, the top row, a second bottom row on the first, then middle rows. */
export type ClipRowKind = 'bottom' | 'top' | 'second' | 'middle';

export interface ClipRow {
  kind: ClipRowKind;
  /** The row's centre in z, where its ears and sockets are centred. */
  z: number;
}

/** Where the seam clips go. Plain data, as it travels with the rim. */
export interface ClipLayout extends ClipNeeds {
  axis: SeamAxis;
  xs: number;
  /** H- and H+: each half's depth from P to its back face. */
  depths: [number, number];
  /** O's end faces along b. */
  ends: [number, number];
  /** z_lo, the cover's bottom edge, and z_hi, PRY_CLEAR under the pry chamfers' foot. */
  zLow: number;
  zHigh: number;
  /** The most rows that fit between them. */
  most: number;
  /** The rows in the order they are placed: bottom, top, second bottom, middles from the bottom up. */
  placed: ClipRow[];
  /** Their centres from the bottom up. */
  zs: number[];
  /** Keys in all, one per row on each end face, and what they are counted at together. */
  count: number;
  clipsHoldN: number;
  /** The hold they were placed for, holdN_seam, and whether they fall short of it. */
  holdN: number;
  heldBack: boolean;
  /** clips.rows was set past what fits, so fewer were built. */
  lowered: boolean;
  diagnostics: Diagnostic[];
}

const mm = (v: number): string => v.toFixed(1);

/** The rows' centres for a count, in G13.10.17's order: bottom, top, second bottom, then middles evenly between. */
export function clipRows(needs: Pick<ClipNeeds, 'height'>, zLow: number, zHigh: number, rows: number): ClipRow[] {
  const he = needs.height;
  const bottom = zLow + he / 2, top = zHigh - he / 2, second = bottom + he + ROW_GAP;
  const out: ClipRow[] = [];
  if (rows >= 1) out.push({ kind: 'bottom', z: bottom });
  if (rows >= 2) out.push({ kind: 'top', z: top });
  if (rows >= 3) out.push({ kind: 'second', z: second });
  const middles = rows - 3;
  for (let k = 1; k <= middles; k++) out.push({ kind: 'middle', z: second + (k * (top - second)) / (middles + 1) });
  return out;
}

/** The widest gap between two neighbouring centres. */
function widestGap(rows: readonly ClipRow[]): number {
  const zs = rows.map((row) => row.z).sort((p, q) => p - q);
  let widest = 0;
  for (let k = 1; k < zs.length; k++) widest = Math.max(widest, zs[k] - zs[k - 1]);
  return widest;
}

/**
 * G13.10.17: the rows up the end faces, both end faces alike, while rows h_e + (rows - 1) ROW_GAP fit between the cover's
 * bottom edge and PRY_CLEAR under the pry chamfers. Auto takes the bottom row, the top row and the second bottom row as
 * they fit, then middle rows until no two centres are more than SEAL_SPACING_MM apart, then more while 2 rows
 * CLIP_HOLD_N is short of `holdN`. A count the user set is held to what fits, with a line when it is lowered. Past the
 * room for one row, `clips-no-room`; with one, `clips-single`; short of the hold, `clips-hold`.
 */
export function placeClips(needs: ClipNeeds, rim: Pick<ClamRim, 'O' | 'Zt' | 'Tb' | 'proud'>, axis: SeamAxis, xs: number, holdN = 0): ClipLayout {
  const { O, Zt, Tb, proud } = rim;
  const [a0, a1, b0, b1] = axis === 'x' ? [O.x0, O.x1, O.y0, O.y1] : [O.y0, O.y1, O.x0, O.x1];
  const he = needs.height;
  const zLow = -Tb + proud;
  const zHigh = Zt - PRY_RUN - PRY_CLEAR;
  const room = zHigh - zLow;
  const most = room < he - 1e-9 ? 0 : Math.floor((room + ROW_GAP) / (he + ROW_GAP) + 1e-9);
  const diagnostics: Diagnostic[] = [];
  let rows: number, lowered = false;
  if (needs.asked !== null) {
    rows = Math.max(0, Math.min(needs.asked, most));
    lowered = most > 0 && needs.asked > most;
  } else {
    rows = Math.min(most, 3);
    while (rows < most && widestGap(clipRows(needs, zLow, zHigh, rows)) > SEAL_SPACING_MM + 1e-9) rows++;
    while (rows < most && 2 * rows * CLIP_HOLD_N < holdN - 1e-9) rows++;
  }
  if (most === 0) {
    // Both heights as printed, from the cover's bottom edge: the halves', and the least a row of ears fits under the chamfers in.
    const tall = Zt + Tb - proud, needed = he + PRY_RUN + PRY_CLEAR;
    diagnostics.push({ code: 'clips-no-room', severity: 'error', also: ['clamshell.fastener', 'cover.topCap'], message: `The halves are ${mm(tall)} mm tall, too low for a row of seam clip ears, ${mm(he)} mm high, under the pry chamfers, which needs them at least ${mm(needed)} mm tall: set Seam fasteners to Bolts or None, or raise Top cap by at least ${mm(needed - tall)} mm.` });
  }
  if (lowered) {
    diagnostics.push({ code: 'clips-rows-lowered', severity: 'info', also: ['clips.rows'], message: `Clip rows is set to ${needs.asked}, but only ${most} row${most > 1 ? 's' : ''} of clip ears fit up the end faces of these halves, so ${most} ${most > 1 ? 'are' : 'is'} built.` });
  }
  // Only where one row is all that fits: one the user set on taller halves is the user's choice.
  if (rows === 1 && most === 1) {
    diagnostics.push({ code: 'clips-single', severity: 'info', message: 'The halves are low, so each end face takes one row of seam clips, at the bottom edge, where the taper pushes the seam open.' });
  }
  const count = 2 * rows;
  const heldBack = rows > 0 && count * CLIP_HOLD_N < holdN - 1e-9;
  if (heldBack) {
    const more = rows < most ? 'raise Clip rows by one, or set Seam fasteners to Bolts' : 'set Seam fasteners to Bolts, or to None and hold the seam with clamps and tape belts';
    diagnostics.push({ code: 'clips-hold', severity: 'warning', also: ['clamshell.fastener', 'clips.rows'], message: `The seam needs holding with ${holdN.toFixed(0)} N, and the ${count} seam clips are counted at ${count * CLIP_HOLD_N} N, ${CLIP_HOLD_N} N each: ${more}.` });
  }
  const placed = clipRows(needs, zLow, zHigh, rows);
  return {
    ...needs,
    axis,
    xs,
    depths: [xs - a0, a1 - xs],
    ends: [b0, b1],
    zLow,
    zHigh,
    most,
    placed,
    zs: placed.map((row) => row.z).sort((p, q) => p - q),
    count,
    clipsHoldN: count * CLIP_HOLD_N,
    holdN,
    heldBack,
    lowered,
    diagnostics,
  };
}

// ----- The ears, the sockets and the keys (G13.10.16) -----

/** One ear pair's place: on which end face, and its row's centre in z. */
export interface ClipSpot {
  end: 'b0' | 'b1';
  z: number;
}

/** Every ear pair of a layout: each row on both end faces, b0's first. */
export function clipSpots(layout: Pick<ClipLayout, 'zs'>): ClipSpot[] {
  return (['b0', 'b1'] as const).flatMap((end) => layout.zs.map((z) => ({ end, z })));
}

/**
 * A point given in a half's clip frame to the mold: a' = |a - xs| along its pull from P, w out from the spot's end face
 * along b, and z.
 */
function pointOf(layout: Pick<ClipLayout, 'axis' | 'xs' | 'ends'>, spot: ClipSpot, sign: 1 | -1, ap: number, w: number, z: number): Vec3 {
  const a = layout.xs + sign * ap;
  const b = spot.end === 'b1' ? layout.ends[1] + w : layout.ends[0] - w;
  return layout.axis === 'x' ? [a, b, z] : [b, a, z];
}

/** The convex hull of points given in a half's clip frame. */
function hullOf(arena: Arena, layout: Pick<ClipLayout, 'axis' | 'xs' | 'ends'>, spot: ClipSpot, sign: 1 | -1, points: [number, number, number][]): Manifold {
  return arena.track(arena.api.Manifold.hull(points.map(([ap, w, z]) => pointOf(layout, spot, sign, ap, w, z))));
}

/** Tests only: negative controls of the relief, the audit and the socket's alignment. */
export interface EarOptions {
  /** False: no relief, so the ears of a pair touch in P. */
  relief?: boolean;
  /** The corbel's face this far from vertical in the pose, where G13.10.16 builds it at exactly 45 degrees. */
  corbelDeg?: number;
  /** The socket's flare, where G13.10.16 builds it at FLARE_DEG. */
  flareDeg?: number;
  /** A male dovetail on a neck in place of the socket, its shoulders facing the bed in the pose. */
  male?: boolean;
}

/**
 * G13.10.16: one half's ears (`sign` +1 for pos, -1 for neg), each the prism over the row's h_e in z of its (a', w)
 * outline: from the relieved face a' = r to the floor web's foot r + d + w_f, out to Le, then the corbel under it at
 * exactly 45 degrees in the pose, back to the end face and EAR_OVERLAP into the wall. Where the half is shallower than the
 * ear, its back face cuts the corbel off and the ear stands on the bed.
 */
export function earSolids(arena: Arena, layout: ClipLayout, sign: 1 | -1, options: EarOptions = {}, spots: ClipSpot[] = clipSpots(layout)): Manifold[] {
  const { relief, depth, floor, earLength: Le, height: he } = layout;
  const H = layout.depths[sign > 0 ? 1 : 0];
  const r = options.relief === false ? 0 : relief;
  const web = r + depth + floor;
  const run = 1 / Math.tan((options.corbelDeg ?? 45) * DEGREE);
  // The outline in (a', w), the corbel's foot EAR_OVERLAP into the wall, held to the half's depth.
  const foot = web + (Le + EAR_OVERLAP) * run;
  const outline: [number, number][] = foot <= H
    ? [[r, -EAR_OVERLAP], [r, Le], [web, Le], [foot, -EAR_OVERLAP]]
    : web < H
      ? [[r, -EAR_OVERLAP], [r, Le], [web, Le], [H, Le - (H - web) / run], [H, -EAR_OVERLAP]]
      : [[r, -EAR_OVERLAP], [r, Le], [H, Le], [H, -EAR_OVERLAP]];
  const ears: Manifold[] = [];
  for (const spot of spots) {
    const z0 = spot.z - he / 2, z1 = spot.z + he / 2;
    ears.push(hullOf(arena, layout, spot, sign, outline.flatMap(([ap, w]) => [[ap, w, z0], [ap, w, z1]] as [number, number, number][])));
    if (options.male) ears.push(...maleTail(arena, layout, spot, sign, r));
  }
  return ears;
}

/** EarOptions.male: a dovetail standing on the ear's face toward P on a neck 1 mm narrower each side, along b. */
function maleTail(arena: Arena, layout: ClipLayout, spot: ClipSpot, sign: 1 | -1, r: number): Manifold[] {
  const { depth: d, neckTip: n, earLength: Le } = layout;
  const t = Math.tan(layout.flareDeg * DEGREE);
  const neck = n / 2 - 1, top = r - 1, far = r - 1 - d;
  const along = (pts: [number, number][]): [number, number, number][] => pts.flatMap(([ap, z]) => [[ap, SOCKET_BACK, spot.z + z], [ap, Le, spot.z + z]] as [number, number, number][]);
  return [
    hullOf(arena, layout, spot, sign, along([[r + 0.01, -neck], [r + 0.01, neck], [top, neck], [top, -neck]])),
    hullOf(arena, layout, spot, sign, along([[top, -n / 2], [top, n / 2], [far, n / 2 + d * t], [far, -(n / 2 + d * t)]])),
  ];
}

/**
 * G13.10.16: one half's sockets, a trapezoid in (a', z) per ear, the neck n(w) on the relieved face a' = r flaring at
 * FLARE_DEG to the floor at r + d, the hull of its end sections at w = SOCKET_BACK and out past the ear's tip (each flare
 * is planar, so the hull is exact), centred in z on the ear. Each runs MOUTH_PAST above the face along its own flare, and
 * is cut from its own half only, where it meets only the ear.
 */
export function socketCutters(arena: Arena, layout: ClipLayout, sign: 1 | -1, options: EarOptions = {}, spots: ClipSpot[] = clipSpots(layout)): Manifold[] {
  if (options.male) return [];
  const { relief, depth: d, earLength: Le } = layout;
  const r = options.relief === false ? 0 : relief;
  const t = Math.tan((options.flareDeg ?? layout.flareDeg) * DEGREE);
  const w0 = SOCKET_BACK, w1 = Le + PAST;
  const section = (w: number): [number, number][] => {
    const half = neckAt(layout, w) / 2;
    const mouth = r - MOUTH_PAST, mouthHalf = half - MOUTH_PAST * t;
    return [[mouth, -mouthHalf], [mouth, mouthHalf], [r + d, half + d * t], [r + d, -(half + d * t)]];
  };
  return spots.map((spot) =>
    hullOf(arena, layout, spot, sign, [w0, w1].flatMap((w) => section(w).map(([ap, z]) => [ap, w, spot.z + z] as [number, number, number]))),
  );
}

/** Tests only: the key's shape changed, for the negative controls and the coupon's trio. */
export interface KeyOptions {
  /** The clearance it is offset by, where the layout's is used otherwise. */
  clearance?: number;
  /** Notches on the head's +y side, to tell the coupon's keys apart. */
  notches?: number;
  /** False: no home marks. */
  marks?: boolean;
}

/**
 * The key's section at u from its tip, in its own (x, y): x across the seam (a - xs), y along z from the row's centre.
 * It is the socket pair's at home, w = SOCKET_BACK + home + u: the neg trapezoid, the 2r gap and the pos trapezoid, each
 * flank offset inward by the clearance and run on to the ears' faces, the neck straight across the gap between them, and
 * the anchor ends trimmed at r + d - KEY_FLOOR_GAP. A plain offset would leave the neck c under the mouth's edges, which
 * a push closes before the flares; this way the key meets the flares and the edges at once. As three convex pieces: the
 * neck across the gap, and each anchor. `clearance` is square to the flares, sectionOffset's in the section.
 */
function keyPieces(needs: ClipNeeds, u: number, clearance: number): [number, number][][] {
  const c = sectionOffset(needs, clearance);
  const t = Math.tan(needs.flareDeg * DEGREE);
  const r = needs.relief, A = needs.key.anchor;
  const w = SOCKET_BACK + needs.key.home + u;
  const n = neckAt(needs, w);
  // Each flank is the socket's offset by c, run on to the ear's face, where the neck takes it across the gap: so the
  // ears' mouth edges keep c / cos(flare) to the neck, which a push closes as fast as it closes c on the flares.
  const neck = n / 2 - c / Math.cos(needs.flareDeg * DEGREE);
  const far = neck + (A - r) * t;
  const box: [number, number][] = [[-(r + 0.01), -neck], [r + 0.01, -neck], [r + 0.01, neck], [-(r + 0.01), neck]];
  const pos: [number, number][] = [[r, -neck], [A, -far], [A, far], [r, neck]];
  const neg = pos.map(([x, y]) => [-x, y] as [number, number]);
  return [box, pos, neg];
}

/** The key's section's half widths at u, across x (the anchors' ends) and along y (the far width there). */
export function keySection(needs: ClipNeeds, u: number, c = needs.clearance): { x: number; y: number; neck: number } {
  const [, pos] = keyPieces(needs, u, c);
  return { x: needs.key.anchor, y: pos[2][1], neck: pos[3][1] };
}

/** The whole key's height in its pose, head down: the body's length and the head's thickness. */
export function keyHeight(needs: Pick<ClipNeeds, 'key'>): number {
  return needs.key.length + needs.key.head;
}

/**
 * The head's half widths in x and y: the body's end section, offset by HEAD_MARGIN, but in y (the mold's z) no more than
 * the ear's half height, so on the bottom row, its ears flush with the cover's bottom edge, the head clears the table at
 * any nozzle: the ear's walls are 6 nozzles, and the head's margin does not shrink with them otherwise.
 */
export function keyHead(needs: ClipNeeds, c = needs.clearance): { x: number; y: number } {
  const end = keySection(needs, needs.key.length, c);
  return { x: end.x + HEAD_MARGIN, y: end.y + Math.max(0, Math.min(HEAD_MARGIN, needs.height / 2 - end.y)) };
}

/**
 * G13.10.16: one key in its print pose, standing on its head: x across the seam, y along the mold's z, and its height
 * z = keyHeight - u, so each layer is the bowtie's section, the neck's tension runs along the layers, and the body narrows
 * upward with nothing overhanging. The head, HEAD_THICKNESS on the bed, is keyHead's, the body's end section offset.
 * The home marks are grooves MARK_SIZE wide and deep across both anchor end faces (+-x), each with a flat floor and a
 * 45 degree roof, MARK_PITCH apart either side of the home line's double groove, which sits level with the ear's tip at
 * home.
 */
export function keySolid(arena: Arena, needs: ClipNeeds, options: KeyOptions = {}): Manifold {
  const { Manifold: M } = arena.api;
  const c = options.clearance ?? needs.clearance;
  const T = keyHeight(needs), L = needs.key.length;
  const zOf = (u: number): number => T - u;
  // The body runs on 0.5 mm into the head, so the two overlap.
  const uEnd = L + 0.5;
  const tip = keyPieces(needs, 0, c), end = keyPieces(needs, uEnd, c);
  const body = tip.map((piece, k) => arena.track(M.hull([...piece.map(([x, y]) => [x, y, zOf(0)] as Vec3), ...end[k].map(([x, y]) => [x, y, zOf(uEnd)] as Vec3)])));
  const head = keyHead(needs, c);
  const headBox = box(arena, -head.x, -head.y, 0, head.x, head.y, needs.key.head);
  let key = arena.track(M.union([...body, headBox]));
  const cuts: Manifold[] = [];
  if (options.marks !== false) {
    const A = needs.key.anchor;
    const span = head.y + 1;
    const groove = (u: number): void => {
      const z0 = zOf(u) - MARK_SIZE / 2;
      for (const side of [1, -1]) {
        // In (x, z): the floor from the face in by MARK_SIZE, the roof back out at 45 degrees, both past the face by PAST.
        const pts: [number, number][] = [[A + PAST, z0], [A - MARK_SIZE, z0], [A + PAST, z0 + MARK_SIZE + PAST]];
        cuts.push(arena.track(M.hull(pts.flatMap(([x, z]) => [[side * x, -span, z], [side * x, span, z]] as Vec3[]))));
      }
    };
    const home = needs.key.homeLine;
    // The double groove: two grooves either side of the home line, DOUBLE_GAP apart.
    groove(home - (MARK_SIZE + DOUBLE_GAP) / 2);
    groove(home + (MARK_SIZE + DOUBLE_GAP) / 2);
    for (let k = 1; k <= MARKS_EACH_SIDE; k++) {
      for (const u of [home - k * MARK_PITCH, home + k * MARK_PITCH]) if (u >= MARK_SIZE && u <= L - MARK_SIZE) groove(u);
    }
  }
  for (let k = 0; k < (options.notches ?? 0); k++) {
    // As the fit pieces' edge marks: 1 mm wide, 0.8 deep, 2.5 apart, on the head's +y side, through its thickness.
    const at = (k - ((options.notches ?? 0) - 1) / 2) * 2.5;
    cuts.push(box(arena, at - 0.5, head.y - 0.8, -PAST, at + 0.5, head.y + PAST, needs.key.head + PAST));
  }
  if (cuts.length > 0) key = arena.track(M.difference([key, ...cuts]));
  return key;
}

function box(arena: Arena, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Manifold {
  return arena.track(arena.track(arena.api.Manifold.cube([x1 - x0, y1 - y0, z1 - z0])).translate([x0, y0, z0]));
}

/**
 * From a key's print pose to its place in the mold at an ear pair, pushed `travel` past home (negative: short of it):
 * its height z' runs out from the end face along b, w = SOCKET_BACK + home - travel + keyHeight - z', its x along a from
 * P and its y along z from the row's centre, the sign of y taken so the turn is rigid. A key is symmetric in y, so either
 * sign seats the same.
 */
export function keyPose(layout: Pick<ClipLayout, 'axis' | 'xs' | 'ends' | 'key'>, spot: ClipSpot, travel = 0): RigidTransform {
  const out = spot.end === 'b1' ? 1 : -1;
  const T = keyHeight(layout);
  // b = end + out (w0 + T - z'), with w0 the tip's w.
  const w0 = SOCKET_BACK + layout.key.home - travel;
  const bAt0 = (spot.end === 'b1' ? layout.ends[1] : layout.ends[0]) + out * (w0 + T);
  // Rows of the rotation: a from x, b from -out z', z from s y.
  const aRow: [number, number, number] = [1, 0, 0], bRow: [number, number, number] = [0, 0, -out];
  const pick = (s: 1 | -1): RigidTransform => {
    const zRow: [number, number, number] = [0, s, 0];
    const [xRow, yRow] = layout.axis === 'x' ? [aRow, bRow] : [bRow, aRow];
    const [tx, ty] = layout.axis === 'x' ? [layout.xs, bAt0] : [bAt0, layout.xs];
    return { rotation: [...xRow, ...yRow, ...zRow] as RigidTransform['rotation'], translation: [tx, ty, spot.z] };
  };
  const det = (t: RigidTransform): number => {
    const [a, b, c, d, e, f, g, h, i] = t.rotation;
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  };
  const pose = det(pick(1)) > 0 ? pick(1) : pick(-1);
  assertRigid(pose);
  return pose;
}

/**
 * G13.10.16: clips.stl's plate, count + SPARES keys standing on their heads in a grid PLATE_GAP apart, in its print pose,
 * centred on the origin.
 */
export function clipPlate(arena: Arena, layout: Pick<ClipLayout, 'count'> & ClipNeeds): Manifold {
  const keys = layout.count + SPARES;
  const head = keyHead(layout);
  const cols = Math.ceil(Math.sqrt(keys)), lines = Math.ceil(keys / cols);
  const dx = 2 * head.x + PLATE_GAP, dy = 2 * head.y + PLATE_GAP;
  const one = keySolid(arena, layout);
  const placed: Manifold[] = [];
  for (let k = 0; k < keys; k++) {
    const i = k % cols, j = Math.floor(k / cols);
    placed.push(arena.track(one.translate([(i - (cols - 1) / 2) * dx, (j - (lines - 1) / 2) * dy, 0])));
  }
  return arena.track(arena.api.Manifold.union(placed));
}

/**
 * The seam clips' lines for the build: placeClips' own (G13.10.19's rules on the room, the rows and the hold). The ears
 * and sockets are sized from the layer and nozzle alone, so every wall is G13.10.16's at any setting, and none is
 * checked here; clipAdvice in report/clamp.ts adds the wedge and the top span.
 */
export function clipDiagnostics(layout: ClipLayout): Diagnostic[] {
  return layout.diagnostics;
}
