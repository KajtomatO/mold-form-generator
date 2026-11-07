import { conditionField } from '../field/build';
import { dilate } from '../field/dilate';
import { planField, type Field, type FieldPlan, type FieldSettings } from '../field/grid';
import { rasterize } from '../field/raster';
import { connectedPieces, type MeshPiece } from '../mesh/shells';
import type { WeldedMesh } from '../mesh/weld';
import { mergeTree, significantLeaves, type Leaf, type MergeTree } from './peaks';
import { findPlateau, flatPole, withinPlateauDrop, type Plateau } from './plateaus';

/**
 * Under this much surface in mm2, a loose piece is a crumb, whatever it looks like. It is about a 1 mm
 * cube, which no mold would be made around.
 */
const FRAGMENT_MM2 = 5;
/** A node this far under the ceiling of the whole model has another body's ceiling over it, in mm. */
export const BURIED = 0.05;

/**
 * A leaf of a body, which may have moved to the part of its flat top that reaches the ceiling, and then
 * to the middle of the nodes there that share its height.
 */
export interface BodyLeaf extends Leaf {
  /** Its index in the body's tree.leaves, which leavesCovered answers in. */
  index: number;
}

/** One body's own view of the ceiling, as if the others were not there. */
export interface Body {
  /** Its own conditioned field. On a one-body model this is the tile field itself. */
  field: Field;
  tree: MergeTree;
  /** The peaks that need air let out: over the persistence limit and not under another body. Highest first. */
  leaves: BodyLeaf[];
  plateau: Plateau | null;
  /** G11's spread: where the body stands on the base, and the shorter side of that. */
  centroid: [number, number];
  extent: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface Fragment {
  reason: 'tiny' | 'buried';
  /** Surface in mm2. */
  area: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface BodySearch {
  bodies: Body[];
  fragments: Fragment[];
}

function surfaceArea(mesh: WeldedMesh, triangles: readonly number[]): number {
  const { positions: p, indices } = mesh;
  let sum = 0;
  for (const t of triangles) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return sum / 2;
}

/**
 * Centre and shorter side of the area the piece stands on, from its triangles within `planeTol` of the
 * plane. A piece with none, such as an open mesh with no underside, falls back to its top view, from the
 * faces looking up. Neither needs a solid.
 */
function standing(mesh: WeldedMesh, piece: MeshPiece, planeTol: number): { centroid: [number, number]; extent: number } {
  const { positions: p, indices } = mesh;
  const gather = (use: (az: number, bz: number, cz: number, doubled: number) => boolean): { centroid: [number, number]; extent: number } | null => {
    let area = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of piece.triangles) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const doubled = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      if (!use(p[a + 2], p[b + 2], p[c + 2], doubled)) continue;
      const weight = Math.abs(doubled) / 2;
      area += weight;
      sx += (weight * (p[a] + p[b] + p[c])) / 3;
      sy += (weight * (p[a + 1] + p[b + 1] + p[c + 1])) / 3;
      x0 = Math.min(x0, p[a], p[b], p[c]);
      x1 = Math.max(x1, p[a], p[b], p[c]);
      y0 = Math.min(y0, p[a + 1], p[b + 1], p[c + 1]);
      y1 = Math.max(y1, p[a + 1], p[b + 1], p[c + 1]);
    }
    return area > 0 ? { centroid: [sx / area, sy / area], extent: Math.min(x1 - x0, y1 - y0) } : null;
  };
  return (
    gather((az, bz, cz) => az <= planeTol && bz <= planeTol && cz <= planeTol) ??
    gather((_a, _b, _c, doubled) => doubled > 0) ?? { centroid: [(piece.min[0] + piece.max[0]) / 2, (piece.min[1] + piece.max[1]) / 2], extent: Math.min(piece.max[0] - piece.min[0], piece.max[1] - piece.min[1]) }
  );
}

/**
 * The leaves of a piece that reach the ceiling of the whole model. Its highest nodes may be under
 * another body's, while the rest of the same flat top is in the open, so each leaf moves to its highest
 * node at the ceiling, and it is gone if none within a plateau's drop of its peak is. Lower nodes do not
 * count: the flank of a piece under another's top sticks out of that wall, but holds no air.
 */
function leavesAtCeiling(tree: MergeTree, field: Field, open: (n: number) => boolean, candidates: readonly BodyLeaf[]): BodyLeaf[] {
  const wanted = new Set(candidates.map((leaf) => leaf.index));
  const best = new Map<number, number>();
  const { nx, cell, values } = field;
  for (let n = 0; n < values.length; n++) {
    const v = values[n];
    if (v <= 0 || !open(n)) continue;
    for (let basin = tree.basins[n]; basin >= 0; basin = tree.basinParents[basin]) {
      const index = tree.basinLeaves[basin];
      if (index < 0 || !wanted.has(index)) continue;
      if (withinPlateauDrop(tree.leaves[index].height, v)) {
        const known = best.get(index);
        if (known === undefined || v > values[known]) best.set(index, n);
      }
      // The nearest kept leaf is the one this node belongs to.
      break;
    }
  }
  const found: BodyLeaf[] = [];
  for (const leaf of candidates) {
    const node = best.get(leaf.index);
    if (node === undefined) continue;
    const i = node % nx, j = (node - i) / nx;
    found.push({ ...leaf, node, x: field.x0 + i * cell, y: field.y0 + j * cell, height: values[node] });
  }
  return found;
}

/** Per node of a body's field: whether the ceiling of the whole model there is this body's own. */
function ownCeiling(field: Field, tile: Field): (n: number) => boolean {
  if (field === tile) return () => true;
  const { nx, cell, values } = field;
  const shiftI = Math.round((field.x0 - tile.x0) / cell), shiftJ = Math.round((field.y0 - tile.y0) / cell);
  return (n) => {
    const i = n % nx, j = (n - i) / nx;
    return tile.values[i + shiftI + (j + shiftJ) * tile.nx] - values[n] <= BURIED;
  };
}

/**
 * A flat face of the model dilates to nodes of exactly one height, and the sweep breaks that tie by
 * node index, which puts a leaf on the first corner of its flat, where an opening's disc hangs off it.
 * So a leaf moves to the pole of the flat it is on, as the plateau rule does with a larger flat. Only
 * nodes at the body's own ceiling count, as a part under another body's is not this body's top.
 */
function centredOnFlat(field: Field, leaf: BodyLeaf, open: (n: number) => boolean): BodyLeaf {
  const { nx, values } = field;
  const height = values[leaf.node];
  const nodes = [leaf.node];
  const seen = new Set(nodes);
  // The field's outer ring is empty, so a flat never reaches it and every node here has 4 neighbours.
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    for (const m of [n - 1, n + 1, n - nx, n + nx]) {
      if (seen.has(m) || values[m] !== height || !open(m)) continue;
      seen.add(m);
      nodes.push(m);
    }
  }
  if (nodes.length === 1) return leaf;
  const { node, x, y } = flatPole(field, nodes);
  return { ...leaf, node, x, y };
}

export interface BodyOptions {
  /** Plan: `vent.persistence`, t / 2 unless edited. */
  ventPersistence: number;
  planeTol: number;
}

/**
 * The bodies of a model, each with its own peaks. A body gets its own pour, so this looks at each one
 * alone: x8 forms 2 cavities, but each of its 8 barriers has a highest point of its own.
 *
 * Never from mesh genus. Connected pieces of the mesh are candidates, and three kinds are not bodies:
 *  - voids, whose surface faces into the solid around them;
 *  - pieces under about 5 mm2 of surface, as crumbs from a broken file;
 *  - pieces with no peak of their own at the ceiling, as nothing about them needs a pour, and a pour
 *    there would only open another body's ceiling. With its base removed, Benchy's sealed letters come
 *    apart as 8 such pieces, and they sit under the hull.
 * `tile` is the conditioned field of one tile, on the plan's lattice. Other pieces go on the same lattice.
 */
export function findBodies(mesh: WeldedMesh, plan: FieldPlan, tile: Field, settings: FieldSettings, options: BodyOptions): BodySearch {
  const pieces = connectedPieces(mesh).filter((piece) => piece.kind !== 'void');
  const bodies: Body[] = [];
  const fragments: Fragment[] = [];
  for (const piece of pieces) {
    const area = surfaceArea(mesh, piece.triangles);
    const about = { area, min: piece.min, max: piece.max };
    if (area < FRAGMENT_MM2 && pieces.length > 1) {
      fragments.push({ reason: 'tiny', ...about });
      continue;
    }
    let field = tile;
    if (pieces.length > 1) {
      const own = planField({ min: piece.min, max: piece.max }, { ...settings, cell: plan.cell, nx: 1, ny: 1 });
      const triangles = new Uint32Array(piece.triangles.length * 3);
      piece.triangles.forEach((t, k) => triangles.set(mesh.indices.subarray(t * 3, t * 3 + 3), k * 3));
      field = conditionField(dilate(rasterize({ positions: mesh.positions, indices: triangles }, own.tile), plan.rEff), settings).field;
    }
    const tree = mergeTree(field);
    const open = ownCeiling(field, tile);
    const significant = significantLeaves(tree, options.ventPersistence).map((leaf): BodyLeaf => ({ ...leaf, index: tree.leaves.indexOf(leaf) }));
    const leaves = (pieces.length > 1 ? leavesAtCeiling(tree, field, open, significant) : significant).map((leaf) => centredOnFlat(field, leaf, open));
    if (leaves.length === 0) {
      fragments.push({ reason: 'buried', ...about });
      continue;
    }
    bodies.push({ field, tree, leaves, plateau: findPlateau(field, leaves[0].height), ...standing(mesh, piece, options.planeTol), min: piece.min, max: piece.max });
  }
  return { bodies, fragments };
}
