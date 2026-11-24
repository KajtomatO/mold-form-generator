import type { Manifold } from 'manifold-3d';
import type { Diagnostic } from '../report/diagnostics';
import { checked, type Arena } from '../solid/arena';
import { contains, outset, type Rect } from '../solid/rect';
import type { ToolMesh } from '../solid/tool';
import { clamGrooveSolid, grooveSolid, ringHull } from './joint';
import { openingCutters, type CutOpening } from './openings';
import { coverBoltCutters } from './bolts';
import { notchBoxes, PRY_LEG, rebateOutset, type ClamRim, type Rim, type SeamAxis } from './rim';
import { PRY_RUN } from './seamBolts';

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
  const { Manifold } = arena.api;
  return notchBoxes(rim).map(({ x0, y0, x1, y1, bottom, top }) => arena.track(arena.track(Manifold.cube([x1 - x0, y1 - y0, top - bottom + 1])).translate([x0, y0, bottom - 1])));
}

/** G9, S12: the cover without its openings, which S13 cuts from this. With bolts, their holes and nut slots too. */
export function buildCoverBody(arena: Arena, rim: Rim, tool: Manifold): Manifold {
  const { Manifold } = arena.api;
  const bolts = rim.bolts ? coverBoltCutters(arena, rim.bolts) : [];
  return checked(arena.track(Manifold.difference([blockSolid(arena, rim), rebateSolid(arena, rim), grooveSolid(arena, rim), tool, ...notchSolids(arena, rim), ...bolts])), 'The cover');
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
 * cropped tool is only right on a preview, whose coarser cell may reach past the rim it is checked
 * against, and at the export cell it would cost clearance, so the pipeline must treat that as a fault.
 */
export function toolDiagnostics(rim: Rim, tool: Pick<ToolMesh, 'domain' | 'clippedNodes'>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!contains(outset(rim.B, rebateOutset(rim, -2)), tool.domain)) {
    diagnostics.push({ code: 'tool-outside-rebate', severity: 'error', message: 'The cavity reaches past the base rebate, so the cover cannot be cut from these values.' });
  }
  if (tool.clippedNodes > 0) {
    diagnostics.push({ code: 'preview-cropped', severity: 'info', message: 'At the preview\'s coarser cell the cavity reaches past the rim in places, so it is cropped to the rim in this preview only.' });
  }
  return diagnostics;
}

// ----- G13.7: the two-part cover's halves -----

/**
 * G13.7 step 2, the shared block both halves are trimmed from: G9's box, rebate and groove, the box square, the groove
 * with its teardrop past D along the pull (clamGrooveSolid; the tests pass G9's own as a negative control). The pry
 * notches and the corner bolts are this type's locks, so the rim has none.
 */
export function buildClamCommon(arena: Arena, rim: ClamRim, groove: Manifold = clamGrooveSolid(arena, rim, rim.axis)): Manifold {
  return checked(arena.track(arena.api.Manifold.difference([blockSolid(arena, rim), rebateSolid(arena, rim), groove])), 'The two-part cover\'s block');
}

/** The unit vector along a. */
function along(axis: SeamAxis, sign: 1 | -1): [number, number, number] {
  return axis === 'x' ? [sign, 0, 0] : [0, sign, 0];
}

/** The block trimmed at P to one half's side: a >= xs for pos (+1), a <= xs for neg (-1). */
export function trimHalf(arena: Arena, solid: Manifold, axis: SeamAxis, xs: number, sign: 1 | -1): Manifold {
  return arena.track(solid.trimByPlane(along(axis, sign), sign * xs));
}

/**
 * G13.7 step 5: a 45 degree chamfer of PRY_LEG on the half's seam edge of each end face, from Zt down PRY_RUN, so the two
 * halves make a V for a screwdriver. Each runs past the box, out of the end face and over the top, and cuts only its half.
 */
export function pryChamfers(arena: Arena, rim: ClamRim, sign: 1 | -1): Manifold[] {
  const { axis, xs, O, Zt } = rim;
  const [b0, b1] = axis === 'x' ? [O.y0, O.y1] : [O.x0, O.x1];
  const z0 = Zt - PRY_RUN, height = PRY_RUN + 1;
  // In (a, b): the chamfer's face from (xs + sign PRY_LEG, b) on the end face to (xs, b + PRY_LEG inward) on P, and on
  // past P and out of the end face, where it cuts nothing of this half.
  const at = (b: number, inward: 1 | -1): [number, number][] => [
    [xs + sign * PRY_LEG, b],
    [xs, b + inward * PRY_LEG],
    [xs - sign, b + inward * PRY_LEG],
    [xs - sign, b - inward],
    [xs + sign * (PRY_LEG + 1), b - inward],
  ];
  return [at(b0, 1), at(b1, -1)].map((points) => {
    const xy = points.map(([a, b]) => (axis === 'x' ? [a, b] : [b, a]) as [number, number]);
    return arena.track(arena.extrude(arena.crossSection([xy], 'NonZero'), height).translate([0, 0, z0]));
  });
}

/** What G13.7 step 3 adds to and cuts from one half besides its tool: the seal's solids, and later the seam fasteners'. */
export interface HalfFeatures {
  add: Manifold[];
  cut: Manifold[];
}

/**
 * G13.7 steps 3 to 5, one half: the shared block trimmed at P, less its tool, with the seal's solids (pos: less the
 * groove and the sockets; neg: with the tongue and the pins), then less the openings' cutters, centred on P and cut from
 * both halves, and the pry chamfers.
 */
export function buildClamHalf(arena: Arena, rim: ClamRim, common: Manifold, tool: Manifold, sign: 1 | -1, features: HalfFeatures, openings: CutOpening[]): Manifold {
  const { Manifold: M } = arena.api;
  const what = sign > 0 ? 'The + half' : 'The - half';
  let half = arena.track(M.difference([trimHalf(arena, common, rim.axis, rim.xs, sign), tool, ...features.cut]));
  if (features.add.length > 0) half = arena.track(M.union([half, ...features.add]));
  const cutters = openings.flatMap((opening) => openingCutters(arena, rim, opening));
  return checked(arena.track(M.difference([half, ...cutters, ...pryChamfers(arena, rim, sign)])), what);
}
