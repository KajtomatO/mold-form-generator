import type { ExampleId } from '../fixtures/loadExamples';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';

/**
 * The defaults every golden here was measured at: today's, less the silicone base layer, which came with
 * 1.0.2 after all of them. The suites read the goldens with it off and check the layer on its own.
 */
export function goldenParams(): Params {
  const params = defaultParams();
  params.silicone.baseLayer = 0;
  return params;
}

/**
 * M1 numbers measured on the 7 examples. Parameters: all defaults, so planeTol is auto (0.05 to
 * 0.2 by model size) and minIsland is 5 mm2. Volumes are mm3, areas mm2, lengths mm. These sit
 * next to the plan's own figures in the tests, and M2 reviews and freezes them.
 */
export interface Golden {
  format: 'binary' | 'ascii';
  rawTriangles: number;
  degenerate: number;
  triangles: number;
  vertices: number;
  /** Edges used by 4 triangles in pairs. Manifold accepts them. */
  nonManifoldEdges: number;
  bodies: number;
  genus: number;
  /** The solid shells summed, so where parts overlap this counts what they share twice. */
  solidVolume: number;
  voidVolume: number;
  /** M11c: the shells' sum less their union, 0 on every model but the chick. */
  overlapVolume: number;
  planeTol: number;
  /** Height of the default plane in the file's own coordinates. */
  planeZ: number;
  baseArea: number;
  /** Footprint components at or above minIsland, largest first. */
  footprints: number[];
  /** Components below minIsland, largest first. */
  islands: number[];
  /**
   * Largest flat level above the default plane, if any is within 1 mm. Exposed means it lies
   * outside the base outline where silicone can reach it. Otherwise it is a recess in the outline.
   */
  upper: { offset: number; area: number; exposed: boolean } | null;
}

export const GOLDEN: Record<ExampleId, Golden> = {
  benchy: {
    format: 'binary',
    rawTriangles: 225706,
    degenerate: 552,
    triangles: 225154,
    vertices: 112569,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: 5,
    solidVolume: 15550.5,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.05,
    planeZ: 0,
    baseArea: 447.8,
    footprints: [439.2, 8.6],
    islands: [],
    upper: { offset: 0.3, area: 78.1, exposed: false },
  },
  goddess: {
    format: 'binary',
    rawTriangles: 38276,
    degenerate: 0,
    triangles: 38276,
    vertices: 19135,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: 0,
    solidVolume: 88656.6,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.0632,
    planeZ: -1.9837,
    baseArea: 1184.5,
    footprints: [1184.3],
    islands: [],
    upper: null,
  },
  vis35: {
    format: 'binary',
    rawTriangles: 18700,
    degenerate: 0,
    triangles: 18700,
    vertices: 9334,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: 3,
    solidVolume: 244605.2,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.1207,
    planeZ: 0.0002,
    baseArea: 361.3,
    footprints: [361.3],
    islands: [],
    upper: { offset: 0.405, area: 769.4, exposed: true },
  },
  jersey: {
    format: 'binary',
    rawTriangles: 1340,
    degenerate: 0,
    triangles: 1340,
    vertices: 672,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: 0,
    solidVolume: 7964.05,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.05,
    planeZ: 0,
    baseArea: 711.5,
    footprints: [711.5],
    islands: [],
    upper: null,
  },
  x8: {
    format: 'binary',
    rawTriangles: 12656,
    degenerate: 0,
    triangles: 12656,
    vertices: 6344,
    nonManifoldEdges: 0,
    bodies: 8,
    genus: -7,
    solidVolume: 59683.1,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.0709,
    planeZ: 0,
    baseArea: 5689.0,
    footprints: [711.5, 711.5, 711.5, 711.5, 711.5, 711.5, 711.5, 708.7],
    islands: [],
    upper: null,
  },
  barrel: {
    format: 'ascii',
    rawTriangles: 9412,
    degenerate: 22,
    triangles: 9390,
    vertices: 4699,
    nonManifoldEdges: 12,
    bodies: 1,
    genus: -1,
    solidVolume: 7489.0,
    voidVolume: 3432.0,
    overlapVolume: 0,
    planeTol: 0.05,
    planeZ: 0,
    baseArea: 215.1,
    footprints: [215.1],
    islands: [],
    upper: null,
  },
  wolf: {
    format: 'binary',
    rawTriangles: 6006,
    degenerate: 0,
    triangles: 6006,
    vertices: 3005,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: 0,
    solidVolume: 257293.2,
    voidVolume: 0,
    overlapVolume: 0,
    planeTol: 0.1079,
    planeZ: 0.1413,
    baseArea: 2811.2,
    footprints: [2489.2, 159.7, 152.3],
    islands: [3.03, 1.83, 1.74, 1.45, 0.95, 0.95],
    upper: { offset: 0.917, area: 108.5, exposed: false },
  },
  // M11c: 6 closed parts, of 85,348, 14,136 (2), 11,122 (2) and 10,322 triangles, the 5 smaller each
  // passing into the largest: one body, of 16,813.2 mm3. The base face's area is its triangles' sum, so it
  // counts twice the 33.5 mm2 where two parts' soles lie on the largest's underside; the footprint is their union.
  chick: {
    format: 'binary',
    rawTriangles: 146186,
    degenerate: 0,
    triangles: 146186,
    vertices: 73105,
    nonManifoldEdges: 0,
    bodies: 1,
    genus: -5,
    solidVolume: 17777.6,
    voidVolume: 0,
    overlapVolume: 964.4,
    planeTol: 0.05,
    planeZ: 0,
    baseArea: 1245.4,
    footprints: [1211.9],
    islands: [],
    upper: null,
  },
};

/**
 * M2 numbers, in ml, frozen after review: a change over 1% fails until it is looked at. The plan's
 * own figures sit beside them, so the distance from them stays visible.
 */
export interface FieldGolden {
  /**
   * Plan defaults: t=3, cell 0.125, printMargin 0.1 so r_eff=3.36625, TIN raise 0.05, draft 1 degree,
   * closing 1.2 mm (11 nodes), 1 x 1 grid. Silicone is the integral of H dA with the raise, less the
   * model's exterior volume from M1 (the barrel's void stays out), less sealed air above the 0.05 ml
   * filter at analysisCell 0.25. Without bores: OPENING_GOLDEN has those.
   */
  silicone: number;
  /**
   * t=3, no margin, no draft, no closing, cell 0.25, the plan's check on the field. This makes r / cell
   * exactly 12. G3 keeps d = r, so straight walls gain one more row at the source's full height: one
   * cell times their area. Just below the ratio that row is gone (see bareOffLattice), and x8 and
   * jersey pass the plan's 5% only because of it. Defaults are not affected: r_eff / cell is 26.93.
   */
  bare: number;
  /**
   * The same run at t=2.9999, pinned beside `bare` so the size of that row stays visible. The plan's
   * figure is not checked against this: whether its check should stay at a whole ratio is for the
   * user to decide.
   */
  bareOffLattice: number;
  /** The plan's table of estimates at defaults. The corner formula reproduces these within 2%, clipping less. */
  planEstimate: number | null;
  /** The plan's M2 check at the bare settings. Null for the chick, added at M11c, which the plan has no figure for. */
  planBare: number | null;
}

export const FIELD_GOLDEN: Record<ExampleId, FieldGolden> = {
  benchy: { silicone: 42.82, bare: 39.64, bareOffLattice: 39.06, planEstimate: 43, planBare: 39.8 },
  goddess: { silicone: 117.67, bare: 102.72, bareOffLattice: 101.52, planEstimate: 118, planBare: 103 },
  vis35: { silicone: 541.13, bare: 478.54, bareOffLattice: 467.93, planEstimate: 544, planBare: 485 },
  jersey: { silicone: 11.17, bare: 9.89, bareOffLattice: 9.54, planEstimate: 11.8, planBare: 10.3 },
  x8: { silicone: 86.02, bare: 75.58, bareOffLattice: 73.02, planEstimate: 92, planBare: 79.3 },
  barrel: { silicone: 10.06, bare: 8.87, bareOffLattice: 8.82, planEstimate: 10.2, planBare: 9.0 },
  wolf: { silicone: 202.48, bare: 182.83, bareOffLattice: 182.03, planEstimate: 208, planBare: 186 },
  // M11c, measured at the same settings. The model's volume taken off is its parts' union: their sum would read 0.96 ml less.
  chick: { silicone: 11.46, bare: 10.16, bareOffLattice: 10.09, planEstimate: null, planBare: null },
};

/**
 * M3 numbers, at plan defaults in one tile. Volumes in mm3 except silicone, which is ml: the voids of
 * the Mode B union with the plate top at +0.01, without the groove. Measured on the real solids.
 * Limits: 1% both ways on silicone, volumes and both gaps; TIN only upward, by 5%; box sizes 0.1%.
 */
export interface SolidGolden {
  silicone: number;
  cover: number;
  glue: number;
  merged: number;
  /** minGap between model and cover, in mm. The check against t alone lets this fall to t unnoticed. */
  gap: number;
  /** The same with draft 0, where nothing widens the cavity past its margin. */
  gapDraft0: number;
  tinTriangles: number;
  boxX: number;
  boxY: number;
  Zt: number;
}

export const SOLID_GOLDEN: Record<ExampleId, SolidGolden> = {
  benchy: { silicone: 42.74, cover: 245127, glue: 17474, merged: 33150, gap: 3.2178, gapDraft0: 3.2097, tinTriangles: 21872, boxX: 88.925, boxY: 59.88, Zt: 56.416 },
  goddess: { silicone: 117.62, cover: 534651, glue: 22432, merged: 111333, gap: 3.2231, gapDraft0: 3.1933, tinTriangles: 39408, boxX: 93.259, boxY: 71.886, Zt: 110.016 },
  vis35: { silicone: 540.97, cover: 1263304, glue: 51155, merged: 295836, gap: 3.2232, gapDraft0: 3.2082, tinTriangles: 44554, boxX: 63.597, boxY: 230.59, Zt: 139.302 },
  jersey: { silicone: 11.15, cover: 80885, glue: 10256, merged: 18367, gap: 3.2406, gapDraft0: 3.2406, tinTriangles: 6462, boxX: 77.746, boxY: 43.136, Zt: 29.085 },
  x8: { silicone: 85.86, cover: 315919, glue: 55195, merged: 116058, gap: 3.2262, gapDraft0: 3.2262, tinTriangles: 60852, boxX: 143.746, boxY: 109.136, Zt: 29.085 },
  barrel: { silicone: 10.05, cover: 75171, glue: 8077, merged: 15611, gap: 3.2189, gapDraft0: 3.2039, tinTriangles: 11538, boxX: 51.687, boxY: 51.688, Zt: 33.918 },
  wolf: { silicone: 202.26, cover: 2436510, glue: 61824, merged: 319814, gap: 3.2104, gapDraft0: 3.1986, tinTriangles: 74904, boxX: 121.234, boxY: 142.435, Zt: 167.405 },
  // M11c. Mode B's merged base is the plate with the union of the 6 parts, and its cavity the union's.
  chick: { silicone: 11.41, cover: 134573, glue: 16190, merged: 33252, gap: 3.26, gapDraft0: 3.2601, tinTriangles: 12344, boxX: 68.456, boxY: 72.941, Zt: 32.026 },
};

/**
 * M4 numbers, at plan defaults in one tile. Leaves and the rest are read off the conditioned tile.
 * Limits: exact on the counts, 1% on the rest. Measured again after the M4 review, once a peak on a
 * flat went to the middle of that flat: Benchy's bores hold 0.457 -> 0.389 ml, VIS-35's 0.329 -> 0.2745,
 * and x8's 1.705 -> 1.573, with its longest bore 6.2 -> 7.75 mm (a vent beside the broken barrier's pour).
 */
export interface OpeningGolden {
  bodies: number;
  cavities: number;
  /** Merge-tree leaves over one height step. */
  leaves: number;
  /** Of those, at or over the default vent persistence of 1.5 mm. */
  significant: number;
  plateauBodies: number;
  pours: number;
  vents: number;
  /** The longest bore, from the flat top to the ceiling at its centre, in mm. */
  longestBore: number;
  /** Silicone in the bores, in ml: to the seat's floor for a pour and to the top for a vent. */
  boreMl: number;
  /** Volume of the cover once cut, in mm3. */
  cover: number;
}

export const OPENING_GOLDEN: Record<ExampleId, OpeningGolden> = {
  benchy: { bodies: 1, cavities: 1, leaves: 4, significant: 2, plateauBodies: 0, pours: 1, vents: 2, longestBore: 25.7, boreMl: 0.389, cover: 244416 },
  goddess: { bodies: 1, cavities: 1, leaves: 4, significant: 3, plateauBodies: 0, pours: 1, vents: 3, longestBore: 9.4, boreMl: 0.334, cover: 533995 },
  vis35: { bodies: 1, cavities: 1, leaves: 4, significant: 2, plateauBodies: 0, pours: 1, vents: 2, longestBore: 6.5, boreMl: 0.2745, cover: 1262706 },
  jersey: { bodies: 1, cavities: 1, leaves: 1, significant: 1, plateauBodies: 1, pours: 1, vents: 1, longestBore: 5.1, boreMl: 0.19, cover: 80372 },
  x8: { bodies: 8, cavities: 2, leaves: 16, significant: 9, plateauBodies: 7, pours: 8, vents: 9, longestBore: 7.75, boreMl: 1.573, cover: 311767 },
  barrel: { bodies: 1, cavities: 1, leaves: 1, significant: 1, plateauBodies: 1, pours: 1, vents: 1, longestBore: 5.8, boreMl: 0.206, cover: 74644 },
  wolf: { bodies: 1, cavities: 1, leaves: 2, significant: 2, plateauBodies: 0, pours: 1, vents: 2, longestBore: 147.3, boreMl: 1.049, cover: 2435148 },
  chick: { bodies: 1, cavities: 1, leaves: 1, significant: 1, plateauBodies: 0, pours: 1, vents: 1, longestBore: 9.99, boreMl: 0.344, cover: 133906 },
};

/**
 * M7: S8 and the demold report at defaults, analysis cell 0.25, smallest reported volume 0.05 ml,
 * smallest island 5 mm2, underside persistence 0.3 mm. Volumes in ml. `footprints` counts the patches
 * each body stands on past the island filter, so 2 or more is a loop lock; patches the plate's sealed
 * air joins are one, as Benchy's lettering joins its hull's two. `looped` counts sandwiched bodies past
 * the filter that hold the model in a loop: 2 or more mouths, or 2 or more walls, as round Benchy's cabin
 * posts. `raw` is S8 before any filter, which shows the tiny hits the reports leave out. Frozen at M7; a
 * change over 5% fails until reviewed.
 */
export interface ReportGolden {
  verdict: 'plausible' | 'jacket-out' | 'cut-required';
  bodies: number;
  footprints: number[];
  underPlugMl: number;
  sandwichedMl: number;
  hints: number;
  looped: number;
  /** Air pockets under the model past both filters. */
  undersideMl: number[];
  /** Sealed space past the volume filter, and whether it is a void of the model itself. */
  sealed: { ml: number; inModel: boolean }[];
  raw: { pockets: number; sealed: number };
}

export const REPORT_GOLDEN: Record<ExampleId, ReportGolden> = {
  benchy: { verdict: 'cut-required', bodies: 1, footprints: [1], underPlugMl: 6.942, sandwichedMl: 8.48, hints: 3, looped: 1, undersideMl: [0.523], sealed: [], raw: { pockets: 2, sealed: 8 } },
  goddess: { verdict: 'cut-required', bodies: 1, footprints: [1], underPlugMl: 24.879, sandwichedMl: 16.68, hints: 3, looped: 2, undersideMl: [], sealed: [], raw: { pockets: 20, sealed: 2 } },
  vis35: { verdict: 'cut-required', bodies: 1, footprints: [1], underPlugMl: 262.361, sandwichedMl: 29.163, hints: 9, looped: 4, undersideMl: [], sealed: [], raw: { pockets: 0, sealed: 0 } },
  jersey: { verdict: 'plausible', bodies: 1, footprints: [1], underPlugMl: 0, sandwichedMl: 0, hints: 0, looped: 0, undersideMl: [], sealed: [], raw: { pockets: 0, sealed: 0 } },
  x8: { verdict: 'plausible', bodies: 8, footprints: [1, 1, 1, 1, 1, 1, 1, 1], underPlugMl: 0, sandwichedMl: 0, hints: 0, looped: 0, undersideMl: [], sealed: [], raw: { pockets: 0, sealed: 0 } },
  barrel: { verdict: 'jacket-out', bodies: 1, footprints: [1], underPlugMl: 1.035, sandwichedMl: 0.218, hints: 2, looped: 0, undersideMl: [], sealed: [{ ml: 3.432, inModel: true }], raw: { pockets: 0, sealed: 1 } },
  wolf: { verdict: 'cut-required', bodies: 1, footprints: [3], underPlugMl: 66.167, sandwichedMl: 14.727, hints: 16, looped: 2, undersideMl: [], sealed: [], raw: { pockets: 71, sealed: 18 } },
  // M11c: S8 reads the 6 parts as one shell of 16,814.9 mm3 on one patch of 1,216.6 mm2. Its silicone past
  // the filter is none: the largest under-plug body is 0.026 ml.
  chick: { verdict: 'plausible', bodies: 1, footprints: [1], underPlugMl: 0, sandwichedMl: 0, hints: 0, looped: 0, undersideMl: [], sealed: [], raw: { pockets: 2, sealed: 0 } },
};

/**
 * M10, bolts on at plan defaults (M3, auto length 12 mm), one tile, export cell. The box is M3's grown by
 * twice the outer land the bolts add, 2 x (6.146 - 2) = 8.292 mm each way, and Zt is M3's: on every
 * example the joint's top already leaves the bolts their wall. Volumes in mm3, at 1%; `slotFloor` is
 * where the bridge sits, a whole number of layers under Zt; `cavity` and `notches` are the least walls the
 * bolts' cuts leave to them, the cavity's read off the export field, at 1%.
 */
export interface BoltGolden {
  cover: number;
  glue: number;
  merged: number;
  boxX: number;
  boxY: number;
  slotFloor: number;
  cavity: number;
  notches: number;
}

export const BOLT_GOLDEN: Record<ExampleId, BoltGolden> = {
  benchy: { cover: 318114, glue: 21962, merged: 37638, boxX: 97.217, boxY: 68.172, slotFloor: 2.8162, cavity: 11.735, notches: 31.82 },
  goddess: { cover: 692365, glue: 27462, merged: 116363, boxX: 101.551, boxY: 80.178, slotFloor: 2.8159, cavity: 12.529, notches: 33.937 },
  vis35: { cover: 1612190, glue: 60464, merged: 305145, boxX: 71.889, boxY: 238.882, slotFloor: 2.7023, cavity: 12.677, notches: 102.111 },
  jersey: { cover: 111534, glue: 13817, merged: 21929, boxX: 86.038, boxY: 51.427, slotFloor: 2.8846, cavity: 7.962, notches: 26.409 },
  x8: { cover: 378402, glue: 63135, merged: 123998, boxX: 152.038, boxY: 117.427, slotFloor: 2.8846, cavity: 7.962, notches: 58.877 },
  barrel: { cover: 106074, glue: 11057, merged: 18591, boxX: 59.979, boxY: 59.98, slotFloor: 2.7183, cavity: 12.503, notches: 14.214 },
  wolf: { cover: 2813521, glue: 70122, merged: 328112, boxX: 129.526, boxY: 150.727, slotFloor: 2.8052, cavity: 21.64, notches: 58.219 },
  chick: { cover: 173821, glue: 20432, merged: 37494, boxX: 76.748, boxY: 81.233, slotFloor: 2.826, cavity: 14.685, notches: 24.088 },
};
