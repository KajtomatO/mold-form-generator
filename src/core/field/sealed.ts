import { analyseIntervals, type SealedDomain } from '../analysis/intervals';
import { connectedPieces } from '../mesh/shells';
import type { WeldedMesh } from '../mesh/weld';

export type { SealedDomain } from '../analysis/intervals';

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

/** One recess the plate closes off under the model, from its own triangles. */
export interface PlateSealedRecess {
  /** In mm3, exact for the mesh: the air between the recess's faces and the plane. */
  volume: number;
  /** Bounds in the mesh's own coordinates. */
  min: [number, number, number];
  max: [number, number, number];
}

export interface PlateSealedAir {
  /**
   * A closed surface with a winding number of 1 in every recess's air and 0 everywhere else above the
   * plane, or null when there is none. Below the plane it is 0 or 1. In the mesh's own coordinates.
   */
  surface: WeldedMesh | null;
  recesses: PlateSealedRecess[];
}

/** How far under the plane, in mm, the surface closes each recess, at a point straight below it. */
const APEX_DEPTH = 1;

/**
 * Air under the model that the plate closes off, such as Benchy's recessed lettering or an inverted cup,
 * exactly, from the mesh's topology. A closed mesh's faces, less those lying on the plane, fall into
 * pieces joined across edges that do not lie on it. The model's outer surface is one piece, and each
 * recess's walls and ceiling another, bounded only by edges on the plane. Measured about a point of the
 * plane, a recess's piece has a negative volume, minus its air, as its faces face into that air: that
 * is the test, and no column or cell is involved. Each such piece, turned inside out and closed by a fan
 * from its edges on the plane to a point under it, is a closed surface round the recess's air alone.
 *
 * `up` and `level` give each point's height over the plane, up . p + level, so this runs on the mesh in
 * the file's coordinates too; `planeTol` is how near the plane a vertex counts as on it, the tolerance
 * the base face itself was found with. A mesh with an open or non-manifold edge in a piece gets nothing
 * for that piece, so the caller falls back to what it did without this.
 */
export function plateSealedAir(mesh: WeldedMesh, up: readonly [number, number, number] = [0, 0, 1], level = 0, planeTol = 1e-4): PlateSealedAir {
  const { positions: p, indices } = mesh;
  const vertexCount = p.length / 3, triangleCount = indices.length / 3;
  const [ux, uy, uz] = up;
  const height = new Float64Array(vertexCount);
  const onPlane = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    height[v] = ux * p[v * 3] + uy * p[v * 3 + 1] + uz * p[v * 3 + 2] + level;
    if (Math.abs(height[v]) <= planeTol) onPlane[v] = 1;
  }

  // The triangles round each vertex, to find the ones across an edge without a map of every edge.
  const firstAt = new Uint32Array(vertexCount + 1);
  for (let k = 0; k < indices.length; k++) firstAt[indices[k] + 1]++;
  for (let v = 0; v < vertexCount; v++) firstAt[v + 1] += firstAt[v];
  const around = new Uint32Array(indices.length);
  const fill = firstAt.slice(0, vertexCount);
  for (let k = 0; k < indices.length; k++) around[fill[indices[k]]++] = (k / 3) | 0;

  const parent = new Int32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) parent[t] = t;
  const find = (t: number): number => {
    while (parent[t] !== t) {
      parent[t] = parent[parent[t]];
      t = parent[t];
    }
    return t;
  };
  const flat = (t: number): boolean => onPlane[indices[t * 3]] === 1 && onPlane[indices[t * 3 + 1]] === 1 && onPlane[indices[t * 3 + 2]] === 1;
  // A piece with an edge that is not shared by exactly two of its faces is no closed piece of a solid.
  const broken = new Uint8Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    if (flat(t)) continue;
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      if (onPlane[a] && onPlane[b]) continue;
      let others = 0;
      for (let k = firstAt[a]; k < firstAt[a + 1]; k++) {
        const o = around[k];
        if (o === t) continue;
        const i = o * 3;
        if (indices[i] !== b && indices[i + 1] !== b && indices[i + 2] !== b) continue;
        others++;
        const ra = find(t), rb = find(o);
        if (ra !== rb) parent[rb] = ra;
      }
      if (others !== 1) broken[t] = 1;
    }
  }

  // Volume about a point of the plane, where faces on the plane add nothing, and each piece's bounds.
  const qx = -level * ux, qy = -level * uy, qz = -level * uz;
  const volume = new Map<number, number>();
  const bad = new Set<number>();
  // A closed piece with no edge on the plane, such as a void shell, is the model's own and no recess.
  const touching = new Set<number>();
  for (let t = 0; t < triangleCount; t++) {
    if (flat(t)) continue;
    const root = find(t);
    const i = t * 3, a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    if (broken[t] || height[indices[i]] < -planeTol || height[indices[i + 1]] < -planeTol || height[indices[i + 2]] < -planeTol) bad.add(root);
    if (onPlane[indices[i]] + onPlane[indices[i + 1]] + onPlane[indices[i + 2]] >= 2) touching.add(root);
    const ax = p[a] - qx, ay = p[a + 1] - qy, az = p[a + 2] - qz;
    const bx = p[b] - qx, by = p[b + 1] - qy, bz = p[b + 2] - qz;
    const cx = p[c] - qx, cy = p[c + 1] - qy, cz = p[c + 2] - qz;
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    volume.set(root, (volume.get(root) ?? 0) + det / 6);
  }
  const sealed = new Set([...volume].filter(([root, v]) => v < 0 && touching.has(root) && !bad.has(root)).map(([root]) => root));
  if (sealed.size === 0) return { surface: null, recesses: [] };

  // Each recess's faces, inside out, and its edges on the plane, which the fan closes.
  const kept = new Map<number, { faces: number[]; edges: number[]; min: [number, number, number]; max: [number, number, number] }>();
  for (let t = 0; t < triangleCount; t++) {
    if (flat(t)) continue;
    const root = find(t);
    if (!sealed.has(root)) continue;
    let piece = kept.get(root);
    if (!piece) kept.set(root, (piece = { faces: [], edges: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    piece.faces.push(a, c, b);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) if (onPlane[u] && onPlane[v]) piece.edges.push(u, v);
    for (const v of [a, b, c]) {
      for (let axis = 0; axis < 3; axis++) {
        const x = p[v * 3 + axis];
        if (x < piece.min[axis]) piece.min[axis] = x;
        if (x > piece.max[axis]) piece.max[axis] = x;
      }
    }
  }
  // The surface's own vertices: those the recesses use, then one point under each.
  const remap = new Int32Array(vertexCount).fill(-1);
  const out: number[] = [];
  const own = (v: number): number => {
    if (remap[v] < 0) {
      remap[v] = out.length / 3;
      out.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
    }
    return remap[v];
  };
  const triangles: number[] = [];
  const recesses: PlateSealedRecess[] = [];
  for (const [root, piece] of kept) {
    for (const v of piece.faces) triangles.push(own(v));
    let sx = 0, sy = 0, sz = 0;
    for (const v of piece.edges) {
      sx += p[v * 3];
      sy += p[v * 3 + 1];
      sz += p[v * 3 + 2];
    }
    const n = piece.edges.length;
    const apex = out.length / 3;
    out.push(sx / n - (APEX_DEPTH + planeTol) * ux, sy / n - (APEX_DEPTH + planeTol) * uy, sz / n - (APEX_DEPTH + planeTol) * uz);
    // A face's edge u to v, which the inside-out face runs v to u, so the fan's face runs u to v.
    for (let k = 0; k < n; k += 2) triangles.push(own(piece.edges[k]), own(piece.edges[k + 1]), apex);
    recesses.push({ volume: -volume.get(root)!, min: piece.min, max: piece.max });
  }
  return { surface: { positions: Float32Array.from(out), indices: Uint32Array.from(triangles) }, recesses };
}

/**
 * Air the silicone cannot reach: free space with the base plate and the model all around it, such as an
 * inverted cup. These are S8's sealed domains, from the free intervals of each column joined where they
 * overlap by at least one cell, as the plan's interval rule says, so a side hole in that cup opens it.
 *
 * Pass exteriorMesh(mesh) to leave out the void shells that the model's volume already includes.
 * Domains under minVolume are dropped, because a thin wall read at this cell makes tiny phantoms.
 */
export function sealedDomains(mesh: WeldedMesh, cell: number, minVolume: number): SealedDomain[] {
  return analyseIntervals(mesh, cell).sealed.filter((domain) => domain.volume >= minVolume);
}
