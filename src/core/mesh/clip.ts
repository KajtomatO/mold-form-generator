import { weld, type WeldedMesh } from './weld';

/** A mesh cut at the base plane, and how many of the input's triangles the cut took away or cut (0: none lay below). */
export interface ClippedMesh extends WeldedMesh {
  cut: number;
}

/**
 * RM, decision C: an open file cut at the base plane z = 0 triangle by triangle, for model_oriented.stl of a repaired
 * model whose file reaches below the plane (a fin or a fold the copy left out, or a part a trim of the copy cuts).
 * The file was open already, so a cut left open is no worse, and a slicer closes it on the first layer as it does the
 * file's other holes. No Manifold: whole triangles above are kept in order, those below go, and one that crosses is
 * cut into one or two along the plane (Sutherland and Hodgman). Each cut point is worked out from its edge's two
 * vertices in one order, the lower index first, so the triangles on either side of the edge share it bit for bit
 * and the cut adds no crack; a corner within `tolerance` of the plane is taken as on it, so faces lying in the plane
 * stay whole, not cut into slivers by the float noise of turning the model. The output is counted first and written
 * into one array of its size (RM's review: a growing list of numbers took 0.6 GB for 3 million triangles).
 */
export function clipBelow(mesh: WeldedMesh, tolerance = 0.001): ClippedMesh {
  const P = mesh.positions, I = mesh.indices;
  const z = (v: number): number => (Math.abs(P[v * 3 + 2]) < tolerance ? 0 : P[v * 3 + 2]);
  const corners = [0, 0, 0];
  // The part at z >= 0 of triangle t, its corners in the triangle's own order: kept corners as vertex indices, cuts
  // as -1 - edge. Its length, or 3 for a triangle wholly above and 0 for one wholly below.
  const poly: number[] = [];
  const part = (t: number): number => {
    corners[0] = I[t];
    corners[1] = I[t + 1];
    corners[2] = I[t + 2];
    let below = 0;
    for (const v of corners) if (z(v) < 0) below++;
    poly.length = 0;
    if (below === 0 || below === 3) return 3 - below;
    for (let k = 0; k < 3; k++) {
      const p = corners[k], q = corners[(k + 1) % 3];
      const zp = z(p), zq = z(q);
      if (zp >= 0) poly.push(p);
      // A corner on the plane needs no cut: the edge meets the plane there.
      if ((zp > 0 && zq < 0) || (zp < 0 && zq > 0)) poly.push(-1 - k);
    }
    return poly.length;
  };
  let floats = 0, cut = 0;
  for (let t = 0; t < I.length; t += 3) {
    const n = part(t);
    if (n !== 3 || poly.length > 0) cut++;
    if (n >= 3) floats += (n - 2) * 9;
  }
  const out = new Float32Array(floats);
  let w = 0;
  const push = (v: number): void => {
    out[w++] = P[v * 3];
    out[w++] = P[v * 3 + 1];
    out[w++] = z(v);
  };
  const cutAt = (a: number, b: number): void => {
    const za = z(a), zb = z(b);
    const f = za / (za - zb);
    out[w++] = P[a * 3] + f * (P[b * 3] - P[a * 3]);
    out[w++] = P[a * 3 + 1] + f * (P[b * 3 + 1] - P[a * 3 + 1]);
    out[w++] = 0;
  };
  const emit = (item: number): void => {
    if (item >= 0) return push(item);
    const k = -1 - item, p = corners[k], q = corners[(k + 1) % 3];
    if (p < q) cutAt(p, q);
    else cutAt(q, p);
  };
  for (let t = 0; t < I.length; t += 3) {
    const n = part(t);
    if (n === 0) continue;
    if (poly.length === 0) {
      for (const v of corners) push(v);
      continue;
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      emit(poly[0]);
      emit(poly[k]);
      emit(poly[k + 1]);
    }
  }
  return { ...weld(out), cut };
}
