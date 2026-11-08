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
