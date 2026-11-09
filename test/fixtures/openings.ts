import type { Manifold } from 'manifold-3d';
import { findBodies, type BodySearch } from '../../src/core/analysis/bodies';
import { placementSettings, placeOpenings, replicateOpenings, type OpeningPin, type Placement } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace, type PlacementSpace } from '../../src/core/analysis/validate';
import { buildField, type BuiltField } from '../../src/core/field/build';
import { fieldSettings, planField, type Field, type FieldPlan, type FieldSettings } from '../../src/core/field/grid';
import type { Bounds, WeldedMesh } from '../../src/core/mesh/weld';
import type { Params } from '../../src/core/params/schema';
import { buildCoverFinal } from '../../src/core/parts/cover';
import type { CutOpening } from '../../src/core/parts/openings';
import { deriveRim, moldBounds, type MoldBounds, type Rim } from '../../src/core/parts/rim';
import type { Arena } from '../../src/core/solid/arena';
import type { Mold } from './mold';

export interface PlanOptions {
  pins?: OpeningPin[];
  removed?: string[];
  /** Field cell, when it should not be the export cell. */
  cell?: number;
}

export interface PlannedOpenings {
  settings: FieldSettings;
  tilePlan: FieldPlan;
  /** The single conditioned tile S7 places on. */
  tile: Field;
  built: BuiltField;
  mold: MoldBounds;
  rim: Rim;
  search: BodySearch;
  space: PlacementSpace;
  placement: Placement;
  /** In ms: S3 to S6 of the export field, the single tile's own field (0 when the mold is one tile), and S7. */
  timings: { field: number; tile: number; placement: number };
}

/** S3 to S7 with S10, none of it touching Manifold: what field.worker will run, in that order. */
export function planOpenings(mesh: WeldedMesh, bounds: Bounds, params: Params, options: PlanOptions = {}): PlannedOpenings {
  const t0 = performance.now();
  const settings = fieldSettings(params, bounds, options.cell);
  const plan = planField(bounds, settings);
  const mold = moldBounds(mesh, bounds, settings);
  const built = buildField(mesh, plan, settings, undefined, mold.D);
  const t1 = performance.now();
  const single = { ...settings, nx: 1, ny: 1 };
  const tilePlan = planField(bounds, single);
  const tile = plan.nx === 1 && plan.ny === 1 ? built.plain : buildField(mesh, tilePlan, single).field;
  const t2 = performance.now();
  const rim = deriveRim(mold, params);
  const opening = placementSettings(params, bounds);
  const search = findBodies(mesh, tilePlan, tile, single, opening);
  const space = placementSpace(built.field, rim, mold.offsets, openingSizes(params));
  const placement = placeOpenings({ bodies: search.bodies, tile, space, settings: opening, pins: options.pins, removed: options.removed });
  const timings = { field: t1 - t0, tile: plan.nx === 1 && plan.ny === 1 ? 0 : t2 - t1, placement: performance.now() - t2 };
  return { settings, tilePlan, tile, built, mold, rim, search, space, placement, timings };
}

export interface OpenedMold {
  planned: PlannedOpenings;
  copies: CutOpening[];
  cover: Manifold;
  /** The boolean alone, in ms. */
  cutMs: number;
}

/** S7 and S13 on a mold already built: the openings placed on its own field, and cut from its cover body. */
export function openMold(arena: Arena, m: Mold, params: Params, options: PlanOptions = {}): OpenedMold {
  const planned = planOpenings(m.oriented.mesh, m.bounds, params, options);
  const copies = replicateOpenings(planned.placement.openings, planned.space);
  const t0 = performance.now();
  const cover = buildCoverFinal(arena, m.cover, m.rim, copies);
  return { planned, copies, cover, cutMs: performance.now() - t0 };
}
