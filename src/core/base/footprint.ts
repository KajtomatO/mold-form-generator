import type { CrossSection, SimplePolygon, Vec2 } from 'manifold-3d';
import type { WeldedMesh } from '../mesh/weld';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { LEVEL_FLOOR, type BaseCandidate } from './candidates';

/** Wide enough to close T-junction gaps in a float32 mesh, too narrow to merge separate feet. */
const CLOSE_GAP = 0.01;

export interface FootprintComponent {
  area: number;
  min: Vec2;
  max: Vec2;
  /** Holes inside the outline, which are kept. */
  holes: number;
  /** Outer contour counter-clockwise, holes clockwise, as ofPolygons reads them back. */
  polygons: SimplePolygon[];
}

export interface Footprint {
  /** Components at least minIsland in size, largest first. */
  components: FootprintComponent[];
  /** Components too small to keep, largest first, listed in Diagnostics. */
  islands: FootprintComponent[];
  /** Area of `components`. */
  area: number;
  /** Area of `components` and `islands`, for comparing against the projected triangles. */
  rawArea: number;
  /** Summed projected area of the input triangles, the independent reference for rawArea. */
  projectedArea: number;
  diagnostics: Diagnostic[];
}

function signedArea(polygon: readonly Vec2[]): number {
  let doubled = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    doubled += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return doubled / 2;
}

/**
 * A hole used as base has no triangles to union, so its rim stands in for the missing face. Seen
 * from above, the largest rim runs counter-clockwise. A rim with its cap the other way runs
 * clockwise, as it is the outline of a recess in the missing face, which keeps it a hole in the union.
 */
function holeContours(oriented: WeldedMesh, holes: BaseCandidate['holes']): Vec2[][] {
  const p = oriented.positions;
  return holes.map((hole) => {
    const rim = Array.from(hole.vertices, (v): Vec2 => [p[v * 3], p[v * 3 + 1]]);
    const [x, y, z] = holes[0].capNormal;
    const [cx, cy, cz] = hole.capNormal;
    const wantedSign = cx * x + cy * y + cz * z >= 0 ? 1 : -1;
    return Math.sign(signedArea(rim)) === wantedSign ? rim : rim.reverse();
  });
}

/**
 * G2 footprint: union the plane's triangles, close T-junction gaps, drop small islands and keep
 * real holes. It uses only triangles, so it works in soup mode too. `cap` adds the section of a
 * trimmed solid: moving the plane up to a higher level turns the pad below into footprint.
 */
export function buildFootprint(arena: Arena, oriented: WeldedMesh, candidate: Pick<BaseCandidate, 'members' | 'holes'>, minIsland: number, cap?: CrossSection): Footprint {
  const { positions: p, indices } = oriented;
  const contours: SimplePolygon[] = [];
  let projectedArea = 0;
  for (const t of candidate.members) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
    const doubled = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (doubled === 0) continue;
    projectedArea += Math.abs(doubled) / 2;
    // Base faces wind clockwise seen from above. Union needs one winding, or folds cancel out.
    contours.push(doubled > 0 ? [[ax, ay], [bx, by], [cx, cy]] : [[ax, ay], [cx, cy], [bx, by]]);
  }
  for (const rim of holeContours(oriented, candidate.holes)) {
    projectedArea += signedArea(rim);
    contours.push(rim);
  }

  const { track, trackAll } = arena;
  const union = arena.crossSection(contours, 'Positive');
  const merged = cap ? track(union.add(cap)) : union;
  // Miter keeps corners sharp on the way out, so the way back returns to the same outline.
  const closed = track(track(merged.offset(CLOSE_GAP, 'Miter')).offset(-CLOSE_GAP, 'Miter'));

  const all = trackAll(closed.decompose())
    .map((part): FootprintComponent => {
      const { min, max } = part.bounds();
      return { area: part.area(), min: [...min], max: [...max], holes: part.numContour() - 1, polygons: arena.polygons(part) };
    })
    .sort((x, y) => y.area - x.area);

  const components = all.filter((c) => c.area >= minIsland);
  const islands = all.filter((c) => c.area < minIsland);
  const diagnostics: Diagnostic[] = [];
  if (islands.length > 0) {
    const areas = islands.map((c) => c.area.toFixed(2)).join(', ');
    diagnostics.push({
      code: 'footprint-islands',
      severity: 'info',
      message: `${islands.length} footprint islands smaller than ${minIsland} mm2 were dropped: ${areas} mm2.`,
    });
  }
  if (components.length === 0 && islands.length > 0) {
    // A model on small feet only: glue mode would silently get a base with no pocket at all.
    diagnostics.push({
      code: 'footprint-empty',
      severity: 'warning',
      message: `Every part of this base is smaller than the ${minIsland} mm2 island limit, so the base would have no pocket; lower the limit to keep them.`,
    });
  }
  return {
    components,
    islands,
    area: components.reduce((sum, c) => sum + c.area, 0),
    rawArea: all.reduce((sum, c) => sum + c.area, 0),
    projectedArea,
    diagnostics,
  };
}

function contains(polygon: SimplePolygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Vec2, [xj, yj] = polygon[j] as Vec2;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface UpperLevel {
  /** Height above the chosen plane, in mm. */
  gap: number;
  offset: number;
  /** Level area outside every base outline, where silicone can run under the model. */
  exposedArea: number;
  /** Level area inside an outline: the floor of a recess, closed off once the base is seated. */
  enclosedArea: number;
}

export interface LevelReport {
  levels: UpperLevel[];
  /** What "Use upper level" moves to, or null if no level needs it. */
  useUpper: UpperLevel | null;
  diagnostics: Diagnostic[];
}

/**
 * G2.6, placed against the footprint. A level outside the base outline stands open to the cavity,
 * so silicone reaches it. A level in a hole of the outline is a recess, such as lettering cut into
 * the underside, and the surrounding face seals it, so trimming the whole base to it helps nothing.
 */
export function classifyLevels(oriented: WeldedMesh, candidate: BaseCandidate, footprint: Footprint, planeTol: number): LevelReport {
  const { positions: p, indices } = oriented;
  // A hole's contour lies inside its outline, so a point in any contour is inside an outline.
  const contours = [...footprint.components, ...footprint.islands].flatMap((c) => c.polygons);
  const levels: UpperLevel[] = [];
  for (const level of candidate.levels) {
    if (level.offset <= candidate.offset + planeTol) continue;
    const gap = level.offset - candidate.offset;
    let exposedArea = 0, enclosedArea = 0;
    for (let t = 0; t < indices.length / 3; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      if (Math.abs(p[a + 2] - gap) > planeTol || Math.abs(p[b + 2] - gap) > planeTol || Math.abs(p[c + 2] - gap) > planeTol) continue;
      const area = Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
      const x = (p[a] + p[b] + p[c]) / 3, y = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      if (contours.some((contour) => contains(contour, x, y))) enclosedArea += area;
      else exposedArea += area;
    }
    levels.push({ gap, offset: level.offset, exposedArea, enclosedArea });
  }

  let useUpper: UpperLevel | null = null;
  for (const level of levels) {
    if (level.exposedArea >= LEVEL_FLOOR && (!useUpper || level.exposedArea > useUpper.exposedArea)) useUpper = level;
  }
  const diagnostics: Diagnostic[] = [];
  if (useUpper) {
    diagnostics.push({
      code: 'upper-level',
      severity: 'warning',
      message: `A ${useUpper.exposedArea.toFixed(0)} mm2 flat level sits ${useUpper.gap.toFixed(2)} mm above this plane, so a film of silicone will enter that gap unless you use the upper level.`,
    });
  }
  for (const level of levels) {
    if (level.enclosedArea < LEVEL_FLOOR || level === useUpper) continue;
    diagnostics.push({
      code: 'recess-level',
      severity: 'info',
      message: `A ${level.enclosedArea.toFixed(0)} mm2 flat level sits ${level.gap.toFixed(2)} mm above this plane inside holes in the base outline, so no silicone reaches it once the base is seated.`,
    });
  }
  return { levels, useUpper, diagnostics };
}
