import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import type { BaseOptions } from '../../src/core/base/candidates';
import { auditEdges, type MeshAudit } from '../../src/core/mesh/audit';
import { meshBounds, weld, type Bounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { parseStl, type ParsedStl } from '../../src/core/stl/parse';

const examplesDir = join(import.meta.dirname, '..', '..', 'examples');

/** The regression set: the models the goldens were measured on, keyed by the ids the goldens use. */
export const EXAMPLE_FILES = {
  benchy: '3dbenchy.stl',
  goddess: 'Goddess Statue.stl',
  vis35: 'VIS-35-skan-skalowany.stl',
  jersey: 'jersey-barrier.stl',
  x8: 'jersey-barriers-x8.stl',
  barrel: 'l_medieval_barrel.stl',
  wolf: 'wolfinal.stl',
  // M11c: a multi-colour model of 6 parts that overlap, which the user's file showed to be one body.
  chick: 'chick_mc.stl',
} as const;

export type ExampleId = keyof typeof EXAMPLE_FILES;

/**
 * R2: these two have no known source, so they are kept only on the maintainer's machine, named in
 * .gitignore, and a clone of the public repository lacks them (examples/SOURCES.md).
 */
export const LOCAL_ONLY: readonly ExampleId[] = ['vis35', 'barrel'];

/**
 * Whether an example's file is in this checkout. Only a local-only one may be missing: a published one
 * always counts as here, so a test that reads it fails loudly if it is gone instead of skipping or dropping
 * it from a loop. CFG_WITHOUT_LOCAL_EXAMPLES=1 counts the local-only ones as missing even where they are
 * on disk, to run the tests as a clone of the public repository runs them.
 */
export function hasExample(id: ExampleId): boolean {
  if (!LOCAL_ONLY.includes(id)) return true;
  return process.env.CFG_WITHOUT_LOCAL_EXAMPLES !== '1' && existsSync(join(examplesDir, EXAMPLE_FILES[id]));
}

/**
 * The files of the examples not in this checkout, which the browser tests' servers answer with a 404, as a
 * clone's would, also where they are on disk under CFG_WITHOUT_LOCAL_EXAMPLES.
 */
export function missingExampleFiles(): string[] {
  return LOCAL_ONLY.filter((id) => !hasExample(id)).map((id) => EXAMPLE_FILES[id]);
}

/** The examples in this checkout. Every loop over the whole regression set runs on these, so a missing local-only one drops out. */
export const EXAMPLE_IDS = (Object.keys(EXAMPLE_FILES) as ExampleId[]).filter(hasExample);

/** Why a test that needs these examples skips. */
function missingNote(ids: ExampleId[]): string {
  return `not in this checkout: ${ids.map((id) => EXAMPLE_FILES[id]).join(' and ')}, kept only on the maintainer's machine (examples/SOURCES.md)`;
}

/**
 * Skips the running test, or each test of a group from its beforeEach, when an example it needs is not in
 * this checkout, naming the file and examples/SOURCES.md. Takes Vitest's test context or Playwright's `test`.
 */
export function skipWithout(test: { skip(condition: boolean, note?: string): void }, ...ids: ExampleId[]): void {
  const missing = ids.filter((id) => !hasExample(id));
  test.skip(missing.length > 0, missingNote(missing));
}

export function exampleBytes(id: ExampleId): Uint8Array {
  // Refused even when on disk under CFG_WITHOUT_LOCAL_EXAMPLES, so a test that reads one without skipping fails there.
  if (!hasExample(id)) throw new Error(missingNote([id]));
  const buffer = readFileSync(join(examplesDir, EXAMPLE_FILES[id]));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

export interface LoadedExample {
  id: ExampleId;
  parsed: ParsedStl;
  welded: WeldedMesh;
  audit: MeshAudit;
  bounds: Bounds;
  /** Default parameters: auto plane tolerance, 5 mm2 minimum island. */
  options: BaseOptions;
}

const cache = new Map<ExampleId, LoadedExample>();

/** Parsed once per test file: the steps are pure and Benchy takes a moment. */
export function loadExample(id: ExampleId): LoadedExample {
  let loaded = cache.get(id);
  if (!loaded) {
    const parsed = parseStl(exampleBytes(id));
    const welded = weld(parsed.positions);
    const bounds = meshBounds(welded.positions);
    loaded = { id, parsed, welded, audit: auditEdges(welded), bounds, options: baseOptions(defaultParams(), bounds) };
    cache.set(id, loaded);
  }
  return loaded;
}

/** A fresh WASM instance, so handle counts and heap readings start clean. */
export async function loadManifold(): Promise<ManifoldToplevel> {
  const api = await Module();
  api.setup();
  return api;
}
