import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { candidateFromPick, findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid, type ImportedSolid } from '../../src/core/mesh/shells';
import { weld } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { EXAMPLE_IDS, exampleBytes, loadExample, loadManifold } from '../fixtures/loadExamples';
import { asciiStl, cracked, inverted, withoutTriangles } from '../fixtures/synthetic';
import { GOLDEN } from './golden';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

function importExample(id: (typeof EXAMPLE_IDS)[number]): ImportedSolid & { genus: number } {
  const { welded, audit } = loadExample(id);
  return withArena(api, (arena) => {
    const imported = importSolid(arena, welded, audit);
    return { ...imported, genus: imported.solid!.genus() };
  });
}

describe.each(EXAMPLE_IDS)('import of %s', (id) => {
  const golden = GOLDEN[id];

  it('parses to the expected format and counts', () => {
    const { parsed, welded } = loadExample(id);
    expect(parsed.format).toBe(golden.format);
    expect(parsed.rawTriangleCount).toBe(golden.rawTriangles);
    expect(parsed.degenerateCount).toBe(golden.degenerate);
    expect(parsed.triangleCount).toBe(golden.triangles);
    expect(welded.indices.length / 3).toBe(golden.triangles);
    expect(welded.positions.length / 3).toBe(golden.vertices);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('validates at the first rung with 0 open edges', () => {
    const { audit } = loadExample(id);
    expect(audit.openEdges).toBe(0);
    expect(audit.misorientedEdges).toBe(0);
    expect(audit.nonManifoldEdges).toBe(golden.nonManifoldEdges);
    expect(audit.openLoops).toEqual([]);
    const imported = importExample(id);
    expect(imported.report).toMatchObject({ route: 'manifold', failure: null, flipped: false, modeBAvailable: true, overlapVolume: 0 });
    expect(imported.report.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('matches the measured shells', () => {
    const { report, genus } = importExample(id);
    expect(report.bodies).toBe(golden.bodies);
    expect(genus).toBe(golden.genus);
    within(report.solidVolume, golden.solidVolume, 0.01);
    if (golden.voidVolume === 0) expect(report.voidVolume).toBe(0);
    else within(report.voidVolume, golden.voidVolume, 0.01);
  });
});

describe('plan facts on import', () => {
  it('Benchy is binary despite its solid header, and loses 552', () => {
    const bytes = exampleBytes('benchy');
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe('solid');
    const { parsed } = loadExample('benchy');
    expect(parsed.format).toBe('binary');
    expect(parsed.rawTriangleCount).toBe(225706);
    expect(parsed.rawTriangleCount - parsed.triangleCount).toBe(552);
  });

  it('dropping every zero-area triangle would open Benchy: the 11 collinear ones must stay', () => {
    const { welded } = loadExample('benchy');
    const { positions: p, indices } = welded;
    const collinear: number[] = [];
    for (let t = 0; t < indices.length / 3; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) collinear.push(t);
    }
    expect(collinear).toHaveLength(11);
    // Without them the mesh has open edges, and Manifold refuses it.
    const opened = withoutTriangles(welded, collinear);
    expect(auditEdges(opened).openEdges).toBe(29);
    expect(withArena(api, (arena) => importSolid(arena, opened, auditEdges(opened)).report.route)).not.toBe('manifold');
  });

  it('the barrel is the only ASCII example', () => {
    expect(EXAMPLE_IDS.filter((id) => loadExample(id).parsed.format === 'ascii')).toEqual(['barrel']);
    expect(loadExample('barrel').parsed.rawTriangleCount).toBe(9412);
  });

  it('a large ASCII file gives the same floats as the binary it came from', () => {
    const { parsed } = loadExample('goddess');
    const bytes = asciiStl(parsed.positions, 'large fixture');
    expect(bytes.length).toBeGreaterThan(5_000_000);
    const again = parseStl(bytes);
    expect(again.format).toBe('ascii');
    expect(again.triangleCount).toBe(38276);
    expect(Buffer.compare(Buffer.from(again.positions.buffer, again.positions.byteOffset, again.positions.byteLength), Buffer.from(parsed.positions.buffer, parsed.positions.byteOffset, parsed.positions.byteLength))).toBe(0);
    expect(weld(again.positions).positions.length / 3).toBe(19135);
  });

  it('the barrel decomposes to +7489 and -3432 within 1%, recording the void', () => {
    const { report } = importExample('barrel');
    expect(report.shells.map((s) => s.kind)).toEqual(['solid', 'void']);
    within(report.shells[0].volume, 7489, 0.01);
    within(report.shells[1].volume, -3432, 0.01);
    expect(report.bodies).toBe(1);
    expect(report.diagnostics.map((d) => d.code)).toEqual(['shell-void']);
  });

  it('x8 has 8 bodies, with negative genus and no error', () => {
    const { report, genus } = importExample('x8');
    expect(report.bodies).toBe(8);
    expect(report.shells.every((s) => s.kind === 'solid')).toBe(true);
    expect(genus).toBe(-7);
    expect(report.diagnostics).toEqual([]);
  });

  it('a real model with its top cap removed reaches soup mode, with the hole measured', () => {
    const { welded } = loadExample('jersey');
    const { positions: p, indices } = welded;
    // The jersey barrier's flat top: every triangle with all corners at the highest z.
    const top: number[] = [];
    for (let t = 0; t < indices.length / 3; t++) {
      if ([0, 1, 2].every((c) => Math.abs(p[indices[t * 3 + c] * 3 + 2] - 20.6683) < 1e-3)) top.push(t);
    }
    expect(top.length).toBeGreaterThan(0);
    const open = withoutTriangles(welded, top);
    const audit = auditEdges(open);
    within(audit.openArea, 263.9, 0.01);
    expect(audit.openLoops[0].capNormal[2]).toBeCloseTo(1, 3);
    const { report } = withArena(api, (arena) => importSolid(arena, open, audit));
    expect(report.route).toBe('soup');
    expect(report.modeBAvailable).toBe(false);
    expect(report.diagnostics.map((d) => d.code)).toEqual(['soup-mode', 'missing-surface']);
    expect(report.bodies).toBe(1);
  });

  it.each(['goddess', 'jersey', 'wolf'] as const)('%s cracked along mid-x by 0.001 mm closes again at the merge rung', (id) => {
    const { welded } = loadExample(id);
    const seam = cracked(welded, 0.001);
    const audit = auditEdges(seam);
    expect(audit.openEdges).toBeGreaterThan(0);
    const { report } = withArena(api, (arena) => importSolid(arena, seam, audit));
    expect(report.route).toBe('merged');
    expect(report.modeBAvailable).toBe(true);
    within(report.solidVolume, GOLDEN[id].solidVolume, 0.001);
  });

  it('a real open model works the same inside out: the same base, and the same picks usable', () => {
    const { welded, options } = loadExample('jersey');
    const open = withoutTriangles(welded, [0]);
    const usablePicks = (mesh: typeof welded): number => {
      let usable = 0;
      for (let t = 0; t < mesh.indices.length / 3; t++) {
        if (orientToBase(mesh, candidateFromPick(mesh, t, options), { planeTol: options.planeTol, soup: true }).usable) usable++;
      }
      return usable;
    };
    const flipped = inverted(open);
    const imported = withArena(api, (arena) => importSolid(arena, flipped, auditEdges(flipped)));
    expect(imported.report).toMatchObject({ route: 'soup', flipped: true });
    const [top] = findBaseCandidates(imported.mesh, options, { openLoops: imported.openLoops });
    expect(top.normal).toEqual([0, 0, -1]);
    within(top.area, 711.5, 0.01);
    expect(usablePicks(imported.mesh)).toBe(usablePicks(open));
    expect(usablePicks(imported.mesh)).toBeGreaterThan(0);
  });
});
