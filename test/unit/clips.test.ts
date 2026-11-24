import { describe, expect, it } from 'vitest';
import { planSwitch } from '../../src/app/moldSwitch';
import { projectFile, projectJson } from '../../src/app/project';
import { readProjectJson } from '../../src/app/projectFile';
import { bedFootprint, chooseSplit, fastenerGrowth, fitsBed } from '../../src/core/field/side';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { CLIP_HOLD_N } from '../../src/core/parts/fasteners';
import { clipNeeds, clipRows, earBedGrowth, EAR_LENGTH, keyHead, keySection, neckAt, placeClips, PRY_CLEAR, ROW_GAP, SOCKET_BACK, type ClipLayout, type ClipNeeds } from '../../src/core/parts/clips';
import type { ClamRim } from '../../src/core/parts/rim';
import { PRY_RUN } from '../../src/core/parts/seamBolts';
import { clipAdvice, SEAL_SPACING_MM, wedgeN } from '../../src/core/report/clamp';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';
import { chooseFor, clipHold, coarseRows, exactFootprint, fineSplit, orientedGallery, prepareClamshell } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { skipWithout, type ExampleId } from '../fixtures/loadExamples';

/**
 * MP3b: G13.10.16 to G13.10.19's seam clips with no solids (docs/PLAN.md, MP3b's checks; G13.10.20): the constants and
 * sizes, the draw against a section solve, the rows against brute force, the hold and the wedge, the bed, G13.10.17's
 * table on the models, and the settings through format 7 and the switch. The solids are test/regression/clips.test.ts's.
 */

const DEGREE = Math.PI / 180;

function params(change: (p: Params) => void = () => {}): Params {
  const p = defaultParams('clamshell');
  p.clamshell.fastener = 'clips';
  change(p);
  return p;
}

/** A rim of the halves' box alone: O 100 x 60 round the origin, Zt as asked, the joint's defaults. */
function rimOf(Zt: number, O = { x0: -50, x1: 50, y0: -30, y1: 30 }): Pick<ClamRim, 'O' | 'Zt' | 'Tb' | 'proud'> {
  return { O, Zt, Tb: 4, proud: 0.2 };
}

const place = (Zt: number, holdN = 0, change?: (p: Params) => void): ClipLayout => placeClips(clipNeeds(params(change)), rimOf(Zt), 'x', 0, holdN);

describe('G13.10.16 the constants and sizes', () => {
  const n: ClipNeeds = clipNeeds(params());

  it('the flare stays under the pose\'s 45 degree limit, the corbel at it, and the taper self-locks well under greased PLA\'s friction', () => {
    expect(n.flareDeg).toBeLessThanOrEqual(40);
    expect(n.flareDeg).toBeLessThan(45);
    // The key's push along its taper is tan(taper) cos(flare) of the load on the flares: it slides back only past that friction.
    const lock = Math.tan(n.taperDeg * DEGREE) * Math.cos(n.flareDeg * DEGREE);
    expect(lock).toBeCloseTo(0.0536, 4);
    expect(lock).toBeLessThan(0.06);
    expect(n.key.perMmPerSide).toBeCloseTo(lock, 12);
    expect(lock).toBeLessThan(0.1);
  });

  it('G13.10.16\'s table at the defaults: r, d, w_f, n at the tip and the bottom, f at both, w_e, h_e, the socket\'s length, the ear\'s depth', () => {
    const got = [n.relief, n.depth, n.floor, n.neckTip, n.neckBottom, n.farTip, n.farBottom, n.wall, n.height, n.socketLength, n.earDepth, n.earLength];
    const want = [0.2, 3.2, 2.0, 5.0, 3.67, 10.37, 9.04, 2.4, 15.17, 9.5, 15.4, 10];
    got.forEach((value, k) => expect(Math.abs(value - want[k]), `column ${k}: ${value} against ${want[k]}`).toBeLessThanOrEqual(0.005));
    expect(earBedGrowth(n)).toBe(2 * EAR_LENGTH);
    expect(fastenerGrowth(params())).toBe(earBedGrowth(n));
    expect(neckAt(n, n.earLength)).toBe(5);
    expect(neckAt(n, SOCKET_BACK)).toBeCloseTo(n.neckBottom, 12);
  });

  it('the key: 11.5 long and a 3 mm head, home 3 mm off the bottom with 6.5 engaged, 3 past and 2.5 short, the anchors 0.5 off the floors', () => {
    const { key } = n;
    expect([key.length, key.head, key.home, key.engaged, key.homeLine, key.travelIn, key.travelOut]).toEqual([11.5, 3, 3, 6.5, 6.5, 3, 2.5]);
    expect(key.anchor).toBeCloseTo(n.relief + n.depth - 0.5, 12);
    // Bottomed, the head stands 2 mm off the ear's tip: the tip at the socket's bottom, the body's end past the tip.
    expect(SOCKET_BACK + key.length - n.earLength).toBeCloseTo(2, 12);
    // A perfectly printed key at clearance 0.1 goes 1.87 mm past home, inside the 3 mm.
    expect(key.seatTravel).toBeCloseTo(1.87, 2);
    expect(key.seatTravel).toBeLessThan(key.travelIn);
  });

  it('the head: 8.8 x 13.0 at the defaults, 1.30 mm above the table on the bottom row, and clear of it at any nozzle and clearance', () => {
    const head = keyHead(n);
    expect(2 * head.x).toBeCloseTo(8.8, 9);
    expect(2 * head.y).toBeCloseTo(12.97, 2);
    const rim = rimOf(60);
    const above = (layout: ClipLayout, needs: ClipNeeds): number => layout.placed.find((row) => row.kind === 'bottom')!.z - keyHead(needs).y + rim.Tb;
    expect(above(place(60), n)).toBeCloseTo(1.3, 2);
    // The ear's walls are 6 nozzles, so a fine nozzle lowers the bottom row's centre while the head's margin stays: it is
    // held to the ear's half height, which keeps the head at least proud over the table.
    for (const nozzle of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8]) {
      for (const clearance of [0, 0.05, 0.1, 0.25, 0.5]) {
        const change = (p: Params): void => {
          p.print.nozzle = nozzle;
          p.clips.clearance = clearance;
        };
        const needs = clipNeeds(params(change));
        expect(above(place(60, 0, change), needs), `nozzle ${nozzle}, clearance ${clearance}`).toBeGreaterThanOrEqual(rim.proud - 1e-9);
        expect(keyHead(needs).y, `nozzle ${nozzle}, clearance ${clearance}`).toBeGreaterThan(keySection(needs, needs.key.length).y);
      }
    }
    // At 0.2 with no clearance the head's full margin would stand 0.03 mm under the table.
    const fine = clipNeeds(params((p) => {
      p.print.nozzle = 0.2;
      p.clips.clearance = 0;
    }));
    expect(fine.height / 2 + rim.proud - (keySection(fine, fine.key.length).y + 1.5)).toBeCloseTo(-0.03, 2);
  });

  it('every length that faces up or down in a pose is a whole number of layers, at layers of 0.1 to 0.3', () => {
    for (const layer of [0.1, 0.15, 0.2, 0.25, 0.3]) {
      const m = clipNeeds(params((p) => (p.print.layerHeight = layer)));
      for (const v of [m.relief, m.depth, m.floor]) expect(Math.abs(v / layer - Math.round(v / layer))).toBeLessThan(1e-9);
      expect(m.depth).toBeGreaterThanOrEqual(3.2 - 1e-9);
      expect(m.floor).toBeGreaterThanOrEqual(2.0 - 1e-9);
    }
  });
});

describe('G13.10.16 the draw, against a section solve', () => {
  const n = clipNeeds(params());
  const t = Math.tan(n.flareDeg * DEGREE);
  /**
   * In the section at w, with the halves g apart (each moved g/2 off P), the perpendicular gap between the key's pos flank
   * at its anchor's end and the pos socket's flank, as the 2D distance from the key's corner to that flank's line. The key
   * at `travel` past home lies where the socket is narrower by the taper.
   */
  function flankGap(g: number, travel: number, w = 6): number {
    const socketHalf = neckAt(n, w) / 2;
    const at = keySection(n, w - SOCKET_BACK - n.key.home + travel);
    // The socket's flank: through (r + g/2, socketHalf) along (1, t); its inward normal points to -z.
    const [px, py] = [n.relief + g / 2, socketHalf];
    const [qx, qy] = [at.x, at.y];
    return ((qx - px) * t - (qy - py)) / Math.hypot(1, t);
  }
  /** The seam gap at which the key first touches, by bisection. */
  function contactGap(travel: number): number {
    let lo = 0, hi = 2;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (flankGap(mid, travel) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  it('the first contact\'s gap is 2c/sin(flare), and each mm of push closes 2 tan(taper)/tan(flare) of it, 0.167 mm', () => {
    for (const c of [0, 0.05, 0.1, 0.25, 0.5]) {
      const m = clipNeeds(params((p) => (p.clips.clearance = c)));
      expect(m.clearance).toBe(c);
    }
    // In the section the clearance reads a little wider, as the taper tilts the flares 4 degrees out of its plane.
    expect(flankGap(0, 0)).toBeCloseTo(n.key.sectionClearance, 9);
    expect(n.key.sectionClearance / n.clearance).toBeCloseTo(1.0014, 4);
    expect(contactGap(0)).toBeCloseTo((2 * n.key.sectionClearance) / Math.sin(n.flareDeg * DEGREE), 6);
    const perMm = contactGap(0) - contactGap(1);
    expect(perMm).toBeCloseTo((2 * Math.tan(n.taperDeg * DEGREE)) / t, 6);
    expect(perMm).toBeCloseTo(0.167, 3);
    // Pushed by seatTravel, the clearance is closed with the seam shut.
    expect(contactGap(n.key.seatTravel)).toBeCloseTo(0, 6);
  });
});

describe('G13.10.17 the rows', () => {
  const n = clipNeeds(params());

  /** Brute force: the most rows of h_e with ROW_GAP between that fit the room, counted one by one. */
  function mostRows(room: number): number {
    let k = 0;
    while ((k + 1) * n.height + k * ROW_GAP <= room + 1e-9) k++;
    return k;
  }

  it('over Zt 20 to 300: every row in [z_lo, z_hi], ROW_GAP apart at least, in the order bottom, top, second bottom, middles, centres at most 100 apart, the count the least that does it', () => {
    for (let Zt = 20; Zt <= 300; Zt += 0.37) {
      const layout = place(Zt);
      const zLow = -4 + 0.2, zHigh = Zt - PRY_RUN - PRY_CLEAR;
      expect([layout.zLow, layout.zHigh]).toEqual([zLow, zHigh]);
      const most = mostRows(zHigh - zLow);
      expect(layout.most).toBe(most);
      const kinds = layout.placed.map((row) => row.kind);
      const order = ['bottom', 'top', 'second'].slice(0, Math.min(3, kinds.length));
      expect(kinds.slice(0, 3)).toEqual(order);
      expect(kinds.slice(3).every((kind) => kind === 'middle')).toBe(true);
      const zs = layout.zs;
      expect(zs).toEqual(layout.placed.map((row) => row.z).sort((p, q) => p - q));
      for (const z of zs) {
        expect(z - n.height / 2).toBeGreaterThanOrEqual(zLow - 1e-9);
        expect(z + n.height / 2).toBeLessThanOrEqual(zHigh + 1e-9);
      }
      if (zs.length > 0) expect(zs[0] - n.height / 2).toBeCloseTo(zLow, 9);
      if (zs.length > 1) expect(zs.at(-1)! + n.height / 2).toBeCloseTo(zHigh, 9);
      if (zs.length > 2) expect(layout.placed[2].z - layout.placed[0].z).toBeCloseTo(n.height + ROW_GAP, 9);
      for (let k = 1; k < zs.length; k++) expect(zs[k] - zs[k - 1]).toBeGreaterThanOrEqual(n.height + ROW_GAP - 1e-9);
      // The least count at or over three that keeps the centres within SEAL_SPACING_MM, where it fits.
      const gap = (rows: number): number => {
        const s = clipRows(n, zLow, zHigh, rows).map((row) => row.z).sort((p, q) => p - q);
        return Math.max(0, ...s.slice(1).map((z, k) => z - s[k]));
      };
      let want = Math.min(most, 3);
      while (want < most && gap(want) > SEAL_SPACING_MM) want++;
      expect(zs.length).toBe(want);
      if (want < most || zs.length < 2) expect(gap(zs.length)).toBeLessThanOrEqual(SEAL_SPACING_MM + 1e-9);
      expect(layout.count).toBe(2 * zs.length);
      expect(layout.diagnostics.filter((d) => d.severity === 'error').length).toBe(most === 0 ? 1 : 0);
    }
  });

  it('Zt 40 takes one row with clips-single, Zt 50 two, Zt 60 the bottom pair, and Zt 24 clips-no-room', () => {
    const one = place(40);
    expect(one.placed.map((row) => row.kind)).toEqual(['bottom']);
    expect(one.diagnostics.map((d) => d.code)).toEqual(['clips-single']);
    expect(place(50).placed.map((row) => row.kind)).toEqual(['bottom', 'top']);
    expect(place(60).placed.map((row) => row.kind)).toEqual(['bottom', 'top', 'second']);
    const none = place(24);
    expect(none.placed).toEqual([]);
    expect(none.count).toBe(0);
    const d = none.diagnostics.find((x) => x.code === 'clips-no-room');
    expect(d?.severity).toBe('error');
    expect(d?.also).toEqual(['clamshell.fastener', 'cover.topCap']);
    // Both heights as printed: 24 + 4 - 0.2, against the ears, the chamfers' run and the gap, 15.17 + 12 + 1.
    expect(d?.message).toContain('The halves are 27.8 mm tall');
    expect(d?.message).toContain('which needs them at least 28.2 mm tall: set Seam fasteners to Bolts or None, or raise Top cap by at least 0.4 mm.');
    // The thresholds: about 24.4 for one, 41.6 for two, 58.8 for the bottom pair.
    const at = (rows: number): number => rows * n.height + (rows - 1) * ROW_GAP + 9.2;
    for (const rows of [1, 2, 3]) {
      expect(place(at(rows)).placed.length).toBe(rows);
      expect(place(at(rows) - 0.01).placed.length).toBe(rows - 1);
    }
    expect([at(1), at(2), at(3)].map((z) => Number(z.toFixed(1)))).toEqual([24.4, 41.5, 58.7]);
  });

  it('a count set by the user is held to what fits, with an info line when lowered, the bottom row first in any count', () => {
    const set = (rows: number, Zt: number): ClipLayout => place(Zt, 0, (p) => (p.clips.rows = rows));
    expect(set(1, 200).placed.map((row) => row.kind)).toEqual(['bottom']);
    // One row the user set on tall halves is the user's choice, with no line that they are low.
    expect(set(1, 200).diagnostics).toEqual([]);
    expect(set(2, 200).placed.map((row) => row.kind)).toEqual(['bottom', 'top']);
    expect(set(5, 200).placed.map((row) => row.kind)).toEqual(['bottom', 'top', 'second', 'middle', 'middle']);
    for (const rows of [1, 2, 5]) expect(set(rows, 200).lowered).toBe(false);
    const low = set(8, 60);
    expect(low.placed.length).toBe(3);
    expect(low.lowered).toBe(true);
    const d = low.diagnostics.find((x) => x.code === 'clips-rows-lowered');
    expect(d?.severity).toBe('info');
    expect(d?.also).toEqual(['clips.rows']);
    expect(d?.message).toBe('Clip rows is set to 8, but only 3 rows of clip ears fit up the end faces of these halves, so 3 are built.');
    // With no room at all nothing is lowered to: clips-no-room says it.
    expect(set(2, 24).diagnostics.map((x) => x.code)).toEqual(['clips-no-room']);
  });
});

describe('G13.10.17 the hold and the wedge', () => {
  it('a hold past the keys raises the rows where they fit, and past what fits gives clips-hold', () => {
    const plain = place(116, 30);
    expect(plain.placed.length).toBe(3);
    expect(plain.heldBack).toBe(false);
    const raised = place(116, 300);
    expect(raised.placed.length).toBe(4);
    expect(raised.count * CLIP_HOLD_N).toBeGreaterThanOrEqual(300);
    expect(raised.diagnostics.map((d) => d.code)).not.toContain('clips-hold');
    // A side push of 90 N a half, a hold of 180 N, on halves with room for two rows: 160 N.
    const short = place(45, 180);
    expect(short.placed.length).toBe(2);
    expect(short.heldBack).toBe(true);
    const d = short.diagnostics.find((x) => x.code === 'clips-hold');
    expect(d?.severity).toBe('warning');
    expect(d?.also).toEqual(['clamshell.fastener', 'clips.rows']);
    expect(d?.message).toBe('The seam needs holding with 180 N, and the 4 seam clips are counted at 160 N, 40 N each: set Seam fasteners to Bolts, or to None and hold the seam with clamps and tape belts.');
    // A count set under what fits says to add a row.
    const set = place(116, 300, (p) => (p.clips.rows = 2));
    expect(set.diagnostics.find((x) => x.code === 'clips-hold')?.message).toContain('raise Clip rows by one, or set Seam fasteners to Bolts');
    expect(place(45, 160).heldBack).toBe(false);
  });

  it('the bottom pair counts 4 keys, 160 N; without it 80; clips-wedge past half of that, at a 5 degree taper or a strong tape on low halves', () => {
    const pair = place(60), single = place(50);
    const advice = (layout: ClipLayout, tapeN: number, taper: number): ReturnType<typeof clipAdvice> => clipAdvice(layout, 20, { holdN: tapeN }, taper, 60, 2);
    expect(advice(pair, 20, 15).bottomHoldN).toBe(160);
    expect(advice(single, 20, 15).bottomHoldN).toBe(80);
    // G13.10.17's case: a 20 N tape pull at 15 degrees is 74.6 N frictionless and 40.4 N at mu 0.2.
    expect(advice(pair, 20, 15).wedgeN.frictionless).toBeCloseTo(74.64, 2);
    expect(advice(pair, 20, 15).wedgeN.mu02).toBeCloseTo(40.45, 2);
    expect(advice(pair, 20, 15).wedgeN.frictionless).toBeCloseTo(wedgeN({ holdN: 20 }, 15), 12);
    const codes = (a: ReturnType<typeof clipAdvice>): string[] => a.diagnostics.map((d) => d.code);
    expect(codes(advice(pair, 10, 15))).toEqual([]);
    expect(codes(advice(pair, 10, 5))).toEqual(['clips-wedge']);
    expect(codes(advice(single, 10, 15))).toEqual([]);
    expect(codes(advice(single, 25, 15))).toEqual(['clips-wedge']);
    const d = advice(single, 25, 15).diagnostics[0];
    expect(d.severity).toBe('info');
    expect(d.message).toBe('Taping the base pushes the halves apart at the bottom with up to 93 N, over half the 80 N the 2 bottom clips are counted at: after taping, check that the seam is closed at the bottom edge, or set Seam fasteners to Bolts.');
    // The top span's line comes with clips as with bolts.
    const wide = clipAdvice(pair, 20, { holdN: 10 }, 15, 240, 2);
    expect(wide.topClamp).toBe(true);
    expect(codes(wide)).toEqual(['seam-top-span']);
    expect(clipAdvice(pair, 20, { holdN: 10 }, 15, SEAL_SPACING_MM, 2).topClamp).toBe(false);
    expect([wide.rows, wide.count, wide.spares, wide.clipHoldN, wide.clipsHoldN]).toEqual([3, 6, 2, 40, 240]);
  });
});

/** G13.10.17's table, measured at beta 20 (MP3b): model, axis, rows per end face, their kinds. */
const TABLE: [string, () => ReturnType<typeof orientedGallery>, 'x' | 'y', string[]][] = [
  ['sphere', () => orientedGallery('sphere'), 'x', ['bottom', 'top']],
  ['benchy', () => orientedExample('benchy').mesh, 'y', ['bottom', 'top']],
  ['goddess', () => orientedExample('goddess').mesh, 'y', ['bottom', 'top', 'second']],
  ['vis35', () => orientedExample('vis35').mesh, 'x', ['bottom', 'top', 'second', 'middle']],
  ['wolf', () => orientedExample('wolf').mesh, 'x', ['bottom', 'top', 'second', 'middle']],
  ['vis35', () => orientedExample('vis35').mesh, 'y', ['bottom', 'top', 'second', 'middle']],
];

describe('G13.10.17\'s table on the models', () => {
  for (const [id, mesh, axis, kinds] of TABLE) {
    it(`${id} split along ${axis} takes ${kinds.length} rows, ${2 * kinds.length} keys and 2 spares, holding the seam`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const prep = prepareClamshell(mesh(), params((p) => {
        p.clamshell.axis = axis;
        Object.assign(p.print, { bedX: 1000, bedY: 1000, bedZ: 1000 });
      }));
      const choice = chooseFor(prep, 20);
      // As the app runs it: the exact rim, and the hold the fine fields give, so the force guard is read too.
      const fine = fineSplit(prep, axis, choice.xs, 0.5);
      const { clips, advice } = clipHold(prep, fine);
      expect(clips.placed.map((row) => row.kind)).toEqual(kinds);
      expect(clips.heldBack).toBe(false);
      expect(clips.count * CLIP_HOLD_N).toBeGreaterThanOrEqual(8 * fine.holdN);
      expect(advice.spares).toBe(2);
      expect(advice.diagnostics.map((d) => d.code).filter((code) => code === 'clips-wedge')).toEqual([]);
    }, 600_000);
  }
});

/**
 * G13.10.17's other models, measured at beta 20 (MP3b), the split as the app chooses it: the low ones with one row and
 * clips-single, the rest with two. Each holds its seam, and no wedge passes half its bottom's rating, the closest the
 * eight barriers' 39.1 N against 40.
 */
const LOW: [string, ExampleId | null, () => ReturnType<typeof orientedGallery>, string[], number][] = [
  ['jersey', 'jersey', () => orientedExample('jersey').mesh, ['bottom'], 37.32],
  ['barrel', 'barrel', () => orientedExample('barrel').mesh, ['bottom'], 37.32],
  ['chick', 'chick', () => orientedExample('chick').mesh, ['bottom'], 37.32],
  ['x8', 'x8', () => orientedExample('x8').mesh, ['bottom', 'top'], 39.1],
  ['cube', null, () => orientedGallery('cube'), ['bottom', 'top'], 37.32],
  ['cylinder', null, () => orientedGallery('cylinder'), ['bottom', 'top'], 37.32],
  ['cone', null, () => orientedGallery('cone'), ['bottom', 'top'], 37.32],
];

describe('G13.10.17 on the low models', () => {
  for (const [id, example, mesh, kinds, wedge] of LOW) {
    it(`${id} takes ${kinds.length} row${kinds.length > 1 ? 's' : ''}${kinds.length === 1 ? ' with clips-single' : ''}, holding the seam, its wedge ${wedge} N under half the bottom's 80 N`, (ctx) => {
      if (example) skipWithout(ctx, example);
      const prep = prepareClamshell(mesh(), params((p) => Object.assign(p.print, { bedX: 1000, bedY: 1000, bedZ: 1000 })));
      const choice = chooseFor(prep, 20);
      const fine = fineSplit(prep, choice.axis, choice.xs, 0.5);
      const { clips, advice } = clipHold(prep, fine);
      expect(clips.placed.map((row) => row.kind)).toEqual(kinds);
      expect(clips.heldBack).toBe(false);
      expect(clips.count * CLIP_HOLD_N).toBeGreaterThanOrEqual(8 * fine.holdN);
      expect(clips.diagnostics.map((d) => d.code)).toEqual(kinds.length === 1 ? ['clips-single'] : []);
      expect(advice.bottomHoldN).toBe(80);
      expect(advice.wedgeN.frictionless).toBeCloseTo(wedge, 1);
      expect(advice.wedgeN.frictionless).toBeLessThan(advice.bottomHoldN / 2);
      expect(advice.diagnostics.map((d) => d.code).filter((code) => code === 'clips-wedge')).toEqual([]);
    }, 600_000);
  }
});

describe('G13.10.18 the bed', () => {
  it('VIS-35 split along x on the user\'s 250 x 210 bed: the ears\' 20 mm miss by 0.6, so the y split is chosen with no warning; Bolts fit there, and None is the bare filter', (ctx) => {
    skipWithout(ctx, 'vis35');
    const user = { bedX: 250, bedY: 210, bedZ: 220 };
    const mesh = orientedExample('vis35').mesh;
    const prep = prepareClamshell(mesh, params((p) => Object.assign(p.print, user)));
    const rows = coarseRows(prep, 20);
    const xs = chooseFor({ ...prep, params: { ...prep.params, clamshell: { ...prep.params.clamshell, axis: 'x' } } }, 20, rows).xs;
    const fine = fineSplit(prep, 'x', xs, prep.params.quality.cellFinal);
    const clipped = exactFootprint(prep, fine, 'clips');
    expect(clipped.width - user.bedX).toBeCloseTo(0.6, 1);
    expect(clipped.fits).toBe(false);
    expect(exactFootprint(prep, fine, 'bolts').fits).toBe(true);
    const bare = exactFootprint(prep, fine, 'none');
    const fp = bedFootprint(fine.rim, 'x', xs, 0);
    expect([bare.width, bare.length, bare.fits]).toEqual([fp.width, fp.length, fitsBed(fp, prep.params.print)]);
    expect(clipped.width - bare.width).toBeCloseTo(2 * EAR_LENGTH, 9);
    // The choice with clips takes the y split, which fits, and says nothing.
    const choice = chooseSplit(rows, prep.bounds, prep.ctx, prep.modelVolume);
    expect(choice.axis).toBe('y');
    expect(choice.fitted).toBe(true);
    expect(choice.diagnostics).toEqual([]);
    // On a bed 1 mm narrower than the y split needs with clips, nothing fits, and the card names Bolts.
    const yFine = fineSplit(prep, 'y', choice.xs, prep.params.quality.cellFinal);
    const narrow = { ...prep.params.print, bedX: Math.ceil(exactFootprint(prep, yFine, 'clips').width) - 1, bedY: 210 };
    const tight = prepareClamshell(mesh, { ...prep.params, print: narrow });
    const missed = chooseSplit(rows, tight.bounds, tight.ctx, tight.modelVolume);
    expect(missed.fitted).toBe(false);
    expect(missed.fitsWith).toBe('bolts');
    expect(missed.diagnostics[0].message).toContain('It fits with Seam fasteners: Bolts.');
  }, 900_000);
});

describe('G13.10.19 the settings', () => {
  it('Clips and the clips group round-trip through format 7, and the switch window lists Clip clearance when it was changed', () => {
    const p = params((q) => {
      q.clips.clearance = 0.25;
      q.clips.rows = 3;
    });
    const f = projectFile({ params: p, plane: DEFAULT_PLANE, pins: [], removed: [] }, 'sphere.stl', { modelSha256: '0'.repeat(64), basePlane: { normal: [0, 0, -1], offset: 0, upper: false } });
    const read = readProjectJson(projectJson(f));
    expect(read.file.params.clamshell.fastener).toBe('clips');
    expect(read.file.params.clips).toEqual({ clearance: 0.25, rows: 3 });
    expect(read.notes).toEqual([]);
    // Back to the one-piece, the clips' rows do not apply, so they are kept, hidden, and none is listed.
    expect(planSwitch(p, 'one-piece').rows.map((row) => row.path)).not.toContain('clips.clearance');
    // From a one-piece cover where the user changed the clearance, the window lists it on the way to the Two-part cover.
    const one = defaultParams();
    one.clips.clearance = 0.3;
    expect(planSwitch(one, 'clamshell').rows.map((row) => row.path)).toEqual(['clips.clearance']);
  });
});
