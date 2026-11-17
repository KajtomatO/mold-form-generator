import type { Mesh } from 'manifold-3d';
import { pointTriangleDistance2 } from '../../src/core/mesh/deviation';
import { windingNumber } from '../../src/core/mesh/shells';
import type { WeldedMesh } from '../../src/core/mesh/weld';

/**
 * RM: brute-force checks of the mesh repair's figures, for small fixtures only. Every distance is to every triangle,
 * and inside is the generalised winding number, so nothing of the code under test is used.
 */

/** The distance from a point to a mesh's nearest triangle, the slow way. */
export function bruteDistance(mesh: WeldedMesh, x: number, y: number, z: number): number {
  let best = Infinity;
  const P = mesh.positions, I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) best = Math.min(best, pointTriangleDistance2(x, y, z, P, I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3));
  return Math.sqrt(best);
}

/** Whether a point lies inside a closed mesh wound outwards, by its generalised winding number. */
export function bruteInside(mesh: WeldedMesh, x: number, y: number, z: number): boolean {
  const asMesh = { numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices } as unknown as Mesh;
  return windingNumber(asMesh, x, y, z) > 0.5;
}

/** A grid of barycentric points on each listed triangle, `steps` to an edge, corners included: [x, y, z, triangle]. */
export function denseSamples(mesh: WeldedMesh, triangles: ArrayLike<number>, steps: number): number[][] {
  const P = mesh.positions, I = mesh.indices;
  const out: number[][] = [];
  for (let k = 0; k < triangles.length; k++) {
    const t = triangles[k];
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        out.push([w * P[a] + u * P[b] + v * P[c], w * P[a + 1] + u * P[b + 1] + v * P[c + 1], w * P[a + 2] + u * P[b + 2] + v * P[c + 2], t]);
      }
    }
  }
  return out;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The squared distance between two segments (Ericson 5.1.9). */
function segmentDistance2(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  let s: number, t: number;
  if (a <= 1e-18 && e <= 1e-18) return dot(r, r);
  if (a <= 1e-18) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-18) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const x = sub([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]);
  return dot(x, x);
}

/** Whether segment pq meets triangle abc, ends included (Moller and Trumbore). */
function segmentHits(p: V3, q: V3, a: V3, b: V3, c: V3): boolean {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a);
  const h: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-14) return false;
  const s = sub(p, a), u = dot(s, h) / det;
  if (u < 0 || u > 1) return false;
  const k: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = dot(d, k) / det;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, k) / det;
  return t >= 0 && t <= 1;
}

/** The least distance between two triangles, exactly: 0 where they meet. */
export function triangleDistance(a: V3[], b: V3[]): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    if (segmentHits(a[i], a[(i + 1) % 3], b[0], b[1], b[2]) || segmentHits(b[i], b[(i + 1) % 3], a[0], a[1], a[2])) return 0;
    for (let j = 0; j < 3; j++) best = Math.min(best, segmentDistance2(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3]));
    best = Math.min(best, pointTriangleDistance2(a[i][0], a[i][1], a[i][2], b.flat(), 0, 3, 6), pointTriangleDistance2(b[i][0], b[i][1], b[i][2], a.flat(), 0, 3, 6));
  }
  return Math.sqrt(best);
}

/** The least distance between two meshes' surfaces, every pair of triangles. */
export function bruteGap(A: WeldedMesh, B: WeldedMesh): number {
  const tri = (m: WeldedMesh, t: number): V3[] => [0, 1, 2].map((c) => Array.from(m.positions.subarray(m.indices[t * 3 + c] * 3, m.indices[t * 3 + c] * 3 + 3)) as V3);
  let best = Infinity;
  for (let s = 0; s < A.indices.length / 3; s++) for (let t = 0; t < B.indices.length / 3; t++) best = Math.min(best, triangleDistance(tri(A, s), tri(B, t)));
  return best;
}
