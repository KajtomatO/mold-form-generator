import { connectedPieces } from '../mesh/shells';
import { meshBounds, type WeldedMesh } from '../mesh/weld';
import { HEIGHT_STEP } from './peaks';

/**
 * S8: the model read as columns. Every column at `analysisCell` holds the model's surface crossings
 * sorted by height, with their winding, which splits it into solid stretches and free ones. Neighbouring
 * free stretches connect only where they overlap by at least one cell, as the plan's interval rule says:
 * that is what keeps the barrel's void apart from the silicone around it, and a steep wall thinner than
 * a cell from leaking. Shells, footprints, the silicone's two awkward kinds, sealed air and the pockets
 * under the model all come from these components.
 * Never from mesh genus, which says nothing about where silicone can go.
 */

/**
 * What bounds a free stretch below and above: the base plate or the model, and the model or nothing.
 * Nothing above means the cover, as the cavity is a height field over the model's top envelope.
 */
const OPEN = 0;
const TOP = 1;
const UNDER = 2;
const SANDWICH = 3;

/** A crossing at a triangle of a void shell, such as the barrel's hollow, which the model's volume already holds. */
const VOID = 1;

/**
 * A wall of sandwiched silicone counts as a place where the model closes it off only along this much of
 * its edge, in mm. Shorter runs are where a wedge of free space thins to under a cell, which the cell
 * decides: on the seven examples they are 1 to 5 columns at 0.25 mm and 1 to 8 at 0.125 mm, where the
 * shortest group counted is one of Benchy's cabin, 8 columns at 0.25 mm and 17 at 0.125 mm.
 */
const MIN_WALL_MM = 2;

export interface IntervalShell {
  /** In mm3, from the solid stretches. */
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
  /** Indexes into IntervalReport.footprints. */
  footprints: number[];
}

/** One connected patch where a shell stands on the plane. */
export interface FootprintPatch {
  shell: number;
  /** In mm2. */
  area: number;
  centroid: [number, number];
}

/**
 * Silicone that is neither plain jacket nor open floor: under the model with the base plate as its floor
 * (under-plug), or between two parts of the model (sandwiched).
 */
export interface SiliconeBody {
  kind: 'under-plug' | 'sandwiched';
  /** In mm3. */
  volume: number;
  /** In mm2, a column counted once per stretch. */
  area: number;
  /** Weighted by volume. For a ring or a wrapped body it can lie in the model, so a hint uses `at`. */
  centroid: [number, number, number];
  /** A point in the body itself, nearest the centroid: on a column of it, inside its free stretch there. */
  at: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** The shell over it, and the one under it for sandwiched silicone, or -1 for the plate. */
  shell: number;
  below: number;
  /** Separate places where it opens into the rest of the silicone. Only counted for sandwiched silicone. */
  mouths: number;
  /**
   * Separate places where the model closes it off at the side, from the part below it to the part above
   * it: the closed end of a blind hole, or each post the silicone runs round. Two or more mean the model
   * is joined to itself round the silicone, so it holds the model in a loop. Only for sandwiched silicone.
   */
  walls: number;
}

export interface SealedDomain {
  /** In mm3. */
  volume: number;
  /** Footprint in mm2. */
  area: number;
  min: [number, number, number];
  max: [number, number, number];
  /** It starts at the base plane, so the base plate is one of its walls, like an inverted cup. */
  onPlane: boolean;
  /** A void of the model itself, which the model's volume already holds, such as the barrel's hollow. */
  inModel: boolean;
}

/**
 * Air that collects under the model as a slowly rising level closes off its way out, from a merge tree
 * of the free stretches by their ceilings. A top vent cannot reach it, as the model is its ceiling.
 */
export interface UndersidePocket {
  /** The highest point of the pocket's ceiling. */
  x: number;
  y: number;
  z: number;
  /** Where its air last joins air that gets away. */
  saddle: number;
  /** z - saddle, in whole height steps. */
  persistence: number;
  /** Air above the saddle, in mm3. */
  volume: number;
  /** The shell over its highest point. */
  shell: number;
}

export interface IntervalReport {
  cell: number;
  shells: IntervalShell[];
  footprints: FootprintPatch[];
  /** Not sealed, any size: the reports filter them by volume. */
  silicone: SiliconeBody[];
  /** Largest first, any size. */
  sealed: SealedDomain[];
  /** Highest persistence first, any persistence of one height step or more. */
  pockets: UndersidePocket[];
  /** Counts, for the record. */
  columns: number;
  freeIntervals: number;
  solidIntervals: number;
}

/**
 * Walks every column a triangle's projection covers, at most once per triangle and column, with the
 * height there, +1 entering the solid and -1 leaving it, and the triangle.
 */
export function forEachCrossing(mesh: WeldedMesh, nx: number, ny: number, cell: number, x0: number, y0: number, visit: (column: number, z: number, sign: number, triangle: number) => void): void {
  const { positions: p, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    let b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const doubled = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    // A vertical face has no column running through it.
    if (doubled === 0) continue;
    // Counter-clockwise from above means the outward normal faces up, so rising through it leaves
    // the solid. The other way enters it.
    const sign = doubled > 0 ? -1 : 1;
    if (doubled < 0) [b, c] = [c, b];
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const area = Math.abs(doubled);

    const iLow = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / cell));
    const iHigh = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
    const jLow = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / cell));
    const jHigh = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / cell));

    // The top-left rule: a column exactly on an edge shared by two triangles hits just one of them,
    // whichever way they are wound, or the winding count would go wrong.
    const topLeftAB = by < ay || (by === ay && bx < ax);
    const topLeftBC = cy < by || (cy === by && cx < bx);
    const topLeftCA = ay < cy || (ay === cy && ax < cx);
    for (let j = jLow; j <= jHigh; j++) {
      const y = y0 + j * cell;
      for (let i = iLow; i <= iHigh; i++) {
        const x = x0 + i * cell;
        const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        if (w0 < 0 || (w0 === 0 && !topLeftAB)) continue;
        if (w1 < 0 || (w1 === 0 && !topLeftBC)) continue;
        if (w2 < 0 || (w2 === 0 && !topLeftCA)) continue;
        visit(i + j * nx, (w1 * az + w2 * bz + w0 * cz) / area, sign, t / 3);
      }
    }
  }
}

/** A union-find over a fixed number of items, with path halving. */
function unionFind(size: number): { parent: Int32Array; find: (a: number) => number; join: (a: number, b: number) => void } {
  const parent = new Int32Array(size);
  for (let a = 0; a < size; a++) parent[a] = a;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  return { parent, find, join: (a, b) => void (parent[find(a)] = find(b)) };
}

/** A growable list of int pairs, for edges and contacts whose count is only known at the end. */
class PairList {
  a: Int32Array<ArrayBuffer> = new Int32Array(1024);
  b: Int32Array<ArrayBuffer> = new Int32Array(1024);
  length = 0;
  push(x: number, y: number): void {
    if (this.length === this.a.length) {
      const grow = (old: Int32Array): Int32Array<ArrayBuffer> => {
        const next = new Int32Array(old.length * 2);
        next.set(old);
        return next;
      };
      this.a = grow(this.a);
      this.b = grow(this.b);
    }
    this.a[this.length] = x;
    this.b[this.length++] = y;
  }
}

/** Why an analysis cell cannot be used, or null when it can: a cell of 0 or less asks for endless or no columns. */
export function analysisCellProblem(cell: number): string | null {
  return cell > 0 && Number.isFinite(cell) ? null : `An analysis cell of ${cell} mm cannot be used: give it a value above 0.`;
}

/**
 * S8 on a mesh standing on z = 0. Pass the whole mesh, voids included: a void's air is reported as sealed
 * and inside the model, and kept apart from air the base plate closes off, which is what the silicone
 * figure takes off. Free stretches thinner than a cell are left out, as the overlap rule could never
 * connect them, and so also too thin to matter.
 */
export function analyseIntervals(mesh: WeldedMesh, cell: number): IntervalReport {
  const problem = analysisCellProblem(cell);
  if (problem) throw new RangeError(problem);
  const empty: IntervalReport = { cell, shells: [], footprints: [], silicone: [], sealed: [], pockets: [], columns: 0, freeIntervals: 0, solidIntervals: 0 };
  if (mesh.indices.length === 0) return empty;
  const { min, max } = meshBounds(mesh.positions);
  // One column past the model on every side, so a hole running out through a side has open air to
  // join. Those columns are all open top.
  const nx = Math.ceil((max[0] - min[0]) / cell) + 2;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 2;
  const x0 = min[0] - cell / 2;
  const y0 = min[1] - cell / 2;
  const columns = nx * ny;
  const cellArea = cell * cell;
  const xOf = (c: number): number => x0 + (c % nx) * cell;
  const yOf = (c: number): number => y0 + Math.floor(c / nx) * cell;

  const voids = new Uint8Array(mesh.indices.length / 3);
  for (const piece of connectedPieces(mesh)) if (piece.kind === 'void') for (const t of piece.triangles) voids[t] = VOID;

  // Crossings per column, sorted by height.
  const start = new Uint32Array(columns + 1);
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (column) => void start[column + 1]++);
  for (let c = 0; c < columns; c++) start[c + 1] += start[c];
  const zs = new Float32Array(start[columns]);
  const signs = new Int8Array(start[columns]);
  const flags = new Uint8Array(start[columns]);
  const fill = start.slice(0, columns);
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (column, z, sign, triangle) => {
    let at = fill[column]++;
    // Insertion sort: a column has few crossings.
    while (at > start[column] && zs[at - 1] > z) {
      zs[at] = zs[at - 1];
      signs[at] = signs[at - 1];
      flags[at] = flags[at - 1];
      at--;
    }
    zs[at] = z;
    signs[at] = sign;
    flags[at] = voids[triangle];
  });

  // The stretches of each column, lowest first. A free stretch knows the solid one under and over it:
  // -1 under is the plate, -1 over is the cover, and -2 over is an open mesh that ends inside its solid.
  const capacity = start[columns] + columns;
  const freeStart = new Uint32Array(columns + 1);
  const fLow = new Float32Array(capacity), fHigh = new Float32Array(capacity);
  const fBelow = new Int32Array(capacity), fAbove = new Int32Array(capacity);
  const fVoid = new Uint8Array(capacity);
  const solidStart = new Uint32Array(columns + 1);
  const sLow = new Float32Array(capacity), sHigh = new Float32Array(capacity);
  let nFree = 0, nSolid = 0;
  for (let c = 0; c < columns; c++) {
    freeStart[c] = nFree;
    solidStart[c] = nSolid;
    let winding = 0;
    let floor = 0, floorVoid = 0;
    // Where the solid we are in began, or -1 outside. A solid that has ended waits in `pending` until the
    // gap over it proves thick enough: a thinner gap joins it to the next one.
    let inside = -1;
    let pending = false, pendingLow = 0, pendingHigh = 0;
    for (let k = start[c]; k < start[c + 1]; k++) {
      const before = winding;
      winding += signs[k];
      const z = zs[k];
      if (before <= 0 && winding > 0) {
        const at = z > 0 ? z : 0;
        if (at - floor >= cell) {
          let below = -1;
          if (pending) {
            sLow[nSolid] = pendingLow;
            sHigh[nSolid] = pendingHigh;
            below = nSolid++;
            pending = false;
          }
          fLow[nFree] = floor;
          fHigh[nFree] = at;
          fBelow[nFree] = below;
          // The solid starting here takes the next index once it ends.
          fAbove[nFree] = nSolid;
          fVoid[nFree] = floorVoid & flags[k];
          nFree++;
          inside = at;
        } else {
          // Too thin to count: the solid goes on from the one under it, or from the plane.
          inside = pending ? pendingLow : 0;
          pending = false;
        }
      } else if (before > 0 && winding <= 0) {
        // Wholly below the plane, which the raster clips too: as if it were not there.
        if (z <= 0) {
          inside = -1;
          continue;
        }
        pending = true;
        pendingLow = inside < 0 ? 0 : inside;
        pendingHigh = z;
        inside = -1;
        floor = z;
        floorVoid = flags[k];
      }
    }
    // The solid under the open top: the one that ended last, which a later entry may have written already.
    let below = -1;
    if (pending) {
      sLow[nSolid] = pendingLow;
      sHigh[nSolid] = pendingHigh;
      below = nSolid++;
    } else if (floor > 0 && nSolid > solidStart[c]) {
      below = nSolid - 1;
    }
    // An open mesh can end with the count still up. That stretch is left out and the column stays open
    // above its last exit, so air beside a hole counts as reachable.
    if (inside >= 0 && nFree > freeStart[c] && fAbove[nFree - 1] === nSolid) fAbove[nFree - 1] = -2;
    fLow[nFree] = floor;
    fHigh[nFree] = Infinity;
    fBelow[nFree] = below;
    fAbove[nFree] = -1;
    fVoid[nFree] = 0;
    nFree++;
  }
  freeStart[columns] = nFree;
  solidStart[columns] = nSolid;

  const kind = new Uint8Array(nFree);
  for (let a = 0; a < nFree; a++) kind[a] = fAbove[a] === -1 ? (fBelow[a] < 0 ? OPEN : TOP) : fBelow[a] < 0 ? UNDER : SANDWICH;

  // Neighbouring columns, by the overlap rule: free space by at least a cell, solid by anything at all,
  // so a thin sheet of the model still holds its shell together.
  const space = unionFind(nFree);
  const classes = unionFind(nFree);
  const solids = unionFind(nSolid);
  const edges = new PairList();
  const contacts = new PairList();
  // Which of its four sides each free stretch meets free space on, as one bit per side.
  const linked = new Uint8Array(nFree);
  const connect = (c: number, d: number, sideOfC: number, sideOfD: number): void => {
    let a = freeStart[c], b = freeStart[d];
    const aEnd = freeStart[c + 1], bEnd = freeStart[d + 1];
    while (a < aEnd && b < bEnd) {
      if (Math.min(fHigh[a], fHigh[b]) - Math.max(fLow[a], fLow[b]) >= cell) {
        linked[a] |= sideOfC;
        linked[b] |= sideOfD;
        space.join(a, b);
        const ka = kind[a], kb = kind[b];
        if (ka === kb && ka >= UNDER) classes.join(a, b);
        if (ka >= UNDER || kb >= UNDER) edges.push(a, b);
        if (ka === SANDWICH && kb !== SANDWICH) contacts.push(a, c);
        if (kb === SANDWICH && ka !== SANDWICH) contacts.push(b, d);
      }
      if (fHigh[a] < fHigh[b]) a++;
      else b++;
    }
    let s = solidStart[c], t = solidStart[d];
    const sEnd = solidStart[c + 1], tEnd = solidStart[d + 1];
    while (s < sEnd && t < tEnd) {
      if (Math.min(sHigh[s], sHigh[t]) > Math.max(sLow[s], sLow[t])) solids.join(s, t);
      if (sHigh[s] < sHigh[t]) s++;
      else t++;
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = i + j * nx;
      if (i + 1 < nx) connect(c, c + 1, 1, 2);
      if (j + 1 < ny) connect(c, c + nx, 4, 8);
    }
  }

  // Each column's last stretch is its open top, so a component holding one is not sealed.
  const open = new Uint8Array(nFree);
  for (let c = 0; c < columns; c++) open[space.find(freeStart[c + 1] - 1)] = 1;
  const sealedOf = (a: number): boolean => open[space.find(a)] === 0;

  // Shells, compacted, with their volume and bounds.
  const shellOfRoot = new Int32Array(nSolid).fill(-1);
  const shells: IntervalShell[] = [];
  const solidShell = new Int32Array(nSolid);
  for (let c = 0; c < columns; c++) {
    const x = xOf(c), y = yOf(c);
    for (let s = solidStart[c]; s < solidStart[c + 1]; s++) {
      const root = solids.find(s);
      let index = shellOfRoot[root];
      if (index < 0) {
        index = shellOfRoot[root] = shells.length;
        shells.push({ volume: 0, min: [x, y, sLow[s]], max: [x, y, sHigh[s]], footprints: [] });
      }
      solidShell[s] = index;
      const shell = shells[index];
      shell.volume += (sHigh[s] - sLow[s]) * cellArea;
      if (x < shell.min[0]) shell.min[0] = x;
      if (y < shell.min[1]) shell.min[1] = y;
      if (sLow[s] < shell.min[2]) shell.min[2] = sLow[s];
      if (x > shell.max[0]) shell.max[0] = x;
      if (y > shell.max[1]) shell.max[1] = y;
      if (sHigh[s] > shell.max[2]) shell.max[2] = sHigh[s];
    }
  }

  // Footprints: columns whose lowest solid starts on the plane, joined by a shared side. Columns where the
  // model stands over air the plate seals off, such as Benchy's recessed lettering, join them too: no
  // silicone reaches between two patches across them, so the patches are one place to the loop lock.
  const STANDING = 1, SEALED_UNDER = 2;
  const footing = new Uint8Array(columns);
  for (let c = 0; c < columns; c++) {
    if (solidStart[c + 1] === solidStart[c]) continue;
    if (sLow[solidStart[c]] === 0) footing[c] = STANDING;
    else if (fLow[freeStart[c]] === 0 && kind[freeStart[c]] === UNDER && sealedOf(freeStart[c])) footing[c] = SEALED_UNDER;
  }
  const patches = unionFind(columns);
  for (let c = 0; c < columns; c++) {
    if (!footing[c]) continue;
    if (c % nx + 1 < nx && footing[c + 1]) patches.join(c, c + 1);
    if (c + nx < columns && footing[c + nx]) patches.join(c, c + nx);
  }
  const footprints: FootprintPatch[] = [];
  const patchOfRoot = new Map<number, number>();
  const sums: [number, number][] = [];
  for (let c = 0; c < columns; c++) {
    // A patch is only where the model stands: sealed air under it joins patches but is no footprint.
    if (footing[c] !== STANDING) continue;
    const root = patches.find(c);
    let index = patchOfRoot.get(root);
    if (index === undefined) {
      index = footprints.length;
      patchOfRoot.set(root, index);
      const shell = solidShell[solidStart[c]];
      footprints.push({ shell, area: 0, centroid: [0, 0] });
      shells[shell].footprints.push(index);
      sums.push([0, 0]);
    }
    footprints[index].area += cellArea;
    sums[index][0] += xOf(c);
    sums[index][1] += yOf(c);
  }
  footprints.forEach((patch, k) => {
    const n = patch.area / cellArea;
    patch.centroid = [sums[k][0] / n, sums[k][1] / n];
  });

  // Sealed domains: free space with no column's open top in it.
  const domains = new Map<number, SealedDomain>();
  for (let c = 0; c < columns; c++) {
    const x = xOf(c), y = yOf(c);
    for (let a = freeStart[c]; a < freeStart[c + 1] - 1; a++) {
      const root = space.find(a);
      if (open[root]) continue;
      let domain = domains.get(root);
      if (!domain) domains.set(root, (domain = { volume: 0, area: 0, min: [x, y, fLow[a]], max: [x, y, fHigh[a]], onPlane: false, inModel: true }));
      domain.volume += (fHigh[a] - fLow[a]) * cellArea;
      domain.area += cellArea;
      domain.min = [Math.min(domain.min[0], x), Math.min(domain.min[1], y), Math.min(domain.min[2], fLow[a])];
      domain.max = [Math.max(domain.max[0], x), Math.max(domain.max[1], y), Math.max(domain.max[2], fHigh[a])];
      if (fLow[a] === 0) domain.onPlane = true;
      if (!fVoid[a]) domain.inModel = false;
    }
  }
  const sealed = [...domains.values()].sort((a, b) => b.volume - a.volume);

  // The silicone's under-plug and sandwiched bodies, leaving out what is sealed.
  const bodyOfRoot = new Map<number, number>();
  const silicone: SiliconeBody[] = [];
  const weights: [number, number, number][] = [];
  const bodyOf = new Int32Array(nFree).fill(-1);
  for (let c = 0; c < columns; c++) {
    const x = xOf(c), y = yOf(c);
    for (let a = freeStart[c]; a < freeStart[c + 1]; a++) {
      if (kind[a] < UNDER || sealedOf(a)) continue;
      const root = classes.find(a);
      let index = bodyOfRoot.get(root);
      if (index === undefined) {
        index = silicone.length;
        bodyOfRoot.set(root, index);
        silicone.push({
          kind: kind[a] === UNDER ? 'under-plug' : 'sandwiched',
          volume: 0,
          area: 0,
          centroid: [0, 0, 0],
          at: [x, y, (fLow[a] + fHigh[a]) / 2],
          min: [x, y, fLow[a]],
          max: [x, y, fHigh[a]],
          shell: fAbove[a] >= 0 ? solidShell[fAbove[a]] : -1,
          below: fBelow[a] >= 0 ? solidShell[fBelow[a]] : -1,
          mouths: 0,
          walls: 0,
        });
        weights.push([0, 0, 0]);
      }
      bodyOf[a] = index;
      const body = silicone[index];
      const volume = (fHigh[a] - fLow[a]) * cellArea;
      body.volume += volume;
      body.area += cellArea;
      weights[index][0] += x * volume;
      weights[index][1] += y * volume;
      weights[index][2] += ((fLow[a] + fHigh[a]) / 2) * volume;
      body.min = [Math.min(body.min[0], x), Math.min(body.min[1], y), Math.min(body.min[2], fLow[a])];
      body.max = [Math.max(body.max[0], x), Math.max(body.max[1], y), Math.max(body.max[2], fHigh[a])];
    }
  }
  silicone.forEach((body, k) => {
    body.centroid = [weights[k][0] / body.volume, weights[k][1] / body.volume, weights[k][2] / body.volume];
  });
  // The point of each body nearest its centroid, at least half a cell off the model where the stretch
  // allows: the middle of a ring or of silicone wrapped round a post is in the model, not in the body.
  const nearest = new Float64Array(silicone.length).fill(Infinity);
  for (let c = 0; c < columns; c++) {
    const x = xOf(c), y = yOf(c);
    for (let a = freeStart[c]; a < freeStart[c + 1]; a++) {
      const k = bodyOf[a];
      if (k < 0) continue;
      const [cx, cy, cz] = silicone[k].centroid;
      const inset = Math.min(cell / 2, (fHigh[a] - fLow[a]) / 2);
      const z = Math.min(Math.max(cz, fLow[a] + inset), fHigh[a] - inset);
      const d = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      if (d < nearest[k]) {
        nearest[k] = d;
        silicone[k].at = [x, y, z];
      }
    }
  }
  for (const [body, mouths] of placesOf(contacts, bodyOf, nx)) silicone[body].mouths = mouths;
  // The columns where sandwiched silicone meets the model on a side, and not more free space.
  const walls = new PairList();
  for (let c = 0; c < columns; c++) {
    for (let a = freeStart[c]; a < freeStart[c + 1]; a++) if (kind[a] === SANDWICH && bodyOf[a] >= 0 && linked[a] !== 15) walls.push(a, c);
  }
  for (const [body, count] of placesOf(walls, bodyOf, nx, Math.ceil(MIN_WALL_MM / cell - 1e-9))) silicone[body].walls = count;

  const pockets = undersidePockets({ nFree, fLow, fHigh, fAbove, kind, sealedOf, edges, freeStart, columns, solidShell, xOf, yOf, cellArea });
  return { cell, shells, footprints, silicone, sealed, pockets, columns, freeIntervals: nFree, solidIntervals: nSolid };
}

/**
 * How many separate places each body's marked columns make, from pairs of a stretch and its column:
 * where a sandwiched body meets other silicone (its mouths), or meets the model on a side (its walls).
 * Columns are grouped by their 8 neighbours, as the edge of a round hole steps diagonally from column to
 * column. Two mouths or more mean the silicone runs through the model and out again; two walls or more
 * that the model is joined to itself round it, as round the posts of a cabin. Either holds the model in
 * a loop. A group of fewer than `least` columns is not counted.
 */
function placesOf(pairs: PairList, bodyOf: Int32Array, nx: number, least = 1): Map<number, number> {
  const byBody = new Map<number, Set<number>>();
  for (let k = 0; k < pairs.length; k++) {
    const body = bodyOf[pairs.a[k]];
    if (body < 0) continue;
    let columns = byBody.get(body);
    if (!columns) byBody.set(body, (columns = new Set()));
    columns.add(pairs.b[k]);
  }
  const counts = new Map<number, number>();
  for (const [body, columns] of byBody) {
    const list = [...columns];
    const index = new Map(list.map((c, k) => [c, k]));
    const groups = unionFind(list.length);
    list.forEach((c, k) => {
      const i = c % nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (i + di < 0 || i + di >= nx) continue;
          const other = index.get(c + di + dj * nx);
          if (other !== undefined) groups.join(k, other);
        }
      }
    });
    const sizes = new Map<number, number>();
    for (let k = 0; k < list.length; k++) sizes.set(groups.find(k), (sizes.get(groups.find(k)) ?? 0) + 1);
    counts.set(body, [...sizes.values()].filter((size) => size >= least).length);
  }
  return counts;
}

interface PocketInput {
  nFree: number;
  fLow: Float32Array;
  fHigh: Float32Array;
  fAbove: Int32Array;
  kind: Uint8Array;
  sealedOf: (a: number) => boolean;
  edges: PairList;
  freeStart: Uint32Array;
  columns: number;
  solidShell: Int32Array;
  xOf: (c: number) => number;
  yOf: (c: number) => number;
  cellArea: number;
}

/**
 * The merge tree of the free stretches with the model as their ceiling, highest ceiling first, as M4's
 * peaks are of the cover's. Stretches under the cover vent, as the openings reach them, so they are the
 * root. Where two pockets of air meet, the lower one dies, and so does one that reaches the root: its
 * persistence is how far its top stands over that meeting, and its volume is the air over that level.
 */
function undersidePockets(input: PocketInput): UndersidePocket[] {
  const { nFree, fLow, fHigh, fAbove, kind, sealedOf, edges, freeStart, columns, solidShell, xOf, yOf, cellArea } = input;
  // Adjacency of the stretches under the model, from the edges the overlap rule found.
  const degree = new Uint32Array(nFree + 1);
  for (let k = 0; k < edges.length; k++) {
    degree[edges.a[k] + 1]++;
    degree[edges.b[k] + 1]++;
  }
  for (let a = 0; a < nFree; a++) degree[a + 1] += degree[a];
  const neighbours = new Int32Array(degree[nFree]);
  const cursor = degree.slice(0, nFree);
  for (let k = 0; k < edges.length; k++) {
    neighbours[cursor[edges.a[k]]++] = edges.b[k];
    neighbours[cursor[edges.b[k]]++] = edges.a[k];
  }

  // Under the model and not sealed, by ceiling level from the top, in whole height steps.
  const levels = new Int32Array(nFree).fill(-1);
  let topLevel = 0, count = 0;
  for (let a = 0; a < nFree; a++) {
    if (kind[a] < UNDER || sealedOf(a)) continue;
    const level = Math.round(fHigh[a] / HEIGHT_STEP);
    levels[a] = level;
    if (level > topLevel) topLevel = level;
    count++;
  }
  const first = new Uint32Array(topLevel + 2);
  for (let a = 0; a < nFree; a++) if (levels[a] >= 0) first[topLevel - levels[a] + 1]++;
  for (let k = 1; k < first.length; k++) first[k] += first[k - 1];
  const order = new Uint32Array(count);
  for (let a = 0; a < nFree; a++) if (levels[a] >= 0) order[first[topLevel - levels[a]]++] = a;

  const columnOf = (a: number): number => {
    let low = 0, high = columns - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (freeStart[middle] <= a) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  // Basin 0 is the air that gets away. Others are pockets, with their highest stretch and members.
  const VENTED = 0;
  const parent: number[] = [VENTED];
  const peak: number[] = [-1];
  const head: number[] = [-1], tail: number[] = [-1];
  const next = new Int32Array(nFree).fill(-1);
  const basinOf = new Int32Array(nFree).fill(-1);
  const find = (b: number): number => {
    while (parent[b] !== b) {
      parent[b] = parent[parent[b]];
      b = parent[b];
    }
    return b;
  };
  const higher = (a: number, b: number): boolean => {
    if (a === VENTED) return true;
    if (b === VENTED) return false;
    return fHigh[peak[a]] > fHigh[peak[b]] || (fHigh[peak[a]] === fHigh[peak[b]] && peak[a] < peak[b]);
  };
  const found: UndersidePocket[] = [];
  const die = (loser: number, level: number, at: number): void => {
    const top = peak[loser];
    const steps = levels[top] - level;
    if (steps < 1) return;
    const saddle = fHigh[at];
    let volume = 0;
    for (let m = head[loser]; m >= 0; m = next[m]) volume += Math.max(0, fHigh[m] - Math.max(saddle, fLow[m]));
    const c = columnOf(top);
    found.push({ x: xOf(c), y: yOf(c), z: fHigh[top], saddle, persistence: steps * HEIGHT_STEP, volume: volume * cellArea, shell: fAbove[top] >= 0 ? solidShell[fAbove[top]] : -1 });
  };

  for (let k = 0; k < order.length; k++) {
    const a = order[k];
    const level = levels[a];
    let basin = -1;
    for (let e = degree[a]; e < degree[a + 1]; e++) {
      const b = neighbours[e];
      let other: number;
      if (kind[b] < UNDER) other = VENTED;
      else if (basinOf[b] >= 0) other = find(basinOf[b]);
      else continue;
      if (basin < 0) {
        basin = other;
      } else if (other !== basin) {
        const [winner, loser] = higher(basin, other) ? [basin, other] : [other, basin];
        die(loser, level, a);
        parent[loser] = winner;
        if (winner !== VENTED && head[loser] >= 0) {
          next[tail[winner]] = head[loser];
          tail[winner] = tail[loser];
        }
        basin = winner;
      }
    }
    if (basin < 0) {
      basin = parent.length;
      parent.push(basin);
      peak.push(a);
      head.push(-1);
      tail.push(-1);
    }
    basinOf[a] = basin;
    if (basin !== VENTED) {
      if (head[basin] < 0) head[basin] = a;
      else next[tail[basin]] = a;
      tail[basin] = a;
    }
  }
  return found.sort((a, b) => b.persistence - a.persistence || b.volume - a.volume);
}
