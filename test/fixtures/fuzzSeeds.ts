import type { ExampleId } from './loadExamples';

/**
 * Parameter sets the fuzz of test/unit/fuzz.test.ts once found failing, by the seed that draws them, with
 * what was wrong, so each stays fixed. A pure set runs on `model`; a build set always on jersey.
 */
export const FUZZ_REGRESSIONS: {
  pure: { seed: number; model: ExampleId; found: string }[];
  build: { seed: number; exportToo: boolean; found: string }[];
} = {
  pure: [
    // Grids past the export's node cap, where the export plan raises its cell and with it the pitch, and
    // the preview's tiles stood on a pitch snapped to the cell it was given, up to 1.9 mm a tile apart.
    { seed: 110002, model: 'barrel', found: 'a preview tile 0.53 mm off the export\'s offset, past half its cell' },
    { seed: 110004, model: 'x8', found: 'a preview tile 1.54 mm off the export\'s offset' },
    { seed: 110010, model: 'x8', found: 'the 18th preview tile 31.8 mm off the export\'s offset' },
    { seed: 110011, model: 'barrel', found: 'a preview tile 0.30 mm off the export\'s offset, past half its cell' },
    { seed: 110013, model: 'x8', found: 'a preview tile 0.34 mm off the export\'s offset, past half its cell' },
  ],
  build: [],
};
