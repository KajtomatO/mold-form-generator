import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { BaseCandidate } from '../core/base/candidates';
import { buildFootprint, type Footprint } from '../core/base/footprint';
import { transformPositions, type RigidTransform } from '../core/base/orient';
import type { Field } from '../core/field/grid';
import type { MeshAudit } from '../core/mesh/audit';
import { importSolid, type ImportedSolid, type SolidReport } from '../core/mesh/shells';
import type { WeldedMesh } from '../core/mesh/weld';
import { crossParameterErrors } from '../core/params/rules';
import type { Params } from '../core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase, layerDiagnostics, orientedSolid, pocketOutline, triangleContour } from '../core/parts/base';
import { buildCoverBody, buildCoverFinal, toolDiagnostics } from '../core/parts/cover';
import { buildFunnel } from '../core/parts/funnel';
import type { CutOpening } from '../core/parts/openings';
import type { Rim } from '../core/parts/rim';
import type { Diagnostic } from '../core/report/diagnostics';
import { Arena, withArena } from '../core/solid/arena';
import type { Rect } from '../core/solid/rect';
import { buildToolMesh, toolSolid } from '../core/solid/tool';
import type { StageId } from '../app/stages';
import { PLAIN_IMPORT, StageMiss, type ImportInput } from './fieldStages';

/** A mesh as it travels to main for drawing: positions only, 3 per vertex. */
export interface PartMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SolidInputs {
  /** The welded mesh and its audit, sent only while the worker does not hold S1. */
  model: { welded: WeldedMesh; audit: MeshAudit } | null;
  plane: { candidate: Pick<BaseCandidate, 'members' | 'holes'>; transform: RigidTransform; needsTrim: boolean; planeTol: number; pocketDepth: number };
  /** Null in a job that only imports, which runs before any field exists. */
  rim: Rim | null;
  /** The export plan's tile offsets. */
  offsets: [number, number][];
  /** S6 for the tool, sent only while the worker does not hold S11. */
  field: Field | null;
  /** The tool is cropped to this. Previews pass rim.D, as their field can sit a cell per tile wider than the export's. */
  clip: Rect | null;
  tol: number;
  copies: CutOpening[];
  /** While an opening is dragged: the other openings' copies, and the dragged one's where it is now. */
  drag: { rest: CutOpening[]; moved: CutOpening[] } | null;
}

export interface ImportOutput {
  report: SolidReport;
  /** What field.worker must use for S2. */
  import: ImportInput;
}

export interface SolidOutputs {
  S1?: ImportOutput;
  S13?: PartMesh & { provisional: boolean; diagnostics: Diagnostic[] };
  S15?: PartMesh & { diagnostics: Diagnostic[] };
  S16?: PartMesh | null;
}

export type SolidWanted = keyof SolidOutputs;

/** A solid kept between jobs, with the arena that owns it, so dropping it frees all of it. */
class Held<T = Manifold> {
  constructor(
    readonly key: string,
    readonly arena: Arena,
    readonly value: T,
  ) {}

  dispose(): void {
    this.arena.dispose();
  }
}

interface ToolEntry {
  solid: Manifold;
  tinTriangles: number;
  clippedNodes: number;
  diagnostics: Diagnostic[];
}

function meshOf(solid: Manifold): PartMesh {
  const mesh = solid.getMesh();
  if (mesh.numProp !== 3) throw new Error(`Expected positions only in a part, got ${mesh.numProp} properties per vertex.`);
  return { positions: mesh.vertProperties, indices: mesh.triVerts };
}

/**
 * S1, S2 and S11 to S16 with Manifold. Only the model, tool, cover body, base body and funnel stay
 * between jobs, plus the footprint, which is plain arrays. Everything else a job makes is in its own
 * arena and freed when it ends, and the meshes go to main.
 */
export class SolidStages {
  private model: Held<{ solid: ImportedSolid; outcome: ImportInput }> | null = null;
  private footprint: { key: string; footprint: Footprint; mesh: WeldedMesh } | null = null;
  private tool: Held<ToolEntry> | null = null;
  private coverBody: Held | null = null;
  private baseBody: Held | null = null;
  private funnel: Held | null = null;
  /** The cover with every opening but the dragged one. Only while that drag lasts, and freed by any other job. */
  private dragRest: Held | null = null;
  /** How often that cover was cut, which a drag should do once, on its first step. */
  dragRestCuts = 0;

  constructor(
    private readonly api: ManifoldToplevel,
    private readonly now: () => number = () => 0,
  ) {}

  cached(): Partial<Record<StageId, string>> {
    const out: Partial<Record<StageId, string>> = {};
    if (this.model) out.S1 = this.model.key;
    if (this.footprint) out.S2 = this.footprint.key;
    if (this.tool) out.S11 = this.tool.key;
    if (this.coverBody) out.S12 = this.coverBody.key;
    if (this.baseBody) out.S14 = this.baseBody.key;
    if (this.funnel) out.S16 = this.funnel.key;
    return out;
  }

  /** Live handles held between jobs: what a soak test watches besides the heap. */
  heldEntries(): number {
    return [this.model, this.tool, this.coverBody, this.baseBody, this.funnel, this.dragRest].filter(Boolean).length;
  }

  clear(): void {
    for (const held of [this.model, this.tool, this.coverBody, this.baseBody, this.funnel, this.dragRest]) held?.dispose();
    this.model = this.tool = this.coverBody = this.baseBody = this.funnel = this.dragRest = null;
    this.footprint = null;
  }

  run(keys: Record<StageId, string>, want: SolidWanted[], params: Params, inputs: SolidInputs, timings: Record<string, number> = {}): SolidOutputs {
    const { api } = this;
    const timed = <T>(stage: string, build: () => T): T => {
      const t0 = this.now();
      const value = build();
      timings[stage] = (timings[stage] ?? 0) + this.now() - t0;
      return value;
    };
    /**
     * Builds in a fresh arena and keeps it. What was held goes only once the new one stands, so a build
     * that throws leaves the old entry whole under its own key rather than freed under it.
     */
    const keep = <T>(old: Held<T> | null, key: string, build: (arena: Arena) => T): Held<T> => {
      const arena = new Arena(api);
      let held: Held<T>;
      try {
        held = new Held(key, arena, build(arena));
      } catch (error) {
        arena.dispose();
        throw error;
      }
      old?.dispose();
      return held;
    };
    const rim = (): Rim => {
      if (!inputs.rim) throw new Error('A job that builds the cover or base must bring the rim.');
      return inputs.rim;
    };

    // Another model: nothing built for the old one can be used again, and it holds memory.
    if (this.model && this.model.key !== keys.S1) this.clear();
    if (!inputs.drag) {
      this.dragRest?.dispose();
      this.dragRest = null;
    }

    const imported = (): { solid: ImportedSolid; outcome: ImportInput } => {
      if (this.model?.key === keys.S1) return this.model.value;
      if (!inputs.model) throw new StageMiss('S1');
      const { welded, audit } = inputs.model;
      this.model = timed('S1', () => keep(null, keys.S1, (arena) => {
        // The import ladder makes many pieces on the way. Only the solid itself is worth keeping.
        const solid = withArena(api, (scratch) => {
          const found = importSolid(scratch, welded, audit);
          if (found.solid) scratch.release(found.solid);
          return found;
        });
        if (solid.solid) arena.track(solid.solid);
        // The usual case leaves the welded mesh as it was, and field.worker has already started on that.
        const plain = solid.solid !== null && solid.mesh === welded;
        const outcome: ImportInput = plain ? PLAIN_IMPORT : { key: `import:${keys.S1}`, soup: solid.solid === null, mesh: solid.mesh, openLoops: solid.openLoops };
        return { solid, outcome };
      }));
      return this.model.value;
    };
    const model = (): ImportedSolid => imported().solid;

    const footprint = (): { footprint: Footprint; mesh: WeldedMesh } => {
      if (this.footprint?.key === keys.S2) return this.footprint;
      const imported = model();
      const value = timed('S2', () => withArena(api, (arena) => {
        const { candidate, transform, needsTrim } = inputs.plane;
        const mesh = { positions: transformPositions(imported.mesh.positions, transform), indices: imported.mesh.indices };
        const placed = needsTrim ? orientedSolid(arena, imported, { transform, needsTrim }) : null;
        const cap = placed ? arena.track(placed.slice(0.02)) : undefined;
        return { footprint: buildFootprint(arena, mesh, candidate, params.base.minIsland, cap), mesh };
      }));
      this.footprint = { key: keys.S2, ...value };
      return value;
    };

    const tool = (): ToolEntry => {
      if (this.tool?.key === keys.S11) return this.tool.value;
      if (!inputs.field) throw new StageMiss('S11');
      const field = inputs.field;
      this.tool = timed('S11', () => keep(this.tool, keys.S11, (arena) => {
        // G4: the raise is the tolerance in use, so the TIN's own error never eats into t.
        const mesh = buildToolMesh(field, { raise: inputs.tol, tol: inputs.tol, clip: inputs.clip ?? undefined });
        return { solid: toolSolid(arena, mesh), tinTriangles: mesh.tinTriangles, clippedNodes: mesh.clippedNodes, diagnostics: [...mesh.diagnostics, ...toolDiagnostics(rim(), mesh)] };
      }));
      return this.tool.value;
    };

    const coverBody = (): Manifold => {
      if (this.coverBody?.key === keys.S12) return this.coverBody.value;
      const cutter = tool().solid;
      this.coverBody = timed('S12', () => keep(this.coverBody, keys.S12, (arena) => buildCoverBody(arena, rim(), cutter)));
      return this.coverBody.value;
    };

    const baseBody = (): Manifold => {
      if (this.baseBody?.key === keys.S14) return this.baseBody.value;
      this.baseBody = timed('S14', () => keep(this.baseBody, keys.S14, (arena) => buildBaseBody(arena, rim())));
      return this.baseBody.value;
    };

    const outputs: SolidOutputs = {};
    if (want.includes('S1')) {
      const { solid, outcome } = imported();
      outputs.S1 = { report: solid.report, import: outcome };
    }

    if (want.includes('S13')) {
      const body = coverBody();
      outputs.S13 = timed('S13', () => withArena(api, (arena) => {
        const diagnostics = [...this.tool!.value.diagnostics];
        if (!inputs.drag) return { ...meshOf(buildCoverFinal(arena, body, rim(), inputs.copies)), provisional: false, diagnostics };
        // A drag cuts only the dragged opening's copies, into the cover already cut for the rest. The solid is
        // the same, but its triangles are not those of one cut of all, so the drop cuts all again.
        const { rest, moved } = inputs.drag;
        const restKey = `${keys.S12}|${JSON.stringify(rest)}`;
        if (rest.length > 0 && this.dragRest?.key !== restKey) {
          this.dragRest?.dispose();
          this.dragRest = keep(null, restKey, (keepArena) => buildCoverFinal(keepArena, body, rim(), rest));
          this.dragRestCuts++;
        }
        const under = rest.length > 0 ? this.dragRest!.value : body;
        return { ...meshOf(buildCoverFinal(arena, under, rim(), moved)), provisional: true, diagnostics };
      }));
    }

    if (want.includes('S15')) {
      const body = baseBody();
      const { footprint: print, mesh } = footprint();
      const imported = model();
      outputs.S15 = timed('S15', () => withArena(api, (arena) => {
        const { planeTol, pocketDepth, transform, needsTrim } = inputs.plane;
        const diagnostics = [...print.diagnostics, ...layerDiagnostics(params.base.thickness, pocketDepth, params.print.layerHeight)];
        const placed = orientedSolid(arena, imported, { transform, needsTrim });
        if (params.base.mode === 'merged') {
          const merged = buildMergedBase(arena, body, placed, print, { planeTol, offsets: inputs.offsets });
          diagnostics.push(...merged.diagnostics);
          // Without a solid there is no merged base, and the plate alone shows what there is.
          return { ...meshOf(merged.base ?? body), diagnostics };
        }
        const section = placed ? arena.track(placed.slice(pocketDepth)) : triangleContour(arena, mesh, pocketDepth);
        const outline = pocketOutline(arena, print, section, params.base.pocketEnlarge);
        const glue = buildGlueBase(arena, body, outline, pocketDepth, inputs.offsets);
        diagnostics.push(...glue.diagnostics);
        return { ...meshOf(glue.base), diagnostics };
      }));
    }

    if (want.includes('S16')) {
      const wanted = params.funnel.generate && !crossParameterErrors(params).some((d) => d.code.startsWith('funnel-'));
      if (!wanted) {
        this.funnel?.dispose();
        this.funnel = null;
        outputs.S16 = null;
      } else {
        if (this.funnel?.key !== keys.S16) this.funnel = timed('S16', () => keep(this.funnel, keys.S16, (arena) => buildFunnel(arena, params)));
        outputs.S16 = meshOf(this.funnel.value);
      }
    }
    return outputs;
  }
}
