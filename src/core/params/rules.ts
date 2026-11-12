import { funnelProfile, MIN_SPIGOT } from '../parts/funnelProfile';
import type { Diagnostic } from '../report/diagnostics';
import { PARAM_SCHEMA, type Params } from './schema';

/**
 * The plan's hard rule on the seat: the cone keeps a millimetre of plastic over the highest ceiling.
 * Zt is Hmax + topCap at least, so this holds over all of the cavity.
 */
const SEAT_ROOF = 1;
/** G12: the print pose has no wall past this from vertical. */
const FUNNEL_LIMIT_DEG = 45;
/** A rim so narrow at its top would be nothing to pour into. Square to the wall, as the wall itself is. */
const MIN_RIM = 0.4;

function funnelProblems(params: Params): Diagnostic[] {
  const { funnel, pour, seat } = params;
  const problems: Diagnostic[] = [];
  const error = (code: string, message: string): void => void problems.push({ code, severity: 'error', message });
  if (!seat.enabled) {
    error('funnel-no-seat', 'The funnel needs the funnel seat, so turn the seat on or the funnel off.');
    return problems;
  }
  if (funnel.topDiameter < pour.diameter + 2 * funnel.wall) {
    error('funnel-top-small', `A funnel top of ${funnel.topDiameter} mm is under the ${pour.diameter + 2 * funnel.wall} mm that a ${pour.diameter} mm pour and its walls need.`);
    return problems;
  }
  if (pour.diameter <= 2 * funnel.tipWall) {
    error('funnel-no-throat', `A pour of ${pour.diameter} mm leaves no throat inside a tip wall of ${funnel.tipWall} mm.`);
    return problems;
  }
  const p = funnelProfile(params);
  if (-p.zTip < MIN_SPIGOT) {
    error('funnel-no-spigot', `A seat clearance of ${funnel.seatClearance} mm leaves ${(-p.zTip).toFixed(2)} mm of spigot in a seat ${seat.depth} mm deep, so make the clearance smaller or the seat deeper.`);
    return problems;
  }
  if (funnel.height <= funnel.neckHeight) {
    error('funnel-no-cone', `A funnel ${funnel.height} mm high has no room for its cone over a neck of ${funnel.neckHeight} mm.`);
    return problems;
  }
  if (p.rRim < p.rNeck) {
    error('funnel-under-neck', `A funnel top of ${funnel.topDiameter} mm is narrower than its ${(2 * p.rNeck).toFixed(1)} mm neck, which is the seat's width at the flat top.`);
    return problems;
  }
  if (p.coneDeg > FUNNEL_LIMIT_DEG) {
    const fits = 2 * (p.rNeck + (funnel.height - funnel.neckHeight));
    error('funnel-too-flat', `The funnel's cone leans ${p.coneDeg.toFixed(0)} degrees from vertical, past the 45 it can print at: make the top at most ${Math.floor(fits)} mm, or the funnel taller.`);
    return problems;
  }
  if (p.zConeInner >= funnel.height || p.rRimInner < p.rNeckInner || p.rRim - p.rRimInner < MIN_RIM || p.zNeckInner > p.zConeInner || p.rNeckInner <= 0) {
    error('funnel-wall', `A funnel wall of ${funnel.wall} mm does not fit in a funnel of ${funnel.topDiameter} by ${funnel.height} mm over a neck of ${funnel.neckHeight} mm.`);
    return problems;
  }
  // FL: the flange's 45 degree chamfer runs in to the neck, and must reach it before the cone widens out again.
  if (p.rFlange > 0 && p.zChamfer > funnel.neckHeight + 1e-9) {
    const widest = Math.floor((funnel.neckHeight - funnel.flangeThickness - (p.rFlange - funnel.flangeWidth - p.rNeck)) * 10) / 10;
    const fits = widest > 0 ? `make Flange width at most ${widest} mm, or ` : '';
    error('funnel-flange', `A flange ${funnel.flangeWidth} mm wide and ${funnel.flangeThickness} mm thick needs a neck at least ${(Math.ceil(p.zChamfer * 10 - 1e-9) / 10).toFixed(1)} mm high for the chamfer that lets it print without supports, over the ${funnel.neckHeight} mm set: ${fits}raise Neck height, or make the flange thinner.`);
  }
  return problems;
}

/**
 * The hard rules between parameters that need nothing but the parameters. Each is an inline error,
 * never a throw, because a user part way through typing a value passes through these all the time.
 * The joint's own rules and the ring radius clamp are in deriveRim, and the rule that the tool domain
 * stays inside the rebate needs a tool, so it is in toolDiagnostics.
 */
export function crossParameterErrors(params: Params): Diagnostic[] {
  const problems: Diagnostic[] = [];
  const { seat, cover, funnel } = params;
  if (seat.enabled && seat.depth > cover.topCap - SEAT_ROOF) {
    problems.push({ code: 'seat-too-deep', severity: 'error', message: `A seat ${seat.depth} mm deep leaves under ${SEAT_ROOF} mm of plastic in a top cap of ${cover.topCap} mm: use a seat of at most ${cover.topCap - SEAT_ROOF} mm, or a thicker cap.` });
  }
  // A pocket that follows the layer height must still be one the pocket's own range allows.
  const { min = 0, max = Infinity } = PARAM_SCHEMA.base.pocketDepth;
  const layer = params.print.layerHeight;
  if (params.base.pocketDepth === null && !(layer >= min && layer <= max)) {
    problems.push({ code: 'pocket-range', severity: 'error', message: `The pocket follows the layer height of ${layer} mm, outside the pocket's range of ${min} to ${max} mm: set the pocket depth yourself.` });
  }
  if (funnel.generate) problems.push(...funnelProblems(params));
  return problems;
}
