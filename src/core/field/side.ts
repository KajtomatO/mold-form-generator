import type { RigidTransform } from '../base/orient';
import { transformPositions } from '../base/orient';
import { meshBounds, type Bounds, type WeldedMesh } from '../mesh/weld';
import type { Params } from '../params/schema';
import { deriveClamRim, hmaxClam, sideBoundsFast, type ClamRim, type ClamVertices, type MoldBounds, type SeamAxis } from '../parts/rim';
import type { Rect } from '../solid/rect';
import { lugBedGrowth, seamBoltNeeds } from '../parts/seamBolts';
import type { Diagnostic } from '../report/diagnostics';
import { conditionField } from './build';
import { dilate } from './dilate';
import { axisOf, pullOf, PULLS, signOf, sideFrame, type Pull } from './frames';
import { MARGIN_CELLS, NODE_CAP, planField, type Field, type FieldPlan, type FieldSettings, type Grid } from './grid';
import { rasterize } from './raster';
import { LIFT_MAX } from './lift';

/**
 * G13.1 to G13.3: the two-part cover's side fields and the choice of its seam plane P = {a = xs}. A side field is G3's
 * field turned on its side: in a pull's frame (u, v, h), v is z and h runs along the pull, so G(u, v) is how far the
 * cavity reaches along the pull in row (u, v), and each half is a height field along its own pull (G13.4).
 */

export type { SeamAxis } from '../parts/rim';
export { axisOf, frameInverse, halfFrame, pullOf, PULLS, seamFrame, sideFrame, signOf, type Pull } from './frames';

/**
 * G13.10.16's ear length Le, out from an end face along b: the seam clips' ears, which widen each half's pose by 2 Le
 * (G13.3's bed filter). Defined here, where the bed reads it, and imported by parts/clips.ts (MP3b).
 */
export const EAR_LENGTH = 10;

export { LIFT_MAX };

/** G13.3: the candidates' place along a, as a fraction of the model's extent. */
export const SWEEP_FROM = 0.2;
export const SWEEP_TO = 0.8;
/** G13.3: the steps of the sweep, then of the second look round the best, in mm. */
export const SWEEP_STEP = 1;
export const REFINE_STEP = 0.25;
/** G13.3: within this fraction of the least silicone, a split is a tie. */
export const TIE = 0.01;
/** G13.2 step 8: the cell of the coarse fields that choose the split, in mm. */
export const COARSE_CELL = 1;

/** The model turned into a pull's frame. The indices are the model's, as the turn is rigid. */
export function turnMesh(mesh: WeldedMesh, frame: RigidTransform): WeldedMesh {
  return { ...mesh, positions: transformPositions(mesh.positions, frame) };
}

/** The seam's h in a pull's frame: xs - amin on the + side, amax - xs on the - side. */
export function seamH(pull: Pull, bounds: Bounds, xs: number): number {
  const a = axisOf(pull) === 'x' ? 0 : 1;
  return signOf(pull) > 0 ? xs - bounds.min[a] : bounds.max[a] - xs;
}

/** Where a reach of h in this frame lies along a: amin + h on the + side, amax - h on the - side. */
export function reachA(pull: Pull, bounds: Bounds, h: number): number {
  const a = axisOf(pull) === 'x' ? 0 : 1;
  return signOf(pull) > 0 ? bounds.min[a] + h : bounds.max[a] - h;
}

/** The mold's b of a lattice u: +x has u = y, -x u = -y, +y u = -x, -y u = x. */
export function bOf(pull: Pull, u: number): number {
  return pull === '+x' || pull === '-y' ? u : -u;
}

// ----- G13.2: the lattice -----

export interface SidePlan {
  pull: Pull;
  frame: RigidTransform;
  /** G4's plan on the turned bounds with one tile: rEff, raise and the padding the chain needs. */
  plan: FieldPlan;
  /** The padded lattice in (u, v): below v = 0 for the prism, above for the roof. */
  grid: Grid;
  /** The row of v = 0. */
  j0: number;
}

/**
 * G13.2 step 1: `planField` on the turned bounds with nx = ny = 1, then padded below v = 0 by max(rEff + MARGIN_CELLS
 * cell, Tb + 2) and above to `top` plus 2 cells: Hmax_clam over the candidates for a coarse field, at the chosen xs for a
 * fine one. The lattice keeps planField's origin, a whole number of cells, so a row lies on v = 0.
 */
export function planSide(pull: Pull, bounds: Bounds, settings: FieldSettings, Tb: number, top: number): SidePlan {
  const frame = sideFrame(pull, bounds);
  const plan = planField(turnedBounds(pull, bounds), { ...settings, nx: 1, ny: 1, spacing: null });
  const { tile, cell } = plan;
  const below = Math.max(plan.rEff + MARGIN_CELLS * cell, Tb + 2);
  const jLow = Math.min(Math.round(tile.y0 / cell), -Math.ceil(below / cell - 1e-9) - 1);
  const jHigh = Math.max(Math.round(tile.y0 / cell) + tile.ny - 1, Math.ceil(top / cell - 1e-9) + 2);
  const grid: Grid = { nx: tile.nx, ny: jHigh - jLow + 1, cell, x0: tile.x0, y0: jLow * cell };
  // planField kept its tile under the cap, and the padding adds rows past it.
  if (grid.nx * grid.ny > NODE_CAP) throw new Error(`The ${pull} side field would need ${grid.nx * grid.ny} nodes, more than the ${NODE_CAP / 1_000_000} million a field may have.`);
  return { pull, frame, plan, grid, j0: -jLow };
}

/** The model's bounds turned into a pull's frame, from their eight corners. */
function turnedBounds(pull: Pull, bounds: Bounds): Bounds {
  const corners: number[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) corners.push(x, y, z);
  return meshBounds(transformPositions(new Float32Array(corners), sideFrame(pull, bounds)));
}

/**
 * The rEff every side field of this model is built with, as planSide's planField gives it at the export's cell, the
 * largest over the pulls: G13.6's D_side, D3 and Hmax_clam read it, so the bounds hold whatever cell planField takes.
 */
export function sideREff(bounds: Bounds, settings: FieldSettings): number {
  let rEff = 0;
  for (const pull of PULLS) rEff = Math.max(rEff, planField(turnedBounds(pull, bounds), { ...settings, cell: settings.cellFinal, nx: 1, ny: 1, spacing: null }).rEff);
  return rEff;
}

/**
 * The lattice's top for G13.2 step 1: at the chosen xs for a fine field, and for a coarse one, which every candidate
 * reads, Hmax_clam at both ends of the extent, as its vertex term is the larger of two linear pieces in xs.
 */
export function sideTop(vertices: ClamVertices, axis: SeamAxis, xs: number | null, betaDeg: number, raise: number, cell: number): number {
  if (xs !== null) return hmaxClam(vertices, axis, xs, betaDeg, raise, cell);
  const a = axis === 'x' ? 0 : 1;
  return Math.max(hmaxClam(vertices, axis, vertices.min[a], betaDeg, raise, cell), hmaxClam(vertices, axis, vertices.max[a], betaDeg, raise, cell));
}

/** G13.2 step 7's eps: max(tinTol, 0.05). */
export function seamEps(tinTol: number): number {
  return Math.max(tinTol, 0.05);
}

// ----- G13.2: the chain -----

/** G13.2 step 4: the base layer's rows, in this frame: rows at v <= top raised to `reach` for u in [u0, u1]. */
export interface LayerRows {
  top: number;
  reach: number;
  u0: number;
  u1: number;
}

export interface SideOptions {
  /** clamshell.ceilingDeg: 0 means no roof. */
  betaDeg: number;
  /** The roof's stop: 0 in a coarse field, the seam's h in a fine one. */
  hStop: number;
  /** Step 6, fine fields only: the seam's h, or null for none. */
  flattenAt: number | null;
  layer: LayerRows | null;
  /** Step 5 runs down to v = -(Tb + 1). */
  Tb: number;
}

/**
 * G13.2 step 3: sweep v upward, G(u, v) := max(G(u, v), G(u, v - 1) - cell cot(beta)) where G(u, v - 1) > hStop. Every
 * plastic ceiling then falls toward P by at most cot(beta) per unit height (G13.5). Beta 0 is no roof.
 */
export function applyRoof(field: Field, betaDeg: number, hStop: number): void {
  if (!(betaDeg > 0)) return;
  const { nx, ny, cell, values } = field;
  const fall = cell / Math.tan((betaDeg * Math.PI) / 180);
  for (let j = 1; j < ny; j++) {
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      const below = values[n - nx];
      if (below > hStop && below - fall > values[n]) values[n] = below - fall;
    }
  }
}

/**
 * G13.2 step 4's rows on one pull, or null with the layer off: up to the layer's top, at b inside D less a cell, raised
 * to the reach of D's far edge on this side less a cell, as G8's layer stops a cell inside D.
 */
export function layerRows(pull: Pull, bounds: Bounds, D: Rect, depth: number, cell: number): LayerRows | null {
  if (!(depth > 0)) return null;
  const axis = axisOf(pull), sign = signOf(pull);
  const [a0, a1, b0, b1] = axis === 'x' ? [D.x0, D.x1, D.y0, D.y1] : [D.y0, D.y1, D.x0, D.x1];
  const a = axis === 'x' ? 0 : 1;
  const reach = sign > 0 ? a1 - cell - bounds.min[a] : bounds.max[a] - (a0 + cell);
  const u = [bOf(pull, b0 + cell), bOf(pull, b1 - cell)];
  return { top: depth, reach, u0: Math.min(...u), u1: Math.max(...u) };
}

/** G13.2 step 4, after the roof and exempt from it: the base layer's rows raised to its farthest reach on this side. */
export function applyLayerRows(field: Field, layer: LayerRows): void {
  const { nx, cell, x0, y0, values } = field;
  const jTop = Math.floor((layer.top - y0) / cell + 1e-9);
  const i0 = Math.max(0, Math.ceil((layer.u0 - x0) / cell - 1e-9)), i1 = Math.min(nx - 1, Math.floor((layer.u1 - x0) / cell + 1e-9));
  const jFloor = Math.round(-y0 / cell);
  for (let j = jFloor; j <= jTop; j++) {
    for (let i = i0, n = i0 + j * nx; i <= i1; i++, n++) if (layer.reach > values[n]) values[n] = layer.reach;
  }
}

/** G13.2 step 5: G(u, v) := max(G(u, v), G(u, 0)) for v < 0 down to -(Tb + 1), the straight prism into the rebate. */
export function applyPrismRows(field: Field, Tb: number): void {
  const { nx, cell, y0, values } = field;
  const j0 = Math.round(-y0 / cell);
  const jEnd = Math.max(0, Math.ceil((-(Tb + 1) - y0) / cell - 1e-9));
  for (let j = j0 - 1; j >= jEnd; j--) {
    for (let i = 0, n = j * nx, from = j0 * nx; i < nx; i++, n++, from++) if (values[from] > values[n]) values[n] = values[from];
  }
}

/**
 * G13.2 step 6, fine fields only: a node whose 8 neighbours and itself all have G <= hs is set to hs - 1 - LIFT_MAX. Those
 * rows hold no cavity on this side of P, so the half is unchanged and G4 untouched, but the TIN collapses there. A
 * node is only ever lowered from at most hs or raised to under hs, so the test reads the same in place.
 */
export function flattenFarSide(field: Field, hs: number): number {
  const { nx, ny, values } = field;
  const flat = hs - 1 - LIFT_MAX;
  let count = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      let clear = true;
      for (let dj = -1; dj <= 1 && clear; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          if (values[ii + jj * nx] > hs) {
            clear = false;
            break;
          }
        }
      }
      if (clear) {
        values[n] = flat;
        count++;
      }
    }
  }
  return count;
}

/**
 * G13.2 steps 2 to 6 on a model already turned into the side's frame: raster, dilate(rEff), draft and closing as G3 and
 * G5, then the roof, the layer rows, the prism rows and, in a fine field, the far side's flatten. Every step raises G
 * but the flatten, which changes only rows proved to lie outside this half.
 */
export function buildSideField(turned: WeldedMesh, side: SidePlan, settings: Pick<FieldSettings, 'draftDeg' | 'closeWidth'>, options: SideOptions): Field {
  const raster = rasterize(turned, side.grid);
  const dilated = dilate(raster, side.plan.rEff);
  const { field } = conditionField(dilated, settings);
  applyRoof(field, options.betaDeg, options.hStop);
  if (options.layer) applyLayerRows(field, options.layer);
  applyPrismRows(field, options.Tb);
  if (options.flattenAt !== null) flattenFarSide(field, options.flattenAt);
  return field;
}

/** The row index of v = 0 in a side field. */
export function floorRow(field: Field): number {
  return Math.round(-field.y0 / field.cell);
}

/** Whether the top row of a roofed field is at or under hStop, so the roof stopped inside the lattice (G13.2 step 3). */
export function topRowClear(field: Field, hStop: number): boolean {
  const { nx, ny, values } = field;
  for (let i = 0, n = (ny - 1) * nx; i < nx; i++, n++) if (values[n] > hStop) return false;
  return true;
}

// ----- G13.4: H_top -----

/**
 * G13.4's H_top, the clamshell's own top-down map, from G+- by a running maximum down each b-column: at (a, b) on the
 * + side, the highest z whose row reaches a. Nodes on the export's lattice of a and b at the field's cell; 0 where
 * no row reaches. x is the map's first axis, as every Field's. With `zCap` (MP4), only the rows at or under it count, so
 * a hidden leaf's own run reads its ceiling under the more of S above it (G13.5).
 */
export function topMap(plus: Field, minus: Field, bounds: Bounds, axis: SeamAxis, xs: number, zCap = Infinity): Field {
  const cell = plus.cell;
  const pp = pullOf(axis, 1), pm = pullOf(axis, -1);
  // b over the union of both fields' u, a over the model's extent with the dilation's reach.
  const bs: number[] = [];
  for (const [f, pull] of [[plus, pp], [minus, pm]] as const) for (const u of [f.x0, f.x0 + (f.nx - 1) * cell]) bs.push(bOf(pull, u));
  const k0 = Math.round(Math.min(...bs) / cell), k1 = Math.round(Math.max(...bs) / cell);
  const a = axis === 'x' ? 0 : 1;
  const reachMax = (f: Field): number => {
    let m = 0;
    for (const v of f.values) if (v > m) m = v;
    return m;
  };
  const i0 = Math.floor(reachA(pm, bounds, reachMax(minus)) / cell) - 1, i1 = Math.ceil(reachA(pp, bounds, reachMax(plus)) / cell) + 1;
  const na = i1 - i0 + 1, nb = k1 - k0 + 1;
  const top = new Float32Array(na * nb);
  for (const [f, pull] of [[plus, pp], [minus, pm]] as const) {
    const sign = signOf(pull), hs = seamH(pull, bounds, xs);
    const jFloor = floorRow(f);
    for (let i = 0; i < f.nx; i++) {
      const kb = Math.round(bOf(pull, f.x0 + i * cell) / cell) - k0;
      // The a nodes on this side, from P outward, and their h in this frame.
      let ia = sign > 0 ? Math.ceil(xs / cell - 1e-9) - i0 : Math.ceil(xs / cell - 1e-9) - 1 - i0;
      let R = -Infinity;
      for (let j = Math.min(f.ny - 1, jFloor + Math.floor(zCap / cell + 1e-9)); j >= jFloor; j--) {
        const g = f.values[i + j * f.nx];
        if (g > R) R = g;
        if (R <= hs) continue;
        const z = (j - jFloor) * cell;
        for (; ia >= 0 && ia < na; ia += sign) {
          const h = sign > 0 ? (i0 + ia) * cell - bounds.min[a] : bounds.max[a] - (i0 + ia) * cell;
          if (h > R) break;
          const at = axis === 'x' ? ia + kb * na : kb + ia * nb;
          if (z > top[at]) top[at] = z;
        }
      }
    }
  }
  return axis === 'x' ? { nx: na, ny: nb, cell, x0: i0 * cell, y0: k0 * cell, values: top } : { nx: nb, ny: na, cell, x0: k0 * cell, y0: i0 * cell, values: top };
}

// ----- G13.3: the sweep -----

/**
 * One side's rows of a coarse field for G13.3, as reaches along a, sorted, with the sums the score needs. Only rows at
 * v >= 0 count, v = 0 at half weight, so the sum is the volume under the surface the TIN interpolates over z >= 0.
 */
export interface SideRows {
  pull: Pull;
  cell: number;
  /** Ascending on the + side, as the cavity is where reach > xs; ascending on the - side too, where reach < xs. */
  reach: Float64Array;
  weight: Float64Array;
  /** Prefix sums over the sorted rows of weight and of weight times reach. */
  sumW: Float64Array;
  sumWR: Float64Array;
  /** The highest z among the rows up to each index from the cavity's end: suffix max on +, prefix max on -. */
  topZ: Float64Array;
}

export function sideRows(field: Field, pull: Pull, bounds: Bounds): SideRows {
  const { nx, ny, cell, values } = field;
  const jFloor = floorRow(field);
  const rows: [number, number, number][] = [];
  for (let j = jFloor; j < ny; j++) {
    const z = (j - jFloor) * cell, w = j === jFloor ? 0.5 : 1;
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      const g = values[n];
      if (g > 0) rows.push([reachA(pull, bounds, g), w, z]);
    }
  }
  rows.sort((p, q) => p[0] - q[0]);
  const n = rows.length;
  const reach = new Float64Array(n), weight = new Float64Array(n), sumW = new Float64Array(n + 1), sumWR = new Float64Array(n + 1), topZ = new Float64Array(n);
  rows.forEach(([r, w], k) => {
    reach[k] = r;
    weight[k] = w;
    sumW[k + 1] = sumW[k] + w;
    sumWR[k + 1] = sumWR[k] + w * r;
  });
  if (signOf(pull) > 0) for (let k = n - 1; k >= 0; k--) topZ[k] = Math.max(rows[k][2], k + 1 < n ? topZ[k + 1] : -Infinity);
  else for (let k = 0; k < n; k++) topZ[k] = Math.max(rows[k][2], k > 0 ? topZ[k - 1] : -Infinity);
  return { pull, cell, reach, weight, sumW, sumWR, topZ };
}

/** The first index whose reach is above xs (+ side, strictly) or at or above it. */
function firstAbove(reach: Float64Array, xs: number): number {
  let lo = 0, hi = reach.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reach[mid] > xs) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface SideScore {
  /** The cavity's volume on both sides with the raise, in mm3, before the model is taken off. */
  volume: number;
  /** Rows of cavity, by weight. */
  rows: number;
  /** The highest z with cavity on P, -Infinity with none. */
  seamTop: number;
}

/**
 * G13.3: V(a, xs) + V_model = sum max(0, reach+ - xs) cell2 + sum max(0, xs - reach-) cell2 + raise (cavity rows) cell2,
 * in O(log n) from the sorted rows.
 */
export function scoreSplit(plus: SideRows, minus: SideRows, xs: number, raise: number): SideScore {
  const cell2 = plus.cell * plus.cell;
  const kp = firstAbove(plus.reach, xs), np = plus.reach.length;
  const wp = plus.sumW[np] - plus.sumW[kp], vp = plus.sumWR[np] - plus.sumWR[kp] - xs * wp;
  // On the - side the cavity is where reach < xs.
  let lo = 0, hi = minus.reach.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (minus.reach[mid] < xs) lo = mid + 1;
    else hi = mid;
  }
  const km = lo;
  const wm = minus.sumW[km], vm = xs * wm - minus.sumWR[km];
  const seamTop = Math.max(kp < np ? plus.topZ[kp] : -Infinity, km > 0 ? minus.topZ[km - 1] : -Infinity);
  return { volume: (vp + vm + raise * (wp + wm)) * cell2, rows: wp + wm, seamTop };
}

/** The same from the fields, row by row: the brute force the sorted sums are tested against. */
export function scoreSplitBrute(plusField: Field, minusField: Field, bounds: Bounds, axis: SeamAxis, xs: number, raise: number): SideScore {
  let volume = 0, rows = 0, seamTop = -Infinity;
  for (const [f, pull] of [[plusField, pullOf(axis, 1)], [minusField, pullOf(axis, -1)]] as const) {
    const jFloor = floorRow(f), cell2 = f.cell * f.cell;
    for (let j = jFloor; j < f.ny; j++) {
      const w = j === jFloor ? 0.5 : 1;
      for (let i = 0; i < f.nx; i++) {
        const g = f.values[i + j * f.nx];
        if (!(g > 0)) continue;
        const r = reachA(pull, bounds, g);
        const depth = signOf(pull) > 0 ? r - xs : xs - r;
        if (depth <= 0) continue;
        volume += w * (depth + raise) * cell2;
        rows += w;
        seamTop = Math.max(seamTop, (j - jFloor) * f.cell);
      }
    }
  }
  return { volume, rows, seamTop };
}

// ----- G13.3: the bed -----

export type SeamFastener = Params['clamshell']['fastener'];

/** G13.3: what each fastener adds across b to a half's pose: the lugs' 2p, the ears' 2 Le, or nothing. */
export function fastenerGrowth(params: Params, fastener: SeamFastener = params.clamshell.fastener): number {
  if (fastener === 'bolts') return lugBedGrowth(seamBoltNeeds(params));
  if (fastener === 'clips') return 2 * EAR_LENGTH;
  return 0;
}

export interface BedFootprint {
  /** Across the bed: O's extent along b with the fastener's growth, and the cover's height Zt + Tb - proud. */
  width: number;
  length: number;
  /** Each half's depth |O.a - xs|, its height in the pose: the - half's, then the + half's. */
  depths: [number, number];
  Zt: number;
}

/** G13.3's footprint of the halves at this split, from the rim, and whether it fits the bed either way round. */
export function bedFootprint(rim: Pick<ClamRim, 'O' | 'Zt' | 'Tb' | 'proud'>, axis: SeamAxis, xs: number, growth: number): BedFootprint {
  const { O } = rim;
  const [a0, a1, b0, b1] = axis === 'x' ? [O.x0, O.x1, O.y0, O.y1] : [O.y0, O.y1, O.x0, O.x1];
  return { width: b1 - b0 + growth, length: rim.Zt + rim.Tb - rim.proud, depths: [xs - a0, a1 - xs], Zt: rim.Zt };
}

export function fitsBed(footprint: BedFootprint, print: Pick<Params['print'], 'bedX' | 'bedY' | 'bedZ'>): boolean {
  const { width: w, length: l } = footprint;
  const flat = (w <= print.bedX + 1e-9 && l <= print.bedY + 1e-9) || (w <= print.bedY + 1e-9 && l <= print.bedX + 1e-9);
  return flat && Math.max(...footprint.depths) <= print.bedZ + 1e-9;
}

/** What the bed filter reads that the sweep does not: the analytic bounds, G8's D and the parameters. */
export interface SplitContext {
  vertices: ClamVertices;
  mold: MoldBounds;
  params: Params;
  /** The tool's raise and the export's cell, for Hmax_clam. */
  raise: number;
  cellFinal: number;
}

/** G13.6's rim at a candidate, from the O(1) bounds: for the bed filter, never smaller than the exact rim's. */
export function quickRim(ctx: SplitContext, axis: SeamAxis, xs: number, betaDeg = ctx.params.clamshell.ceilingDeg): ClamRim {
  const { vertices, mold, params, raise, cellFinal } = ctx;
  return deriveClamRim(mold, sideBoundsFast(vertices, axis, xs), hmaxClam(vertices, axis, xs, betaDeg, raise, cellFinal), params, axis, xs, vertices.zJ);
}

// ----- G13.3: the choice -----

export interface SplitCandidate {
  axis: SeamAxis;
  xs: number;
  score: SideScore;
  /** Silicone in mm3: the score less the model above the plane. */
  silicone: number;
  footprint: BedFootprint;
  fits: boolean;
}

export interface SplitChoice extends SplitCandidate {
  /** Every candidate looked at, both axes, the sweep's and the second look's. */
  candidates: number;
  /** Whether any candidate fitted the bed: false keeps the bed warning. */
  fitted: boolean;
  /** With none fitting: the largest whole beta at which some split fits, or null if none does even at 0. */
  fitsAtBeta: number | null;
  /** With none fitting: the fastener with which some split fits, or null. */
  fitsWith: SeamFastener | null;
  diagnostics: Diagnostic[];
}

/** The coarse fields' rows for each pull the choice may take. */
export type SplitRows = Partial<Record<Pull, SideRows>>;

/** G13.3's candidates on one axis: [0.2, 0.8] of the extent in whole steps, or the typed offset alone. */
function positions(vertices: ClamVertices, axis: SeamAxis, offset: number | null, cellFinal: number): number[] {
  const a = axis === 'x' ? 0 : 1;
  const lo = vertices.min[a], hi = vertices.max[a];
  if (offset !== null) return [typedSeam(lo, hi, offset, cellFinal)];
  const from = lo + SWEEP_FROM * (hi - lo), to = lo + SWEEP_TO * (hi - lo);
  const out: number[] = [];
  for (let k = Math.ceil(from / SWEEP_STEP - 1e-9); k * SWEEP_STEP <= to + 1e-9; k++) out.push(k * SWEEP_STEP);
  // A model shorter than a step along a still gets its middle.
  if (out.length === 0) out.push(Math.round((lo + hi) / 2 / cellFinal) * cellFinal);
  return out;
}

/** G13.3's typed offset, mm from the centre of the extent: clamped to the extent less 1 mm on each side and snapped to cellFinal. */
export function typedSeam(lo: number, hi: number, offset: number, cellFinal: number): number {
  const xs = Math.min(hi - 1, Math.max(lo + 1, (lo + hi) / 2 + offset));
  const snapped = Math.round(xs / cellFinal) * cellFinal;
  // The snap may not take it back past the clamp.
  return snapped < lo + 1 ? snapped + cellFinal : snapped > hi - 1 ? snapped - cellFinal : snapped;
}

/** Ties within TIE of the least silicone: the higher seam-section top, then the lower Zt, then x. */
function better(p: SplitCandidate, q: SplitCandidate, least: number): number {
  const tie = (c: SplitCandidate): boolean => c.silicone <= least + TIE * Math.abs(least);
  const tp = tie(p), tq = tie(q);
  if (tp !== tq) return tp ? -1 : 1;
  if (!tp) return p.silicone - q.silicone;
  if (p.score.seamTop !== q.score.seamTop) return q.score.seamTop - p.score.seamTop;
  if (Math.abs(p.footprint.Zt - q.footprint.Zt) > 1e-9) return p.footprint.Zt - q.footprint.Zt;
  if (p.axis !== q.axis) return p.axis === 'x' ? -1 : 1;
  return p.silicone - q.silicone;
}

function pick(list: SplitCandidate[]): SplitCandidate | null {
  if (list.length === 0) return null;
  const least = Math.min(...list.map((c) => c.silicone));
  return [...list].sort((p, q) => better(p, q, least))[0];
}

const mm = (v: number): string => v.toFixed(1);

/** The axes the choice may take: both on auto, or the one typed. */
export function splitAxes(params: Params): SeamAxis[] {
  const axis = params.clamshell.axis;
  return axis === 'auto' ? ['x', 'y'] : [axis];
}

/**
 * G13.3 (stage S6c): every candidate scored from the same coarse fields, kept where its halves fit the bed, and the
 * least silicone taken with the ties' order. With none fitting, the least silicone is taken with the bed warning, which
 * names the largest beta at which some split fits and, where the fastener alone breaks the fit, the one that fits; beta
 * and the fastener are never changed here. `modelVolume` is the model above the plane, which the score does not hold.
 */
export function chooseSplit(rows: SplitRows, bounds: Bounds, ctx: SplitContext, modelVolume: number): SplitChoice {
  const { params, raise, cellFinal, vertices } = ctx;
  const growth = fastenerGrowth(params);
  const all: SplitCandidate[] = [];
  const at = (axis: SeamAxis, xs: number): SplitCandidate => {
    const plus = rows[pullOf(axis, 1)], minus = rows[pullOf(axis, -1)];
    if (!plus || !minus) throw new Error(`The ${axis} split has no coarse fields.`);
    const score = scoreSplit(plus, minus, xs, raise);
    const footprint = bedFootprint(quickRim(ctx, axis, xs), axis, xs, growth);
    return { axis, xs, score, silicone: score.volume - modelVolume, footprint, fits: fitsBed(footprint, params.print) };
  };
  for (const axis of splitAxes(params)) {
    const first = positions(vertices, axis, params.clamshell.offset, cellFinal).map((xs) => at(axis, xs));
    all.push(...first);
    if (params.clamshell.offset !== null) continue;
    // The second look, round the best of this axis that fits, or of all if none does.
    const best = pick(first.filter((c) => c.fits)) ?? pick(first)!;
    const a = axis === 'x' ? 0 : 1;
    const lo = vertices.min[a] + SWEEP_FROM * (vertices.max[a] - vertices.min[a]), hi = vertices.min[a] + SWEEP_TO * (vertices.max[a] - vertices.min[a]);
    for (let k = -3; k <= 3; k++) {
      const xs = best.xs + k * REFINE_STEP;
      if (k === 0 || xs < lo - 1e-9 || xs > hi + 1e-9) continue;
      all.push(at(axis, Math.round(xs / cellFinal) * cellFinal));
    }
  }
  const fitting = all.filter((c) => c.fits);
  const chosen = pick(fitting) ?? pick(all)!;
  const diagnostics: Diagnostic[] = [];
  let fitsAtBeta: number | null = null, fitsWith: SeamFastener | null = null;
  if (fitting.length === 0) {
    const anyFits = (beta: number, grow: number): boolean => all.some((c) => fitsBed(bedFootprint(quickRim(ctx, c.axis, c.xs, beta), c.axis, c.xs, grow), params.print));
    for (let beta = Math.ceil(params.clamshell.ceilingDeg) - 1; beta >= 0; beta--) {
      if (anyFits(beta, growth)) {
        fitsAtBeta = beta;
        break;
      }
    }
    // Clips' ears are the widest, then the lugs, then none: the first narrower one that fits is named.
    const order: SeamFastener[] = ['clips', 'bolts', 'none'];
    for (const f of order.slice(order.indexOf(params.clamshell.fastener) + 1)) {
      if (anyFits(params.clamshell.ceilingDeg, fastenerGrowth(params, f))) {
        fitsWith = f;
        break;
      }
    }
    const { bedX, bedY, bedZ } = params.print;
    const fp = chosen.footprint;
    const slope = fitsAtBeta === null ? ' No split fits at any ceiling slope.' : ` A split fits at a ceiling slope of ${fitsAtBeta} degrees or less.`;
    const fastener = fitsWith === null ? '' : ` It fits with Seam fasteners: ${fitsWith === 'none' ? 'None' : fitsWith === 'bolts' ? 'Bolts' : 'Clips'}.`;
    diagnostics.push({
      code: 'clamshell-bed',
      severity: 'warning',
      also: ['print.bedX', 'print.bedY', 'print.bedZ', 'clamshell.ceilingDeg', 'clamshell.fastener'],
      message: `The halves do not fit the ${mm(bedX)} x ${mm(bedY)} x ${mm(bedZ)} mm bed set under Advanced, Printer: the split along ${chosen.axis.toUpperCase()}, with the least silicone, needs ${mm(fp.width)} x ${mm(fp.length)} mm, ${mm(Math.max(...fp.depths))} mm tall.${slope}${fastener}`,
    });
  }
  return { ...chosen, candidates: all.length, fitted: fitting.length > 0, fitsAtBeta, fitsWith, diagnostics };
}

/**
 * G13.4's seam section S on the lattice: the rows (b, z), z >= 0, whose cavity is non-empty on either side of P, from
 * the two fine fields of one axis, which share the lattice of b as both start on whole cells. `b0` is the first column's b.
 */
export interface SeamMask {
  mask: Uint8Array;
  nb: number;
  nz: number;
  b0: number;
  cell: number;
}

export function seamMask(plus: Field, minus: Field, bounds: Bounds, axis: SeamAxis, xs: number): SeamMask {
  const cell = plus.cell;
  const pp = pullOf(axis, 1), pm = pullOf(axis, -1);
  const bs: number[] = [];
  for (const [f, pull] of [[plus, pp], [minus, pm]] as const) for (const u of [f.x0, f.x0 + (f.nx - 1) * cell]) bs.push(bOf(pull, u));
  const k0 = Math.round(Math.min(...bs) / cell), k1 = Math.round(Math.max(...bs) / cell);
  const nb = k1 - k0 + 1;
  const nz = Math.max(plus.ny - floorRow(plus), minus.ny - floorRow(minus));
  const mask = new Uint8Array(nb * nz);
  for (const [f, pull] of [[plus, pp], [minus, pm]] as const) {
    const hs = seamH(pull, bounds, xs), jFloor = floorRow(f);
    for (let j = jFloor; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        if (f.values[i + j * f.nx] > hs) mask[Math.round(bOf(pull, f.x0 + i * cell) / cell) - k0 + (j - jFloor) * nb] = 1;
      }
    }
  }
  return { mask, nb, nz, b0: k0 * cell, cell };
}

/**
 * G13.6's check on a fine side field, maskOverrun's for this type: how far the cavity at z <= zJ passes `D`, in mm. A
 * row's cavity runs along a from P to its reach, with the tool's raise; as in maskOverrun, a node's surface reaches one
 * cell further across b and up z, so rows to zJ + cell count and b is taken a cell wider. At the export cell this
 * must be 0, and that keeps the base's joint off either half's cavity.
 */
export function sideOverrun(field: Field, pull: Pull, bounds: Bounds, hs: number, raise: number, D: Rect, zJ: number): number {
  const { nx, ny, cell, x0, values } = field;
  const axis = axisOf(pull), sign = signOf(pull);
  const [a0, a1, b0, b1] = axis === 'x' ? [D.x0, D.x1, D.y0, D.y1] : [D.y0, D.y1, D.x0, D.x1];
  const jFloor = floorRow(field);
  const jTop = Math.min(ny - 1, jFloor + Math.floor((zJ + cell) / cell + 1e-9));
  let worst = 0;
  for (let j = 0; j <= jTop; j++) {
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      const g = values[n];
      if (g <= hs) continue;
      const b = bOf(pull, x0 + i * cell), reach = reachA(pull, bounds, g + raise);
      worst = Math.max(worst, b0 - (b - cell), b + cell - b1, sign > 0 ? reach - a1 : a0 - reach);
    }
  }
  return worst;
}
