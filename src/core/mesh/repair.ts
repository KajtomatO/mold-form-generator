import type { MeshAudit, OpenLoop } from './audit';
import { float32Ulp } from './marching';
import { meshBounds, type WeldedMesh } from './weld';

/**
 * RM: the parts of the mesh repair that need no lattice: the orientation fix, rung A (closing holes, losing
 * nothing) and the rebuild's grid (rung B's cell). Pure TS, typed arrays only; our own code, from the papers
 * cited where each part is.
 */

/** Why a repair could not be made, with the job's own sentence for the maker. */
export class RepairError extends Error {
  constructor(
    readonly code: 'repair-nothing' | 'repair-empty' | 'repair-failed' | 'repair-cell',
    message: string,
  ) {
    super(message);
    this.name = 'RepairError';
  }
}

/** The finest and coarsest grids a rebuild takes, in mm. */
export const REPAIR_CELL_MIN = 0.1;
export const REPAIR_CELL_MAX = 2;
/** The step the automatic grid is rounded up to, in mm. */
export const REPAIR_CELL_STEP = 0.05;
/**
 * Triangles marching tetrahedra makes per (summed area / cell squared): 8 for a flat face square to an axis; the
 * spike measured 6.9 to 9.2 on the 15 examples at their automatic cells, median 8.4 (docs/PLAN.md, RM).
 */
export const TRIANGLES_PER_CELL_AREA = 8;
/** The most triangles a rebuild may extract before they are reduced, and the most lattice nodes it may visit. */
export const MAX_EXTRACTED = 3_000_000;
export const MAX_NODES = 64_000_000;
/** The most triangles a rebuilt copy keeps after it is reduced (Q4). */
export const REPAIRED_TRIANGLE_LIMIT = 1_000_000;
/**
 * RM, D26: past this many triangles a rebuilt model's left-out parts are held by the export's field but not measured
 * on their own, as their prisms would cost about 1.1 s and 0.4 GB more (the design's probe: 11 us and 4 kB a
 * triangle): the file's clearance is then not verified, as an open mesh's is not.
 */
export const OUTSIDE_MEASURE_LIMIT = 100_000;
/** The longest hole rung A closes, in edges, and the work all its holes may take together (n cubed over 6 a hole). */
export const MAX_HOLE_EDGES = 512;
export const MAX_FILL_WORK = 2e8;

/** The summed area of a mesh's triangles, in mm2, by + - * / and square roots only. */
export function surfaceArea(mesh: WeldedMesh): number {
  const P = mesh.positions, I = mesh.indices;
  let sum = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    sum += Math.sqrt(x * x + y * y + z * z) / 2;
  }
  return sum;
}

/** Nodes on each axis of a rebuild's lattice at `h` over these bounds: 2.37 cells of padding below, at least one above. */
export function latticeNodes(min: readonly number[], max: readonly number[], h: number): [number, number, number] {
  const n: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) n[a] = Math.floor((max[a] - (min[a] - 2.37 * h)) / h) + 3;
  return n;
}

/** What a mesh's size says about a rebuild's grid: its summed area and its bounds. */
export interface CellFacts {
  area: number;
  min: [number, number, number];
  max: [number, number, number];
}

export function cellFacts(mesh: WeldedMesh): CellFacts {
  const { min, max } = meshBounds(mesh.positions);
  return { area: surfaceArea(mesh), min, max };
}

const roundCell = (h: number): number => Math.round(h * 100) / 100;
const nodesAt = (facts: CellFacts, h: number): number => latticeNodes(facts.min, facts.max, h).reduce((p, n) => p * n, 1);
/** About how many triangles a rebuild at `h` extracts before it is reduced. */
export const extractedEstimate = (facts: CellFacts, h: number): number => (TRIANGLES_PER_CELL_AREA * facts.area) / (h * h);

/**
 * How far from the origin a lattice at `h` reaches at most: the model's largest coordinate and the lattice's padding,
 * 2.37 cells below and at most 3 above, with a cell to spare.
 */
const reachOf = (facts: CellFacts, h: number): number => Math.max(...facts.min.map(Math.abs), ...facts.max.map(Math.abs)) + 4 * h;
/**
 * The fewest float32 steps of the lattice's largest coordinate a cell must span (RM's review): marching keeps a vertex
 * 16 steps from a node (clampFor), which must stay well inside its edge, at most a quarter of it, or vertices of one
 * node's edges pass each other. At 0.1 mm that is reached about 26 m from the origin.
 */
const CELL_ULPS = 64;
const fineEnough = (facts: CellFacts, h: number): boolean => h >= CELL_ULPS * float32Ulp(reachOf(facts, h));

/**
 * The automatic grid, which is also the finest a model takes: about MAX_EXTRACTED triangles extracted (the square
 * root rule of the design, k = 8), at least REPAIR_CELL_MIN, rounded up to REPAIR_CELL_STEP, then coarsened a step
 * at a time while the lattice would pass MAX_NODES (a thin model in a tall box), or a cell would span too few float32
 * steps of a model far from the origin. At most REPAIR_CELL_MAX, which may still be too fine (repairCellLimit).
 */
export function autoRepairCell(facts: CellFacts): number {
  const ideal = Math.sqrt((TRIANGLES_PER_CELL_AREA * facts.area) / MAX_EXTRACTED);
  let h = roundCell(Math.max(REPAIR_CELL_MIN, Math.ceil(ideal / REPAIR_CELL_STEP - 1e-9) * REPAIR_CELL_STEP));
  while (h < REPAIR_CELL_MAX && (nodesAt(facts, h) > MAX_NODES || !fineEnough(facts, h))) h = roundCell(h + REPAIR_CELL_STEP);
  return Math.min(h, REPAIR_CELL_MAX);
}

const cellText = (h: number): string => `${h.toFixed(2)} mm`;

/** Why a grid of a size the app takes cannot be used on this model, as what it "would" do, or null when it can. */
export function repairCellLimit(facts: CellFacts, cell: number): string | null {
  const extracted = extractedEstimate(facts, cell);
  if (extracted > MAX_EXTRACTED) return `would make about ${(extracted / 1e6).toFixed(1)} million triangles before they are reduced, past the ${MAX_EXTRACTED / 1e6} million this app takes`;
  const nodes = nodesAt(facts, cell);
  if (nodes > MAX_NODES) return `would need ${(nodes / 1e6).toFixed(0)} million points round this model, past the ${MAX_NODES / 1e6} million this app takes`;
  if (!fineEnough(facts, cell)) return `would be too fine for a model this far from the origin, whose coordinates reach ${Math.round(reachOf(facts, 0)).toLocaleString('en-US')} mm`;
  return null;
}

/** Why a grid typed for a rebuild cannot be used on this model, or null when it can. */
export function repairCellProblem(facts: CellFacts, cell: number): string | null {
  if (!(Number.isFinite(cell) && cell >= REPAIR_CELL_MIN && cell <= REPAIR_CELL_MAX)) return `A grid of ${cell} mm cannot be used: give it a value from ${REPAIR_CELL_MIN} to ${REPAIR_CELL_MAX} mm, or leave it empty for auto.`;
  const limit = repairCellLimit(facts, cell);
  if (limit === null) return null;
  const finest = autoRepairCell(facts);
  return repairCellLimit(facts, finest) === null
    ? `A ${cellText(cell)} grid ${limit}: ${cellText(finest)} is the finest for this model.`
    : `A ${cellText(cell)} grid ${limit}, and no grid from ${REPAIR_CELL_MIN} to ${REPAIR_CELL_MAX} mm suits this model, so it cannot be rebuilt.`;
}

/**
 * Each half-edge's partner across an edge exactly two faces share, -1 where one face or more than two do. Half-edge
 * h is corner h % 3 of triangle h / 3, from that corner to the next. Found by a counting sort of the half-edges under
 * their lower end, as neighboursOf in deviation.ts does, so it costs O(edges) and no comparator sort.
 */
function partners(mesh: WeldedMesh): Int32Array {
  const I = mesh.indices, V = mesh.positions.length / 3, H = I.length;
  const end = (h: number): number => I[h - (h % 3) + ((h % 3) + 1) % 3];
  const starts = new Int32Array(V + 1);
  for (let h = 0; h < H; h++) starts[Math.min(I[h], end(h)) + 1]++;
  for (let v = 0; v < V; v++) starts[v + 1] += starts[v];
  const fill = starts.slice(0, V), halfs = new Int32Array(H);
  for (let h = 0; h < H; h++) halfs[fill[Math.min(I[h], end(h))]++] = h;
  const across = new Int32Array(H).fill(-1);
  const done = new Uint8Array(H);
  for (let v = 0; v < V; v++) {
    for (let i = starts[v]; i < starts[v + 1]; i++) {
      const g = halfs[i];
      if (done[g]) continue;
      const other = Math.max(I[g], end(g));
      let mate = -1, uses = 1;
      for (let j = i + 1; j < starts[v + 1]; j++) {
        const h = halfs[j];
        if (Math.max(I[h], end(h)) !== other) continue;
        done[h] = 1;
        uses++;
        if (mate < 0) mate = h;
      }
      if (uses === 2) {
        across[g] = mate;
        across[mate] = g;
      }
    }
  }
  return across;
}

export interface Oriented {
  /** The same triangles in the same order, some wound the other way. */
  mesh: WeldedMesh;
  /** How many were turned. */
  turned: number;
  /** Edges whose two faces could not be made to agree, as on a Moebius strip. */
  conflicts: number;
}

/**
 * The orientation fix: a breadth-first walk over the edges two faces share makes each connected piece's winding
 * agree with its first triangle's, then a piece whose signed volume about its own centre is negative is turned
 * whole, unless it lies within another piece's box, as a void wound inwards does (connectedPieces' rule). Vertex
 * and triangle order are kept, so the file's own triangles stay where they were. `consistent`: the audit found no
 * edge two faces run the same way, so the walk is skipped (see there).
 */
export function orientPieces(mesh: WeldedMesh, consistent = false): Oriented {
  const I = mesh.indices, P = mesh.positions, T = I.length / 3;
  const flip = new Uint8Array(T);
  const piece = new Int32Array(T).fill(-1);
  let pieces = 0, conflicts = 0;
  if (consistent) {
    // No edge runs the same way in both its faces, so the walk would turn nothing: only whole pieces are turned, and
    // pieces joined through a vertex count as one, as connectedPieces counts them (the 3 million triangle block: 0.7 s
    // for the walk, 0.1 for this).
    const V = P.length / 3;
    const parent = new Int32Array(V);
    for (let v = 0; v < V; v++) parent[v] = v;
    const find = (v: number): number => {
      while (parent[v] !== v) v = parent[v] = parent[parent[v]];
      return v;
    };
    for (let t = 0; t < I.length; t += 3) {
      const r = find(I[t]);
      parent[find(I[t + 1])] = r;
      parent[find(I[t + 2])] = r;
    }
    const id = new Int32Array(V).fill(-1);
    for (let t = 0; t < T; t++) {
      const r = find(I[t * 3]);
      if (id[r] < 0) id[r] = pieces++;
      piece[t] = id[r];
    }
  } else {
    const across = partners(mesh);
    const queue = new Int32Array(T);
    for (let root = 0; root < T; root++) {
      if (piece[root] >= 0) continue;
      let head = 0, tail = 0;
      queue[tail++] = root;
      piece[root] = pieces;
      while (head < tail) {
        const t = queue[head++];
        for (let c = 0; c < 3; c++) {
          const g = across[t * 3 + c];
          if (g < 0) continue;
          const n = (g - (g % 3)) / 3;
          // Two faces agree when they run their shared edge opposite ways, so from different ends.
          const same = I[t * 3 + c] === I[g];
          const want = flip[t] ^ (same ? 1 : 0);
          if (piece[n] < 0) {
            piece[n] = pieces;
            flip[n] = want;
            queue[tail++] = n;
          } else if (flip[n] !== want) conflicts++;
        }
      }
      pieces++;
    }
  }
  // Each piece's box and signed volume about its own centre, as the fix has wound it.
  const box = new Float64Array(pieces * 6);
  for (let p = 0; p < pieces; p++) box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], p * 6);
  for (let t = 0; t < T; t++) {
    const o = piece[t] * 6;
    for (let c = 0; c < 3; c++) {
      const v = I[t * 3 + c] * 3;
      for (let d = 0; d < 3; d++) {
        if (P[v + d] < box[o + d]) box[o + d] = P[v + d];
        if (P[v + d] > box[o + 3 + d]) box[o + 3 + d] = P[v + d];
      }
    }
  }
  const volume = new Float64Array(pieces);
  for (let t = 0; t < T; t++) {
    const o = piece[t] * 6;
    const cx = (box[o] + box[o + 3]) / 2, cy = (box[o + 1] + box[o + 4]) / 2, cz = (box[o + 2] + box[o + 5]) / 2;
    const a = I[t * 3] * 3;
    let b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    if (flip[t]) [b, c] = [c, b];
    const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz;
    const bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz;
    const ex = P[c] - cx, ey = P[c + 1] - cy, ez = P[c + 2] - cz;
    volume[piece[t]] += ax * (by * ez - bz * ey) - ay * (bx * ez - bz * ex) + az * (bx * ey - by * ex);
  }
  const turnWhole = new Uint8Array(pieces);
  for (let p = 0; p < pieces; p++) {
    if (!(volume[p] < 0)) continue;
    let nested = false;
    for (let q = 0; q < pieces && !nested; q++) {
      if (q === p) continue;
      nested = [0, 1, 2].every((d) => box[q * 6 + d] < box[p * 6 + d] && box[q * 6 + 3 + d] > box[p * 6 + 3 + d]);
    }
    if (!nested) turnWhole[p] = 1;
  }
  let turned = 0;
  const indices = I.slice();
  for (let t = 0; t < T; t++) {
    if ((flip[t] ^ turnWhole[piece[t]]) === 0) continue;
    turned++;
    indices[t * 3 + 1] = I[t * 3 + 2];
    indices[t * 3 + 2] = I[t * 3 + 1];
  }
  return { mesh: turned === 0 ? mesh : { positions: P, indices }, turned, conflicts };
}

/** Whether rung A can close a mesh's holes: no edge more than two faces share, none run the same way, every hole a simple loop not too long. */
export function fillable(audit: MeshAudit): boolean {
  if (audit.nonManifoldEdges > 0 || audit.misorientedEdges > 0 || audit.openLoops.length === 0) return false;
  let work = 0;
  for (const loop of audit.openLoops) {
    const n = loop.vertices.length;
    if (n < 3 || n > MAX_HOLE_EDGES || n !== loop.edgeCount || new Set(loop.vertices).size !== n) return false;
    work += (n * n * n) / 6;
  }
  return work <= MAX_FILL_WORK;
}

export interface Filled {
  /** The mesh with its caps appended: the same vertices, its own triangles first and in order. */
  mesh: WeldedMesh;
  /** Each hole's cap, as [first, count] of the appended triangles, in the audit's loop order. */
  caps: [number, number][];
  /** The caps' summed area, in mm2. */
  area: number;
}

/**
 * Rung A: each hole closed by the triangulation of its rim of least area (Barequet and Sharir 1995; Liepa 2003, the
 * area weight only, without the fairing), by dynamic programming over the rim's vertices, O(n cubed) a hole. The
 * cap runs each rim edge the other way to the face it closes against, so the mesh's winding goes on across it.
 * Only triangles are appended: no vertex is added or moved. `hold` is given each hole's tables, for the meter.
 */
export function fillHoles(mesh: WeldedMesh, loops: readonly OpenLoop[], hold?: (arrays: unknown[]) => void): Filled {
  const P = mesh.positions;
  const extra: number[] = [];
  const caps: [number, number][] = [];
  let area = 0;
  for (const loop of loops) {
    const v = loop.vertices;
    const n = v.length;
    const triArea = (i: number, j: number, k: number): number => {
      const a = v[i] * 3, b = v[j] * 3, c = v[k] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
      const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
      return Math.sqrt(x * x + y * y + z * z) / 2;
    };
    const cost = new Float64Array(n * n);
    const pick = new Int32Array(n * n);
    hold?.([cost, pick]);
    for (let len = 2; len < n; len++) {
      for (let i = 0; i + len < n; i++) {
        const j = i + len;
        let best = Infinity, bk = -1;
        for (let k = i + 1; k < j; k++) {
          const c = cost[i * n + k] + cost[k * n + j] + triArea(i, k, j);
          if (c < best) {
            best = c;
            bk = k;
          }
        }
        cost[i * n + j] = best;
        pick[i * n + j] = bk;
      }
    }
    area += cost[n - 1];
    const first = mesh.indices.length / 3 + extra.length / 3;
    const stack: [number, number][] = [[0, n - 1]];
    while (stack.length > 0) {
      const [i, j] = stack.pop()!;
      if (j - i < 2) continue;
      const k = pick[i * n + j];
      // The rim runs along its open half-edges i to i + 1; this triangle runs them the other way.
      extra.push(v[i], v[j], v[k]);
      stack.push([i, k], [k, j]);
    }
    caps.push([first, n - 2]);
  }
  const indices = new Uint32Array(mesh.indices.length + extra.length);
  indices.set(mesh.indices);
  indices.set(extra, mesh.indices.length);
  return { mesh: { positions: mesh.positions, indices }, caps, area };
}
