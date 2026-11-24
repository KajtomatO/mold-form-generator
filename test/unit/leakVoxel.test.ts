import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discMinimum } from '../../src/core/analysis/validate';
import { orientSolid, type RigidTransform } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildCoverFinal } from '../../src/core/parts/cover';
import { buildFunnel } from '../../src/core/parts/funnel';
import { funnelProfile } from '../../src/core/parts/funnelProfile';
import { clamGrooveSolid, grooveSolid } from '../../src/core/parts/joint';
import { openingCutters, OPENING_SEGMENTS, type CutOpening } from '../../src/core/parts/openings';
import { rebateOutset, type ClamRim } from '../../src/core/parts/rim';
import { bRange, openingTopRadius, rectSection, seamGroove, uSpan, type SeamSeal } from '../../src/core/parts/seam';
import { seamBoltCuts } from '../../src/core/parts/seamBolts';
import { socketCutters } from '../../src/core/parts/clips';
import { Arena } from '../../src/core/solid/arena';
import { clamCase, siliconeSolid, type ClamCase } from '../fixtures/clamshell';
import { and, andNot, barrierExits, columnZone, count, emptyBits, firstCell, flangeZone, grow6, leastFlangeCrossing, opened, or, outsideOf, voxelGrid, voxelize, type Bits, type VoxelGrid } from '../fixtures/leakVoxels';
import { loadManifold } from '../fixtures/loadExamples';
import { buildMold } from '../fixtures/mold';
import { box } from '../fixtures/synthetic';

/**
 * MP2's leak voxel test (docs/PLAN.md, MP2's checks; G13.9), under CFG_FULL: a 10 mm cube coupon at t 3, first as a
 * one-piece mold for the baseline, then as a two-part one, and the sphere, each voxelized at 0.1 mm (the base with the
 * model on it, the cover or both halves, the funnel on its seat), every part opened by a ball of 0.2 mm so its printed
 * edges are rounded, the liquid in the cavity, the openings and the funnel. K4 and K5 are the empty cells whose centre
 * lies in the base groove's or the seam groove's cutter. Every way out of the liquid must cross K4, K5 or the flange's
 * contact, and K4 and K5 may open onto the open air only at the band's exits through the top face beside an opening.
 */
const FULL = process.env.CFG_FULL === '1';
const CELL = 0.1;
/** The ball's radius, in cells: 0.2 mm. */
const ROUND = 2;
/** The flange's contact zone reaches this far either side of the top face: the rounding and a cell. */
const CONTACT_LAYER = ROUND * CELL + CELL / 2;
/** The lattice stops this far over the top: the flange and the funnel's neck, whose inside is liquid up to Zf beyond it. */
const OVER_TOP = 3;
/** An exit zone reaches this far under the top face, past the rounding of its edges, and this far past the band's outside. */
const EXIT_DEPTH = CONTACT_LAYER + CELL;
const EXIT_SPARE = 0.5;

const SLOW = 1_800_000;

let api: ManifoldToplevel;
let arena: Arena;

beforeAll(async () => {
  api = await loadManifold();
  arena = new Arena(api);
});
afterAll(() => arena.dispose());

const track = (m: Manifold): Manifold => arena.track(m);
const cross = (c: CrossSection): CrossSection => arena.track(c);

/** The funnel's inside, from its tip to its rim, which the liquid fills: G12's inner profile, revolved. */
function funnelInside(params: Params): Manifold {
  const p = funnelProfile(params);
  const outline: [number, number][] = [[0, p.zTip - 1], [p.rThroat, p.zTip - 1], [p.rThroat, p.zTip], [p.rNeckInner, p.zNeckInner], [p.rNeckInner, p.zConeInner], [p.rRimInner, p.zRim], [0, p.zRim]];
  return arena.revolve(arena.crossSection([outline]), OPENING_SEGMENTS);
}

interface Mold {
  /** The cover's parts, the base with the model on it, and the funnel on its seat. */
  covers: Manifold[];
  base: Manifold;
  funnel: Manifold;
  /** The liquid's space before the parts take theirs: cavity, cutters and the funnel's inside. */
  liquid: Manifold[];
  /** K4's and K5's cutters. */
  grooves: Manifold[];
  /** The seam bolts' cutters, or the seam clips' sockets, whose empty cells must all lie in the outside (MP3, MP3b). */
  cuts: Manifold[];

  pour: CutOpening;
  /**
   * Beside each opening on P, the disc through the top face that holds the band's two exits: there K5 may meet the
   * outside. A vent's is a barrier too, as its mouth is open at a head of about 0 (G13.9's "At the top").
   */
  exits: { x: number; y: number; r: number; vent: boolean }[];
  Zt: number;
  rFlange: number;
}

interface Reading {
  crossing: number;
  /**
   * K4's and K5's cells that open onto the open air, the outside less the ducts a print's rounding leaves, but in an exit
   * zone, and the first of them. A groove running out of the cover elsewhere holds its Vaseline open to the air, as the
   * draft's loop did, and a crack can run round it.
   */
  exits: number;
  exitAt: [number, number, number] | null;
  /** The same cells in the exit zones, which the rule lets open: with none there, the rule would see nothing. */
  atExits: number;
  /** The seam bolts' empty cells, and those of them the outside does not reach, which would join the liquid's side. */
  cutCells: number;
  cutsInside: number;
  cells: { liquid: number; barrier: number; contact: number };
}

/**
 * The mold voxelized and opened, the least flange crossing out of its liquid, and where K4 or K5 opens to the open air
 * but at an exit. With `sealed`, the flange's zone and a rounding past its rim are a barrier as K4 and K5 are, as
 * README.txt's Vaseline ring under the flange makes it: then any way out is one past the seal's grooves away from the
 * funnel. CFG_TRACE=1 prints the way out found.
 */
function leak(mold: Mold, sealed = false): Reading {
  const box3 = [...mold.covers, mold.base, mold.funnel].map((p) => p.boundingBox());
  const min = [0, 1, 2].map((a) => Math.min(...box3.map((b) => b.min[a])));
  const max = [0, 1, 2].map((a) => Math.max(...box3.map((b) => b.max[a])));
  max[2] = mold.Zt + OVER_TOP;
  const g: VoxelGrid = voxelGrid(min, max, CELL, ROUND + 2);
  const cells = (m: Manifold): Bits => voxelize(g, m.getMesh());
  const parts = [...mold.covers, mold.base, mold.funnel].map((m) => opened(g, cells(m)));
  const occupied = or(...parts);
  const liquid = andNot(or(...mold.liquid.map(cells)), occupied);
  // K1, K2, K3 and the flange's seat are cracks: a part's cells touching another part's hold the crack's film.
  const contact = or(...parts.map((part, k) => and(part, grow6(g, or(...parts.filter((_, j) => j !== k))))));
  // K4 and K5: the empty cells whose centre lies in a groove's cutter, the plan's rule.
  const grooves = andNot(or(...mold.grooves.map(cells)), occupied);
  const zones = mold.exits.map((e) => ({ ...e, bits: columnZone(g, e.x, e.y, e.r, mold.Zt - EXIT_DEPTH) }));
  const allowed = zones.length > 0 ? or(...zones.map((z) => z.bits)) : emptyBits(g);
  const vents = zones.filter((z) => z.vent).map((z) => andNot(z.bits, occupied));
  const ring = flangeZone(g, mold.pour.x, mold.pour.y, mold.rFlange + CONTACT_LAYER, mold.Zt, CONTACT_LAYER);
  const barrier = or(grooves, ...vents, ...(sealed ? [andNot(ring, liquid)] : []));
  const flange = sealed ? emptyBits(g) : flangeZone(g, mold.pour.x, mold.pour.y, mold.rFlange, mold.Zt, CONTACT_LAYER);
  const input = { occupied, liquid, barrier, flange, contact };
  // The open air: the outside opened by the rounding's ball, so the ducts a print's rounded edges leave along the seam's
  // edges and a groove's mouth, no wider than the ball, are cracks, as K1 is, and not openings.
  const outside = outsideOf(g, input);
  const air = opened(g, outside);
  const open = barrierExits(g, grooves, air, allowed);
  const cuts = mold.cuts.length > 0 ? andNot(or(...mold.cuts.map(cells)), occupied) : emptyBits(g);
  if (process.env.CFG_TRACE && count(open) > 0) console.log('K4 or K5 open to the air at', firstCell(g, open));
  const crossing = leastFlangeCrossing(g, input, process.env.CFG_TRACE ? (path) => console.log('path out, outside first:', path.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ; ')) : undefined);
  return { crossing, exits: count(open), exitAt: firstCell(g, open), atExits: count(and(and(grooves, grow6(g, air)), allowed)), cutCells: count(cuts), cutsInside: count(andNot(cuts, outside)), cells: { liquid: count(liquid), barrier: count(barrier), contact: count(contact) } };
}

const COUPON = (): ReturnType<typeof box> => box([-5, -5, 0], [5, 5, 10]);

function couponParams(): Params {
  const params = defaultParams();
  params.base.mode = 'merged';
  return params;
}

/** The one-piece coupon: G9's cover with a pour at the top's centre, G10's base with the cube on it, the funnel on its seat. */
function onePiece(): Mold {
  const params = couponParams();
  const mold = buildMold(arena, COUPON(), params, { modes: { merged: false, glue: false } });
  const { rim } = mold;
  const sizes = { r: params.pour.diameter / 2 };
  const [x, y] = [(mold.bounds.min[0] + mold.bounds.max[0]) / 2, (mold.bounds.min[1] + mold.bounds.max[1]) / 2];
  const pour: CutOpening = { kind: 'pour', x, y, zb: discMinimum(mold.built.field, x, y, sizes.r), diameter: params.pour.diameter, seatDepth: params.seat.depth, seatHalfAngleDeg: params.seat.halfAngleDeg };
  const cover = buildCoverFinal(arena, mold.cover, rim, [pour]);
  const funnel = track(buildFunnel(arena, params).translate([x, y, rim.Zt]));
  return {
    covers: [cover],
    base: track(mold.baseBody.add(mold.model!)),
    funnel,
    liquid: [track(mold.tool.trimByPlane([0, 0, 1], 0)), ...openingCutters(arena, rim, pour), track(funnelInside(params).translate([x, y, rim.Zt]))],
    grooves: [grooveSolid(arena, rim)],
    cuts: [],
    pour,
    exits: [],
    Zt: rim.Zt,
    rFlange: funnelProfile(params).rFlange,
  };
}

/**
 * The two-part coupon or model: MP2's halves with Seam fasteners None, the pour and any vent on P (defaultOpenings in
 * test/fixtures/clamshell.ts; the coupon has room for no vent clear of the flange), the funnel on the pour's seat.
 */
function twoPart(c: ClamCase, extraCut: Manifold[] = []): Mold {
  const { build, params } = c;
  const { rim, seal } = build;
  const pour = build.openings.find((o) => o.kind === 'pour')!;
  const funnel = track(buildFunnel(arena, params).translate([pour.x, pour.y, rim.Zt]));
  const covers = build.halves.map((half) => (extraCut.length > 0 ? track(api.Manifold.difference([half, ...extraCut])) : half));
  return {
    covers,
    base: track(build.base.add(c.model.solid)),
    funnel,
    liquid: [siliconeSolid(arena, build, null), ...build.openings.flatMap((o) => openingCutters(arena, rim, o)), track(funnelInside(params).translate([pour.x, pour.y, rim.Zt]))],
    // The cutters as cut: the seam groove's starts 0.3 mm short of P, so the rounded edges of neg's face in front of its
    // mouth, which open into it, are K5 too.
    grooves: [clamGrooveSolid(arena, rim, rim.axis), seamGroove(arena, seal)],
    cuts: [
      ...(build.bolts && build.bolts.spots.length > 0 ? [-1, 1].flatMap((sign) => seamBoltCuts(arena, build.bolts!, sign as 1 | -1)) : []),
      ...(build.clips && build.clips.zs.length > 0 ? [-1, 1].flatMap((sign) => socketCutters(arena, build.clips!, sign as 1 | -1)) : []),
    ],
    pour,
    exits: build.openings.map((o) => ({ x: o.x, y: o.y, r: openingTopRadius(o) + params.clamshell.seamLand + seal.gw + EXIT_SPARE, vent: o.kind === 'vent' })),
    Zt: rim.Zt,
    rFlange: funnelProfile(params).rFlange,
  };
}

function merged(change: (p: Params) => void = () => {}): (p: Params) => void {
  return (p) => {
    p.base.mode = 'merged';
    change(p);
  };
}

/**
 * The draft's loop, rejected in review: E_in the plate's shadow R_plate and the cavity's offset, with no J, the band
 * round it unclipped and no ring under legs, so its legs run down through the rebate wall past the plate's sides,
 * beside the base groove and out of the cover's bottom edge.
 */
function draftLoop(seal: SeamSeal, rim: ClamRim, params: Params): SeamSeal {
  const bottom = -rim.Tb + rim.proud;
  const [pu0, pu1] = uSpan(rim.axis, ...bRange(rim.axis, rim.B));
  const plate = rectSection(arena, pu0, pu1, -rim.Tb, 0);
  const Ein = cross(arena.api.CrossSection.union([cross(seal.Rsil.offset(params.clamshell.seamLand, 'Round', 2, 32)), plate]));
  const [ou0, ou1] = uSpan(rim.axis, ...bRange(rim.axis, rim.O));
  const band = cross(cross(cross(Ein.offset(seal.gw, 'Round', 2, 32)).subtract(Ein)).intersect(rectSection(arena, ou0, ou1, bottom - 1, seal.Zt + 2)));
  return { ...seal, Ein, band, legs: cross(seal.legs.subtract(seal.legs)) };
}

/** A 90 degree V, 1 mm deep, along P across the whole top face, cut from both halves. */
function topVee(rim: ClamRim): Manifold {
  const { xs, Zt } = rim;
  const vee = arena.crossSection([[[xs - 1.5, Zt + 0.5], [xs, Zt - 1], [xs + 1.5, Zt + 0.5]]], 'NonZero');
  const length = 1000;
  const prism = track(arena.extrude(vee, length).translate([0, 0, -length / 2]));
  // (a, z, b) to the mold: an x seam (x, z, -y), a y seam (y, z, x), both turns.
  const turn: RigidTransform = rim.axis === 'x' ? { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0], translation: [0, 0, 0] } : { rotation: [0, 0, 1, 1, 0, 0, 0, 1, 0], translation: [0, 0, 0] };
  return orientSolid(arena, prism, turn);
}

describe.runIf(FULL)('MP2: the leak voxel test', () => {
  // The one-piece coupon's reading, the baseline, read once by whichever test needs it first, so a -t filter cannot leave
  // it unread.
  let one: Reading | null = null;
  const baseline = (): Reading => (one ??= leak(onePiece()));

  it('the one-piece coupon, the baseline: every way out crosses K4 or the flange\'s contact, whose least crossing is 21 cells', () => {
    const reading = baseline();
    console.log(`one-piece coupon: least flange crossing ${reading.crossing} cells`, reading.cells);
    expect(reading.crossing).toBe(21);
    expect(reading.exits, `K4 opens to the air at ${reading.exitAt}`).toBe(0);
  }, SLOW);

  const cases = new Map<string, ClamCase>();
  const caseOf = (id: 'coupon' | 'sphere'): ClamCase => {
    if (!cases.has(id)) cases.set(id, clamCase(arena, id === 'coupon' ? COUPON() : id, merged()));
    return cases.get(id)!;
  };

  it('the one-piece coupon with the flange sealed: no way out at all, every one crossing K4', () => {
    expect(leak(onePiece(), true).crossing).toBe(Infinity);
  }, SLOW);

  it('the cases: a vent beside the pour on the sphere, none on the coupon, which has no room for one clear of the flange', () => {
    expect(caseOf('sphere').build.openings.map((o) => o.kind)).toEqual(['pour', 'vent']);
    expect(caseOf('coupon').build.openings.map((o) => o.kind)).toEqual(['pour']);
  }, SLOW);

  for (const id of ['coupon', 'sphere'] as const) {
    it(`the two-part ${id}, the flange sealed: no way out at all, every one crossing K4 or K5, which open to the air only at the band's exits`, () => {
      const reading = leak(twoPart(caseOf(id)), true);
      expect(reading.crossing).toBe(Infinity);
      expect(reading.exits, `K4 or K5 opens to the air at ${reading.exitAt}`).toBe(0);
      expect(reading.atExits).toBeGreaterThan(0);
    }, SLOW);

    // MP2's check: beside a pour the band's inner edge surfaces at seat radius + seamLand from the axis, 8.73 mm at the
    // defaults, so the two-part cover's default Flange width is seamLand + 2 mm (defaults.clamshell.json), which puts the
    // flange's rim 2 mm past it, as the one-piece flange's rim is past the seat.
    it(`the two-part ${id}: the least crossing of the flange's contact is at least the one-piece coupon's`, () => {
      const reading = leak(twoPart(caseOf(id)));
      console.log(`two-part ${id}: least flange crossing ${reading.crossing} cells against ${baseline().crossing}`, reading.cells);
      expect(reading.crossing).toBeGreaterThanOrEqual(baseline().crossing);
    }, SLOW);
  }

  // MP3: the same with the seam bolts' lugs and cuts, which lie outside O, on the dry side (G13.10.8). On the sphere only,
  // as MP2's two-part cases are, since the test voxelizes the whole mold at 0.1 mm.
  let bolted: ClamCase | null = null;
  const boltedSphere = (): ClamCase => (bolted ??= clamCase(arena, 'sphere', merged((p) => (p.clamshell.fastener = 'bolts'))));

  it('the two-part sphere with seam bolts, the flange sealed: still no way out, and every bolt cut\'s cell in the outside, none joining the liquid\'s side', () => {
    const c = boltedSphere();
    expect(c.build.bolts!.perEnd).toBe(2);
    const reading = leak(twoPart(c), true);
    console.log('two-part sphere with seam bolts, the flange sealed:', reading.cutCells, 'cells of bolt cuts,', reading.cutsInside, 'past the outside', reading.cells);
    expect(reading.crossing).toBe(Infinity);
    expect(reading.exits, `K4 or K5 opens to the air at ${reading.exitAt}`).toBe(0);
    expect(reading.cutCells).toBeGreaterThan(1000);
    expect(reading.cutsInside).toBe(0);
  }, SLOW);

  it('the two-part sphere with seam bolts: the least crossing of the flange\'s contact is still at least the one-piece coupon\'s', () => {
    const reading = leak(twoPart(boltedSphere()));
    console.log(`two-part sphere with seam bolts: least flange crossing ${reading.crossing} cells against ${baseline().crossing}`, reading.cells);
    expect(reading.crossing).toBeGreaterThanOrEqual(baseline().crossing);
  }, SLOW);

  // MP3b: the same with the seam clips' ears and sockets, which lie wholly outside O (G13.10.16), on the sphere only.
  let clipped: ClamCase | null = null;
  const clippedSphere = (): ClamCase => (clipped ??= clamCase(arena, 'sphere', merged((p) => (p.clamshell.fastener = 'clips'))));

  it('the two-part sphere with seam clips, the flange sealed: still no way out, and every socket\'s cell in the outside, none joining the liquid\'s side', () => {
    const c = clippedSphere();
    expect(c.build.clips!.placed.length).toBe(2);
    const reading = leak(twoPart(c), true);
    console.log('two-part sphere with seam clips, the flange sealed:', reading.cutCells, 'cells of sockets,', reading.cutsInside, 'past the outside', reading.cells);
    expect(reading.crossing).toBe(Infinity);
    expect(reading.exits, `K4 or K5 opens to the air at ${reading.exitAt}`).toBe(0);
    expect(reading.cutCells).toBeGreaterThan(1000);
    expect(reading.cutsInside).toBe(0);
  }, SLOW);

  it('the two-part sphere with seam clips: the least crossing of the flange\'s contact is still at least the one-piece coupon\'s', () => {
    const reading = leak(twoPart(clippedSphere()));
    console.log(`two-part sphere with seam clips: least flange crossing ${reading.crossing} cells against ${baseline().crossing}`, reading.cells);
    expect(reading.crossing).toBeGreaterThanOrEqual(baseline().crossing);
  }, SLOW);

  it('negative controls on the coupon: a tongue stopping short of the base groove, and a V on the top face through the seat, each let the liquid out past every groove', () => {
    const short = clamCase(arena, COUPON(), merged(), { seal: (seal) => ({ ...seal, band: cross(seal.band.intersect(rectSection(arena, -1e3, 1e3, seal.zr + 1, seal.Zt + 2))) }) });
    const plain = clamCase(arena, COUPON(), merged());
    // The flange sealed, so what each lets out is its own leak, not the one beside the pour.
    expect(leak(twoPart(short), true).crossing).toBe(0);
    expect(leak(twoPart(plain, [topVee(plain.build.rim)]), true).crossing).toBe(0);
  }, SLOW);

  it('negative control on the coupon: the draft\'s loop, whose legs bypass K4, opens K5 to the air at the cover\'s bottom edge', () => {
    const draft = clamCase(arena, COUPON(), merged(), { seal: draftLoop });
    const reading = leak(twoPart(draft), true);
    console.log(`the draft's loop, the flange sealed: least crossing ${reading.crossing}, ${reading.exits} cells of K5 open to the air, the first at ${reading.exitAt}`);
    expect(reading.exits).toBeGreaterThan(0);
    expect(reading.exitAt![2]).toBeLessThan(0);
  }, SLOW);
});
