import type { Manifold, Vec2 } from 'manifold-3d';
import type { Field } from '../field/grid';
import type { Params } from '../params/schema';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { outset, type Rect } from '../solid/rect';
import { BOLT_LENGTHS, BRIDGE_LIMIT, FASTENERS, longestLength, OVER_SINK_LAYERS, OVER_SINK_MM, standardLength, threadPast, TIP_CLEARANCE, type BoltSize, type Fastener } from './fasteners';

/**
 * M10: four countersunk screws up through the base's corners into hex nuts slid into side slots in the
 * cover. Everything sits in the outer land, outside the groove, so the seal stays inside the bolts, and
 * nothing goes through the flat top (D5). This file derives where they go from the rim, cuts them, and
 * checks the walls they leave.
 */

const DEGREE = Math.PI / 180;
/** The same as the openings', so a hole is a 48-gon, 0.2% inside its circle. */
const SEGMENTS = 48;
/** How far a cutter runs past a surface it opens through, so they share no plane. */
const PAST = 1;
/** The base's hole runs this far above the plate, clear of the ridge, so it shares no plane with the top. */
const ABOVE_PLATE = 0.5;
/** The cover's lower hole starts this far below the shelf, in the rebate's empty space. */
const BELOW_SHELF = 0.5;
/** Overlap between the slot and the hole above it, so the two are one cut. */
const OVERLAP = 0.01;
/** A wall short of the least by more than float rounding is a clash. */
const SLACK = 1e-6;

export type BoltExit = 'x0' | 'x1' | 'y0' | 'y1';

export interface BoltSpot {
  /** The axis, in mold coordinates. */
  x: number;
  y: number;
  /** -1 or 1: left or right, front (towards -y, as the first view faces) or back. */
  sx: number;
  sy: number;
  /** The side wall the nut slot opens through. */
  exit: BoltExit;
  /** From the axis to just past that wall, along the slot. */
  slotRun: number;
}

/** What the bolts need from the parameters alone, before the rim places them. */
export interface BoltNeeds {
  size: BoltSize;
  fastener: Fastener;
  minWall: number;
  layer: number;
  holeClearance: number;
  holeRadius: number;
  /** The countersink's radius at the base's underside, and its depth up from there at 45 degrees. */
  sinkRadius: number;
  sinkDepth: number;
  /** Across the slot, which is the bridge its ceiling spans in print pose: the nut's flats with the clearance. */
  slotWidth: number;
  /** The nut's height with the clearance, and a layer for the bridge to sag into. */
  slotHeight: number;
  /** The lowest the slot's floor may sit: a wall over the groove's roof. */
  slotFloorMin: number;
  /** From B's sides to each axis: the most a hole, countersink or slot needs to keep its wall to the outside. */
  edge: number;
  /** The outer land that leaves a wall between a hole and the groove's corner, with the axis at `edge` from B. */
  land: number;
  /** The shortest standard length that passes the nut wherever the slot comes to sit. */
  autoLength: number;
  /** The length in use: the user's, or the auto one. */
  length: number;
  /** Where that length's hole over the nut would end, if the cover were tall enough. */
  wantedTop: number;
  /** Zt must reach this, so the shortest bolt and its slot keep a wall under the flat top. */
  coverHeight: number;
}

/** Where the bolts are, and everything they are cut from. Plain data, as it travels with the rim. */
export interface BoltLayout extends BoltNeeds {
  /** The base's underside, where the countersink opens. */
  bed: number;
  /** The slot's floor: the bridge in print pose, a whole number of layers from the flat top. */
  slotFloor: number;
  slotTop: number;
  /** The blind end of the hole over the nut, never past a wall under Zt. */
  holeTop: number;
  /** The length that passes this nut by the thread asked for, and the longest standard one the cover holds. */
  reach: number;
  longest: number | null;
  /** The outer land the joint alone would have. */
  jointLand: number;
  spots: BoltSpot[];
}

/**
 * The hole over the nut, for a screw of this length with its head in the countersink, which sits it up to a
 * clearance deep: the deepest it can go, so the screw never bottoms out.
 */
function holeTopFor(length: number, Tb: number, holeClearance: number): number {
  return length - Tb + holeClearance + TIP_CLEARANCE;
}

/**
 * G8 with bolts: the room they ask of the rim. The axis sits `edge` in from B's sides, which is the widest
 * of the hole's wall at the plate's top, the countersink's at the underside, where the bed relief takes
 * the plate in, and square to the plate's leaning side above it, and the slot's to the side wall it does
 * not open through. The groove's outer wall can
 * have a sharp corner, so the hole keeps its wall to that corner on the diagonal: land = edge + q / sqrt 2.
 */
export function boltNeeds(params: Params): BoltNeeds {
  const b = params.bolts, j = params.joint;
  const fastener = FASTENERS[b.size];
  const layer = params.print.layerHeight;
  const Tb = params.base.thickness;
  const tanTaper = Math.tan(j.taperDeg * DEGREE);
  const holeRadius = fastener.d / 2 + b.holeClearance;
  const sinkRadius = fastener.headDiameter / 2 + b.holeClearance;
  const slotWidth = fastener.nutFlats + 2 * b.nutClearance;
  const slotHeight = fastener.nutHeight + 2 * b.nutClearance + layer;
  const toBox = j.taperClearance + (Tb - j.baseProud) * tanTaper + params.cover.wall;
  // The plate's underside reaches this far past B: the taper's spread less the bed relief's run.
  const foot = (Tb - params.base.bedReliefHeight) * tanTaper - params.base.bedReliefRun;
  // Over the relief the plate's side leans out at the taper, so at a steep taper and a wide wall the
  // countersink's rim at the underside comes nearer that face, square to it, than along the underside.
  const leaning = sinkRadius + b.minWall / Math.cos(j.taperDeg * DEGREE) - Tb * tanTaper;
  const edge = Math.max(holeRadius + b.minWall, sinkRadius + b.minWall - foot, leaning, slotWidth / 2 + b.minWall - toBox);
  const land = edge + (holeRadius + b.minWall) / Math.SQRT2;
  const slotFloorMin = j.ridgeHeight + j.grooveExtraDepth + b.minWall;
  // The slot's floor is moved up to a layer boundary, by less than a layer, so the length counts that layer too.
  // A head sits from flush to a hole clearance deep, as the printed countersink comes out: the length the nut
  // needs takes it flush, and the hole over the nut (holeTopFor) takes it deep, so each is on the safe side.
  const reachMax = Tb + slotFloorMin + layer + fastener.nutHeight + threadPast(fastener);
  const autoLength = standardLength(reachMax) ?? BOLT_LENGTHS[BOLT_LENGTHS.length - 1];
  const length = b.length ?? autoLength;
  const coverHeight = Math.max(holeTopFor(autoLength, Tb, b.holeClearance), slotFloorMin + layer + slotHeight) + b.minWall;
  return {
    size: b.size,
    fastener,
    minWall: b.minWall,
    layer,
    holeClearance: b.holeClearance,
    holeRadius,
    sinkRadius,
    sinkDepth: sinkRadius - holeRadius,
    slotWidth,
    slotHeight,
    slotFloorMin,
    edge,
    land,
    autoLength,
    length,
    wantedTop: holeTopFor(length, Tb, b.holeClearance),
    coverHeight,
  };
}

/** What placeBolts reads of the rim being derived. */
export interface RimForBolts {
  D: Rect;
  e4: number;
  B: Rect;
  O: Rect;
  Zt: number;
  Tb: number;
  jointLand: number;
}

/**
 * The four corners of B, each axis `edge` in from both sides. Both side walls are then equally near, so
 * each slot opens through the shorter side, away from the pry notches at the middle of the long sides.
 */
export function placeBolts(needs: BoltNeeds, rim: RimForBolts): BoltLayout {
  const { B, O, Zt, Tb } = rim;
  const { edge, layer, minWall } = needs;
  const wide = O.x1 - O.x0 >= O.y1 - O.y0;
  const spots: BoltSpot[] = [];
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const x = sx > 0 ? B.x1 - edge : B.x0 + edge;
      const y = sy > 0 ? B.y1 - edge : B.y0 + edge;
      const exit: BoltExit = wide ? (sx > 0 ? 'x1' : 'x0') : sy > 0 ? 'y1' : 'y0';
      const wall = exit === 'x1' ? O.x1 - x : exit === 'x0' ? x - O.x0 : exit === 'y1' ? O.y1 - y : y - O.y0;
      spots.push({ x, y, sx, sy, exit, slotRun: wall + PAST });
    }
  }
  // In print pose the cover's layers count from the flat top, so a floor a whole number of layers under Zt
  // puts the bridge on a layer boundary and the membrane over the hole is exactly the first layer above it.
  const slotFloor = Zt - layer * Math.floor((Zt - needs.slotFloorMin) / layer + 1e-9);
  const slotTop = slotFloor + needs.slotHeight;
  const holeTop = Math.min(needs.wantedTop, Zt - minWall);
  // With the head flush, as in boltNeeds: the screw's end passes the nut by the thread at this length.
  const reach = Tb + slotFloor + needs.fastener.nutHeight + threadPast(needs.fastener);
  const longest = longestLength(Zt - minWall - TIP_CLEARANCE - needs.holeClearance + Tb);
  return { ...needs, bed: -Tb, slotFloor, slotTop, holeTop, reach, longest, jointLand: rim.jointLand, spots };
}

// ----- the cuts -----

/** The slot's outline in plan: a hex pocket round the axis, flats along the slot, opening into a channel out through the wall. */
export function slotOutline(bolts: Pick<BoltLayout, 'slotWidth'>, spot: BoltSpot): Vec2[] {
  const half = bolts.slotWidth / 2;
  // The hexagon's corner on the slot's line, and its two corners either side of it.
  const apex = bolts.slotWidth / Math.sqrt(3);
  const local: [number, number][] = [[-apex, 0], [-apex / 2, -half], [spot.slotRun, -half], [spot.slotRun, half], [-apex / 2, half]];
  // Turned, never mirrored, so the outline keeps its counter-clockwise order.
  const turn = { x1: [1, 0], y1: [0, 1], x0: [-1, 0], y0: [0, -1] }[spot.exit];
  return local.map(([u, v]) => [spot.x + u * turn[0] - v * turn[1], spot.y + u * turn[1] + v * turn[0]]);
}

function column(arena: Arena, x: number, y: number, z0: number, z1: number, r0: number, r1: number): Manifold {
  const { track } = arena;
  return track(track(arena.api.Manifold.cylinder(z1 - z0, r0, r1, SEGMENTS)).translate([x, y, z0]));
}

/**
 * G9 with bolts: per corner, the hole from the shelf up to a membrane one layer thick, the nut slot over
 * it, and the hole on over the nut for the screw's end. The membrane closes the hole at the slot's floor,
 * which is its ceiling in print pose, so the bridge prints whole; the screw pushes through it.
 */
export function coverBoltCutters(arena: Arena, bolts: BoltLayout): Manifold[] {
  const { track } = arena;
  const cutters: Manifold[] = [];
  for (const spot of bolts.spots) {
    cutters.push(column(arena, spot.x, spot.y, -BELOW_SHELF, bolts.slotFloor - bolts.layer, bolts.holeRadius, bolts.holeRadius));
    const outline = arena.crossSection([slotOutline(bolts, spot)]);
    cutters.push(track(track(arena.extrude(outline, bolts.slotTop - bolts.slotFloor)).translate([0, 0, bolts.slotFloor])));
    if (bolts.holeTop > bolts.slotTop + OVERLAP) cutters.push(column(arena, spot.x, spot.y, bolts.slotTop - OVERLAP, bolts.holeTop, bolts.holeRadius, bolts.holeRadius));
  }
  return cutters;
}

/** G10 with bolts: per corner, a 90 degree countersink opening at the underside, and the hole up through the plate. */
export function baseBoltCutters(arena: Arena, bolts: BoltLayout): Manifold[] {
  const cutters: Manifold[] = [];
  for (const spot of bolts.spots) {
    // From PAST below the underside, at 45 degrees, to the hole's radius at the countersink's depth.
    cutters.push(column(arena, spot.x, spot.y, bolts.bed - PAST, bolts.bed + bolts.sinkDepth, bolts.sinkRadius + PAST, bolts.holeRadius));
    cutters.push(column(arena, spot.x, spot.y, bolts.bed - PAST, ABOVE_PLATE, bolts.holeRadius, bolts.holeRadius));
  }
  return cutters;
}

/** The bridges in print pose that the overhang audit lists apart: each slot's floor, at its height in mold coordinates. */
export function boltBridges(bolts: BoltLayout): { z: number; outline: Vec2[]; span: number }[] {
  return bolts.spots.map((spot) => ({ z: bolts.slotFloor, outline: slotOutline(bolts, spot), span: bolts.slotWidth }));
}

// ----- the walls they leave -----

type Shape = { circle: [number, number, number] } | { polygon: Vec2[] };

/** A cut as a prism: an outline in plan between two heights, which is what each piece of a bolt's cut is. */
interface Prism {
  name: string;
  part: 'cover' | 'base';
  shape: Shape;
  z0: number;
  z1: number;
  /** A slot opens through this wall by design, so no wall is asked of it there. */
  exit?: BoltExit;
}

/**
 * Math.hypot is not required to round exactly, and SpiderMonkey's differs from V8's in the last bit, which
 * report.json would show. A square root is exact in every engine, and these values are far from overflow.
 */
function hypot(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

function segmentDistance(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const along = dx === 0 && dy === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return hypot(px - a[0] - along * dx, py - a[1] - along * dy);
}

function insidePolygon(px: number, py: number, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointToPolygon(px: number, py: number, polygon: Vec2[]): number {
  if (insidePolygon(px, py, polygon)) return 0;
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) best = Math.min(best, segmentDistance(px, py, polygon[j], polygon[i]));
  return best;
}

function rectPolygon(r: Rect): Vec2[] {
  return [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
}

/** Plan distance from a shape to a point: 0 inside it. */
function shapeToPoint(shape: Shape, px: number, py: number): number {
  if ('circle' in shape) {
    const [x, y, r] = shape.circle;
    return Math.max(0, hypot(px - x, py - y) - r);
  }
  return pointToPolygon(px, py, shape.polygon);
}

/** Plan distance from a convex shape to a filled rectangle: 0 where they overlap, else the gap between their edges. */
function shapeToRect(shape: Shape, rect: Rect): number {
  const box = rectPolygon(rect);
  if ('circle' in shape) {
    const [x, y, r] = shape.circle;
    return Math.max(0, pointToPolygon(x, y, box) - r);
  }
  const poly = shape.polygon;
  if (poly.some(([x, y]) => insidePolygon(x, y, box)) || box.some(([x, y]) => insidePolygon(x, y, poly))) return 0;
  let best = Infinity;
  for (const [x, y] of poly) best = Math.min(best, pointToPolygon(x, y, box));
  for (const [x, y] of box) best = Math.min(best, pointToPolygon(x, y, poly));
  return best;
}

/** The distance between two prisms of this kind, a shape and a box: their gap in plan and their gap in height, together. */
function gap3(plan: number, z0: number, z1: number, zb0: number, zb1: number): number {
  return hypot(plan, Math.max(0, zb0 - z1, z0 - zb1));
}

/** The furthest any shape reaches from its axis in plan, which limits where a cavity node could come near it. */
function reachOf(shape: Shape): Rect {
  if ('circle' in shape) {
    const [x, y, r] = shape.circle;
    return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  }
  const xs = shape.polygon.map((p) => p[0]), ys = shape.polygon.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Every piece of every bolt's cut, as prisms. The countersink is a cone, and is measured against the plate on its own. */
function prisms(bolts: BoltLayout): Prism[] {
  const out: Prism[] = [];
  for (const spot of bolts.spots) {
    const name = boltName(spot);
    const circle: Shape = { circle: [spot.x, spot.y, bolts.holeRadius] };
    out.push({ name: `the ${name} bolt's hole in the cover`, part: 'cover', shape: circle, z0: 0, z1: bolts.slotFloor - bolts.layer });
    out.push({ name: `the ${name} nut slot`, part: 'cover', shape: { polygon: slotOutline(bolts, spot) }, z0: bolts.slotFloor, z1: bolts.slotTop, exit: spot.exit });
    if (bolts.holeTop > bolts.slotTop) out.push({ name: `the ${name} bolt's hole over its nut`, part: 'cover', shape: circle, z0: bolts.slotTop, z1: bolts.holeTop });
    out.push({ name: `the ${name} bolt's hole in the base`, part: 'base', shape: circle, z0: bolts.bed + bolts.sinkDepth, z1: 0 });
  }
  return out;
}

/** "front left", from the spot's corner, as the app's first view faces the front. */
export function boltName(spot: Pick<BoltSpot, 'sx' | 'sy'>): string {
  return `${spot.sy < 0 ? 'front' : 'back'} ${spot.sx < 0 ? 'left' : 'right'}`;
}

/** The least wall each bolt's cut leaves, by what it faces, in mm, with what reaches it nearest. */
export interface BoltClearance {
  wall: number;
  /** The cut that comes nearest, in words, or null when nothing is in reach. */
  by: string | null;
}

export interface BoltClearances {
  groove: BoltClearance;
  /** The cover's outside, the rebate's mouth on the shelf, and the flat top. */
  outside: BoltClearance;
  /** The plate's sides and underside, round the countersink and the hole. */
  plate: BoltClearance;
  notches: BoltClearance;
}

/** What the clearance checks read of the rim. Rim itself would be a cycle of imports. */
export interface RimWalls {
  D: Rect;
  B: Rect;
  O: Rect;
  Zt: number;
  e3: number;
  e4: number;
  cT: number;
  tanTaper: number;
  tanRidge: number;
  ridgeHeight: number;
  grooveExtra: number;
  reliefHeight: number;
  reliefRun: number;
  Tb: number;
  notches: { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number }[];
  bolts: BoltLayout | null;
}

function nearest(list: [number, string][]): BoltClearance {
  let best: BoltClearance = { wall: Infinity, by: null };
  for (const [wall, by] of list) if (wall < best.wall) best = { wall, by };
  return best;
}

/** Distance between two polylines in a vertical section: at a vertex of one or the other. */
function polylineGap(a: Vec2[], b: Vec2[]): number {
  let best = Infinity;
  for (const p of a) for (let i = 1; i < b.length; i++) best = Math.min(best, segmentDistance(p[0], p[1], b[i - 1], b[i]));
  for (const p of b) for (let i = 1; i < a.length; i++) best = Math.min(best, segmentDistance(p[0], p[1], a[i - 1], a[i]));
  return best;
}

/**
 * The walls the bolts leave, from the rim alone: to the groove (a filled box out to its outer wall, which
 * only shrinks upward, so this is on the safe side), to the cover's outside and flat top, to the plate's
 * tapered sides with the bed relief, and to the pry notches. The cavity needs the field: boltCavityWall.
 */
export function boltClearances(rim: RimWalls): BoltClearances {
  const bolts = rim.bolts!;
  const all = prisms(bolts);
  const cover = all.filter((p) => p.part === 'cover');
  const grooveTop = rim.ridgeHeight + rim.grooveExtra;
  // The groove's faces in the cover lie over the shelf: under it inside B is the rebate's empty space.
  const groove = outset(rim.D, rim.e4);
  // The ridge stands on the base, its outer wall widest where it starts inside the plate.
  const ridge = outset(rim.D, rim.e3 + 0.5 * rim.tanRidge);
  const grooveList: [number, string][] = cover.map((p) => [gap3(shapeToRect(p.shape, groove), p.z0, p.z1, 0, grooveTop), p.name]);
  for (const p of all.filter((q) => q.part === 'base')) grooveList.push([gap3(shapeToRect(p.shape, ridge), p.z0, p.z1, -0.5, rim.ridgeHeight), p.name]);

  const outsideList: [number, string][] = [];
  const mouth = outset(rim.B, rim.cT);
  for (const p of cover) {
    const { x0, y0, x1, y1 } = reachOf(p.shape);
    const sides: [BoltExit, number][] = [['x0', x0 - rim.O.x0], ['x1', rim.O.x1 - x1], ['y0', y0 - rim.O.y0], ['y1', rim.O.y1 - y1]];
    for (const [side, wall] of sides) if (side !== p.exit) outsideList.push([wall, p.name]);
    outsideList.push([rim.Zt - p.z1, p.name]);
    // On the shelf, between the hole and the rebate's edge.
    if (p.z0 <= 0) outsideList.push([Math.min(x0 - mouth.x0, mouth.x1 - x1, y0 - mouth.y0, mouth.y1 - y1), p.name]);
  }

  // The plate in a vertical section from each axis to each side it is near: its side, with the taper and the
  // relief, against the countersink and the hole. The corners are no nearer, as their radius is held to edge.
  const plateList: [number, string][] = [];
  const spread = (rim.Tb - rim.reliefHeight) * rim.tanTaper;
  for (const spot of bolts.spots) {
    const out: Vec2[] = [[bolts.holeRadius, 0], [bolts.holeRadius, bolts.bed + bolts.sinkDepth], [bolts.sinkRadius, bolts.bed]];
    for (const side of [spot.sx > 0 ? rim.B.x1 - spot.x : spot.x - rim.B.x0, spot.sy > 0 ? rim.B.y1 - spot.y : spot.y - rim.B.y0]) {
      const plate: Vec2[] = [[side, 0], [side + spread, bolts.bed + rim.reliefHeight], [side + spread - rim.reliefRun, bolts.bed]];
      plateList.push([polylineGap(out, plate), `the ${boltName(spot)} countersink`]);
    }
  }

  const notchList: [number, string][] = [];
  for (const n of rim.notches) for (const p of cover) notchList.push([gap3(shapeToRect(p.shape, n), p.z0, p.z1, n.z0, n.z1), p.name]);
  return { groove: nearest(grooveList), outside: nearest(outsideList), plate: nearest(plateList), notches: nearest(notchList) };
}

/**
 * The least wall between the bolts' cuts and the cavity, by the field in 3D: each node with H above 0 is a
 * column from 0 to H plus the TIN's raise, and the surface between nodes reaches up to a cell past the last
 * of them, which comes off the distance in plan. `clip` is the rim's D, which the tool is cut to on a
 * preview. Nodes further than `reach` from any cut are not visited, and then the wall reads as `reach`.
 */
export function boltCavityWall(bolts: BoltLayout, field: Field, raise: number, clip: Rect | null, reach = 10): BoltClearance {
  const { nx, ny, cell, x0, y0, values } = field;
  let best: BoltClearance = { wall: reach, by: null };
  for (const p of prisms(bolts)) {
    // A cell more, as a node's wall is its distance less a cell: every node under `reach` is visited.
    const box = outset(reachOf(p.shape), reach + cell);
    const i0 = Math.max(0, Math.floor((box.x0 - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((box.x1 - x0) / cell));
    const j0 = Math.max(0, Math.floor((box.y0 - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((box.y1 - y0) / cell));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const h = values[i + j * nx];
        if (!(h > 0)) continue;
        const x = x0 + i * cell;
        if (clip && (x < clip.x0 || x > clip.x1 || y < clip.y0 || y > clip.y1)) continue;
        const wall = gap3(Math.max(0, shapeToPoint(p.shape, x, y) - cell), p.z0, p.z1, 0, h + raise);
        if (wall < best.wall) best = { wall, by: p.name };
      }
    }
  }
  return best;
}

/**
 * The least wall to the cavity however far it is, for report.json: the search widens until it finds the
 * cavity. Nothing is further than the box round the field and the bolts, and the base's hole, which has
 * no gap in height to any column, gives a wall under that, so past it there is no cavity at all.
 */
export function boltCavityWallAnywhere(bolts: BoltLayout, field: Field, raise: number, clip: Rect | null): BoltClearance {
  const xs = [field.x0, field.x0 + (field.nx - 1) * field.cell, ...bolts.spots.map((s) => s.x)];
  const ys = [field.y0, field.y0 + (field.ny - 1) * field.cell, ...bolts.spots.map((s) => s.y)];
  const most = hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  for (let reach = 10; ; reach *= 2) {
    const wall = boltCavityWall(bolts, field, raise, clip, reach);
    if (wall.by !== null || reach > most) return wall;
  }
}

/** Whether the screw in use passes its nut by the thread asked for and stops under the flat top: what bolt-short and bolt-long check. */
export function lengthFits(bolts: Pick<BoltLayout, 'length' | 'reach' | 'wantedTop' | 'holeTop'>): boolean {
  return bolts.length >= bolts.reach - SLACK && bolts.wantedTop <= bolts.holeTop + SLACK;
}

const mm = (v: number): string => `${v.toFixed(2)} mm`;

/** A clash is named with what to change. */
function clash(wall: BoltClearance, what: string, fix: string, minWall: number, also: string[]): Diagnostic | null {
  if (!(wall.wall < minWall - SLACK) || wall.by === null) return null;
  const by = wall.by.charAt(0).toUpperCase() + wall.by.slice(1);
  return { code: 'bolt-collision', severity: 'warning', also, message: `${by} comes within ${mm(Math.max(0, wall.wall))} of ${what}, under the least wall of ${minWall} mm: ${fix}` };
}

/** The checks on the bolts from the rim alone: lengths, the plate over the countersink, the bridge, and every wall but the cavity's. */
export function boltRimDiagnostics(rim: RimWalls): Diagnostic[] {
  const bolts = rim.bolts;
  if (!bolts) return [];
  const out: Diagnostic[] = [];
  const name = `${bolts.size} x ${bolts.length}`;
  if (bolts.length < bolts.reach - SLACK) {
    const fits = standardLength(bolts.reach);
    out.push({ code: 'bolt-short', severity: 'warning', message: `An ${name} mm screw does not reach through the nut with ${threadPast(bolts.fastener).toFixed(1)} mm of thread past it, which takes ${bolts.reach.toFixed(1)} mm from the base's underside: ${fits !== null ? `use ${fits} mm or longer` : 'use a thinner base or a smaller least wall'}.` });
  }
  if (bolts.wantedTop > bolts.holeTop + SLACK) {
    out.push({ code: 'bolt-long', severity: 'warning', message: `An ${name} mm screw is too long for this cover: its hole stops ${bolts.minWall} mm under the flat top, so the screw would bottom out before it clamps. ${bolts.longest !== null && bolts.longest >= bolts.reach - SLACK ? `Use ${bolts.longest} mm or shorter.` : 'Use a shorter screw or a taller top cap.'}` });
  }
  const over = rim.Tb - bolts.sinkDepth;
  const least = Math.max(OVER_SINK_MM, OVER_SINK_LAYERS * bolts.layer);
  if (over < least - SLACK) {
    const need = Math.ceil((bolts.sinkDepth + least) / bolts.layer - 1e-9) * bolts.layer;
    out.push({ code: 'bolt-plate-thin', severity: 'warning', also: ['bolts.size'], message: `The ${bolts.size} countersinks are ${bolts.sinkDepth.toFixed(2)} mm deep, which leaves ${over.toFixed(2)} mm of plate over them, under the ${least.toFixed(1)} mm a printed plate needs so the heads do not pull through: raise Base thickness to at least ${Number(need.toFixed(2))} mm, or use a smaller bolt.` });
  }
  if (bolts.slotWidth > BRIDGE_LIMIT + SLACK) {
    out.push({ code: 'bolt-bridge', severity: 'warning', also: ['bolts.size'], message: `Each nut slot's ceiling bridges ${bolts.slotWidth.toFixed(1)} mm in print pose, past the ${BRIDGE_LIMIT} mm that prints flat without supports on most printers: use a smaller nut clearance or bolt size.` });
  }
  const walls = boltClearances(rim);
  const w = bolts.minWall;
  for (const d of [
    clash(walls.groove, 'the groove and ridge', 'raise Outer land under Advanced, Joint, or use a smaller bolt.', w, ['joint.landOuter']),
    clash(walls.outside, "the cover's outside", 'raise Wall, or use a smaller bolt.', w, ['cover.wall']),
    // The axis keeps `edge` from B whatever the grid's edge, so only a smaller countersink moves this wall.
    clash(walls.plate, "the base's side", 'use a smaller bolt, or a smaller Hole clearance per side.', w, ['bolts.size', 'bolts.holeClearance']),
    clash(walls.notches, 'a pry notch', 'turn Pry notches off, or narrow them under Advanced, Joint.', w, ['joint.pryNotches']),
  ]) {
    if (d) out.push(d);
  }
  return out;
}

/** The cavity check, as a diagnostic: none while the wall holds. */
export function boltCavityDiagnostics(bolts: BoltLayout | null, field: Field, raise: number, clip: Rect | null): Diagnostic[] {
  if (!bolts) return [];
  // Only a wall under the least matters here, so the search reaches no further than that and a cell.
  const wall = boltCavityWall(bolts, field, raise, clip, bolts.minWall + 2 * field.cell);
  const d = clash(wall, 'the cavity', 'raise Edge distance under Grid, or use a smaller bolt.', bolts.minWall, ['grid.edge']);
  return d ? [d] : [];
}
