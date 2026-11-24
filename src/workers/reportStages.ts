import { analyseIntervals, analysisCellProblem, type IntervalReport } from '../core/analysis/intervals';
import type { UncoveredLeaf } from '../core/analysis/placement';
import { geometryReports, type GeometryReports } from '../core/analysis/reports';
import { transformPositions, type RigidTransform } from '../core/base/orient';
import type { Field } from '../core/field/grid';
import type { WeldedMesh } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import type { Rim } from '../core/parts/rim';
import type { StageId } from '../app/stages';
import { InlineError, StageMiss } from './fieldStages';
import { effectiveParams } from '../core/mold/types';
import { meshBounds } from '../core/mesh/weld';
import { fieldSettings, planField } from '../core/field/grid';
import { moldSilicone, sealedAirOf } from '../core/field/silicone';
import { buildField } from '../core/field/build';
import { moldBounds } from '../core/parts/rim';
import { chooseFor, prepareClamshell } from '../core/field/clamshell';

/** What S8 and S9 need from main. The mesh rides along only while the worker lacks S8. */
export interface ReportsInputs {
  /** The mesh S2 oriented, in the file's own coordinates, with S2's transform. */
  mesh: WeldedMesh | null;
  transform: RigidTransform;
  /** The conditioned composite on screen, with its plan's raise, rim and tile count. */
  field: Field;
  raise: number;
  rim: Rim;
  tiles: number;
  ceiling: { leaves: number; uncovered: UncoveredLeaf[] };
  /**
   * MP5: the other mold type's silicone, worked out lazily here, after the preview: the two-part cover's from G13.3's
   * coarse fields while the one-piece cover is on screen, or the one-piece cover's H at the preview cell while the
   * two-part cover is, each at `params`, the settings a switch would give. Null where the other type is not offered.
   */
  estimate: { kind: 'two-part' | 'one-piece'; params: Params; cell: number } | null;
}

/** MP5: the other type's silicone, in ml, at the settings a switch would give, less the model above the plane. */
export interface TypeEstimate {
  kind: 'two-part' | 'one-piece';
  ml: number;
}

export interface ReportsOutputs {
  S9: GeometryReports;
  estimate?: TypeEstimate | null;
}

/**
 * S8 and S9 in a field.worker of their own, apart from the preview's, so neither T1 nor T2 ever waits for
 * them. S8 depends only on the oriented mesh and the analysis cell, so it is kept between jobs, and a
 * change of t or of a filter runs S9 alone, which only reads the field and filters S8.
 */
export class ReportStages {
  private s8: { key: string; value: IntervalReport } | null = null;
  /** The oriented mesh S8 was read from, kept with it only where an estimate was asked for (MP5). */
  private mesh: { key: string; value: WeldedMesh } | null = null;
  /** An estimate is asked for after the S8 it reads was built without one: main is to send the mesh again. */
  private meshWanted = false;

  constructor(private readonly now: () => number = () => 0) {}

  /** S8 as it stands, which only tests read: main gets S9 alone. */
  get intervals(): IntervalReport | null {
    return this.s8?.value ?? null;
  }

  cached(): Partial<Record<StageId, string>> {
    return this.s8 && !this.meshWanted ? { S8: this.s8.key } : {};
  }

  /** What it keeps between jobs, for the memory meter (MM1). */
  heldArrays(): unknown[] {
    return [this.s8, this.mesh];
  }

  run(keys: Record<StageId, string>, params: Params, inputs: ReportsInputs, timings: Record<string, number> = {}): ReportsOutputs {
    if (this.s8?.key !== keys.S8) {
      const cell = params.quality.analysisCell;
      // As with the preview cell, a cell of 0 from a project file asks for endless columns.
      const problem = analysisCellProblem(cell);
      if (problem) throw new InlineError('cell', problem);
      if (!inputs.mesh) throw new StageMiss('S8');
      const t0 = this.now();
      const mesh: WeldedMesh = { positions: transformPositions(inputs.mesh.positions, inputs.transform), indices: inputs.mesh.indices };
      this.s8 = { key: keys.S8, value: analyseIntervals(mesh, cell) };
      this.mesh = inputs.estimate ? { key: keys.S8, value: mesh } : null;
      this.meshWanted = false;
      timings.S8 = this.now() - t0;
    } else if (inputs.estimate && this.mesh?.key !== keys.S8) {
      // S8 came first without an estimate, as before the model's bodies were known, so its mesh was not kept: the job
      // asks for it once more, and keeps it.
      this.meshWanted = !inputs.mesh;
      if (!inputs.mesh) throw new StageMiss('S8');
      this.mesh = { key: keys.S8, value: { positions: transformPositions(inputs.mesh.positions, inputs.transform), indices: inputs.mesh.indices } };
    }
    const t1 = this.now();
    const S9 = geometryReports(params, { s8: this.s8.value, field: inputs.field, raise: inputs.raise, rim: inputs.rim, tiles: inputs.tiles, ceiling: inputs.ceiling });
    timings.S9 = this.now() - t1;
    const mesh = this.mesh?.key === keys.S8 ? this.mesh.value : null;
    const estimate = inputs.estimate && mesh ? typeEstimate(mesh, inputs.estimate, this.s8.value) : null;
    return { S9, estimate };
  }
}

/**
 * MP5: the other type's silicone (G13.13): the two-part cover's at G13.3's choice from its coarse fields, as the card's
 * estimate reads it, or the one-piece cover's from its H at the preview cell, both less the model above the plane and
 * S8's sealed air. A model the other type cannot build gives null.
 */
export function typeEstimate(mesh: WeldedMesh, asked: NonNullable<ReportsInputs['estimate']>, s8: IntervalReport): TypeEstimate | null {
  const params = effectiveParams(asked.params);
  const bounds = meshBounds(mesh.positions);
  const settings = fieldSettings(params, bounds);
  const { sealedAir } = sealedAirOf(mesh, settings, s8);
  try {
    if (asked.kind === 'two-part') {
      const prep = prepareClamshell(mesh, params, { sealedAir });
      return { kind: 'two-part', ml: chooseFor(prep, params.clamshell.ceilingDeg).silicone / 1000 - sealedAir / 1000 };
    }
    const single = { ...fieldSettings(params, bounds, asked.cell), nx: 1, ny: 1 };
    const plan = planField(bounds, single);
    const mold = moldBounds(mesh, bounds, fieldSettings(params, bounds));
    const { ml } = moldSilicone(mesh, plan, buildField(mesh, plan, single, undefined, mold.D).field, { overlapVolume: 0 }, single, s8);
    return { kind: 'one-piece', ml };
  } catch {
    // An estimate says nothing the mold needs: a model the other type cannot build simply has none.
    return null;
  }
}
