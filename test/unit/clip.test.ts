import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { clipBelow } from '../../src/core/mesh/clip';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { parseStl } from '../../src/core/stl/parse';
import { box, BOX_TOP, weldedFixture, withoutTriangles } from '../fixtures/synthetic';

function oilBarrel(): WeldedMesh {
  const bytes = readFileSync(join(import.meta.dirname, '..', '..', 'test-models', 'N Scale Oil Barrel.stl'));
  return weld(parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)).positions);
}

/** The mesh moved down so the plane z = 0 lies `depth` above its lowest point, as a trim of its base would stand it. */
function lowered(mesh: WeldedMesh, depth: number): WeldedMesh {
  const { min } = meshBounds(mesh.positions);
  return { positions: Float32Array.from(mesh.positions, (v, k) => (k % 3 === 2 ? v - (min[2] + depth) : v)), indices: mesh.indices };
}

describe('RM: an open file cut at the base plane, for model_oriented.stl', () => {
  for (const depth of [0.3, 2]) {
    it(`the oil barrel cut ${depth} mm up ends at z = 0 exactly, with one more hole along the cut and no crack`, () => {
      const mesh = lowered(oilBarrel(), depth);
      const before = auditEdges(mesh);
      const cut = clipBelow(mesh);
      expect(meshBounds(cut.positions).min[2]).toBe(0);
      const after = auditEdges(cut);
      expect(after.nonManifoldEdges).toBe(0);
      expect(after.misorientedEdges).toBe(0);
      // Its own hole and the cut's: the triangles on either side of each cut edge share the cut point bit for bit.
      expect(after.openLoops.length).toBe(before.openLoops.length + 1);
      expect(cut.indices.length).toBeLessThan(mesh.indices.length);
    });
  }

  it('keeps a mesh above the plane as it is, and a corner within a micrometre of it on it', () => {
    const open = weldedFixture(withoutTriangles(box([0, 0, 0], [30, 20, 12]), BOX_TOP));
    const same = clipBelow(open);
    expect(Array.from(same.positions)).toEqual(Array.from(open.positions));
    expect(Array.from(same.indices)).toEqual(Array.from(open.indices));
    const nudged = { positions: Float32Array.from(open.positions, (v, k) => (k % 3 === 2 && v === 0 ? -0.0004 : v)), indices: open.indices };
    const kept = clipBelow(nudged);
    expect(kept.indices.length).toBe(open.indices.length);
    expect(meshBounds(kept.positions).min[2]).toBe(0);
  });

  it('cuts a box\'s walls where the plane crosses them, wound as they were', () => {
    const open = weldedFixture(withoutTriangles(box([0, 0, -5], [30, 20, 12]), BOX_TOP));
    const cut = clipBelow(open);
    expect(meshBounds(cut.positions).min[2]).toBe(0);
    // The bottom goes, the four walls are cut to 12 mm, and the top's hole and the cut are the two holes left.
    const audit = auditEdges(cut);
    expect(audit.openLoops.length).toBe(2);
    expect(audit.misorientedEdges).toBe(0);
    expect(audit.openArea).toBeCloseTo(1200, 3);
  });
});
