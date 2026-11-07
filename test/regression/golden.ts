import type { ExampleId } from '../fixtures/loadExamples';

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
  solidVolume: number;
  voidVolume: number;
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
    planeTol: 0.1079,
    planeZ: 0.1413,
    baseArea: 2811.2,
    footprints: [2489.2, 159.7, 152.3],
    islands: [3.03, 1.83, 1.74, 1.45, 0.95, 0.95],
    upper: { offset: 0.917, area: 108.5, exposed: false },
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
   * filter at analysisCell 0.25. No bores yet, as M4 adds them.
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
  planEstimate: number;
  /** The plan's M2 check at the bare settings. */
  planBare: number;
}

export const FIELD_GOLDEN: Record<ExampleId, FieldGolden> = {
  benchy: { silicone: 42.82, bare: 39.64, bareOffLattice: 39.06, planEstimate: 43, planBare: 39.8 },
  goddess: { silicone: 117.67, bare: 102.72, bareOffLattice: 101.52, planEstimate: 118, planBare: 103 },
  vis35: { silicone: 541.13, bare: 478.54, bareOffLattice: 467.93, planEstimate: 544, planBare: 485 },
  jersey: { silicone: 11.17, bare: 9.89, bareOffLattice: 9.54, planEstimate: 11.8, planBare: 10.3 },
  x8: { silicone: 86.02, bare: 75.58, bareOffLattice: 73.02, planEstimate: 92, planBare: 79.3 },
  barrel: { silicone: 10.06, bare: 8.87, bareOffLattice: 8.82, planEstimate: 10.2, planBare: 9.0 },
  wolf: { silicone: 202.48, bare: 182.83, bareOffLattice: 182.03, planEstimate: 208, planBare: 186 },
};
