import { findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { parseStl } from '../../src/core/stl/parse';
import { loadGallery } from './loadGallery';

/**
 * MP1's run lives in src/core/field/clamshell.ts, which the tests and the measurement call as MP5 will; this adds only
 * the gallery's models, oriented as fieldRuns.ts orients the test models.
 */
export { chooseFor, coarseRows, exactFootprint, exactRim, fineSplit, prepareClamshell, seamHold, sideField, type ClamshellPrep, type FineSplit, type SeamHold } from '../../src/core/field/clamshell';

const galleryCache = new Map<string, WeldedMesh>();

/** A gallery model on its top ranked plane, as fieldRuns.ts gives the test models. */
export function orientedGallery(id: string): WeldedMesh {
  let mesh = galleryCache.get(id);
  if (!mesh) {
    const welded = weld(parseStl(loadGallery(id)).positions);
    const options = baseOptions(defaultParams(), meshBounds(welded.positions));
    const [top] = findBaseCandidates(welded, options);
    mesh = orientToBase(welded, top, { planeTol: options.planeTol, soup: false }).mesh;
    galleryCache.set(id, mesh);
  }
  return mesh;
}
