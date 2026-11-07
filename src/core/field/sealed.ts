import { connectedPieces } from '../mesh/shells';
import { meshBounds, type WeldedMesh } from '../mesh/weld';

export interface SealedDomain {
  /** In mm3. */
  volume: number;
  /** Footprint in mm2. */
  area: number;
  min: [number, number, number];
  max: [number, number, number];
  /** It starts at the base plane, so the base plate is one of its walls, like an inverted cup. */
  onPlane: boolean;
}

/** The mesh without its void shells, which are inside the model's exterior volume already. */
export function exteriorMesh(mesh: WeldedMesh): WeldedMesh {
  const pieces = connectedPieces(mesh);
  if (!pieces.some((piece) => piece.kind === 'void')) return mesh;
  const kept: number[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'void') continue;
    for (const t of piece.triangles) kept.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(kept) };
}

/** Separate bodies in the mesh: each needs its own pour, so a void shell does not count as one. */
export function countBodies(mesh: WeldedMesh): number {
  return connectedPieces(mesh).filter((piece) => piece.kind !== 'void').length;
}

/** Walks every column a triangle's projection covers, at most once per triangle and column. */
function forEachCrossing(mesh: WeldedMesh, nx: number, ny: number, cell: number, x0: number, y0: number, visit: (column: number, z: number, sign: number) => void): void {
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
        visit(i + j * nx, (w1 * az + w2 * bz + w0 * cz) / area, sign);
      }
    }
  }
}

/**
 * Air the silicone cannot reach: free space with the base plate and the model all around it, such
 * as an inverted cup. M2's method is the simplest that sees a side hole in that cup: per column, the
 * free intervals between sorted surface crossings, joined to the neighbouring columns where they
 * overlap by at least one cell, as the plan's interval rule says. A joined group that holds no
 * column's open top is sealed. M7 builds its fuller analysis over these same intervals.
 *
 * Pass exteriorMesh(mesh) to leave out the void shells that the model's volume already includes.
 * Groups under minVolume are dropped, because a thin wall read at this cell makes tiny phantoms.
 */
export function sealedDomains(mesh: WeldedMesh, cell: number, minVolume: number): SealedDomain[] {
  const { min, max } = meshBounds(mesh.positions);
  // One column past the model on every side, so a hole running out through a side has open air to
  // join. Those columns are all open top.
  const nx = Math.ceil((max[0] - min[0]) / cell) + 2;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 2;
  const x0 = min[0] - cell / 2;
  const y0 = min[1] - cell / 2;
  const columns = nx * ny;

  const start = new Uint32Array(columns + 1);
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (column) => void start[column + 1]++);
  for (let c = 0; c < columns; c++) start[c + 1] += start[c];
  const zs = new Float32Array(start[columns]);
  const signs = new Int8Array(start[columns]);
  const fill = start.slice(0, columns);
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (column, z, sign) => {
    let at = fill[column]++;
    // Insertion sort: a column has few crossings.
    while (at > start[column] && zs[at - 1] > z) {
      zs[at] = zs[at - 1];
      signs[at] = signs[at - 1];
      at--;
    }
    zs[at] = z;
    signs[at] = sign;
  });

  // Free intervals, lowest first within a column.
  const intervalStart = new Uint32Array(columns + 1);
  const capacity = start[columns] + columns;
  const low = new Float32Array(capacity);
  const high = new Float32Array(capacity);
  let intervals = 0;
  for (let c = 0; c < columns; c++) {
    intervalStart[c] = intervals;
    let winding = 0, floor = 0;
    for (let k = start[c]; k < start[c + 1]; k++) {
      const z = zs[k];
      const before = winding;
      winding += signs[k];
      if (z <= 0) continue;
      // Thinner than the overlap rule can ever connect, and so also too thin to matter.
      if (before <= 0 && winding > 0) {
        if (z - floor >= cell) {
          low[intervals] = floor;
          high[intervals++] = z;
        }
      } else if (before > 0 && winding <= 0) {
        floor = z;
      }
    }
    // Open to the sky. An open mesh can end with the count still up, and its column stays open too,
    // so air beside a hole counts as reachable.
    low[intervals] = floor;
    high[intervals++] = Infinity;
  }
  intervalStart[columns] = intervals;

  const parent = new Int32Array(intervals);
  for (let a = 0; a < intervals; a++) parent[a] = a;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const connect = (c: number, d: number): void => {
    let a = intervalStart[c], b = intervalStart[d];
    const aEnd = intervalStart[c + 1], bEnd = intervalStart[d + 1];
    while (a < aEnd && b < bEnd) {
      if (Math.min(high[a], high[b]) - Math.max(low[a], low[b]) >= cell) parent[find(a)] = find(b);
      if (high[a] < high[b]) a++;
      else b++;
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = i + j * nx;
      if (i + 1 < nx) connect(c, c + 1);
      if (j + 1 < ny) connect(c, c + nx);
    }
  }

  // Each column's last interval is its open top.
  const open = new Uint8Array(intervals);
  for (let c = 0; c < columns; c++) open[find(intervalStart[c + 1] - 1)] = 1;

  const found = new Map<number, SealedDomain>();
  const cellArea = cell * cell;
  for (let c = 0; c < columns; c++) {
    for (let a = intervalStart[c]; a < intervalStart[c + 1] - 1; a++) {
      const root = find(a);
      if (open[root]) continue;
      const x = x0 + (c % nx) * cell, y = y0 + Math.floor(c / nx) * cell;
      let domain = found.get(root);
      if (!domain) found.set(root, (domain = { volume: 0, area: 0, min: [x, y, low[a]], max: [x, y, high[a]], onPlane: false }));
      domain.volume += (high[a] - low[a]) * cellArea;
      domain.area += cellArea;
      domain.min = [Math.min(domain.min[0], x), Math.min(domain.min[1], y), Math.min(domain.min[2], low[a])];
      domain.max = [Math.max(domain.max[0], x), Math.max(domain.max[1], y), Math.max(domain.max[2], high[a])];
      if (low[a] === 0) domain.onPlane = true;
    }
  }
  return [...found.values()].filter((domain) => domain.volume >= minVolume).sort((a, b) => b.volume - a.volume);
}
