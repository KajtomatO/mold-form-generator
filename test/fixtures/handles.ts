import type { ManifoldToplevel } from 'manifold-3d';

interface EmbindHandle {
  delete(): void;
  isDeleted(): boolean;
}

export interface HandleLedger {
  /** Handles returned by any Manifold or CrossSection API call so far. */
  created(): number;
  /** Calls that reached the real delete. */
  deleted(): number;
  /** Handles that embind itself says are still alive. */
  live(): EmbindHandle[];
}

const SKIPPED = new Set(['constructor', 'delete', 'isDeleted', 'clone', 'isAliasOf', 'deleteLater', 'prototype', 'length', 'name', 'arguments', 'caller']);

/**
 * Wraps the real API of one fresh Manifold instance so that every handle it hands out is seen,
 * whichever code asked for it, and asks embind whether each one is really gone. Nothing here
 * trusts the arena: forgetting track() shows up as a live handle.
 */
export function countHandles(api: ManifoldToplevel): HandleLedger {
  const seen = new Set<EmbindHandle>();
  let deleted = 0;

  // Handles carry the embind prototypes, which the API's wrapper functions hide. Reach them from
  // sample instances.
  const sampleSolid = api.Manifold.tetrahedron();
  const sampleSection = api.CrossSection.square(1);
  const solidProto = Object.getPrototypeOf(sampleSolid);
  const sectionProto = Object.getPrototypeOf(sampleSection);
  sampleSolid.delete();
  sampleSection.delete();

  const isHandle = (value: unknown): value is EmbindHandle =>
    typeof value === 'object' && value !== null && (solidProto.isPrototypeOf(value) || sectionProto.isPrototypeOf(value));

  const register = (value: unknown): void => {
    if (isHandle(value)) seen.add(value);
    else if (Array.isArray(value)) value.forEach(register);
  };

  const wrapAll = (target: Record<string, unknown>): void => {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (SKIPPED.has(name) || name.startsWith('_')) continue;
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = function (this: unknown, ...args: unknown[]): unknown {
        const result = original.apply(this, args);
        register(result);
        return result;
      };
    }
  };
  wrapAll(solidProto);
  wrapAll(sectionProto);
  wrapAll(api.Manifold as unknown as Record<string, unknown>);
  wrapAll(api.CrossSection as unknown as Record<string, unknown>);

  for (const proto of [solidProto, sectionProto]) {
    const realDelete = proto.delete;
    proto.delete = function (this: EmbindHandle): void {
      realDelete.call(this);
      deleted++;
    };
  }

  const module = api as unknown as Record<string, unknown>;
  for (const name of ['Manifold', 'CrossSection']) {
    module[name] = new Proxy(module[name] as object, {
      construct(target, args, newTarget) {
        const handle = Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget);
        register(handle);
        return handle;
      },
    });
  }

  return {
    created: () => seen.size,
    deleted: () => deleted,
    live: () => [...seen].filter((handle) => !handle.isDeleted()),
  };
}
