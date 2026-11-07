import { transformPositions, type RigidTransform } from '../core/base/orient';
import { buildField } from '../core/field/build';
import { fieldSettings, planField } from '../core/field/grid';
import { meshBounds, type WeldedMesh } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import type { Diagnostic } from '../core/report/diagnostics';

/** What the walls between tiles come to on the export field, which a coarse preview cannot tell (G6). */
export interface WallCheck {
  /** Thinnest plastic between tiles in mm, or null where no wall stands between them. */
  minWall: number | null;
  merged: boolean;
  requiredWall: number;
  /** The cell it ran at: the export cell, unless the node cap raised it. */
  cell: number;
  /** The export field's own: thin wall, merged tiles, and a cell raised past the node cap. */
  diagnostics: Diagnostic[];
  ms: number;
}

export interface WallInputs {
  /** The mesh S2 oriented, which is the import's when it changed the welded one. */
  mesh: WeldedMesh;
  transform: RigidTransform;
}

/** The export's own field, built as T3 builds it before any raise of the margin, with its wall check. */
export function checkWalls(params: Params, inputs: WallInputs, now: () => number): WallCheck {
  const t0 = now();
  const mesh: WeldedMesh = { positions: transformPositions(inputs.mesh.positions, inputs.transform), indices: inputs.mesh.indices };
  const bounds = meshBounds(mesh.positions);
  const settings = fieldSettings(params, bounds);
  const plan = planField(bounds, settings);
  const built = buildField(mesh, plan, settings);
  return { minWall: built.minWall, merged: built.tilesMerged, requiredWall: plan.requiredWall, cell: plan.cell, diagnostics: built.diagnostics, ms: now() - t0 };
}
