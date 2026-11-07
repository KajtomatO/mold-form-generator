import type { Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { assertRigid, type RigidTransform } from '../base/orient';
import type { Params } from '../params/schema';
import { checked, withArena, type Arena } from '../solid/arena';
import { funnelProfile } from './funnelProfile';
import { OPENING_SEGMENTS } from './openings';
import { poseToStl } from './poses';

/**
 * G12: revolved, with no flat ledge, as the neck's outside runs straight into the spigot's wide end.
 * With its axis on the origin and z = 0 at the cover's flat top, which is where it sits in use.
 * The rules in params/rules.ts say which values give a sound profile, and M6 shows those as errors.
 */
export function buildFunnel(arena: Arena, params: Params): Manifold {
  const p = funnelProfile(params);
  const outline: SimplePolygon = [
    [p.rThroat, p.zTip],
    [p.rTip, p.zTip],
    [p.rNeck, 0],
    [p.rNeck, p.zNeck],
    [p.rRim, p.zRim],
    [p.rRimInner, p.zRim],
    [p.rNeckInner, p.zConeInner],
    [p.rNeckInner, p.zNeckInner],
  ];
  return checked(arena.track(arena.crossSection([outline]).revolve(OPENING_SEGMENTS)), 'The funnel');
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
