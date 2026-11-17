import { describe, expect, it } from 'vitest';
import { vote, type Columns } from '../../src/core/mesh/columns';
import type { Lattice } from '../../src/core/mesh/marching';

/**
 * RM, rung B: the columns' vote on a lattice of 5 x 5 x 5 nodes a millimetre apart, with columns made by hand, so each
 * rule of the vote is held on its own (RM's review found none of them pinned): a node with no axis to vote takes its
 * neighbours' majority, round after round; so does one whose two voting axes split, rather than going inside; and a
 * change of inside exactly at a node's height counts as above it, as the marching's f > 0 does.
 */
const LAT: Lattice = { h: 1, o: [0, 0, 0], n: [5, 5, 5] };
const IN = 0x40;
const node = (x: number, y: number, z: number): number => x + y * 5 + z * 25;

/** The columns along `axis`: `spec` gives a column's changes of inside by its node coordinates, or null where it does not vote. */
function columns(axis: number, spec: (at: [number, number, number]) => number[] | null): Columns {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const nu = LAT.n[u], nv = LAT.n[v];
  const starts = new Int32Array(nu * nv + 1), reliable = new Uint8Array(nu * nv);
  const heights: number[] = [];
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const c = iu + iv * nu;
      const at: [number, number, number] = [0, 0, 0];
      at[u] = iu;
      at[v] = iv;
      starts[c] = heights.length;
      const changes = spec(at);
      if (changes) {
        reliable[c] = 1;
        heights.push(...changes);
      }
    }
  }
  starts[nu * nv] = heights.length;
  return { axis, nu, nv, starts, heights: Float64Array.from(heights), reliable, crossings: heights.length, unbalanced: reliable.length - reliable.reduce((s, r) => s + r, 0) };
}

/** A cube of nodes 1 to 3 inside on every axis, but the columns `off` names, which do not vote. */
function cube(off: (axis: number, at: [number, number, number]) => boolean): Columns[] {
  return [0, 1, 2].map((axis) => columns(axis, (at) => {
    if (off(axis, at)) return null;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    return at[u] >= 1 && at[u] <= 3 && at[v] >= 1 && at[v] <= 3 ? [0.5, 3.5] : [];
  }));
}

describe('RM: the columns\' vote', () => {
  it('a node no axis votes for takes its neighbours\' majority: the middle of a cube whose three columns through it do not vote is inside', () => {
    const through = (axis: number, at: [number, number, number]): boolean => [0, 1, 2].every((a) => a === axis || at[a] === 2);
    const result = vote(LAT, cube(through));
    expect(result.ties).toBe(1);
    expect(result.tiesLeft).toBe(0);
    expect(result.bits[node(2, 2, 2)] & IN).toBe(IN);
    // Its neighbours, each with two axes voting inside, and a node outside the cube.
    expect(result.bits[node(1, 2, 2)] & IN).toBe(IN);
    expect(result.bits[node(0, 2, 2)] & IN).toBe(0);
  });

  it('a node whose two voting axes split goes by its neighbours too, not inside by itself', () => {
    // At (4, 4, 4): x does not vote, y says inside (a sliver from 3.5 to 4.5) and z outside; its neighbours are outside.
    const cols = [
      columns(0, (at) => (at[1] === 4 && at[2] === 4 ? null : [])),
      columns(1, (at) => (at[0] === 4 && at[2] === 4 ? [3.5, 4.5] : [])),
      columns(2, () => []),
    ];
    const result = vote(LAT, cols);
    expect(result.split).toBe(1);
    expect(result.ties).toBe(1);
    expect(result.bits[node(4, 4, 4)] & IN).toBe(0);
  });

  it('a change of inside exactly at a node\'s height counts as above it', () => {
    // Only z votes at (0, 0, k), and its column changes at 2 and at 3.5: inside from 2 up, so the node at 2 is not.
    const cols = [
      columns(0, (at) => (at[1] === 0 ? null : [])),
      columns(1, (at) => (at[0] === 0 ? null : [])),
      columns(2, (at) => (at[0] === 0 && at[1] === 0 ? [2, 3.5] : [])),
    ];
    const result = vote(LAT, cols);
    expect([0, 1, 2, 3, 4].map((z) => (result.bits[node(0, 0, z)] & IN) === IN)).toEqual([false, false, false, true, false]);
  });
});
