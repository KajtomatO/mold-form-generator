import type { WeldedMesh } from '../mesh/weld';
import type { Diagnostic } from '../report/diagnostics';
import { countCavities, tileWalls, type CavityCount } from './cavities';
import { applyClosing } from './closing';
import { compositeTiles } from './composite';
import { dilate } from './dilate';
import { applyDraft } from './draft';
import type { Field, FieldPlan, FieldSettings } from './grid';
import { rasterize } from './raster';

export interface StageTimings {
  raster: number;
  dilate: number;
  composite: number;
  draft: number;
  closing: number;
  cavities: number;
  /** The check between tiles, which only a real grid needs. */
  wall: number;
}

export interface BuiltField {
  /** The conditioned composite. */
  field: Field;
  cavities: CavityCount;
  /** Thinnest plastic keeping tiles apart in mm, or null when no wall separates them. */
  minWall: number | null;
  /** The cavities of neighbouring tiles join, so no wall stands between them there. */
  tilesMerged: boolean;
  diagnostics: Diagnostic[];
  timings: StageTimings;
}

export interface Conditioned {
  field: Field;
  draftMs: number;
  closingMs: number;
}

/**
 * S6: draft, then closing, on a copy. For one tile the composite is the tile itself, and a stage
 * cache keeps S4 and S5 to condition again, so a draft slider moved down must start from them.
 */
export function conditionField(composite: Field, settings: Pick<FieldSettings, 'draftDeg' | 'closeWidth'>, now: () => number = () => 0): Conditioned {
  const field: Field = { ...composite, values: composite.values.slice() };
  const t0 = now();
  applyDraft(field, settings.draftDeg);
  const t1 = now();
  applyClosing(field, settings.closeWidth);
  return { field, draftMs: t1 - t0, closingMs: now() - t1 };
}

/**
 * S3 to S6 in one go, with the checks on the result. M5's stage cache will call the same steps one
 * by one. `now` comes from the caller, as core has no clock.
 */
export function buildField(mesh: WeldedMesh, plan: FieldPlan, settings: FieldSettings, now: () => number = () => 0): BuiltField {
  const t0 = now();
  const raster = rasterize(mesh, plan.tile);
  const t1 = now();
  const tile = dilate(raster, plan.rEff);
  const t2 = now();
  const { field: composite, owners } = compositeTiles(tile, plan);
  const t3 = now();
  const { field, draftMs, closingMs } = conditionField(composite, settings, now);
  const t4 = now();
  const cavities = countCavities(field);
  const t5 = now();

  const { minWall, merged } = owners ? tileWalls(field, owners) : { minWall: null, merged: false };
  const t6 = now();
  const { requiredWall, spacing, autoSpacing } = plan;
  const diagnostics = [...plan.diagnostics];
  if (merged) {
    diagnostics.push({
      code: 'tiles-merged',
      severity: 'warning',
      message: `Spacing ${spacing.toFixed(1)} mm leaves no wall between neighbouring models, so their cavities join into one; a spacing of ${autoSpacing.toFixed(1)} mm keeps them apart.`,
    });
  }
  if (minWall !== null && minWall < requiredWall) {
    diagnostics.push({
      code: 'thin-tile-wall',
      severity: 'warning',
      message: `Spacing ${spacing.toFixed(1)} mm leaves a plastic wall of ${minWall.toFixed(2)} mm between models, under the ${requiredWall.toFixed(1)} mm it needs; a spacing of ${autoSpacing.toFixed(1)} mm keeps it printable.`,
    });
  }
  return {
    field,
    cavities,
    minWall,
    tilesMerged: merged,
    diagnostics,
    timings: { raster: t1 - t0, dilate: t2 - t1, composite: t3 - t2, draft: draftMs, closing: closingMs, cavities: t5 - t4, wall: t6 - t5 },
  };
}
