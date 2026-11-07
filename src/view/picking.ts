import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { PartGeometry } from './scene';

/**
 * Click-to-pick on the model as the pipeline holds it. The viewport may draw a lighter proxy (G1.8),
 * but a pick must name a triangle of the real mesh, so the BVH is built over that, once, the first
 * time it is needed. `indirect` leaves the index buffer in its order, so a hit's faceIndex is the
 * triangle's own index.
 */
export class Picker {
  private mesh: PartGeometry | null = null;
  private bvh: MeshBVH | null = null;

  setMesh(mesh: PartGeometry | null): void {
    if (mesh === this.mesh) return;
    this.mesh = mesh;
    this.bvh?.geometry.dispose();
    this.bvh = null;
  }

  /** The triangle a ray in the model's own coordinates hits first, or null. */
  pick(ray: THREE.Ray): number | null {
    if (!this.mesh) return null;
    if (!this.bvh) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(this.mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(this.mesh.indices, 1));
      this.bvh = new MeshBVH(geometry, { indirect: true });
    }
    const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
    return hit?.faceIndex ?? null;
  }
}

/**
 * Triangles of a mesh lying on the plane of one of them, within a tolerance: G2's membership by
 * vertex distance, so disconnected faces such as two feet count together. Only triangles facing the
 * same way are kept, so a thin wall's far side is not taken with it.
 */
export function coplanarTriangles(mesh: PartGeometry, triangle: number, tolerance: number): Uint32Array {
  const { positions: p, indices } = mesh;
  const corner = (t: number, c: number): THREE.Vector3 => {
    const v = indices[t * 3 + c] * 3;
    return new THREE.Vector3(p[v], p[v + 1], p[v + 2]);
  };
  const a = corner(triangle, 0), b = corner(triangle, 1), c = corner(triangle, 2);
  const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const offset = normal.dot(a);
  const found: number[] = [];
  const count = indices.length / 3;
  for (let t = 0; t < count; t++) {
    let on = true;
    for (let k = 0; k < 3 && on; k++) {
      const v = indices[t * 3 + k] * 3;
      on = Math.abs(normal.x * p[v] + normal.y * p[v + 1] + normal.z * p[v + 2] - offset) <= tolerance;
    }
    if (!on) continue;
    const n = new THREE.Vector3().subVectors(corner(t, 1), corner(t, 0)).cross(new THREE.Vector3().subVectors(corner(t, 2), corner(t, 0)));
    if (n.dot(normal) > 0) found.push(t);
  }
  return Uint32Array.from(found);
}
