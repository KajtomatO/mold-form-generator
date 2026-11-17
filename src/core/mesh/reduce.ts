import { windingFolds } from './folds';
import type { MeshSimplifier } from './simplify';
import { compacted } from './simplify';
import type { WeldedMesh } from './weld';

/**
 * RM, rung B's reduction: meshoptimizer takes the extracted surface (a few million small triangles) down by its edge
 * collapses to what the error allows, then what its collapses broke is put right. It can leave a flap of no volume
 * (two triangles on the same three vertices wound opposite ways), which goes; an edge three or four faces share, or
 * one two faces run the same way; or a fold, a triangle turned over through another. The extracted vertices round
 * such a place are locked and it runs again from the extracted surface, until none is left (the spike: at most 4
 * rounds on the 15 examples). Locked by radius, not by box: a box kept up to 5 times the triangles.
 */

/** How many times the reduction may run before it gives up on a surface it cannot keep closed. */
export const REDUCE_ROUNDS = 8;

/** The pairs of triangles on the same three vertices wound opposite ways, which both go, and the indices kept. */
export function cancelPairs(indices: Uint32Array): { indices: Uint32Array; pairs: number } {
  const T = indices.length / 3;
  let cap = 16;
  while (cap < T * 2) cap *= 2;
  const mask = cap - 1;
  const slot = new Int32Array(cap).fill(-1);
  const gone = new Uint8Array(T);
  let pairs = 0;
  // Each triangle by its vertices turned so the least comes first; then (least, x, y) is one way round when x < y.
  const key = new Uint32Array(3);
  const sorted = (t: number): boolean => {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    let lo = a, x = b, y = c;
    if (b < lo && b < c) {
      lo = b;
      x = c;
      y = a;
    } else if (c < lo && c < b) {
      lo = c;
      x = a;
      y = b;
    }
    key[0] = lo;
    key[1] = x < y ? x : y;
    key[2] = x < y ? y : x;
    return x < y;
  };
  for (let t = 0; t < T; t++) {
    const even = sorted(t);
    const a = key[0], b = key[1], c = key[2];
    let hash = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
    hash ^= hash >>> 15;
    let s = hash & mask;
    for (;;) {
      const u = slot[s];
      if (u < 0) {
        slot[s] = t;
        break;
      }
      if (!gone[u]) {
        const uEven = sorted(u);
        if (key[0] === a && key[1] === b && key[2] === c && uEven !== even) {
          gone[u] = 1;
          gone[t] = 1;
          pairs++;
          break;
        }
      }
      s = (s + 1) & mask;
    }
  }
  if (pairs === 0) return { indices, pairs };
  const out = new Uint32Array((T - 2 * pairs) * 3);
  let w = 0;
  for (let t = 0; t < T; t++) {
    if (gone[t]) continue;
    out[w++] = indices[t * 3];
    out[w++] = indices[t * 3 + 1];
    out[w++] = indices[t * 3 + 2];
  }
  return { indices: out, pairs };
}

/**
 * The triangles with an edge not shared by exactly two faces running it opposite ways, by index into `indices`.
 * Half-edges sorted under their lower end by counting, so O(edges).
 */
export function badTriangles(indices: Uint32Array, vertexCount: number): Int32Array {
  const I = indices, H = I.length;
  const end = (h: number): number => I[h - (h % 3) + ((h % 3) + 1) % 3];
  const starts = new Int32Array(vertexCount + 1);
  for (let h = 0; h < H; h++) starts[Math.min(I[h], end(h)) + 1]++;
  for (let v = 0; v < vertexCount; v++) starts[v + 1] += starts[v];
  const fill = starts.slice(0, vertexCount), halfs = new Int32Array(H);
  for (let h = 0; h < H; h++) halfs[fill[Math.min(I[h], end(h))]++] = h;
  const bad = new Uint8Array(H / 3);
  const done = new Uint8Array(H);
  const group: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    for (let i = starts[v]; i < starts[v + 1]; i++) {
      const g = halfs[i];
      if (done[g]) continue;
      const other = Math.max(I[g], end(g));
      group.length = 0;
      group.push(g);
      for (let j = i + 1; j < starts[v + 1]; j++) {
        const h = halfs[j];
        if (Math.max(I[h], end(h)) !== other) continue;
        done[h] = 1;
        group.push(h);
      }
      if (group.length === 2 && I[group[0]] !== I[group[1]]) continue;
      for (const h of group) bad[(h - (h % 3)) / 3] = 1;
    }
  }
  let count = 0;
  for (let t = 0; t < bad.length; t++) count += bad[t];
  const out = new Int32Array(count);
  for (let t = 0, w = 0; t < bad.length; t++) if (bad[t]) out[w++] = t;
  return out;
}

export interface Reduced {
  /** Compacted, its vertices a subset of the extracted ones, unmoved. */
  mesh: WeldedMesh;
  rounds: number;
  /** Extracted vertices locked by the end. */
  locked: number;
  /** Flaps cancelled over all rounds. */
  pairs: number;
  /** meshoptimizer's own error figure for the last round, in mm, which is no bound (for the record). */
  reportedMm: number;
  /** Whether the last round left every edge shared by two faces running it opposite ways and no fold. */
  clean: boolean;
  /** Whether a count was asked for, as the error alone left more than the limit. */
  capped: boolean;
}

/**
 * The extracted surface reduced: meshoptimizer at `errorMm` (absolute) as far as that goes, or, where that leaves
 * more than `maxTriangles`, to that count; flaps cancelled; then, while an edge is bad or the surface folds, the
 * extracted vertices within `lockRadius` of a bad triangle's corners, or in a box round a fold's column, locked,
 * and again from the extracted surface. `onRound` hears each round; `hold` the arrays held:
 * the repair counts meshoptimizer's own heap itself (repairImport.ts), as it does not expose it.
 */
export function reduceRebuilt(extracted: WeldedMesh, simplifier: MeshSimplifier, errorMm: number, lockRadius: number, maxTriangles: number, onRound?: (round: number) => void, hold?: (arrays: unknown[]) => void): Reduced {
  const P = extracted.positions, I = extracted.indices, V = P.length / 3;
  const lock = new Uint8Array(V);
  let locked = 0, pairs = 0, reportedMm = 0, rounds = 0, clean = false, capped = false;
  let target = 0, error = errorMm;
  let result: WeldedMesh = extracted;
  const none = new Float32Array(0);
  while (rounds < REDUCE_ROUNDS) {
    rounds++;
    onRound?.(rounds);
    hold?.([lock, result]);
    let [raw, reported] = simplifier.simplifyWithAttributes(I, P, 3, none, 0, [], lock, target * 3, error, ['ErrorAbsolute']);
    if (!capped && raw.length / 3 > maxTriangles) {
      // The error alone leaves too many: to the count, whatever the error.
      capped = true;
      target = maxTriangles;
      error = 1e30;
      [raw, reported] = simplifier.simplifyWithAttributes(I, P, 3, none, 0, [], lock, target * 3, error, ['ErrorAbsolute']);
    }
    reportedMm = reported;
    const cancelled = cancelPairs(raw);
    pairs += cancelled.pairs;
    const kept = cancelled.indices;
    hold?.([lock, kept]);
    const bad = badTriangles(kept, V);
    result = compacted(P, kept);
    const boxes: number[] = [];
    if (bad.length === 0) {
      // Every edge is right: a fold is a collapse that turned a triangle over, which only the columns see.
      windingFolds(result, undefined, undefined, 0, (x, y, from, to) => void boxes.push(x - 0.5, y - 0.5, from - lockRadius, x + 0.5, y + 0.5, to + lockRadius));
      if (boxes.length === 0) {
        clean = true;
        break;
      }
    }
    if (rounds === REDUCE_ROUNDS) break;
    const before = locked;
    if (boxes.length > 0) {
      for (let v = 0; v < V; v++) {
        if (lock[v]) continue;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        for (let q = 0; q < boxes.length; q += 6) {
          if (x >= boxes[q] && y >= boxes[q + 1] && z >= boxes[q + 2] && x <= boxes[q + 3] && y <= boxes[q + 4] && z <= boxes[q + 5]) {
            lock[v] = 1;
            locked++;
            break;
          }
        }
      }
    } else locked += lockNear(P, lock, kept, bad, lockRadius);
    // Nothing new to lock: another round would make the same surface.
    if (locked === before) break;
  }
  return { mesh: result, rounds, locked, pairs, reportedMm, clean, capped };
}

/** Locks every vertex of P within `radius` of a corner of the listed triangles, by a hashed grid of the corners; how many it locked. */
function lockNear(P: Float32Array, lock: Uint8Array, kept: Uint32Array, bad: Int32Array, radius: number): number {
  const corners = new Float64Array(bad.length * 9);
  for (let i = 0; i < bad.length; i++) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) corners[i * 9 + c * 3 + d] = P[kept[bad[i] * 3 + c] * 3 + d];
  const n = corners.length / 3;
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const cellOf = (x: number): number => Math.floor(x / radius);
  const hash = (i: number, j: number, k: number): number => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & mask;
  const starts = new Int32Array(size + 1);
  for (let p = 0; p < n; p++) starts[hash(cellOf(corners[p * 3]), cellOf(corners[p * 3 + 1]), cellOf(corners[p * 3 + 2])) + 1]++;
  for (let s = 0; s < size; s++) starts[s + 1] += starts[s];
  const list = new Int32Array(n);
  const fill = starts.slice(0, size);
  for (let p = 0; p < n; p++) list[fill[hash(cellOf(corners[p * 3]), cellOf(corners[p * 3 + 1]), cellOf(corners[p * 3 + 2]))]++] = p;
  const r2 = radius * radius;
  let locked = 0;
  for (let v = 0; v < lock.length; v++) {
    if (lock[v]) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const i0 = cellOf(x), j0 = cellOf(y), k0 = cellOf(z);
    let near = false;
    for (let di = -1; di <= 1 && !near; di++) {
      for (let dj = -1; dj <= 1 && !near; dj++) {
        for (let dk = -1; dk <= 1 && !near; dk++) {
          const s = hash(i0 + di, j0 + dj, k0 + dk);
          for (let e = starts[s]; e < starts[s + 1]; e++) {
            const p = list[e];
            const dx = x - corners[p * 3], dy = y - corners[p * 3 + 1], dz = z - corners[p * 3 + 2];
            if (dx * dx + dy * dy + dz * dz <= r2) {
              near = true;
              break;
            }
          }
        }
      }
    }
    if (near) {
      lock[v] = 1;
      locked++;
    }
  }
  return locked;
}
