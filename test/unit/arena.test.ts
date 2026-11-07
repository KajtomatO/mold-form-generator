import type { ManifoldToplevel } from 'manifold-3d';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { Arena, withArena } from '../../src/core/solid/arena';
import { countHandles, type HandleLedger } from '../fixtures/handles';
import { loadManifold } from '../fixtures/loadExamples';
import { box, flatTetrahedron, inverted, join, seamBox, withoutTriangles } from '../fixtures/synthetic';

// A new instance per test, because countHandles patches the API it is given.
let api: ManifoldToplevel;
let ledger: HandleLedger;
beforeEach(async () => {
  api = await loadManifold();
  ledger = countHandles(api);
});

describe('the handle counter itself', () => {
  it('sees handles from statics, methods, arrays and the constructor, and real deletions', () => {
    const cube = api.Manifold.cube(10); // static
    const moved = cube.translate(20, 0, 0); // method
    const section = moved.slice(5); // a CrossSection from a Manifold
    const offset = section.offset(1); // CrossSection method
    const parts = api.Manifold.compose([cube, moved]).decompose(); // an array, and an unnamed temp
    const built = new api.Manifold(cube.getMesh()); // the constructor
    // cube, moved, section, offset, composed, 2 parts, built
    expect(ledger.created()).toBe(8);
    expect(ledger.live()).toHaveLength(8);

    [cube, moved, section, offset, built, ...parts].forEach((h) => h.delete());
    // The composed handle was never named, so it is still alive, and the counter must say so.
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.deleted()).toBe(7);
  });

  it('negative control: a forgotten handle in a builder shows up as a leak', () => {
    withArena(api, ({ track }) => {
      const a = track(api.Manifold.cube(10));
      a.translate(1, 0, 0); // never tracked
    });
    expect(ledger.created()).toBe(2);
    expect(ledger.live()).toHaveLength(1);
    expect(ledger.deleted()).toBe(1);
    ledger.live().forEach((h) => h.delete());
    expect(ledger.live()).toHaveLength(0);
  });
});

describe('withArena', () => {
  it('really frees everything it tracked', () => {
    let held: { isDeleted(): boolean }[] = [];
    const volume = withArena(api, ({ track, trackAll }) => {
      const a = track(api.Manifold.cube(10));
      const b = track(a.translate(5, 0, 0));
      const sum = track(a.add(b));
      const parts = trackAll(sum.decompose());
      const section = track(sum.slice(5));
      held = [a, b, sum, section, ...parts] as unknown as typeof held;
      return sum.volume();
    });
    expect(volume).toBeCloseTo(1500, 3);
    expect(ledger.created()).toBeGreaterThanOrEqual(5);
    expect(ledger.live()).toEqual([]);
    expect(held.every((h) => h.isDeleted())).toBe(true);
  });

  it('frees everything when the build throws, and lets the error through', () => {
    const boom = new Error('boom');
    expect(() =>
      withArena(api, ({ track }) => {
        track(api.Manifold.cube(10));
        track(api.CrossSection.square(4));
        throw boom;
      }),
    ).toThrow(boom);
    expect(ledger.created()).toBe(2);
    expect(ledger.live()).toEqual([]);
  });

  it('deletes a handle tracked twice only once, which embind would throw on', () => {
    expect(() =>
      withArena(api, ({ track }) => {
        const a = track(api.Manifold.cube(10));
        track(a);
      }),
    ).not.toThrow();
    expect(ledger.deleted()).toBe(1);
    expect(ledger.live()).toEqual([]);
  });

  it('lets a released handle outlive the arena, until its new owner frees it', () => {
    const kept = withArena(api, (arena) => {
      const a = arena.track(api.Manifold.cube(10));
      return arena.release(arena.track(a.translate(1, 1, 1)));
    });
    expect(kept.volume()).toBeCloseTo(1000, 3);
    expect(ledger.live()).toEqual([kept]);
    kept.delete();
    expect(ledger.live()).toEqual([]);
  });

  it('creates Manifolds and CrossSections for the caller, already tracked', () => {
    withArena(api, (arena) => {
      const mesh = box([0, 0, 0], [1, 1, 1]);
      const solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
      expect(solid.volume()).toBeCloseTo(1, 5);
      const section = arena.crossSection([[[0, 0], [2, 0], [2, 2], [0, 2]]]);
      expect(section.area()).toBeCloseTo(4, 5);
    });
    expect(ledger.created()).toBeGreaterThanOrEqual(2);
    expect(ledger.live()).toEqual([]);
  });

  it('survives manual disposal twice, for a worker that disposes on its way down', () => {
    const arena = new Arena(api);
    arena.track(api.Manifold.cube(1));
    arena.dispose();
    arena.dispose();
    expect(ledger.deleted()).toBe(1);
    expect(ledger.live()).toEqual([]);
  });
});

describe('the polygon glue', () => {
  it('frees the vectors manifold-3d loses, and leaves its constructor and get as they were', () => {
    const glue = api as unknown as { Vector_vec2: unknown; Vector2_vec2: { prototype: { get: unknown } } };
    const { Vector_vec2 } = glue;
    const { get } = glue.Vector2_vec2.prototype;
    withArena(api, (arena) => {
      const section = arena.crossSection([[[0, 0], [2, 0], [2, 2], [0, 2]], [[5, 0], [7, 0], [7, 2], [5, 2]]]);
      expect(section.area()).toBeCloseTo(8, 5);
      expect(arena.polygons(section).map((polygon) => polygon.length)).toEqual([4, 4]);
    });
    expect(glue.Vector_vec2).toBe(Vector_vec2);
    expect(glue.Vector2_vec2.prototype.get).toBe(get);
    expect(ledger.live()).toEqual([]);
  });
});

describe('importSolid leaves no handles behind, on any route', () => {
  const routes = {
    'plain solid': box([0, 0, 0], [10, 10, 10]),
    'flipped': inverted(box([0, 0, 0], [10, 10, 10])),
    'overlapping shells': join(box([0, 0, 0], [10, 10, 10]), box([5, 0, 0], [15, 10, 10])),
    'void': join(box([0, 0, 0], [10, 10, 10]), inverted(box([2, 2, 2], [8, 8, 8]))),
    'inverted body': join(box([0, 0, 0], [10, 10, 10]), inverted(box([20, 0, 0], [25, 10, 10]))),
    'nested body in a void': join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([10, 10, 10], [20, 20, 20])),
    'soup': withoutTriangles(box([0, 0, 0], [10, 10, 10]), [0]),
    'inverted soup': inverted(withoutTriangles(box([0, 0, 0], [10, 10, 10]), [0])),
    'merged': seamBox(),
    'merged and flipped': inverted(seamBox()),
    // Closed, so Manifold accepts it, but it encloses nothing: the soup route with a live solid.
    'closed with no volume': flatTetrahedron(),
  };
  it.each(Object.entries(routes))('%s', (_, mesh) => {
    withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
    expect(ledger.live()).toEqual([]);
  });

  it('really has a handle to free on the closed route with no volume', () => {
    const mesh = flatTetrahedron();
    const { report } = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
    expect(report.route).toBe('soup');
    expect(ledger.created()).toBe(1);
    expect(ledger.deleted()).toBe(1);
  });
});
