import type { Manifold } from 'manifold-3d';
import type { Diagnostic } from '../report/diagnostics';
import { checked, type Arena } from '../solid/arena';
import { contains, outset, type Rect } from '../solid/rect';
import type { ToolMesh } from '../solid/tool';
import { grooveSolid, ringHull } from './joint';
import { openingCutters, type CutOpening } from './openings';
import { rebateOutset, type Rim } from './rim';

/** The cover's bottom edge: `proud` above the base's underside, so the base always rests on the table. */
export function coverBottom(rim: Rim): number {
  return -rim.Tb + rim.proud;
}

/** G9: the box, with its top edge chamfered at exactly 45 degrees so the first layer needs no support. */
function blockSolid(arena: Arena, rim: Rim): Manifold {
  const { O, Zt, topChamfer } = rim;
  const rings = [{ rect: O, radius: 0, z: coverBottom(rim) }];
  if (topChamfer > 0) {
    rings.push({ rect: O, radius: 0, z: Zt - topChamfer }, { rect: outset(O, -topChamfer), radius: 0, z: Zt });
  } else {
    rings.push({ rect: O, radius: 0, z: Zt });
  }
  return ringHull(arena, rings);
}

/** G9: the taper the base seats in. Each ring is the plate's at that height, offset by cT, corners included. */
function rebateSolid(arena: Arena, rim: Rim): Manifold {
  const ringAt = (z: number): { rect: Rect; radius: number; z: number } => {
    const by = rebateOutset(rim, z);
    return { rect: outset(rim.B, by), radius: rim.cornerRadius + by, z };
  };
  return ringHull(arena, [ringAt(0), ringAt(-rim.Tb - 1)]);
}

/** G9: two boxes at mid long sides, breaking through the wall into the rebate. */
function notchSolids(arena: Arena, rim: Rim): Manifold[] {
  if (rim.pryHeight <= 0) return [];
  const { O, B, pryWidth } = rim;
  const { Manifold } = arena.api;
  const bottom = coverBottom(rim);
  const top = bottom + rim.pryHeight;
  // The rebate narrows upward, so this reaches inside it all the way up the notch.
  const reach = rebateOutset(rim, top) - 0.5;
  const box = (x0: number, y0: number, x1: number, y1: number): Manifold =>
    arena.track(arena.track(Manifold.cube([x1 - x0, y1 - y0, top - bottom + 1])).translate([x0, y0, bottom - 1]));
  if (O.x1 - O.x0 >= O.y1 - O.y0) {
    const cx = (O.x0 + O.x1) / 2;
    return [box(cx - pryWidth / 2, B.y1 + reach, cx + pryWidth / 2, O.y1 + 1), box(cx - pryWidth / 2, O.y0 - 1, cx + pryWidth / 2, B.y0 - reach)];
  }
  const cy = (O.y0 + O.y1) / 2;
  return [box(B.x1 + reach, cy - pryWidth / 2, O.x1 + 1, cy + pryWidth / 2), box(O.x0 - 1, cy - pryWidth / 2, B.x0 - reach, cy + pryWidth / 2)];
}

/** G9, S12: the cover without its openings, which S13 cuts from this. */
export function buildCoverBody(arena: Arena, rim: Rim, tool: Manifold): Manifold {
  const { Manifold } = arena.api;
  return checked(arena.track(Manifold.difference([blockSolid(arena, rim), rebateSolid(arena, rim), grooveSolid(arena, rim), tool, ...notchSolids(arena, rim)])), 'The cover');
}

/**
 * G9, S13: the cover with its openings. This is the one step a dragged opening repeats on the cached
 * body, and it runs all the cutters as one batch, as a run of single subtractions costs far more.
 */
export function buildCoverFinal(arena: Arena, body: Manifold, rim: Pick<Rim, 'Zt'>, openings: CutOpening[]): Manifold {
  if (openings.length === 0) return body;
  const cutters = openings.flatMap((opening) => openingCutters(arena, rim, opening));
  return checked(arena.track(arena.api.Manifold.difference([body, ...cutters])), 'The cover with its openings');
}

/**
 * The plan's rule, tool domain inside the rebate at z = -2: anything outside would cut the wall. A
 * cropped tool is only right on a preview, where the field may run wider than the rim it is checked
 * against, and at the export cell it would cost clearance, so the pipeline must treat that as a fault.
 */
export function toolDiagnostics(rim: Rim, tool: Pick<ToolMesh, 'domain' | 'clippedNodes'>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!contains(outset(rim.B, rebateOutset(rim, -2)), tool.domain)) {
    diagnostics.push({ code: 'tool-outside-rebate', severity: 'error', message: 'The cavity reaches past the base rebate, so the cover cannot be cut from these values.' });
  }
  if (tool.clippedNodes > 0) {
    diagnostics.push({ code: 'preview-cropped', severity: 'info', message: 'The preview grid sits wider than the export at this cell, so the last row of cavities is cropped to the rim in this preview only.' });
  }
  return diagnostics;
}
