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
