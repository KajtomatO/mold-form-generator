import Delatin from 'delatin';
import type { Manifold } from 'manifold-3d';
import type { Field } from '../field/grid';
import type { Diagnostic } from '../report/diagnostics';
import { checked, type Arena } from './arena';
import type { Rect } from './rect';

/** Where nodes outside the cavity go, so the surface crosses z = 0 inside the rebate, never along it. */
export const TOOL_FLOOR = -1;
/** The closed bottom of the tool. The cross-parameter rules keep the ring inside the rebate here. */
export const TOOL_BOTTOM = -2;
/** The risk table's limit: past this a tool gets too heavy for booleans in the browser. */
export const TIN_TRIANGLE_LIMIT = 1_500_000;
/** A retry past the limit asks for this much more than the last run reached, so it can finish under the limit. */
const TOL_STEP = 1.25;

export interface ToolOptions {
  /** Added to nodes above 0, because the TIN may sit this far under them. It is not in the field. */
  raise: number;
  /** Largest vertical error of the TIN at any node. */
  tol: number;
  triangleLimit?: number;
  /**
   * The surface stays under z = 0 past this, so nodes within a cell of its edge stay on the floor. A
   * preview's coarser cell can reach past the export's bounds, and its tiles sit up to half a cell off
   * the export's (G6). Only a preview may pass this, so the
   * preview's cavity cannot cut through a rim placed from the export plan. On an export field this
   * must not bite, since it would take away clearance: see clippedNodes.
   */
  clip?: Rect;
}

export interface ToolMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** The rectangle of the z = -2 ring. */
  domain: Rect;
  /** Triangles of the height surface alone, without the walls and the bottom. */
  tinTriangles: number;
  /** The tolerance the TIN was held to, which is the one asked for unless the limit moved it. */
  tol: number;
  /** The vertical error it reached. */
  maxError: number;
  /** The raise really applied. It goes up from `options.raise` by as much as the tolerance did. */
  raise: number;
  clippedNodes: number;
  diagnostics: Diagnostic[];
}

/**
 * G7: the height surface as few triangles as the tolerance allows. Only nodes count, so the grid
 * outside the cavity is cropped first, keeping one ring on the floor to close against.
 */
export function buildToolMesh(field: Field, options: ToolOptions): ToolMesh {
  const { raise, triangleLimit = TIN_TRIANGLE_LIMIT, clip } = options;
  const { nx, ny, cell, x0, y0, values } = field;

  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, clippedNodes = 0;
  const inClip = (i: number, j: number): boolean => {
    if (!clip) return true;
    const x = x0 + i * cell, y = y0 + j * cell;
    return x - cell >= clip.x0 && x + cell <= clip.x1 && y - cell >= clip.y0 && y + cell <= clip.y1;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      if (values[n] <= 0) continue;
      if (!inClip(i, j)) {
        clippedNodes++;
        continue;
      }
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (i1 < 0) throw new Error('The field has no cavity to build a tool from.');
  i0 = Math.max(0, i0 - 1);
  j0 = Math.max(0, j0 - 1);
  i1 = Math.min(nx - 1, i1 + 1);
  j1 = Math.min(ny - 1, j1 + 1);
  const width = i1 - i0 + 1, height = j1 - j0 + 1;

  const data = new Float32Array(width * height);
  const fill = (lift: number): void => {
    for (let j = 0; j < height; j++) {
      const from = (j + j0) * nx + i0;
      for (let i = 0; i < width; i++) {
        const v = values[from + i];
        data[i + j * width] = v > 0 && inClip(i + i0, j + j0) ? v + lift : TOOL_FLOOR;
      }
    }
  };

  // Past the limit the tolerance gives way, with the raise going up by the same, so the surface still
  // clears the field. It has to be a new run, as the raise is part of what the TIN must follow.
  let tol = options.tol, lift = raise;
  let tin: Delatin;
  for (;;) {
    fill(lift);
    tin = new Delatin(data, width, height);
    // Same as tin.run(tol), with a stop: the triangle count is what fills memory.
    while (tin.getMaxError() > tol && tin.triangles.length / 3 < triangleLimit) tin.refine();
    if (tin.getMaxError() <= tol) break;
    const wider = tin.getMaxError() * TOL_STEP;
    lift += wider - tol;
    tol = wider;
  }
  const diagnostics: Diagnostic[] = [];
  if (tol > options.tol) {
    diagnostics.push({
      code: 'tin-limit',
      severity: 'warning',
      message: `The cavity surface passed the limit of ${triangleLimit} triangles, so its tolerance went from ${options.tol} to ${tol.toFixed(3)} mm and the cavity was raised by the difference to keep the clearance.`,
    });
  }

  const { coords, triangles } = tin;
  const vertexCount = coords.length / 2;
  const onBorder: number[] = [];
  const rank = (i: number, j: number): number => {
    // Distance along the border, counter-clockwise seen from above, starting at (0, 0).
    const w = width - 1, h = height - 1;
    if (j === 0) return i;
    if (i === w) return w + j;
    if (j === h) return w + h + (w - i);
    return 2 * w + h + (h - j);
  };
  for (let v = 0; v < vertexCount; v++) {
    const i = coords[v * 2], j = coords[v * 2 + 1];
    if (i === 0 || j === 0 || i === width - 1 || j === height - 1) onBorder.push(v);
  }
  onBorder.sort((a, b) => rank(coords[a * 2], coords[a * 2 + 1]) - rank(coords[b * 2], coords[b * 2 + 1]));

  // Top surface, then one copy of each border vertex on the bottom, then the bottom's centre.
  const total = vertexCount + onBorder.length + 1;
  const positions = new Float32Array(total * 3);
  const xAt = (i: number): number => x0 + (i + i0) * cell;
  const yAt = (j: number): number => y0 + (j + j0) * cell;
  for (let v = 0; v < vertexCount; v++) {
    const i = coords[v * 2], j = coords[v * 2 + 1];
    const z = data[i + j * width];
    positions[v * 3] = xAt(i);
    positions[v * 3 + 1] = yAt(j);
    positions[v * 3 + 2] = z;
  }
  onBorder.forEach((v, k) => {
    const at = (vertexCount + k) * 3;
    positions[at] = positions[v * 3];
    positions[at + 1] = positions[v * 3 + 1];
    positions[at + 2] = TOOL_BOTTOM;
  });
  const centre = total - 1;
  positions[centre * 3] = xAt((width - 1) / 2);
  positions[centre * 3 + 1] = yAt((height - 1) / 2);
  positions[centre * 3 + 2] = TOOL_BOTTOM;

  const tinTriangles = triangles.length / 3;
  const indices = new Uint32Array((tinTriangles + onBorder.length * 3) * 3);
  // Delatin winds clockwise in x and y, so the corners are swapped for normals pointing up.
  for (let t = 0; t < tinTriangles; t++) {
    indices[t * 3] = triangles[t * 3];
    indices[t * 3 + 1] = triangles[t * 3 + 2];
    indices[t * 3 + 2] = triangles[t * 3 + 1];
  }
  let at = tinTriangles * 3;
  for (let k = 0; k < onBorder.length; k++) {
    const next = (k + 1) % onBorder.length;
    const a = onBorder[k], b = onBorder[next];
    const a2 = vertexCount + k, b2 = vertexCount + next;
    indices[at++] = a;
    indices[at++] = a2;
    indices[at++] = b2;
    indices[at++] = a;
    indices[at++] = b2;
    indices[at++] = b;
    indices[at++] = centre;
    indices[at++] = b2;
    indices[at++] = a2;
  }

  return { positions, indices, domain: { x0: xAt(0), y0: yAt(0), x1: xAt(width - 1), y1: yAt(height - 1) }, tinTriangles, tol, maxError: tin.getMaxError(), raise: lift, clippedNodes, diagnostics };
}

/** The closed solid. A bad one here would quietly cut a wrong cavity, so it is checked rather than trusted. */
export function toolSolid(arena: Arena, mesh: ToolMesh): Manifold {
  const solid = checked(arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices })), 'The cavity tool');
  if (!(solid.volume() > 0)) throw new Error(`The cavity tool has volume ${solid.volume()}.`);
  return solid;
}
