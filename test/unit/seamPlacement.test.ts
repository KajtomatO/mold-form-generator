import type { ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySwitch, planSwitch } from '../../src/app/moldSwitch';
import { projectFile, projectJson } from '../../src/app/project';
import { readProjectJson } from '../../src/app/projectFile';
import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { pinOnSeam, placeSeamOpenings, placementSettings, seamBOf, seamCutOpenings, seamRoomFits, type OpeningPin, type SeamOpening, type SeamPlacementInput, type SeamRoom } from '../../src/core/analysis/placement';
import { modelStrip, seamTree, significantSeamLeaves, topRunColumns, type SeamCells, type SeamTree } from '../../src/core/analysis/seam';
import { flangeOutreachesLand, flangeReach, MIN_CEILING, openingSizes, placementSpace, topRadius, ventLand } from '../../src/core/analysis/validate';
import { bOf, floorRow, pullOf, seamH, seamMask, topMap, type SeamAxis } from '../../src/core/field/side';
import type { Field } from '../../src/core/field/grid';
import { meshBounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { BAND_ROOM, PRY_LEG } from '../../src/core/parts/rim';
import { buildClamshell } from '../../src/core/parts/clamshell';
import { rectSection, uOfB, uSpan, bRange } from '../../src/core/parts/seam';
import { Arena } from '../../src/core/solid/arena';
import { Pipeline } from '../../src/app/pipeline';
import { onSeam, SEAM_DROP_REACH, SEAM_DROP_STEP, seamCheck, seamDrop } from '../../src/app/seamDrag';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { chooseFor, fineSplit, orientedGallery, placeSeam, prepareClamshell, seamRoom, type ClamshellPrep, type FineSplit, type SeamStage } from '../fixtures/clamshell';
import { loadExample, loadManifold, skipWithout } from '../fixtures/loadExamples';
import { box, tiltedBox, tShape } from '../fixtures/synthetic';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';

/**
 * MP4: G13.5's air and openings on the seam (docs/PLAN.md, MP4's checks): H_top and S's merge tree against brute force,
 * every centre on P, the room rule, the hidden-leaf vent through the upper run on a T, the 1D plateau's warning, the vent
 * beside the pour on FL's closest circle, and pins kept across a switch of type and back. MP2's seal, pull and leak
 * voxel checks run with these openings in place of the hand-placed ones (clamCase in test/fixtures/clamshell.ts).
 */
const SLOW = 300_000;

let api: ManifoldToplevel;
let arena: Arena;
beforeAll(async () => {
  api = await loadManifold();
  arena = new Arena(api);
});
afterAll(() => arena.dispose());

interface Split {
  prep: ClamshellPrep;
  fine: FineSplit;
  stage: SeamStage;
}

const splits = new Map<string, Split>();

/** A model at the two-part defaults, G13.3's split (or `force`), fine fields at `cell`, and MP4's placement. */
function split(name: string, mesh: () => WeldedMesh, change: (p: Params) => void = () => {}, cell?: number): Split {
  let found = splits.get(name);
  if (!found) {
    const params = defaultParams('clamshell');
    change(params);
    const prep = prepareClamshell(mesh(), params);
    const choice = chooseFor(prep, params.clamshell.ceilingDeg);
    const fine = fineSplit(prep, choice.axis, choice.xs, cell ?? params.quality.cellFinal);
    found = { prep, fine, stage: placeSeam(prep, fine) };
    splits.set(name, found);
  }
  return found;
}

function oriented(welded: WeldedMesh): WeldedMesh {
  const options = baseOptions(defaultParams(), meshBounds(welded.positions));
  const [top] = findBaseCandidates(welded, options);
  return orientToBase(welded, top, { planeTol: options.planeTol, soup: false }).mesh;
}

const sphere = (): Split => split('sphere', () => orientedGallery('sphere'));
const cube = (): Split => split('cube', () => orientedGallery('cube'));
const cone = (): Split => split('cone', () => orientedGallery('cone'));
const goddess = (): Split => split('goddess', () => oriented(loadExample('goddess').welded));
/** placeSeam's input for a split, with the room changed, so a case can force what the rule refuses. */
function seamInput(s: Split, room: SeamRoom, pins?: OpeningPin[]): SeamPlacementInput {
  const { prep, fine, stage } = s;
  return {
    axis: fine.axis,
    xs: fine.xs,
    space: placementSpace(stage.top, fine.rim, [[0, 0]], openingSizes(prep.params)),
    tree: stage.tree,
    topUnder: (z) => topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs, z),
    room,
    model: modelStrip(prep.mesh, fine.axis, fine.xs, 3, prep.params.quality.analysisCell),
    settings: placementSettings(prep.params, prep.bounds),
    pins,
    centre: [0, 0],
  };
}

/** The T on the plane as built, its seam forced to x = 0, across the arm. */
const tee = (armTo: number): Split => split(`tee ${armTo}`, () => tShape(api, armTo), (p) => {
  p.clamshell.axis = 'x';
  p.clamshell.offset = 0;
});

// ----- brute force -----

/** H_top read straight from its definition: at each node, the highest z whose row on that side reaches it, rows at or under zCap. */
function bruteTop(H: Field, plus: Field, minus: Field, prep: ClamshellPrep, axis: SeamAxis, xs: number, zCap = Infinity): Float32Array {
  const out = new Float32Array(H.values.length);
  const cell = H.cell;
  for (let n = 0; n < out.length; n++) {
    const i = n % H.nx, j = (n - i) / H.nx;
    const [a, b] = axis === 'x' ? [H.x0 + i * cell, H.y0 + j * cell] : [H.y0 + j * cell, H.x0 + i * cell];
    const sign: 1 | -1 = a >= xs - 1e-9 ? 1 : -1;
    const f = sign > 0 ? plus : minus;
    const pull = pullOf(axis, sign);
    const hs = seamH(pull, prep.bounds, xs);
    const ai = axis === 'x' ? 0 : 1;
    const h = sign > 0 ? a - prep.bounds.min[ai] : prep.bounds.max[ai] - a;
    const col = Math.round((bOf(pull, b) - f.x0) / cell);
    if (col < 0 || col >= f.nx) continue;
    const jFloor = floorRow(f);
    for (let row = f.ny - 1; row >= jFloor; row--) {
      const z = (row - jFloor) * cell;
      if (z > zCap + 1e-9) continue;
      const g = f.values[col + row * f.nx];
      if (g > hs && g >= h) {
        out[n] = z;
        break;
      }
    }
  }
  return out;
}

interface BruteLeaf {
  k: number;
  j: number;
  saddle: number;
  persistence: number;
  hidden: boolean;
}

/**
 * The merge tree's leaves from their definition: cells in the sweep's order (down z, then along b); a cell is born where
 * no earlier cell touches it, and dies at the first cell after which its component holds a cell born before it. A leaf
 * is a birth that rose above the row it died at, or never died.
 */
function bruteLeaves(cells: SeamCells): BruteLeaf[] {
  const { mask, nb, nz, cell } = cells;
  const order: number[] = [];
  for (let j = nz - 1; j >= 0; j--) for (let k = 0; k < nb; k++) if (mask[k + j * nb]) order.push(k + j * nb);
  const rank = new Map(order.map((n, t) => [n, t]));
  const leaves: BruteLeaf[] = [];
  for (let t = 0; t < order.length; t++) {
    const n = order[t];
    const k = n % nb, j = (n - k) / nb;
    const earlier = (m: number): boolean => rank.has(m) && rank.get(m)! < t;
    if ((k > 0 && earlier(n - 1)) || (j + 1 < nz && earlier(n + nb))) continue;
    // One union-find from scratch, with the earliest rank in each set.
    const parent = new Map<number, number>();
    const least = new Map<number, number>();
    const find = (a: number): number => {
      while (parent.get(a) !== a) a = parent.get(a)!;
      return a;
    };
    let deathRow = -1;
    for (let s = 0; s < order.length && deathRow < 0; s++) {
      const m = order[s];
      parent.set(m, m);
      least.set(m, s);
      const mk = m % nb, mj = (m - mk) / nb;
      for (const o of [mk > 0 ? m - 1 : -1, mj + 1 < nz ? m + nb : -1]) {
        if (o < 0 || !parent.has(o)) continue;
        const ra = find(m), rb = find(o);
        if (ra === rb) continue;
        parent.set(ra, rb);
        least.set(rb, Math.min(least.get(ra)!, least.get(rb)!));
      }
      if (s >= t && find(n) !== undefined && least.get(find(n))! < t) deathRow = mj;
    }
    if (deathRow >= 0 && deathRow >= j) continue;
    // Its flat top: the columns from k at row j with no S right above them; hidden where S stands over every one.
    let k1 = k;
    while (k1 + 1 < nb && mask[k1 + 1 + j * nb] && !(j + 1 < nz && mask[k1 + 1 + (j + 1) * nb])) k1++;
    let hidden = true;
    for (let kk = k; kk <= k1; kk++) {
      let above = false;
      for (let jj = j + 1; jj < nz; jj++) if (mask[kk + jj * nb]) above = true;
      if (!above) hidden = false;
    }
    const row = Math.max(deathRow, 0);
    leaves.push({ k, j, saddle: row * cell, persistence: (j - row) * cell, hidden });
  }
  return leaves;
}

/** A seeded generator, so a failing mask can be made again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A blobby mask: random cells, each kept where most of its 3 x 3 neighbourhood was drawn, so runs and gaps form. */
function blobs(seed: number, nb: number, nz: number): SeamCells {
  const next = random(seed);
  const raw = Array.from({ length: nb * nz }, () => (next() < 0.55 ? 1 : 0));
  const mask = new Uint8Array(nb * nz);
  for (let j = 0; j < nz; j++) {
    for (let k = 0; k < nb; k++) {
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) sum += raw[Math.min(nb - 1, Math.max(0, k + dk)) + Math.min(nz - 1, Math.max(0, j + dj)) * nb];
      mask[k + j * nb] = sum >= 5 ? 1 : 0;
    }
  }
  return { mask, nb, nz, b0: -3, cell: 0.5 };
}

function sameLeaves(tree: SeamTree, brute: BruteLeaf[]): void {
  const got = tree.leaves.map(({ k, j, saddle, persistence, hidden }) => ({ k, j, saddle, persistence, hidden })).sort((p, q) => p.j - q.j || p.k - q.k);
  const want = [...brute].sort((p, q) => p.j - q.j || p.k - q.k);
  expect(got).toEqual(want);
}

const bOfOpening = (s: Split, o: { x: number; y: number }): number => seamBOf(s.fine.axis, o);
const stageCodes = (s: Split): string[] => s.stage.placement.diagnostics.map((d) => d.code);
const aOf = (s: Split, o: { x: number; y: number }): number => (s.fine.axis === 'x' ? o.x : o.y);

describe('MP4: H_top and S\'s merge tree against brute force', () => {
  it('H_top is the highest z whose row reaches each node, on both sides of P, also with the rows capped', () => {
    for (const s of [sphere(), cone(), tee(24)]) {
      const { prep, fine } = s;
      const H = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs);
      expect(Array.from(H.values)).toEqual(Array.from(bruteTop(H, fine.plus.field, fine.minus.field, prep, fine.axis, fine.xs)));
      for (const cap of [10, 21.3]) {
        const capped = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs, cap);
        expect(Array.from(capped.values)).toEqual(Array.from(bruteTop(capped, fine.plus.field, fine.minus.field, prep, fine.axis, fine.xs, cap)));
      }
      // Some node on P itself: the + side's first a node, at xs, reads the seam's own top.
      expect(H.values.reduce((m, v) => Math.max(m, v), 0)).toBeGreaterThan(0);
    }
  }, SLOW);

  it('the merge tree\'s leaves, saddles, persistence and hidden flags on random masks match the definition', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const cells = blobs(seed, 14, 11);
      sameLeaves(seamTree(cells), bruteLeaves(cells));
    }
  });

  it('and on S of the T at 1 mm, where the post\'s top is a hidden leaf under the arm', () => {
    const s = split('tee coarse', () => tShape(api, 26), (p) => {
      p.clamshell.axis = 'x';
      p.clamshell.offset = 0;
    }, 1);
    const cells = seamMask(s.fine.plus.field, s.fine.minus.field, s.prep.bounds, s.fine.axis, s.fine.xs);
    const tree = seamTree(cells);
    sameLeaves(tree, bruteLeaves(cells));
    expect(significantSeamLeaves(tree, 1.5).some((leaf) => leaf.hidden && leaf.b > 18 && leaf.b < 28)).toBe(true);
  }, SLOW);
});

describe('MP4: the openings on P', () => {
  const all = (): [string, Split][] => [['sphere', sphere()], ['cube', cube()], ['cone', cone()], ['tee 24', tee(24)], ['tee 26', tee(26)]];

  it('every centre lies on P, and every opening is valid', () => {
    for (const [name, s] of all()) {
      const { openings, diagnostics } = s.stage.placement;
      expect(openings.length, name).toBeGreaterThan(0);
      for (const o of openings) {
        expect(aOf(s, o), name).toBe(s.fine.xs);
        expect(o.valid, name).toBe(true);
        expect(o.zb, name).toBeGreaterThanOrEqual(MIN_CEILING);
      }
      expect(diagnostics.filter((d) => d.severity === 'error'), name).toEqual([]);
      // The cutters' openings are the placed ones, each with its own zb.
      expect(s.stage.openings.map((o) => [o.kind, o.x, o.y, o.zb])).toEqual(openings.map((o) => [o.kind, o.x, o.y, o.zb]));
    }
  }, SLOW);

  it('Goddess: every centre on P, the pour off the head\'s top that its disc does not fit, but letting its air out', (ctx) => {
    skipWithout(ctx, 'goddess');
    const s = goddess();
    for (const o of s.stage.placement.openings) expect(aOf(s, o)).toBe(s.fine.xs);
    const codes = s.stage.placement.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('pour-off-peak');
    expect(codes).not.toContain('peak-uncovered');
    expect(s.stage.placement.uncovered).toEqual([]);
  }, SLOW);

  it('the room rule holds: each band inside O, clear of the pry chamfers and, where kept, the pins\' sockets', () => {
    for (const [name, s] of all()) {
      const { room, placement } = s.stage;
      const sizes = openingSizes(s.prep.params);
      for (const o of placement.openings) {
        const b = bOfOpening(s, o);
        expect(seamRoomFits(room, sizes, o.kind, b, o.zb, placement.pinsKept), name).toBe(true);
        const R = topRadius(sizes, o.kind) + room.band;
        expect(b - R, name).toBeGreaterThanOrEqual(room.o0 + PRY_LEG - 1e-9);
        expect(b + R, name).toBeLessThanOrEqual(room.o1 - PRY_LEG + 1e-9);
      }
      expect(placement.pinsKept, name).toBe(true);
    }
  }, SLOW);

  it('the rule\'s edges: past O, on a pry chamfer, a lug or an ear, and on a pin\'s socket, each refused', () => {
    const s = sphere();
    const sizes = openingSizes(s.prep.params);
    const { room } = s.stage;
    const R = topRadius(sizes, 'vent') + room.band;
    const z = room.Zt - 20;
    expect(seamRoomFits(room, sizes, 'vent', room.o0 + R + PRY_LEG + 0.01, z, false)).toBe(true);
    expect(seamRoomFits(room, sizes, 'vent', room.o0 + R + PRY_LEG - 0.01, z, false)).toBe(false);
    // A pin's socket: the band reaching over it is refused only while the pins are kept clear.
    const pin = room.pins[0];
    const onPin = pin.b + pin.r + R - 0.01;
    expect(seamRoomFits(room, sizes, 'vent', onPin, z, true)).toBe(false);
    // With the seam bolts' lugs and the clip ears: boxes past O's end faces, which the band inside O never meets.
    for (const fastener of ['bolts', 'clips'] as const) {
      const p = structuredClone(s.prep.params);
      p.clamshell.fastener = fastener;
      const withFastener = seamRoom(p, s.fine);
      expect(withFastener.keepOut.length).toBeGreaterThan(2);
      for (const box of withFastener.keepOut.slice(2)) expect(box.b1 <= withFastener.o0 + 1e-9 || box.b0 >= withFastener.o1 - 1e-9).toBe(true);
    }
  });

  it('a box kept out over the sphere\'s top moves the pour along P until its band clears it', () => {
    const s = sphere();
    const { prep, fine, stage } = s;
    const sizes = openingSizes(prep.params);
    const room: SeamRoom = { ...stage.room, keepOut: [...stage.room.keepOut, { b0: -2, b1: 2, z0: 0, z1: stage.room.Zt }] };
    const placed = placeSeamOpenings(seamInput(s, room));
    const pour = placed.openings.find((o) => o.kind === 'pour')!;
    const b = bOfOpening(s, pour);
    expect(Math.abs(b) - (topRadius(sizes, 'pour') + room.band)).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(seamRoomFits(room, sizes, 'pour', b, pour.zb, placed.pinsKept)).toBe(true);
  });

  it('a pin\'s socket under the pour\'s band: the plan without the pins is taken, and the seal leaves them out with its line', () => {
    const s = sphere();
    const { prep, fine, stage } = s;
    const pour = stage.placement.openings.find((o) => o.kind === 'pour')!;
    // A socket just under the top, over the seam's highest point: kept clear, the pour would move far down the sphere.
    const room: SeamRoom = { ...stage.room, pins: [...stage.room.pins, { b: bOfOpening(s, pour), z: stage.room.Zt - 3, r: stage.room.pins[0].r }] };
    const kept = placeSeamOpenings(seamInput(s, room));
    expect(kept.pinsKept).toBe(false);
    const free = kept.openings.find((o) => o.kind === 'pour')!;
    expect(bOfOpening(s, free)).toBe(bOfOpening(s, pour));
    expect(free.zb).toBe(pour.zb);
    expect(seamRoomFits(room, openingSizes(prep.params), 'pour', bOfOpening(s, free), free.zb, true)).toBe(false);
    // The build passes the choice to the seal.
    const build = buildClamshell(arena, prep, fine, { openings: seamCutOpenings(kept.openings, openingSizes(prep.params)), pinsKept: kept.pinsKept });
    expect(build.seal.pins).toEqual([]);
    expect(build.diagnostics.filter((d) => d.code === 'seam-pins-dropped').map((d) => d.severity)).toEqual(['info']);
    // The same openings with the pins kept: the seal has room for them, so only the placement's choice dropped them.
    const plain = buildClamshell(arena, prep, fine, { openings: stage.openings, pinsKept: true });
    expect(plain.seal.pins.length).toBe(2);
  }, SLOW);

  it('the vent beside the pour stands on FL\'s closest circle, flangeReach, intersected with P', () => {
    for (const [name, s] of [['sphere', sphere()], ['cone', cone()]] as const) {
      const sizes = openingSizes(s.prep.params);
      expect(flangeOutreachesLand(sizes)).toBe(true);
      const { openings } = s.stage.placement;
      const pour = openings.find((o) => o.kind === 'pour')!;
      const vent = openings.find((o) => o.role === 'beside')!;
      expect(Math.abs(bOfOpening(s, vent) - bOfOpening(s, pour)), name).toBeCloseTo(flangeReach(sizes) + 0.01, 9);
    }
  }, SLOW);

  it('and on the land\'s closest circle, ventLand, with a flange the land keeps clear', () => {
    const s = split('sphere flange 1', () => orientedGallery('sphere'), (p) => (p.funnel.flangeWidth = 1));
    const sizes = openingSizes(s.prep.params);
    expect(flangeOutreachesLand(sizes)).toBe(false);
    const { openings } = s.stage.placement;
    const pour = openings.find((o) => o.kind === 'pour')!;
    const vent = openings.find((o) => o.role === 'beside')!;
    expect(Math.abs(bOfOpening(s, vent) - bOfOpening(s, pour))).toBeCloseTo(ventLand(sizes) + 0.01, 9);
  }, SLOW);

  it('Goddess: the vent beside the pour on FL\'s closest circle too, on the side whose ceiling stands higher', (ctx) => {
    skipWithout(ctx, 'goddess');
    const s = goddess();
    const sizes = openingSizes(s.prep.params);
    const { openings } = s.stage.placement;
    const pour = openings.find((o) => o.kind === 'pour')!;
    const vent = openings.find((o) => o.role === 'beside')!;
    expect(Math.abs(bOfOpening(s, vent) - bOfOpening(s, pour))).toBeCloseTo(flangeReach(sizes) + 0.01, 9);
    // On the - side of the pour, where MP2's hand-placed vent took the + side: b 144.1 against 169.7.
    expect(bOfOpening(s, vent)).toBeLessThan(bOfOpening(s, pour));
    expect(bOfOpening(s, vent)).toBeCloseTo(144.1, 1);
  }, SLOW);

  it('FL\'s vent-low note on P: the cone\'s vent beside the pour, pushed down its flank by the flange', () => {
    const s = cone();
    const note = s.stage.placement.diagnostics.find((d) => d.code === 'vent-low')!;
    expect(note).toBeDefined();
    expect(note.message).toMatch(/^The vent at \(-?\d+\.\d, -?\d+\.\d\) beside the pour stands 12\.8 mm from it to clear its funnel's flange, .* A Flange width of at most [\d.]+ mm under Pour & funnel /);
    const vent = s.stage.placement.openings.find((o) => o.role === 'beside')!;
    expect(note.at).toEqual([vent.x, vent.y, vent.zb]);
    // With the flange the land keeps clear, the vent stands nearer the pour and the note goes.
    const plain = split('cone flange 1', () => orientedGallery('cone'), (p) => (p.funnel.flangeWidth = 1));
    expect(plain.stage.placement.diagnostics.map((d) => d.code)).not.toContain('vent-low');
  }, SLOW);

  it('a second pour pinned beside the placed one: funnel-collision on P', () => {
    const s = sphere();
    const pour = s.stage.placement.openings.find((o) => o.kind === 'pour')!;
    const b = bOfOpening(s, pour) + 14;
    const pinned: OpeningPin = s.fine.axis === 'x' ? { id: 'b0:pour:1', kind: 'pour', x: s.fine.xs, y: b } : { id: 'b0:pour:1', kind: 'pour', x: b, y: s.fine.xs };
    const placed = placeSeam(s.prep, s.fine, { pins: [pinned] }).placement;
    const pours = placed.openings.filter((o) => o.kind === 'pour');
    expect(pours.map((o) => o.id).sort()).toEqual(['b0:pour:0', 'b0:pour:1']);
    // The first pour is still b0:pour:0, by the seam's top, the pinned one's land kept, and the vent beside goes by it.
    const first = pours.find((o) => o.id === 'b0:pour:0')!;
    expect(Math.abs(bOfOpening(s, first) - bOfOpening(s, pour))).toBeLessThanOrEqual(2);
    const beside = placed.openings.find((o) => o.role === 'beside');
    if (beside) expect(Math.abs(bOfOpening(s, beside) - bOfOpening(s, first))).toBeLessThan(Math.abs(bOfOpening(s, beside) - b));
    else expect(placed.diagnostics.find((d) => d.code === 'vent-refused')!.message).toContain(`at (${first.x.toFixed(1)}, ${first.y.toFixed(1)})`);
    const apart = Math.abs(bOfOpening(s, first) - b).toFixed(1);
    expect(placed.diagnostics.find((d) => d.code === 'funnel-collision')?.message).toMatch(new RegExp(`^Funnels of \\d+ mm collide, as two pours are only ${apart.replace('.', '\\.')} mm apart\\.`));
  }, SLOW);
});

describe('MP4: the bands against the built seal', () => {
  it('on the sphere, the seal reaches the top only inside each opening\'s band, with BAND_ROOM to spare', () => {
    const s = sphere();
    const build = buildClamshell(arena, s.prep, s.fine, { openings: s.stage.openings, pinsKept: s.stage.placement.pinsKept });
    const { seal, rim } = build;
    const sizes = openingSizes(s.prep.params);
    const top = arena.track(seal.outer.intersect(rectSection(arena, ...uSpan(rim.axis, ...bRange(rim.axis, rim.O)), rim.Zt - 0.5, rim.Zt)));
    expect(top.isEmpty()).toBe(false);
    const bands = s.stage.placement.openings.map((o) => {
      const u0 = uOfB(rim.axis, bOfOpening(s, o)), R = topRadius(sizes, o.kind) + s.stage.room.band - BAND_ROOM;
      return rectSection(arena, u0 - R - 1e-6, u0 + R + 1e-6, rim.Zt - 1, rim.Zt + 1);
    });
    const outside = arena.track(top.subtract(arena.track(api.CrossSection.union(bands))));
    expect(outside.isEmpty() || outside.area() < 1e-6).toBe(true);
    expect(seal.pins.length).toBe(2);
  }, SLOW);
});

describe('MP4: the hidden leaf, on a T with an arm across P', () => {
  it('the post\'s top is a significant hidden leaf, and its vent rises from the post\'s own ceiling through the arm\'s run to the top', () => {
    const s = tee(26);
    const { tree, placement, room } = s.stage;
    const significant = significantSeamLeaves(tree, s.prep.params.silicone.t / 2);
    const leaf = significant.find((l) => l.hidden)!;
    expect(leaf).toBeDefined();
    expect(leaf.b).toBeGreaterThan(18);
    expect(leaf.b).toBeLessThan(28);
    const vent = placement.openings.find((o) => o.hidden)!;
    expect(vent).toBeDefined();
    expect(vent.kind).toBe('vent');
    const b = bOfOpening(s, vent);
    const { mask, nb, nz, b0, cell } = tree.cells;
    // Inside the leaf's top run, its zb under the leaf's top and on the post's run.
    const columns = topRunColumns(tree, tree.leaves.indexOf(leaf), s.prep.params.silicone.t / 2).map((k) => b0 + k * cell);
    expect(b).toBeGreaterThanOrEqual(Math.min(...columns) - 1e-9);
    expect(b).toBeLessThanOrEqual(Math.max(...columns) + 1e-9);
    expect(vent.zb).toBeLessThanOrEqual(leaf.height + 1e-9);
    expect(vent.zb).toBeGreaterThan(leaf.height - 3);
    // Its column on P: S under zb (the post's run), a gap of plastic, then S again (the arm's run), all under Zt.
    const k = Math.round((b - b0) / cell);
    const column = Array.from({ length: nz }, (_, j) => mask[k + j * nb]);
    const above = column.map((on, j) => (on && j * cell > leaf.height + 1 ? j : -1)).filter((j) => j >= 0);
    expect(above.length).toBeGreaterThan(0);
    expect(column.slice(leaf.j + 1, above[0]).every((on) => !on)).toBe(true);
    expect(above[0] * cell).toBeLessThan(room.Zt);
    // Its line clears the model in S8's columns, from under its bore to the top.
    const strip = modelStrip(s.prep.mesh, s.fine.axis, s.fine.xs, 3, s.prep.params.quality.analysisCell);
    expect(strip.clear(b, s.prep.params.vents.diameter / 2, vent.zb - 0.5, room.Zt)).toBe(true);
    // And where the arm stands over it, the line would not.
    expect(strip.clear(20, s.prep.params.vents.diameter / 2, vent.zb - 0.5, room.Zt)).toBe(false);
    expect(placement.uncovered).toEqual([]);
    expect(placement.diagnostics.map((d) => d.code)).not.toContain('air-underside');
  }, SLOW);

  it('a pin on the hidden leaf\'s vent keeps its own run\'s ceiling, so it still lets that leaf\'s air out', () => {
    const s = tee(26);
    const vent = s.stage.placement.openings.find((o) => o.hidden)!;
    const placed = placeSeam(s.prep, s.fine, { pins: [{ id: vent.id, kind: 'vent', x: vent.x, y: vent.y }] }).placement;
    const pinned = placed.openings.find((o) => o.id === vent.id)!;
    expect([pinned.pinned, pinned.hidden, pinned.zb]).toEqual([true, true, vent.zb]);
    expect(placed.uncovered).toEqual([]);
    // The cutters' openings keep the flag, for README.txt's line on cutting the rods at demold (MP5).
    const cut = seamCutOpenings(placed.openings, openingSizes(s.prep.params));
    expect(cut.filter((o) => o.kind === 'vent' && o.hidden).length).toBe(1);
  }, SLOW);

  it('with the arm short of the post\'s end, the post\'s top is open to the top there: no hidden leaf, and a plain vent', () => {
    const s = tee(24);
    const { tree, placement } = s.stage;
    const leaf = significantSeamLeaves(tree, s.prep.params.silicone.t / 2).find((l) => l.b > 18 && l.b < 28)!;
    expect(leaf).toBeDefined();
    expect(leaf.hidden).toBe(false);
    expect(placement.openings.some((o) => o.hidden)).toBe(false);
    const vent = placement.openings.find((o) => o.role === 'leaf')!;
    expect(bOfOpening(s, vent)).toBeGreaterThan(24);
    expect(placement.uncovered).toEqual([]);
    expect(stageCodes(s)).not.toContain('air-underside');
    // Two pours: the second replaces that vent, which stands off the leaf's middle, and takes the leaf.
    const two = split('tee 24, 2 pours', () => tShape(api, 24), (p) => {
      p.clamshell.axis = 'x';
      p.clamshell.offset = 0;
      p.pour.perModel = 2;
    });
    const pours = two.stage.placement.openings.filter((o) => o.kind === 'pour');
    expect(pours.length).toBe(2);
    expect(two.stage.placement.openings.some((o) => o.id === vent.id)).toBe(false);
    expect(two.stage.placement.uncovered).toEqual([]);
    expect(stageCodes(two)).not.toContain('pour-shortfall');
  }, SLOW);

  it('with the arm over all of the post, no line clears the model, and S8\'s underside-air warning names the spot', () => {
    const s = tee(34);
    const { placement, tree } = s.stage;
    expect(placement.openings.some((o) => o.hidden)).toBe(false);
    const warning = placement.diagnostics.find((d) => d.code === 'air-underside')!;
    expect(warning).toBeDefined();
    expect(warning.message).toMatch(/^Air stays under an overhang of the model, \d+ mm up, /);
    const leaf = tree.leaves.find((l) => l.hidden)!;
    expect(warning.at).toEqual([s.fine.xs, leaf.b, leaf.height]);
    expect(placement.diagnostics.map((d) => d.code)).not.toContain('peak-uncovered');
  }, SLOW);
});

describe('MP4: the 1D plateau', () => {
  it('the cube\'s flat top along P gets its pour at the middle and the plateau warning; the sphere and the cone none', () => {
    const c = cube();
    const plateau = c.stage.placement.plateau!;
    expect(plateau).not.toBe(null);
    expect(plateau.b1 - plateau.b0).toBeGreaterThanOrEqual(10);
    const pour = c.stage.placement.openings.find((o) => o.kind === 'pour')!;
    expect(pour.role).toBe('plateau');
    expect(bOfOpening(c, pour)).toBeCloseTo((plateau.b0 + plateau.b1) / 2, 6);
    expect(c.stage.placement.diagnostics.filter((d) => d.code === 'seam-plateau').length).toBe(1);
    for (const s of [sphere(), cone()]) {
      expect(s.stage.placement.plateau).toBe(null);
      expect(s.stage.placement.diagnostics.map((d) => d.code)).not.toContain('seam-plateau');
    }
    const warning = c.stage.placement.diagnostics.find((d) => d.code === 'seam-plateau')!;
    expect(warning.at).toEqual([pour.x, pour.y, pour.zb]);
  }, SLOW);

  it('a box whose top tilts along P: flat, and at 0.5 degrees, a plateau; at 1.5 degrees, too short within 0.2 mm', () => {
    // H_top comes in whole cells, so the slope is read over the stretch: node to node, every step would be 45 degrees.
    for (const [deg, flat] of [[0, true], [0.5, true], [1.5, false]] as const) {
      const s = split(`tilted ${deg}`, () => tiltedBox(deg), (p) => {
        p.clamshell.axis = 'x';
        p.clamshell.offset = 0;
      });
      const { plateau } = s.stage.placement;
      const pour = s.stage.placement.openings.find((o) => o.kind === 'pour')!;
      expect(plateau !== null, `${deg}`).toBe(flat);
      expect(stageCodes(s).includes('seam-plateau'), `${deg}`).toBe(flat);
      if (!plateau) continue;
      // The stretch within 0.2 mm of the top: about 0.2 / tan(0.5 degrees), 23 mm, at 0.5.
      expect(plateau.b1 - plateau.b0, `${deg}`).toBeGreaterThanOrEqual(deg === 0 ? 50 : 18);
      expect(pour.role).toBe('plateau');
      expect(bOfOpening(s, pour)).toBeCloseTo((plateau.b0 + plateau.b1) / 2, 6);
    }
  }, SLOW);
});

describe('MP4: pins stored as (x, y)', () => {
  it('a pin survives one-piece, then two-part, then one-piece: on P at (xs, pin.b), a drag along P changing only b', () => {
    const s = sphere();
    const { fine, prep } = s;
    // As the one-piece left it, off P.
    const stored: OpeningPin = fine.axis === 'x' ? { id: 'b0:pour:0', kind: 'pour', x: 3.25, y: 1.5 } : { id: 'b0:pour:0', kind: 'pour', x: 1.5, y: 3.25 };
    const onePiece = defaultParams();
    // Switched to the two-part cover, and saved and opened again in format 7.
    const twoPart = applySwitch(planSwitch(onePiece, 'clamshell'), []);
    expect(twoPart.mold.type).toBe('clamshell');
    const saved = readProjectJson(projectJson(projectFile({ params: twoPart, plane: DEFAULT_PLANE, pins: [stored], removed: [] }, 'sphere.stl', { modelSha256: null, basePlane: null })));
    expect(saved.file.pins).toEqual([stored]);
    // On P the pour stands at (xs, pin.b), pinned, and the rest are placed round it.
    const placed = placeSeam(prep, fine, { pins: saved.file.pins });
    const pour = placed.placement.openings.find((o) => o.id === 'b0:pour:0')!;
    expect(pour.pinned).toBe(true);
    expect([aOf(s, pour), bOfOpening(s, pour)]).toEqual([fine.xs, 1.5]);
    expect(placed.placement.openings.filter((o) => o.kind === 'pour').length).toBe(1);
    // A drag along P moves b only; the a the one-piece stored stays.
    const dragged = pinOnSeam(stored, stored.id, 'pour', fine.axis, fine.xs, -2);
    expect(fine.axis === 'x' ? [dragged.x, dragged.y] : [dragged.y, dragged.x]).toEqual([3.25, -2]);
    // A pin first made on P takes xs for a.
    const made = pinOnSeam(undefined, 'b0:vent:beside', 'vent', fine.axis, fine.xs, 8);
    expect(fine.axis === 'x' ? [made.x, made.y] : [made.y, made.x]).toEqual([fine.xs, 8]);
    // Back to the one-piece: the type switches, the pins are the project's and untouched, so it stands where it was stored.
    const back = applySwitch(planSwitch(twoPart, 'one-piece'), []);
    expect(back.mold.type).toBe('one-piece');
    const again = readProjectJson(projectJson(projectFile({ params: back, plane: DEFAULT_PLANE, pins: [stored], removed: [] }, 'sphere.stl', { modelSha256: null, basePlane: null })));
    expect(again.file.pins).toEqual([stored]);
  }, SLOW);

  it('and through the pipeline: a switch of type there and back keeps the project\'s pins', () => {
    const stored: OpeningPin = { id: 'b0:pour:0', kind: 'pour', x: 3.25, y: 1.5 };
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    p.setPins([stored]);
    // As the store's makeSwitch writes the plan's groups.
    const switchTo = (to: 'clamshell' | 'one-piece'): void => {
      const next = applySwitch(planSwitch(p.params, to), []);
      p.setParams((params) => {
        for (const group of Object.keys(next) as (keyof Params)[]) (params as Record<string, unknown>)[group] = next[group];
      });
    };
    switchTo('clamshell');
    expect(p.params.mold.type).toBe('clamshell');
    expect(p.project().pins).toEqual([stored]);
    switchTo('one-piece');
    expect(p.params.mold.type).toBe('one-piece');
    expect(p.project().pins).toEqual([stored]);
  });
});

describe('MP5: a drop on P', () => {
  it('snaps along P by SEAM_DROP_STEP to the nearest spot with the seal\'s room, the refusal naming seam-room, within SEAM_DROP_REACH', () => {
    const s = sphere();
    const { fine, stage } = s;
    const seam = { axis: fine.axis, xs: fine.xs, room: stage.room, pinsKept: stage.placement.pinsKept };
    const vent = stage.placement.openings.find((o) => o.kind === 'vent' && !o.hidden)!;
    const others = stage.placement.openings.filter((o) => o !== vent);
    // On the pry chamfer at O's end: no room for the band, so the drop moves inwards along P to the first spot that has it.
    const asked = stage.room.o0 + PRY_LEG / 2;
    const at = fine.axis === 'x' ? { x: fine.xs + 4, y: asked } : { x: asked, y: fine.xs + 4 };
    const drop = seamDrop(stage.space, seam, 'vent', at.x, at.y, others);
    expect(drop.valid).toBe(true);
    expect(drop.snapped).toBe(true);
    expect(drop.refused).toContain('seam-room');
    expect(seamCheck(stage.space, seam, onSeam(seam, 'vent', at.x, at.y), others).problems).toContain('seam-room');
    const b = seamBOf(fine.axis, drop);
    expect(b).toBeGreaterThan(asked);
    const steps = (b - asked) / SEAM_DROP_STEP;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    expect(b - asked).toBeLessThanOrEqual(SEAM_DROP_REACH);
    // On P: a = xs, whatever a the pointer had.
    expect(fine.axis === 'x' ? drop.x : drop.y).toBe(fine.xs);
    // Past O altogether, with no spot within reach: it stays where it was let go, invalid, as dropOpening leaves it.
    const far = stage.room.o0 - SEAM_DROP_REACH - 20;
    const out = seamDrop(stage.space, seam, 'vent', fine.axis === 'x' ? fine.xs : far, fine.axis === 'x' ? far : fine.xs, others);
    expect(out.valid).toBe(false);
    expect(out.problems).toContain('seam-room');
  }, SLOW);

  it('every spot a drop accepts, S7c accepts as valid with the vent pinned there', () => {
    const s = sphere();
    const { prep, fine, stage } = s;
    const seam = { axis: fine.axis, xs: fine.xs, room: stage.room, pinsKept: stage.placement.pinsKept };
    const vent = stage.placement.openings.find((o) => o.kind === 'vent' && !o.hidden)!;
    const others = stage.placement.openings.filter((o) => o !== vent);
    const { o0, o1 } = stage.room;
    let tried = 0;
    for (let k = 0; k <= 6; k++) {
      const b = o0 + ((o1 - o0) * k) / 6;
      const drop = seamDrop(stage.space, seam, 'vent', fine.axis === 'x' ? fine.xs : b, fine.axis === 'x' ? b : fine.xs, others);
      if (!drop.valid) continue;
      tried++;
      const placed = placeSeam(prep, fine, { pins: [{ id: vent.id, kind: 'vent', x: drop.x, y: drop.y }] });
      const pinned = placed.placement.openings.find((o) => o.id === vent.id)!;
      expect(pinned.valid, `b = ${b.toFixed(2)}`).toBe(true);
      expect(placed.placement.diagnostics.filter((d) => d.code === 'opening-invalid')).toEqual([]);
    }
    expect(tried).toBeGreaterThan(2);
  }, SLOW);
});

describe('MP4: settings off the usual range', () => {
  const OFF: { name: string; change: (p: Params) => void; codes: string[]; message?: RegExp }[] = [
    { name: 'vents off', change: (p) => (p.vents.enabled = false), codes: [] },
    { name: 'a 30 mm pour', change: (p) => (p.pour.diameter = 30), codes: [] },
    { name: 'a 6 mm vent', change: (p) => (p.vents.diameter = 6), codes: [] },
    { name: '3 pours', change: (p) => (p.pour.perModel = 3), codes: ['pour-shortfall'], message: /^Placed 1 of 3 pours on the seam, one at each of its high points open to the top, the highest at \(-?\d+\.\d, -?\d+\.\d\): on the two-part cover extra pours go only to the seam's other high points, and this seam has no more\. Set Pours per body to 1\.$/ },
    { name: 'no funnel flange', change: (p) => (p.funnel.flangeWidth = 0), codes: [] },
    { name: 'seam land 0.8, pins off', change: (p) => {
      p.clamshell.seamLand = 0.8;
      p.clamshell.pins = false;
    }, codes: [] },
  ];
  for (const { name, change, codes, message } of OFF) {
    it(`${name}: placed with a line where it must, never a throw`, () => {
      const s = split(`sphere ${name}`, () => orientedGallery('sphere'), change);
      const got = s.stage.placement.diagnostics.map((d) => d.code);
      for (const code of codes) expect(got).toContain(code);
      if (message) expect(s.stage.placement.diagnostics.find((d) => d.code === codes[0])!.message).toMatch(message);
      expect(s.stage.placement.openings.filter((o: SeamOpening) => o.kind === 'pour').length).toBeGreaterThan(0);
      if (name === 'vents off') expect(s.stage.placement.openings.every((o) => o.kind === 'pour')).toBe(true);
      if (name.includes('pins off')) expect(s.stage.room.pins).toEqual([]);
    }, SLOW);
  }

  it('a 10 mm cube coupon: the pour with no room for a vent beside it, which a line says', () => {
    const s = split('coupon', () => oriented(box([-5, -5, 0], [5, 5, 10])));
    expect(s.stage.placement.openings.map((o) => o.kind)).toEqual(['pour']);
    const refused = s.stage.placement.diagnostics.find((d) => d.code === 'vent-refused')!;
    expect(refused.message).toMatch(/^No room for a vent beside the pour at \(-?\d+\.\d, -?\d+\.\d\) on the seam, with room for the seam's seal beside it(, clear of its funnel's flange: .*Flange width .* under Pour & funnel .*| and clear of its funnel's flange)\.$/);
  }, SLOW);
});
