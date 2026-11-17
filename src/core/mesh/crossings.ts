import type { WeldedMesh } from './weld';

/**
 * The column scan the analyses and the repair share (RM): moved here from src/core/analysis/intervals.ts unchanged,
 * which re-exports it, as intervals.ts imports shells.ts and shells.ts needs it for its fold check (folds.ts).
 */

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
