import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { fieldSettings, type FieldSettings } from '../../src/core/field/grid';
import type { Bounds, WeldedMesh } from '../../src/core/mesh/weld';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { loadExample, type ExampleId } from './loadExamples';

export interface OrientedExample {
  mesh: WeldedMesh;
  bounds: Bounds;
}

const cache = new Map<ExampleId, OrientedExample>();

/** The example on its top ranked plane, which is the plan's default base on all 7. */
export function orientedExample(id: ExampleId): OrientedExample {
  let found = cache.get(id);
  if (!found) {
    const { welded, options } = loadExample(id);
    const [top] = findBaseCandidates(welded, options);
    const { mesh } = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
    found = { mesh, bounds: meshBounds(mesh.positions) };
    cache.set(id, found);
  }
  return found;
}

/** Plan defaults: margin, 1 degree draft and 1.2 mm closing on, cell 0.125, one tile. */
export function defaultSettings(bounds: Bounds, cell?: number): FieldSettings {
  return fieldSettings(defaultParams(), bounds, cell);
}

/** The bare formula the oracles describe: r = t with no margin, no draft and no closing. */
export function bareSettings(bounds: Bounds, cell = 0.125): FieldSettings {
  return { ...defaultSettings(bounds, cell), cellFinal: cell, margin: false, draftDeg: 0, closeWidth: 0 };
}
