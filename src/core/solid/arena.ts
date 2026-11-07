import type { CrossSection, FillRule, Manifold, ManifoldToplevel, Mesh, Polygons, SimplePolygon } from 'manifold-3d';

interface Handle {
  delete(): void;
}

/** The glue's own polygon vectors, which its typings leave out. */
interface PolygonVectors {
  Vector_vec2: new () => Handle & { isDeleted(): boolean };
  Vector2_vec2: { prototype: { get(index: number): Handle & { isDeleted(): boolean } } };
}

/**
 * Owns the WASM handles of one build, because the JS garbage collector never frees them.
 * Every Manifold and CrossSection goes through track(), or is created here.
 *
 * manifold-3d's own `new Manifold` wrapper drops a handle when it throws on a bad mesh. That
 * handle is out of reach from here. It costs about 600 bytes per failed import attempt, which the
 * disposable worker absorbs, and heap.test.ts holds that route to a limit of its own.
 *
 * Its polygon glue (3.5.4) also loses one vector per contour, both ways, and the footprint makes
 * one contour per triangle. Those are in reach, so withoutGlueLeaks frees them.
 */
export class Arena {
  private readonly owned = new Set<Handle>();

  constructor(readonly api: ManifoldToplevel) {}

  /** An arrow function, so callers can destructure it and write `track(a.subtract(b))`. */
  track = <T extends Handle>(handle: T): T => {
    this.owned.add(handle);
    return handle;
  };

  trackAll = <T extends Handle>(handles: T[]): T[] => {
    handles.forEach(this.track);
    return handles;
  };

  /** Throws ManifoldError if the mesh is not a closed oriented 2-manifold. */
  manifold(mesh: Mesh): Manifold {
    return this.track(new this.api.Manifold(mesh));
  }

  crossSection(contours: Polygons, fillRule?: FillRule): CrossSection {
    return this.track(this.withoutGlueLeaks(() => this.api.CrossSection.ofPolygons(contours, fillRule)));
  }

  /** section.toPolygons(), without the glue's leak. */
  polygons(section: CrossSection): SimplePolygon[] {
    return this.withoutGlueLeaks(() => section.toPolygons());
  }

  /**
   * While `call` runs, notes every inner vector the glue creates or reads out, then frees those
   * it did not. It looks the constructor and `get` up each time, so this catches them all.
   */
  private withoutGlueLeaks<R>(call: () => R): R {
    const vectors = this.api as unknown as PolygonVectors;
    const Inner = vectors.Vector_vec2;
    const outer = vectors.Vector2_vec2.prototype;
    const get = outer.get;
    const seen: (Handle & { isDeleted(): boolean })[] = [];
    vectors.Vector_vec2 = function () {
      const vector = new Inner();
      seen.push(vector);
      return vector;
    } as unknown as PolygonVectors['Vector_vec2'];
    outer.get = function (this: unknown, index: number) {
      const vector = get.call(this, index);
      seen.push(vector);
      return vector;
    };
    try {
      return call();
    } finally {
      vectors.Vector_vec2 = Inner;
      outer.get = get;
      for (const vector of seen) if (!vector.isDeleted()) vector.delete();
    }
  }

  /** Hands a handle to the caller, who must delete it or track it in another arena. */
  release<T extends Handle>(handle: T): T {
    this.owned.delete(handle);
    return handle;
  }

  dispose(): void {
    for (const handle of this.owned) handle.delete();
    this.owned.clear();
  }
}

/** Runs a synchronous build and frees everything it tracked, even if it throws. */
export function withArena<R>(api: ManifoldToplevel, build: (arena: Arena) => R): R {
  const arena = new Arena(api);
  try {
    return build(arena);
  } finally {
    arena.dispose();
  }
}
