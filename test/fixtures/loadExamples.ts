import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import type { BaseOptions } from '../../src/core/base/candidates';
import { auditEdges, type MeshAudit } from '../../src/core/mesh/audit';
import { meshBounds, weld, type Bounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { parseStl, type ParsedStl } from '../../src/core/stl/parse';

const examplesDir = join(import.meta.dirname, '..', '..', 'examples');

export const EXAMPLE_FILES = {
  benchy: '3dbenchy.stl',
  goddess: 'Goddess Statue.stl',
  vis35: 'VIS-35-skan-skalowany.stl',
  jersey: 'jersey-barrier.stl',
  x8: 'jersey-barriers-x8.stl',
  barrel: 'l_medieval_barrel.stl',
  wolf: 'wolfinal(1).stl',
  // M11c: a multi-colour model of 6 parts that overlap, which the user's own file showed to be one body.
  chick: 'chick_mc.stl',
} as const;

export type ExampleId = keyof typeof EXAMPLE_FILES;
export const EXAMPLE_IDS = Object.keys(EXAMPLE_FILES) as ExampleId[];

export function exampleBytes(id: ExampleId): Uint8Array {
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
