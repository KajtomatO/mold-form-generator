import type { WeldedMesh } from './weld';

/** A smaller hole lowers a ceiling dilated by about 3 mm by well under 0.1 mm, so warning is noise. */
export const MISSING_SURFACE_MM2 = 1;

/** A hole in the surface: a closed run of open edges. */
export interface OpenLoop {
  edgeCount: number;
  /** Area of the flat cap that would close the hole. */
  area: number;
  /** Outward normal of that missing cap. A cap facing up means a missing top surface. */
  capNormal: [number, number, number];
  /** The rim's vertices, in order around the hole. */
  vertices: Uint32Array;
}

export interface MeshAudit {
  triangleCount: number;
  vertexCount: number;
  edgeCount: number;
  /** Edges used by one triangle. */
  openEdges: number;
  /** Edges used by more than two triangles. Manifold accepts these when they pair up. */
  nonManifoldEdges: number;
  /** Edges used by two triangles running the same way. */
  misorientedEdges: number;
  openLoops: OpenLoop[];
  /** Summed area of the missing caps. */
  openArea: number;
}

/** Walks the open half-edges into loops. An open end at a non-manifold vertex still gets a loop. */
function traceLoops(open: Map<number, number[]>, positions: Float32Array): OpenLoop[] {
  const loops: OpenLoop[] = [];
  for (const [first, targets] of open) {
    while (targets.length > 0) {
      let nx = 0, ny = 0, nz = 0, edgeCount = 0;
      const vertices: number[] = [];
      let a = first;
      for (;;) {
        const next = open.get(a)?.pop();
        if (next === undefined) break;
        vertices.push(a);
        const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
        const bx = positions[next * 3], by = positions[next * 3 + 1], bz = positions[next * 3 + 2];
        nx += ay * bz - az * by;
        ny += az * bx - ax * bz;
        nz += ax * by - ay * bx;
        edgeCount++;
        a = next;
        if (a === first) break;
      }
      const length = Math.hypot(nx, ny, nz);
      // A cap closing the hole runs along each open edge the other way, hence the minus signs.
      const capNormal: OpenLoop['capNormal'] = length > 0 ? [-nx / length, -ny / length, -nz / length] : [0, 0, 0];
      loops.push({ edgeCount, area: length / 2, capNormal, vertices: Uint32Array.from(vertices) });
    }
  }
  return loops;
}

/**
 * Counts edge defects. It reports only: whether a mesh is usable is decided by Manifold itself,
 * which accepts the barrel's 12 four-triangle edges because their directions pair up.
 */
export function auditEdges(mesh: WeldedMesh): MeshAudit {
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const vertexCount = positions.length / 3;

  // Each half-edge becomes one sortable number: the undirected edge, doubled, plus a direction
  // bit. Float64 holds this exactly up to about 67M vertices.
  const keys = new Float64Array(indices.length);
  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) {
      const a = indices[t * 3 + c];
      const b = indices[t * 3 + ((c + 1) % 3)];
      keys[t * 3 + c] = a < b ? (a * vertexCount + b) * 2 : (b * vertexCount + a) * 2 + 1;
    }
  }
  keys.sort();

  let edgeCount = 0, openEdges = 0, nonManifoldEdges = 0, misorientedEdges = 0;
  const open = new Map<number, number[]>();
  for (let i = 0; i < keys.length; ) {
    const edge = Math.floor(keys[i] / 2);
    let forward = 0, backward = 0;
    while (i < keys.length && Math.floor(keys[i] / 2) === edge) {
      if (keys[i] % 2 === 0) forward++;
      else backward++;
      i++;
    }
    edgeCount++;
    const uses = forward + backward;
    if (uses > 2) nonManifoldEdges++;
    else if (uses === 2 && forward !== backward) misorientedEdges++;
    else if (uses === 1) {
      openEdges++;
      const low = Math.floor(edge / vertexCount);
      const high = edge - low * vertexCount;
      const from = forward === 1 ? low : high;
      const to = forward === 1 ? high : low;
      const targets = open.get(from);
      if (targets) targets.push(to);
      else open.set(from, [to]);
    }
  }

  const openLoops = traceLoops(open, positions);
  const openArea = openLoops.reduce((sum, loop) => sum + loop.area, 0);
  return { triangleCount, vertexCount, edgeCount, openEdges, nonManifoldEdges, misorientedEdges, openLoops, openArea };
}
