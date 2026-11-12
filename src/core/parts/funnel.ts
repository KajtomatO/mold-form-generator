import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { assertRigid, type RigidTransform } from '../base/orient';
import type { Params } from '../params/schema';
import { checked, withArena, type Arena } from '../solid/arena';
import { funnelProfile } from './funnelProfile';
import { OPENING_SEGMENTS } from './openings';
import { poseToStl } from './poses';

/**
 * G12, revolved, with its axis on the origin and z = 0 at the cover's flat top, which is where it sits in
 * use. FL: a flange round the spigot's root lies flat on that top, so the funnel stands on it and the
 * spigot only centres it: its edge rises square, then a 45 degree chamfer runs in to the neck, so the
 * print pose needs no supports. Over its last 2 layers, or as many as a first layer squashed 0.2 mm into
 * the seat's mouth needs, the spigot runs straight up, clear of that mouth, which prints in the cover's
 * first layers and comes out a little narrower, so it does not hold the flange off the top; a seat too
 * shallow to spare that gets less (funnelProfile). With a flange width of 0 the neck's outside runs
 * straight into the spigot's wide end, as before FL. The rules in params/rules.ts say which values give
 * a sound profile, and M6 shows those as errors.
 */
export function buildFunnel(arena: Arena, params: Params): Manifold {
  const p = funnelProfile(params);
  const outside: [number, number][] = p.rFlange > 0
    ? [...(p.relief > 0 ? [[p.rRelief, -p.relief], [p.rRelief, 0]] as [number, number][] : [[p.rNeck, 0]] as [number, number][]), [p.rFlange, 0], [p.rFlange, p.zFlange], [p.rNeck, p.zChamfer]]
    : [[p.rNeck, 0]];
  // A chamfer that ends at the neck's top leaves no straight neck between them.
  if (p.rFlange === 0 || p.zChamfer < p.zNeck) outside.push([p.rNeck, p.zNeck]);
  const outline: SimplePolygon = [
    [p.rThroat, p.zTip],
    [p.rTip, p.zTip],
    ...outside,
    [p.rRim, p.zRim],
    [p.rRimInner, p.zRim],
    [p.rNeckInner, p.zConeInner],
    [p.rNeckInner, p.zNeckInner],
  ];
  return checked(arena.revolve(arena.crossSection([outline]), OPENING_SEGMENTS), 'The funnel');
}

/** Wide rim on the bed, by a half turn about x, so every wall leans in towards the tip. */
export function funnelPose(params: Pick<Params, 'funnel'>): RigidTransform {
  const pose: RigidTransform = { rotation: [1, 0, 0, 0, -1, 0, 0, 0, -1], translation: [0, 0, params.funnel.height] };
  assertRigid(pose);
  return pose;
}

export interface FunnelFile {
  stl: Uint8Array;
  /** One per pour across the mold, for the ZIP's README. */
  quantity: number;
}

/** G12: one STL per mold, whatever the number of pours, since they all share one diameter. */
export function funnelFile(api: ManifoldToplevel, params: Params, pours: number): FunnelFile {
  const stl = withArena(api, (arena) => poseToStl(api, buildFunnel(arena, params), funnelPose(params)));
  return { stl, quantity: pours };
}
