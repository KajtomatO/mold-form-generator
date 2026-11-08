import type { CrossSection, Manifold, SimplePolygon, Vec2 } from 'manifold-3d';
import type { Footprint, FootprintComponent } from '../base/footprint';
import { orientSolid, trimToBase, type OrientedModel } from '../base/orient';
import type { ImportedSolid } from '../mesh/shells';
import type { WeldedMesh } from '../mesh/weld';
import type { Diagnostic } from '../report/diagnostics';
import { auditOverhang } from '../report/overhang';
import { checked, type Arena } from '../solid/arena';
import { outset } from '../solid/rect';
import { baseBoltCutters } from './bolts';
import { ridgeSolid, ringHull } from './joint';
import type { Rim } from './rim';

const POCKET_SEGMENTS = 32;
/** How far the pocket's cut runs above the plate, so the two share no plane. */
const POCKET_HEADROOM = 1;
/** G10: a stub stops short of the footprint's edge and starts this far down in the plate. */
const STUB_INSET = 0.05;
const STUB_BOTTOM = -0.4;
const STUB_RISE = 0.05;

export interface BaseBodyOptions {
  /**
   * Height of the plate's top. Only the closed-volume check moves it, by a hair above the cover's
   * shelf at 0, so the union overlaps for real instead of touching.
   */
  plateTop?: number;
}

/** G10, S14: plate and ridge. Flat underside, with the relief around it against first-layer squish. With bolts, their countersunk holes. */
export function buildBaseBody(arena: Arena, rim: Rim, options: BaseBodyOptions = {}): Manifold {
  const { B, Tb, tanTaper, cornerRadius, reliefHeight, reliefRun } = rim;
  const plateTop = options.plateTop ?? 0;
  // The corners move with the sides, so the taper has one slant all the way round.
  const spread = (Tb - reliefHeight) * tanTaper;
  const plate = ringHull(arena, [
    { rect: outset(B, -plateTop * tanTaper), radius: Math.max(0, cornerRadius - plateTop * tanTaper), z: plateTop },
    { rect: outset(B, spread), radius: cornerRadius + spread, z: reliefHeight - Tb },
    { rect: outset(B, spread - reliefRun), radius: Math.max(0, cornerRadius + spread - reliefRun), z: -Tb },
  ]);
  const body = arena.track(plate.add(ridgeSolid(arena, rim)));
  if (!rim.bolts) return checked(body, 'The base body');
  return checked(arena.track(arena.api.Manifold.difference([body, ...baseBoltCutters(arena, rim.bolts)])), 'The base body');
}

function sectionOf(arena: Arena, components: FootprintComponent[]): CrossSection {
  return arena.crossSection(components.flatMap((c) => c.polygons), 'NonZero');
}

/** The footprint kept after the island filter, as one section. Empty if the filter took all of it. */
export function footprintSection(arena: Arena, footprint: Footprint): CrossSection {
  return sectionOf(arena, footprint.components);
}

/**
 * The model's outline at height z from its triangles alone, for an open mesh with no solid to slice.
 * Each crossing edge gets one point, so neighbouring triangles share it and the segments chain into
 * loops. A hole leaves a run with two ends, which gets closed straight across.
 */
export function triangleContour(arena: Arena, mesh: WeldedMesh, z: number): CrossSection {
  const { positions: p, indices } = mesh;
  const count = p.length / 3;
  const crossing = (a: number, b: number): { key: number; point: Vec2 } => {
    const low = Math.min(a, b), high = Math.max(a, b);
    const za = p[low * 3 + 2], zb = p[high * 3 + 2];
    const f = (z - za) / (zb - za);
    return { key: low * count + high, point: [p[low * 3] + f * (p[high * 3] - p[low * 3]), p[low * 3 + 1] + f * (p[high * 3 + 1] - p[low * 3 + 1])] };
  };
  const links = new Map<number, number[]>();
  const points = new Map<number, Vec2>();
  for (let t = 0; t < indices.length; t += 3) {
    const found: { key: number; point: Vec2 }[] = [];
    for (let c = 0; c < 3; c++) {
      const a = indices[t + c], b = indices[t + ((c + 1) % 3)];
      // A corner exactly on the plane counts as above, on both triangles that share it.
      if (p[a * 3 + 2] >= z !== p[b * 3 + 2] >= z) found.push(crossing(a, b));
    }
    if (found.length !== 2) continue;
    const [s, e] = found;
    points.set(s.key, s.point);
    points.set(e.key, e.point);
    if (!links.has(s.key)) links.set(s.key, []);
    if (!links.has(e.key)) links.set(e.key, []);
    links.get(s.key)!.push(e.key);
    links.get(e.key)!.push(s.key);
  }

  const seen = new Set<number>();
  const contours: SimplePolygon[] = [];
  // Open ends first, so a run is walked from one end to the other rather than from its middle.
  const starts = [...[...links.keys()].filter((key) => links.get(key)!.length === 1), ...links.keys()];
  for (const start of starts) {
    if (seen.has(start)) continue;
    const contour: Vec2[] = [];
    let at: number | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      contour.push(points.get(at)!);
      at = links.get(at)!.find((next) => !seen.has(next));
    }
    if (contour.length >= 3) contours.push(contour);
  }
  return arena.crossSection(contours, 'EvenOdd');
}

function wholeLayers(value: number, layer: number): boolean {
  return Math.abs(value / layer - Math.round(value / layer)) < 1e-6;
}

/** G10: a slicer rounds what is not whole layers, so a pocket can print a layer off or not at all. */
export function layerDiagnostics(thickness: number, pocketDepth: number, layerHeight: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!wholeLayers(thickness, layerHeight)) {
    diagnostics.push({ code: 'base-layers', severity: 'warning', message: `Base thickness ${thickness} mm is not a whole number of ${layerHeight} mm layers, so the slicer will round it.` });
  }
  if (!wholeLayers(pocketDepth, layerHeight)) {
    diagnostics.push({ code: 'pocket-layers', severity: 'warning', message: `Pocket depth ${pocketDepth} mm is not a whole number of ${layerHeight} mm layers, so it may print a layer off, or not at all.` });
  }
  return diagnostics;
}

/**
 * G10: the pocket's outline, from the footprint plus the model's section at the pocket's top, as a
 * model that widens just above its base must still drop in. `section` is the solid's slice, or
 * triangleContour in soup mode.
 */
export function pocketOutline(arena: Arena, footprint: Footprint, section: CrossSection, enlarge: number): CrossSection {
  const whole = arena.track(footprintSection(arena, footprint).add(section));
  return enlarge > 0 ? arena.track(whole.offset(enlarge, 'Round', undefined, POCKET_SEGMENTS)) : whole;
}

export interface GlueBase {
  base: Manifold;
  /** One pocket's volume under z = 0, from its outline. */
  pocketVolume: number;
  diagnostics: Diagnostic[];
}

/** G10, S15 Mode A: plate and ridge, less one pocket per tile. */
export function buildGlueBase(arena: Arena, body: Manifold, outline: CrossSection, depth: number, offsets: readonly [number, number][]): GlueBase {
  const { track } = arena;
  // Manifold calls the extrusion of nothing an invalid construction, and a boolean would pass that on.
  if (outline.isEmpty()) {
    const message = 'This base gets no pocket, as the model has no footprint and no section at the pocket\'s depth, so nothing will locate it when glued.';
    return { base: body, pocketVolume: 0, diagnostics: [{ code: 'pocket-empty', severity: 'warning', message }] };
  }
  const prism = track(arena.extrude(outline, depth + POCKET_HEADROOM).translate([0, 0, -depth]));
  const pockets = offsets.map(([x, y]) => track(prism.translate([x, y, 0])));
  const base = checked(track(body.subtract(track(arena.api.Manifold.union(pockets)))), 'The base');
  return { base, pocketVolume: outline.area() * depth, diagnostics: [] };
}

/**
 * The model as Mode B and model_oriented.stl want it: rigidly placed, cut at the plane if anything
 * lies below it. Null in soup mode, as there is no solid to do this with.
 */
export function orientedSolid(arena: Arena, imported: Pick<ImportedSolid, 'solid'>, oriented: Pick<OrientedModel, 'transform' | 'needsTrim'>): Manifold | null {
  if (!imported.solid) return null;
  const placed = orientSolid(arena, imported.solid, oriented.transform);
  return oriented.needsTrim ? trimToBase(arena, placed) : placed;
}

export interface MergedBase {
  /** Null when Mode B is not available for this mesh. */
  base: Manifold | null;
  /** Sealed air filled in, in mm3 over the whole mold: voids in the model, and recesses the plate closes off. */
  filledVoid: number;
  /** Faces of the printed model steeper than 45 degrees in print pose, in mm2 per tile: not the plate's fault. */
  modelOverhangArea: number;
  diagnostics: Diagnostic[];
}

/**
 * Shells this small are not parts: a model's flat underside lying on the plate's top can leave a sheet
 * with no volume, or a void that thin, where the two faces meet. It would count as a stray body.
 */
const CRUMB_MM3 = 1e-3;

export interface MergedOptions {
  planeTol: number;
  offsets: readonly [number, number][];
}

/** G10, S15 Mode B: plate, ridge, the tiled models and stubs that tie them to the plate. */
export function buildMergedBase(arena: Arena, body: Manifold, model: Manifold | null, footprint: Footprint, options: MergedOptions): MergedBase {
  const { track, trackAll } = arena;
  const { Manifold: M } = arena.api;
  if (!model) {
    return {
      base: null,
      filledVoid: 0,
      modelOverhangArea: 0,
      diagnostics: [{ code: 'mode-b-disabled', severity: 'error', message: 'Merged mode needs a closed solid, and this mesh is open, so please use glue mode or repair the file.' }],
    };
  }
  const diagnostics: Diagnostic[] = [];

  const parts = trackAll(model.decompose());
  const whole = track(M.union(parts.filter((part) => part.volume() > 0)));

  // Feet too small for the footprint still stand on the plate, and within planeTol they can sit a hair
  // above it. So when the filter took everything, they get the stubs and the warning stays for real strays.
  const tied = footprint.components.length > 0 ? footprint.components : footprint.islands;
  const shrunk = track(sectionOf(arena, tied).offset(-STUB_INSET, 'Miter'));
  const stubs: Manifold[] = [];
  if (!shrunk.isEmpty()) {
    const stub = track(arena.extrude(shrunk, options.planeTol + STUB_RISE - STUB_BOTTOM).translate([0, 0, STUB_BOTTOM]));
    stubs.push(stub);
  }
  const copies = options.offsets.flatMap(([x, y]) => [whole, ...stubs].map((part) => track(part.translate([x, y, 0]))));
  const merged = checked(track(M.union([body, ...copies])), 'The merged base');

  // Air no silicone reaches has no use inside a printed part: the model's own voids went above, and
  // here go recesses in its underside that the plate has closed off, such as Benchy's lettering.
  const shells = trackAll(merged.decompose());
  const bodies = shells.filter((shell) => shell.volume() >= CRUMB_MM3);
  const recesses = shells.reduce((sum, shell) => sum + Math.min(0, shell.volume()), 0);
  const voids = parts.reduce((sum, part) => sum + Math.min(0, part.volume()), 0);
  const filledVoid = -(voids * options.offsets.length + recesses);
  if (filledVoid >= CRUMB_MM3) {
    diagnostics.push({ code: 'void-filled', severity: 'info', message: `Merged mode fills ${filledVoid.toFixed(0)} mm3 of sealed space in and under the model, which silicone cannot reach.` });
  }
  if (bodies.length > 1) {
    const loose = bodies.length - 1;
    const message = loose === 1 ? 'One part of this model does not touch the plate, so it would print as a loose piece.' : `${loose} parts of this model do not touch the plate, so they would print as loose pieces.`;
    diagnostics.push({ code: 'merged-bodies', severity: 'warning', message });
  }
  // compose keeps positive shells only, which is what fills those voids in the file.
  const base = bodies.length === 1 ? bodies[0] : track(M.compose(bodies));

  // Read off the final part, as a recess filled above has no ceiling left to print. The faces on the
  // plane sit on the plate, not over air, and above it the ridge only faces up, so what is left is the model.
  const mesh = base.getMesh();
  const { steepArea } = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }, { only: (_x, _y, z) => z > options.planeTol + STUB_RISE });
  const modelOverhangArea = steepArea / options.offsets.length;
  // Under half a mm2 would read as 0 mm2 needing supports: slivers of the mesh, not an overhang to print.
  if (modelOverhangArea >= 0.5) {
    diagnostics.push({ code: 'model-overhang', severity: 'info', message: `The model itself has ${modelOverhangArea.toFixed(0)} mm2 of overhang past 45 degrees per copy, which needs supports when it is printed on the base.` });
  }
  return { base, filledVoid, modelOverhangArea, diagnostics };
}
