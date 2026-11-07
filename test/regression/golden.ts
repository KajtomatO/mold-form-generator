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
