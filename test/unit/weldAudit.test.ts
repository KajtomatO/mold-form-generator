import { describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { weld } from '../../src/core/mesh/weld';
import { BOX_BOTTOM_FIRST, BOX_TOP, box, inverted, join, nextFloat, toSoup, withoutTriangles } from '../fixtures/synthetic';

describe('exact weld', () => {
  it('rebuilds a box from soup: 36 corners become 8 vertices', () => {
    const welded = weld(toSoup(box([0, 0, 0], [1, 2, 3])));
    expect(welded.positions.length / 3).toBe(8);
    expect(welded.indices.length).toBe(36);
    expect(auditEdges(welded).openEdges).toBe(0);
  });

  it('keeps triangle order and corner order', () => {
    const soup = toSoup(box([0, 0, 0], [1, 2, 3]));
    expect(Array.from(toSoup(weld(soup)))).toEqual(Array.from(soup));
  });

  it('is compact: every vertex is used and none are unreferenced', () => {
    const welded = weld(toSoup(withoutTriangles(box([0, 0, 0], [1, 1, 1]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])));
    const used = new Set(welded.indices);
    expect(used.size).toBe(welded.positions.length / 3);
    expect(Math.max(...used)).toBe(used.size - 1);
  });

  it('merges -0 with +0', () => {
    const welded = weld(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, -0, -0, -0, 1, -0, 0, 0, 1, -0]));
    expect(welded.positions.length / 3).toBe(3);
  });

  it('merges -0 with +0 on every axis when the hash table is large', () => {
    // The sign bit only reaches the slot number when the table has more than 2^16 slots, so a
    // small mesh would pass by luck even if the two zeros hashed differently.
    const count = 40000;
    const soup = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      soup.set([0, i, i, -0, i, i, 1, i, i], i * 9); // -0 in x
      if (i % 2) soup.set([i, 0, i, i, -0, i, i, 1, i], i * 9); // -0 in y
      if (i % 3 === 0) soup.set([i, i, 0, i, i, -0, i, i, 1], i * 9); // -0 in z
    }
    const welded = weld(soup);
    for (let i = 0; i < count; i++) expect(welded.indices[i * 3]).toBe(welded.indices[i * 3 + 1]);
  });

  it('does not merge values one float step apart, because the weld must never move geometry', () => {
    const welded = weld(Float32Array.from([1, 1, 1, 2, 2, 2, 3, 3, 3, nextFloat(1), 1, 1, 2, 2, 2, 3, 3, 3]));
    expect(welded.positions.length / 3).toBe(4);
  });

  it('handles a large grid without hash failures', () => {
    const size = 300;
    const soup: number[] = [];
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const a = [i * 0.1, j * 0.1, 0], b = [(i + 1) * 0.1, j * 0.1, 0], c = [i * 0.1, (j + 1) * 0.1, 0], d = [(i + 1) * 0.1, (j + 1) * 0.1, 0];
        soup.push(...a, ...b, ...d, ...a, ...d, ...c);
      }
    }
    const welded = weld(Float32Array.from(soup));
    expect(welded.indices.length / 3).toBe(2 * size * size);
    expect(welded.positions.length / 3).toBe((size + 1) * (size + 1));
  });
});

describe('edge audit', () => {
  it('finds nothing wrong with a closed box', () => {
    const audit = auditEdges(box([0, 0, 0], [1, 1, 1]));
    expect(audit).toMatchObject({ triangleCount: 12, vertexCount: 8, edgeCount: 18, openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0, openArea: 0 });
    expect(audit.openLoops).toEqual([]);
  });

  it('counts the 3 open edges and the one hole left by a missing triangle', () => {
    const audit = auditEdges(withoutTriangles(box([0, 0, 0], [10, 10, 10]), [BOX_BOTTOM_FIRST]));
    expect(audit.openEdges).toBe(3);
    expect(audit.openLoops).toHaveLength(1);
    expect(audit.openLoops[0].edgeCount).toBe(3);
    expect(audit.openLoops[0].area).toBeCloseTo(50, 3);
  });

  it('reports the size and upward facing of a missing top cap', () => {
    const audit = auditEdges(withoutTriangles(box([0, 0, 0], [20, 20, 10]), BOX_TOP));
    expect(audit.openEdges).toBe(4);
    expect(audit.openLoops).toHaveLength(1);
    expect(audit.openArea).toBeCloseTo(400, 3);
    expect(audit.openLoops[0].capNormal[2]).toBeCloseTo(1, 6);
  });

  it('reports a downward facing missing bottom cap', () => {
    const audit = auditEdges(withoutTriangles(box([0, 0, 0], [20, 20, 10]), [0, 1]));
    expect(audit.openLoops[0].capNormal[2]).toBeCloseTo(-1, 6);
  });

  it('counts an edge shared by three triangles as non-manifold', () => {
    const mesh = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 1, 0, 3, 0, 1, 4]),
    };
    expect(auditEdges(mesh).nonManifoldEdges).toBe(1);
  });

  it('counts two triangles running the same way along an edge as misoriented', () => {
    const mesh = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3]),
    };
    const audit = auditEdges(mesh);
    expect(audit.misorientedEdges).toBe(1);
    expect(audit.openEdges).toBe(4);
  });

  it('finds every wrongly wound face of a box with one triangle flipped', () => {
    const mesh = box([0, 0, 0], [1, 1, 1]);
    const flipped = inverted(withoutTriangles(mesh, Array.from({ length: 12 }, (_, i) => i).filter((i) => i !== 5)));
    const indices = Uint32Array.from([...withoutTriangles(mesh, [5]).indices, ...flipped.indices]);
    expect(auditEdges({ positions: mesh.positions, indices }).misorientedEdges).toBe(3);
  });

  it('counts holes of separate shells separately', () => {
    const a = withoutTriangles(box([0, 0, 0], [1, 1, 1]), BOX_TOP);
    const b = withoutTriangles(box([5, 0, 0], [6, 1, 1]), BOX_TOP);
    const audit = auditEdges(join(a, b));
    expect(audit.openLoops).toHaveLength(2);
    expect(audit.openArea).toBeCloseTo(2, 5);
  });
});
