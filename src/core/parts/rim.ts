import { exportPlan, tileOffsets, type Field, type FieldSettings } from '../field/grid';
import type { Bounds, WeldedMesh } from '../mesh/weld';
import type { Params } from '../params/schema';
import type { Diagnostic } from '../report/diagnostics';
import { outset, type Rect } from '../solid/rect';
import { boltClearances, boltNeeds, boltRimDiagnostics, placeBolts, type BoltClearances, type BoltLayout, type RimWalls } from './bolts';

const DEGREE = Math.PI / 180;
/**
 * Added to the analytic bound in G8: what the cell can push the cavity past it. A source sits up to
 * half a cell past its vertex, and the surface takes up to one more cell to come down through z = 0.
 * That is under the plan's 0.5 mm up to a cell of 1/3 mm, and the export cell may go up to 0.5 mm.
 */
const BOUND_SLACK = 0.5;
const BOUND_CELLS = 1.5;

/** What the rim needs to know about the mold. None of it depends on the cell of a preview. */
export interface MoldBounds {
  /** The cavity can reach this far at z = 0, over all tiles. */
  D: Rect;
  /** Bounding box of the model, over all tiles. */
  model: Rect;
  hMax: number;
  /** The shift of each tile, from the export plan. Pockets and Mode B copies go here. */
  offsets: [number, number][];
}

/**
 * G8, one tile: how far a vertex at height z pushes the cavity out, from dilation and draft. The
 * raster clips at the plane, so geometry below it counts only where its edges cross the plane.
 */
function tileBound(mesh: WeldedMesh, rEff: number, draftDeg: number, cell: number): Rect {
  const { positions: p, indices } = mesh;
  const tan = Math.tan(draftDeg * DEGREE);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number, z: number): void => {
    const reach = rEff + (z + rEff) * tan;
    if (x - reach < x0) x0 = x - reach;
    if (x + reach > x1) x1 = x + reach;
    if (y - reach < y0) y0 = y - reach;
    if (y + reach > y1) y1 = y + reach;
  };
  let anyBelow = false;
  for (let v = 0; v < p.length; v += 3) {
    if (p[v + 2] >= 0) grow(p[v], p[v + 1], p[v + 2]);
    else anyBelow = true;
  }
  if (anyBelow) {
    for (let t = 0; t < indices.length; t += 3) {
      for (let c = 0; c < 3; c++) {
        const a = indices[t + c] * 3, b = indices[t + ((c + 1) % 3)] * 3;
        const za = p[a + 2], zb = p[b + 2];
        if (za < 0 === zb < 0) continue;
        const f = za / (za - zb);
        grow(p[a] + f * (p[b] - p[a]), p[a + 1] + f * (p[b + 1] - p[a + 1]), 0);
      }
    }
  }
  const slack = Math.max(BOUND_SLACK, BOUND_CELLS * cell);
  return { x0: x0 - slack, y0: y0 - slack, x1: x1 + slack, y1: y1 + slack };
}

/**
 * The analytic bounds of G8. They always come from the export plan, so a preview at any cell gets
 * the same outer box and the same tile positions as the export.
 */
export function moldBounds(mesh: WeldedMesh, bounds: Bounds, settings: FieldSettings): MoldBounds {
  const plan = exportPlan(bounds, settings);
  const tile = tileBound(mesh, plan.rEff, settings.draftDeg, plan.cell);
  const spanX = (plan.nx - 1) * plan.pitchXmm, spanY = (plan.ny - 1) * plan.pitchYmm;
  return {
    D: { x0: tile.x0, y0: tile.y0, x1: tile.x1 + spanX, y1: tile.y1 + spanY },
    model: { x0: bounds.min[0], y0: bounds.min[1], x1: bounds.max[0] + spanX, y1: bounds.max[1] + spanY },
    hMax: plan.hMax,
    offsets: tileOffsets(plan),
  };
}

/** G8: everything the cover and base are built from. Never entered directly, always derived. */
export interface Rim {
  D: Rect;
  /** Offsets from D: groove inner wall, ridge inner wall, ridge outer wall, groove outer wall, base top. */
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  e5: number;
  /** Outline of the base top at z = 0. */
  B: Rect;
  /** Outer box. */
  O: Rect;
  hMax: number;
  /** Top of the cover. */
  Zt: number;
  /** Base thickness. */
  Tb: number;
  proud: number;
  wall: number;
  topChamfer: number;
  cT: number;
  cG: number;
  tanTaper: number;
  cosTaper: number;
  tanRidge: number;
  cosRidge: number;
  ridgeHeight: number;
  grooveExtra: number;
  /** The plate's, after giving way to the room between D and B. */
  cornerRadius: number;
  reliefHeight: number;
  reliefRun: number;
  pryWidth: number;
  /** 0 with the notches off. */
  pryHeight: number;
  /** M10: where the bolts go and what they are cut from, or null with the bolts off. */
  bolts: BoltLayout | null;
  edge: {
    /** What the user typed, or null while it is on auto. */
    requested: number | null;
    /** The smallest edge that leaves room for the joint on every side. */
    minimum: number;
  };
  /** Errors here mean the parts cannot be built from these values. */
  diagnostics: Diagnostic[];
}

/** The height a pry notch may reach while staying under the shelf at z = 0. */
const PRY_MARGIN = 0.5;
/** A length past another by more than float rounding. */
const SLACK = 1e-6;

export function deriveRim(bounds: MoldBounds, params: Params): Rim {
  const { D, model, hMax } = bounds;
  const { thickness: Tb, bedReliefHeight: reliefHeight, bedReliefRun: reliefRun } = params.base;
  const { wall, topCap, topChamfer } = params.cover;
  const j = params.joint;
  const cT = j.taperClearance, cG = j.grooveClearance, proud = j.baseProud;
  const tanTaper = Math.tan(j.taperDeg * DEGREE);
  const tanRidge = Math.tan(j.ridgeDraftDeg * DEGREE);

  // With bolts the outer land grows as far as their holes and walls need, and no further.
  const bolts = params.bolts.enabled ? boltNeeds(params) : null;
  const e1 = j.landInner;
  const e2 = e1 + cG;
  const e3 = e2 + j.ridgeWidth;
  const e4 = e3 + cG;
  const e5 = bolts ? e4 + Math.max(j.landOuter, bolts.land) : e4 + j.landOuter;

  // From the base top out to the box, at the cover's bottom edge.
  const toBox = cT + (Tb - proud) * tanTaper + wall;
  const edge = params.grid.edge;
  // Extra width goes to the outer land, so the joint stays tight to the cavity.
  const boxOf = (smallest: Rect): Rect => {
    const wider = edge === null ? smallest : outset(model, edge - toBox);
    return { x0: Math.min(smallest.x0, wider.x0), y0: Math.min(smallest.y0, wider.y0), x1: Math.max(smallest.x1, wider.x1), y1: Math.max(smallest.y1, wider.y1) };
  };
  const minimumOf = (smallest: Rect): number => Math.max(model.x0 - smallest.x0, model.y0 - smallest.y0, smallest.x1 - model.x1, smallest.y1 - model.y1) + toBox;
  const smallest = outset(D, e5);
  const B = boxOf(smallest);
  const O = outset(B, toBox);
  const minimum = minimumOf(smallest);
  // The rim the joint alone would give, which the bolts' notes are told against.
  const plain = outset(D, e4 + j.landOuter);

  const diagnostics: Diagnostic[] = [];
  if (edge !== null && edge < minimum) {
    const why = bolts && minimum > minimumOf(plain) + SLACK ? 'the joint and the bolts in its corners need' : 'the joint needs';
    diagnostics.push({
      code: 'edge-raised',
      severity: 'info',
      message: `Edge raised from ${edge.toFixed(1)} to ${minimum.toFixed(1)} mm, because ${why} that much room around the cavity.`,
    });
  }
  // G8 has it that the joint cannot hit the cavity, and the rings' corners follow the plate's. Past the
  // room between D and B, the inner ring would pass within s1 of D's corner, and at last open the groove
  // into the cavity, while the plate's corner cut into the outer land. Up to it, every land holds.
  const room = Math.min(D.x0 - B.x0, D.y0 - B.y0, B.x1 - D.x1, B.y1 - D.y1);
  // A bolt's axis sits bolts.edge in from both sides, so a corner no rounder than that keeps its wall.
  const cornerRadius = bolts ? Math.min(params.base.cornerRadius, room, bolts.edge) : Math.min(params.base.cornerRadius, room);
  if (cornerRadius < params.base.cornerRadius) {
    const what = bolts && bolts.edge < room ? 'the bolt holes in the corners' : 'the lands around the cavity';
    diagnostics.push({ code: 'corner-clamped', severity: 'info', message: `Corner radius lowered from ${params.base.cornerRadius.toFixed(1)} to ${cornerRadius.toFixed(1)} mm, as a rounder corner would cut into ${what}.` });
  }
  if (j.grooveExtraDepth <= 0) {
    diagnostics.push({ code: 'groove-too-shallow', severity: 'error', message: `The groove must be deeper than the ridge: at an extra depth of ${j.grooveExtraDepth} mm the ridge meets the groove's roof, so the base cannot seat on the shelf.` });
  }
  const ridgeTop = j.ridgeWidth - 2 * j.ridgeHeight * tanRidge;
  if (ridgeTop <= 0) {
    diagnostics.push({ code: 'ridge-too-thin', severity: 'error', message: `The ridge comes to nothing at this height and draft: ${j.ridgeWidth} mm wide at the base, it narrows by ${(2 * j.ridgeHeight * tanRidge).toFixed(2)} mm.` });
  }
  if (cG <= cT) {
    diagnostics.push({ code: 'joint-clearance', severity: 'warning', message: `Groove clearance ${cG} mm is not above taper clearance ${cT} mm, so the ridge could touch first and hold the taper open.` });
  }

  let pryHeight = j.pryNotches ? j.pryHeight : 0;
  const pryRoom = Tb - proud - PRY_MARGIN;
  if (pryHeight > pryRoom) {
    pryHeight = pryRoom;
    diagnostics.push({ code: 'pry-clamped', severity: 'info', message: `Pry notches were lowered to ${pryRoom.toFixed(2)} mm, so they stay below the shelf the base seats on.` });
  }

  const jointTop = Math.max(hMax + topCap, j.ridgeHeight + j.grooveExtraDepth + topCap);
  // The shortest bolt and its slot keep a wall under the flat top, which on a low model raises it.
  const Zt = bolts ? Math.max(jointTop, bolts.coverHeight) : jointTop;
  if (bolts) {
    // What the bolts add to the box, which a wide edge may already hold in part or whole.
    const without = boxOf(plain);
    const grow = [B.x1 - B.x0 - (without.x1 - without.x0), B.y1 - B.y0 - (without.y1 - without.y0)];
    if (grow[0] > SLACK || grow[1] > SLACK) {
      const box = Math.abs(grow[0] - grow[1]) < 0.05
        ? `is ${grow[0].toFixed(1)} mm wider each way`
        : `grows by ${[grow[0] > SLACK ? `${grow[0].toFixed(1)} mm from left to right` : '', grow[1] > SLACK ? `${grow[1].toFixed(1)} mm from front to back` : ''].filter(Boolean).join(' and ')}`;
      diagnostics.push({ code: 'bolt-land', severity: 'info', message: `The outer land grows from ${j.landOuter.toFixed(1)} to ${bolts.land.toFixed(1)} mm to hold the ${bolts.size} bolts with a wall of ${bolts.minWall} mm round them, so the box ${box}.` });
    }
    if (Zt > jointTop + SLACK) {
      // A smaller size has a shorter auto length and a lower slot, so it always lowers the top; a base it may not.
      const smaller = bolts.size === 'M2.5' ? '' : ' A smaller bolt size lowers it.';
      diagnostics.push({ code: 'bolt-cover-raised', severity: 'info', also: ['bolts.size'], message: `The flat top is raised from ${jointTop.toFixed(1)} to ${Zt.toFixed(1)} mm, ${(Zt - jointTop).toFixed(1)} mm over what Top cap asks, so the ${bolts.size} x ${bolts.autoLength} mm screws and their nut slots keep a wall of ${bolts.minWall} mm under it.${smaller}` });
    }
  }
  const rim: Rim = {
    D,
    e1, e2, e3, e4, e5,
    B,
    O,
    hMax,
    Zt,
    Tb,
    proud,
    wall,
    topChamfer,
    cT,
    cG,
    tanTaper,
    cosTaper: Math.cos(j.taperDeg * DEGREE),
    tanRidge,
    cosRidge: Math.cos(j.ridgeDraftDeg * DEGREE),
    ridgeHeight: j.ridgeHeight,
    grooveExtra: j.grooveExtraDepth,
    cornerRadius,
    reliefHeight,
    reliefRun,
    pryWidth: j.pryWidth,
    pryHeight,
    bolts: bolts ? placeBolts(bolts, { D, e4, B, O, Zt, Tb, jointLand: j.landOuter }) : null,
    edge: { requested: edge, minimum },
    diagnostics,
  };
  if (rim.bolts) diagnostics.push(...boltRimDiagnostics(wallsOf(rim)));
  return rim;
}

function wallsOf(rim: Rim): RimWalls {
  return { ...rim, notches: notchBoxes(rim).map((n) => ({ x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1, z0: n.bottom - 1, z1: n.top })) };
}

/** M10: the walls the bolts leave to the groove, the outside, the plate's sides and the notches, or null with the bolts off. */
export function boltWalls(rim: Rim): BoltClearances | null {
  return rim.bolts ? boltClearances(wallsOf(rim)) : null;
}

/** G9: where the two pry notches go, at mid long sides, breaking through the wall into the rebate. Empty with them off. */
export interface NotchBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The cover's bottom edge, which the cut starts a mm under, and the notch's top. */
  bottom: number;
  top: number;
}

export function notchBoxes(rim: Rim): NotchBox[] {
  if (rim.pryHeight <= 0) return [];
  const { O, B, pryWidth } = rim;
  const bottom = -rim.Tb + rim.proud;
  const top = bottom + rim.pryHeight;
  // The rebate narrows upward, so this reaches inside it all the way up the notch.
  const reach = rebateOutset(rim, top) - 0.5;
  if (O.x1 - O.x0 >= O.y1 - O.y0) {
    const cx = (O.x0 + O.x1) / 2;
    return [
      { x0: cx - pryWidth / 2, y0: B.y1 + reach, x1: cx + pryWidth / 2, y1: O.y1 + 1, bottom, top },
      { x0: cx - pryWidth / 2, y0: O.y0 - 1, x1: cx + pryWidth / 2, y1: B.y0 - reach, bottom, top },
    ];
  }
  const cy = (O.y0 + O.y1) / 2;
  return [
    { x0: B.x1 + reach, y0: cy - pryWidth / 2, x1: O.x1 + 1, y1: cy + pryWidth / 2, bottom, top },
    { x0: O.x0 - 1, y0: cy - pryWidth / 2, x1: B.x0 - reach, y1: cy + pryWidth / 2, bottom, top },
  ];
}

/** Half width of the rebate at height z <= 0, measured out from B. */
export function rebateOutset(rim: Rim, z: number): number {
  return rim.cT - z * rim.tanTaper;
}

/**
 * G8's check on the H mask: how far the cavity passes D, in mm. A last node above 0 pulls the surface
 * to z = 0 up to one cell further on, which is included. At the export cell this must be 0, and that
 * is what keeps the groove off the cavity whatever the model does.
 */
export function maskOverrun(field: Field, D: Rect): number {
  const { nx, ny, cell, x0, y0, values } = field;
  let worst = 0;
  for (let j = 0, n = 0; j < ny; j++) {
    const y = y0 + j * cell;
    for (let i = 0; i < nx; i++, n++) {
      if (values[n] <= 0) continue;
      const x = x0 + i * cell;
      worst = Math.max(worst, D.x0 - (x - cell), D.y0 - (y - cell), x + cell - D.x1, y + cell - D.y1);
    }
  }
  return worst;
}

// ----- G13.6: the two-part cover's bounds -----

/** The seam plane's axis: P = {a = xs}, a being x or y, and b the other horizontal axis. */
export type SeamAxis = 'x' | 'y';

/**
 * G13.6 and G13.8: the plastic the seam's groove keeps to O's face across the pull, in mm. The band needs O.b at least
 * seamLand + rw + 2cG + BAND_ROOM past D3.b, which deriveClamRim adds up.
 */
export const BAND_ROOM = 0.8;

/**
 * G13.6, what the vertices give once, for both axes and any xs: the extremes the O(1) bounds read. The model is the
 * oriented one cut at z = 0 (clipBelow), so every vertex is at z >= 0 and the cut's own corners are among them.
 */
export interface ClamVertices {
  /** The clipped model's positions. */
  positions: Float32Array;
  /** Its extent along x and y. */
  min: [number, number];
  max: [number, number];
  rEff: number;
  tanDraft: number;
  /** G13.6's zJ: rh + gx + seamLand + 0.5, the height D_side bounds the cavity up to. */
  zJ: number;
  /**
   * How far over zJ + rEff + w a vertex still counts towards D_side: G13.6's filter, widened by the closing's width,
   * which reaches that far along v, and SIDE_SLACK for the raster's half cell. Without it, a model that overhangs just
   * over the joint (the wolf) had low nodes up to 0.8 mm past D_side.
   */
  zSlack: number;
  /** Per axis, the relaxed D_side and D3 terms across and along the pull (see sideBoundsFast). */
  axes: Record<SeamAxis, AxisExtremes>;
  /** Hmax_clam's M+ and M- per axis and per tan(beta) + tan(alpha), worked out on first use. */
  hmax: Map<string, [number, number]>;
}

interface AxisExtremes {
  /** Over the vertices low enough for D_side at any xs: max of b + k a and b - k a, min of b - k a and b + k a, k = tan(alpha). */
  sideB: [number, number, number, number];
  /** The same over every vertex, for D3. */
  allB: [number, number, number, number];
  /** Along the pull: the least and most a of those vertices, and of all. */
  sideA: [number, number];
  allA: [number, number];
}

const AXIS = { x: 0, y: 1 } as const;
const other = (axis: SeamAxis): 0 | 1 => (axis === 'x' ? 1 : 0);

/** G13.6's zJ, from the joint and the seam land. */
export function seamJointTop(params: Params): number {
  return params.joint.ridgeHeight + params.joint.grooveExtraDepth + params.clamshell.seamLand + 0.5;
}

/** The extremes of the clipped model that every O(1) bound of G13.3 and G13.6 reads, for both axes. */
export function clamVertices(clipped: WeldedMesh, rEff: number, draftDeg: number, zJ: number, closeWidth: number): ClamVertices {
  const zSlack = closeWidth + SIDE_SLACK;
  const p = clipped.positions;
  const tanDraft = Math.tan(draftDeg * DEGREE);
  const min: [number, number] = [Infinity, Infinity], max: [number, number] = [-Infinity, -Infinity];
  for (let v = 0; v < p.length; v += 3) {
    for (const k of [0, 1] as const) {
      if (p[v + k] < min[k]) min[k] = p[v + k];
      if (p[v + k] > max[k]) max[k] = p[v + k];
    }
  }
  // A vertex counts towards D_side where z <= zJ + rEff + w, and w is largest at the far end of the extent.
  const axes = {} as Record<SeamAxis, AxisExtremes>;
  for (const axis of ['x', 'y'] as const) {
    const a = AXIS[axis], b = other(axis);
    const zLow = zJ + zSlack + rEff + (max[a] - min[a] + rEff) * tanDraft;
    const sideB: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity];
    const allB: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity];
    const sideA: [number, number] = [Infinity, -Infinity], allA: [number, number] = [Infinity, -Infinity];
    for (let v = 0; v < p.length; v += 3) {
      const av = p[v + a], bv = p[v + b];
      const plus = bv + tanDraft * av, minus = bv - tanDraft * av;
      if (plus > allB[0]) allB[0] = plus;
      if (minus > allB[1]) allB[1] = minus;
      if (minus < allB[2]) allB[2] = minus;
      if (plus < allB[3]) allB[3] = plus;
      if (av < allA[0]) allA[0] = av;
      if (av > allA[1]) allA[1] = av;
      if (p[v + 2] > zLow) continue;
      if (plus > sideB[0]) sideB[0] = plus;
      if (minus > sideB[1]) sideB[1] = minus;
      if (minus < sideB[2]) sideB[2] = minus;
      if (plus < sideB[3]) sideB[3] = plus;
      if (av < sideA[0]) sideA[0] = av;
      if (av > sideA[1]) sideA[1] = av;
    }
    axes[axis] = { sideB, allB, sideA, allA };
  }
  return { positions: p, min, max, rEff, tanDraft, zJ, zSlack, axes, hmax: new Map() };
}

/** A rectangle from extents along a and b. */
function rectOf(axis: SeamAxis, a0: number, a1: number, b0: number, b1: number): Rect {
  return axis === 'x' ? { x0: a0, x1: a1, y0: b0, y1: b1 } : { x0: b0, x1: b1, y0: a0, y1: a1 };
}

/** What D_side and D3 add past a vertex, across the pull, besides w: rEff and G13.6's 0.5. */
const SIDE_SLACK = 0.5;

export interface SideBounds {
  /** D_side: the cavity at z <= zJ, across the pull with the draft's w, along it clamped to include xs. */
  side: Rect;
  /** D3: the same terms with no z filter. */
  all: Rect;
}

/**
 * G13.6, exactly, in O(vertices): D_side counts a vertex where v.z <= zJ + zSlack + rEff + w(v), w(v) = (|v.a - xs| + rEff)
 * tan(alpha); across the pull it reaches v.b +- (rEff + w(v)) + 0.5, along it v.a +- rEff + 0.5, clamped to include xs.
 * D3 is the same with no z filter.
 */
export function sideBounds(vertices: ClamVertices, axis: SeamAxis, xs: number): SideBounds {
  const { positions: p, rEff, tanDraft, zJ, zSlack } = vertices;
  const a = AXIS[axis], b = other(axis);
  let sa0 = Infinity, sa1 = -Infinity, sb0 = Infinity, sb1 = -Infinity;
  let aa0 = Infinity, aa1 = -Infinity, ab0 = Infinity, ab1 = -Infinity;
  for (let v = 0; v < p.length; v += 3) {
    const av = p[v + a], bv = p[v + b];
    const w = (Math.abs(av - xs) + rEff) * tanDraft;
    const across = rEff + w + SIDE_SLACK;
    aa0 = Math.min(aa0, av - rEff - SIDE_SLACK);
    aa1 = Math.max(aa1, av + rEff + SIDE_SLACK);
    ab0 = Math.min(ab0, bv - across);
    ab1 = Math.max(ab1, bv + across);
    if (p[v + 2] > zJ + zSlack + rEff + w) continue;
    sa0 = Math.min(sa0, av - rEff - SIDE_SLACK);
    sa1 = Math.max(sa1, av + rEff + SIDE_SLACK);
    sb0 = Math.min(sb0, bv - across);
    sb1 = Math.max(sb1, bv + across);
  }
  // A model with nothing low (it cannot happen once clipped at 0, but an empty filter must not give Infinity).
  if (!(sa0 <= sa1)) sa0 = sa1 = xs, sb0 = ab0, sb1 = ab1;
  return { side: rectOf(axis, Math.min(sa0, xs), Math.max(sa1, xs), sb0, sb1), all: rectOf(axis, Math.min(aa0, xs), Math.max(aa1, xs), ab0, ab1) };
}

/**
 * The same bounds in O(1) for G13.3's bed filter, never inside the exact ones: the z filter is taken at its widest
 * over the extent, and |v.a - xs| tan(alpha) is split into its two linear pieces, whose maxima the vertices give once.
 * The widest filter holds only for xs inside the extent, where every candidate lies, so any other xs is refused.
 */
export function sideBoundsFast(vertices: ClamVertices, axis: SeamAxis, xs: number): SideBounds {
  const { rEff, tanDraft: k } = vertices;
  const a = AXIS[axis];
  if (xs < vertices.min[a] - 1e-9 || xs > vertices.max[a] + 1e-9) throw new Error(`The seam at ${axis} = ${xs} lies outside the model's extent, ${vertices.min[a]} to ${vertices.max[a]}.`);
  const { sideB, allB, sideA, allA } = vertices.axes[axis];
  const grow = rEff + rEff * k + SIDE_SLACK;
  const across = (m: [number, number, number, number]): [number, number] => [Math.min(m[2] + k * xs, m[3] - k * xs) - grow, Math.max(m[0] - k * xs, m[1] + k * xs) + grow];
  const [sb0, sb1] = across(sideB), [ab0, ab1] = across(allB);
  return {
    side: rectOf(axis, Math.min(sideA[0] - rEff - SIDE_SLACK, xs), Math.max(sideA[1] + rEff + SIDE_SLACK, xs), sb0, sb1),
    all: rectOf(axis, Math.min(allA[0] - rEff - SIDE_SLACK, xs), Math.max(allA[1] + rEff + SIDE_SLACK, xs), ab0, ab1),
  };
}

/**
 * G13.6's Hmax_clam: max over v of (v.z + |v.a - xs| tan(beta) + rEff / cos(beta) + w(v)) + (raise + cell) max(1, tan(beta)),
 * in O(1) per xs: the vertex term is max(M+ - c xs, M- + c xs) with M+- = max(v.z +- c v.a), c = tan(beta) + tan(alpha).
 * With beta 0, rEff / cos(beta) is rEff. `cell` is the field's: the export's for the rim, so the rim is cell-independent.
 */
export function hmaxClam(vertices: ClamVertices, axis: SeamAxis, xs: number, betaDeg: number, raise: number, cell: number): number {
  const tanBeta = betaDeg > 0 ? Math.tan(betaDeg * DEGREE) : 0;
  const c = tanBeta + vertices.tanDraft;
  const key = `${axis} ${c}`;
  let m = vertices.hmax.get(key);
  if (!m) {
    const p = vertices.positions, a = AXIS[axis];
    let plus = -Infinity, minus = -Infinity;
    for (let v = 0; v < p.length; v += 3) {
      plus = Math.max(plus, p[v + 2] + c * p[v + a]);
      minus = Math.max(minus, p[v + 2] - c * p[v + a]);
    }
    m = [plus, minus];
    vertices.hmax.set(key, m);
  }
  const { rEff, tanDraft } = vertices;
  const sphere = betaDeg > 0 ? rEff / Math.cos(betaDeg * DEGREE) : rEff;
  return Math.max(m[0] - c * xs, m[1] + c * xs) + sphere + rEff * tanDraft + (raise + cell) * Math.max(1, tanBeta);
}

/** G13.6's rim: G8's, from D = max(D_G8, D_side) and Hmax_clam, with D3 and the wall's raise for the band. */
export interface ClamRim extends Rim {
  axis: SeamAxis;
  xs: number;
  /** G8's D, which this type's D only ever widens. */
  DG8: Rect;
  Dside: Rect;
  D3: Rect;
  zJ: number;
  /** Whether D_side took D past D_G8 on any side, which report.json states. */
  dGrew: boolean;
  /** The wall the user set and the one the band needed, or null when the user's was enough. */
  wallRaised: { from: number; to: number } | null;
}

/**
 * G13.6: the rim of the two-part cover at this split. The corner bolts and the pry notches are this type's locks, so
 * they are off here whatever `params` hold. O is G8's with the user's wall, raised only where the band above the joint
 * would leave less than seamLand + gw + 0.8 between D3 and O's faces across the pull; the base, B, is unchanged. The
 * wall is one value round the box, as `cover.wall` is, so a raise moves all four of O's faces, the halves' depths
 * and the bed's height with them, and the edge's minimum by the same.
 */
export function deriveClamRim(mold: MoldBounds, bounds: SideBounds, hmax: number, params: Params, axis: SeamAxis, xs: number, zJ: number): ClamRim {
  const locked: Params = { ...params, bolts: { ...params.bolts, enabled: false }, joint: { ...params.joint, pryNotches: false } };
  const DG8 = mold.D, Dside = bounds.side, D3 = bounds.all;
  const D: Rect = { x0: Math.min(DG8.x0, Dside.x0), y0: Math.min(DG8.y0, Dside.y0), x1: Math.max(DG8.x1, Dside.x1), y1: Math.max(DG8.y1, Dside.y1) };
  const dGrew = D.x0 < DG8.x0 || D.y0 < DG8.y0 || D.x1 > DG8.x1 || D.y1 > DG8.y1;
  const rim = deriveRim({ ...mold, D, hMax: hmax }, locked);
  const j = params.joint;
  const room = params.clamshell.seamLand + j.ridgeWidth + 2 * j.grooveClearance + BAND_ROOM;
  const short = axis === 'x' ? Math.max(rim.O.y0 - (D3.y0 - room), D3.y1 + room - rim.O.y1) : Math.max(rim.O.x0 - (D3.x0 - room), D3.x1 + room - rim.O.x1);
  let wallRaised: ClamRim['wallRaised'] = null;
  if (short > SLACK) {
    const to = rim.wall + short;
    wallRaised = { from: rim.wall, to };
    rim.O = outset(rim.O, short);
    rim.wall = to;
    rim.edge = { ...rim.edge, minimum: rim.edge.minimum + short };
    rim.diagnostics.push({ code: 'seam-wall-raised', severity: 'info', also: ['cover.wall'], message: `Wall raised from ${wallRaised.from.toFixed(1)} to ${to.toFixed(1)} mm for the seam seal, so its groove keeps ${BAND_ROOM} mm of plastic to the outside.` });
  }
  // D3 along the pull stays inside O less the wall, as D_G8 holds every vertex with its margin: G13.6's assert.
  const [a0, a1, o0, o1] = axis === 'x' ? [D3.x0, D3.x1, rim.O.x0, rim.O.x1] : [D3.y0, D3.y1, rim.O.y0, rim.O.y1];
  if (a0 < o0 + rim.wall - SLACK || a1 > o1 - rim.wall + SLACK) throw new Error(`D3 reaches past the wall along the pull (${a0.toFixed(3)} to ${a1.toFixed(3)} against ${(o0 + rim.wall).toFixed(3)} to ${(o1 - rim.wall).toFixed(3)}).`);
  return { ...rim, axis, xs, DG8, Dside, D3, zJ, dGrew, wallRaised };
}
