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
}

export interface ReportsOutputs {
  S9: GeometryReports;
}

/**
 * S8 and S9 in a field.worker of their own, apart from the preview's, so neither T1 nor T2 ever waits for
 * them. S8 depends only on the oriented mesh and the analysis cell, so it is kept between jobs, and a
 * change of t or of a filter runs S9 alone, which only reads the field and filters S8.
 */
export class ReportStages {
  private s8: { key: string; value: IntervalReport } | null = null;

  constructor(private readonly now: () => number = () => 0) {}

  /** S8 as it stands, which only tests read: main gets S9 alone. */
  get intervals(): IntervalReport | null {
    return this.s8?.value ?? null;
  }

  cached(): Partial<Record<StageId, string>> {
    return this.s8 ? { S8: this.s8.key } : {};
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
      timings.S8 = this.now() - t0;
    }
    const t1 = this.now();
    const S9 = geometryReports(params, { s8: this.s8.value, field: inputs.field, raise: inputs.raise, rim: inputs.rim, tiles: inputs.tiles, ceiling: inputs.ceiling });
    timings.S9 = this.now() - t1;
    return { S9 };
  }
}
