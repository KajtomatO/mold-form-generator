import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { BaseCandidate } from '../core/base/candidates';
import { buildFootprint, classifyLevels, type Footprint, type LevelReport } from '../core/base/footprint';
import { transformPositions, type RigidTransform } from '../core/base/orient';
import type { Field } from '../core/field/grid';
import { exteriorMesh } from '../core/field/sealed';
import type { MeshAudit } from '../core/mesh/audit';
import { importSolid, sharedVolume, type ImportedSolid, type SolidReport } from '../core/mesh/shells';
import { displayProxy, HEAVY_LIMITS, importFromCopy, manifoldPathSolid, type HeavyLimits, type MeshSimplifier } from '../core/mesh/simplify';
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
  /**
   * The welded mesh and its audit, sent only while the worker does not hold S1. `known` is an import of the
   * same mesh that checked it whole, sent past G1.8's limit, so this worker builds only the copy (M11).
   */
  model: { welded: WeldedMesh; audit: MeshAudit; known?: SolidReport | null } | null;
  /** The whole candidate, as G2.6's report on the footprint reads its levels. */
  plane: { candidate: BaseCandidate; transform: RigidTransform; needsTrim: boolean; planeTol: number; pocketDepth: number };
  /** Null in a job that only imports, which runs before any field exists. */
  rim: Rim | null;
  /** The export plan's tile offsets. */
  offsets: [number, number][];
  /** S6 for the tool, sent only while the worker does not hold S11. */
  field: Field | null;
  /** The tool is cropped to this. Previews pass rim.D, as their coarser cell can reach past the export's bounds. */
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
  /** G1.8: a lighter copy for the viewport above 300k triangles, or null. Picking still uses the real mesh. */
  display: PartMesh | null;
  /**
   * M11c: the union of parts the import joined, which the section's cut is counted from, with its triangles
   * less its void shells for the silicone's (null with none); null where the import kept none.
   */
  joined: { mesh: PartMesh; exterior: Uint32Array | null } | null;
}

/** The footprint as main needs it before any part is built: G2.6's levels, and the islands it dropped. */
export interface FootprintOutput {
  levels: LevelReport;
  diagnostics: Diagnostic[];
  /**
   * What the model's parts share above the plane, in mm3, which the silicone takes off: the import's
   * overlap, or on a plane that trims the model, that of the trimmed parts, as the trim takes away what
   * they share below it (M11c).
   */
  overlap: number;
}

export interface SolidOutputs {
  S1?: ImportOutput;
  S2?: FootprintOutput;
  S13?: PartMesh & { provisional: boolean; diagnostics: Diagnostic[] };
  /** `merged` when the base holds the model's copies, as Mode B's does once the model is a solid. */
  S15?: PartMesh & { diagnostics: Diagnostic[]; merged: boolean };
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
  /**
   * The import. For a mesh past G1.8's limit its solid is the simplified copy every later Manifold step
   * uses, and the whole one is freed once checked, so the two never stand in the heap together for long.
   */
  private model: Held<{ solid: ImportedSolid; outcome: ImportInput; simplified: Diagnostic[]; whole: boolean }> | null = null;
  private footprint: { key: string; footprint: Footprint; mesh: WeldedMesh; overlap: number } | null = null;
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
    /** For the display proxy. Without one, a heavy model is drawn as it is. */
    private readonly simplifier: MeshSimplifier | null = null,
    private readonly limits: HeavyLimits = HEAVY_LIMITS,
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

    const imported = (): { solid: ImportedSolid; outcome: ImportInput; simplified: Diagnostic[]; whole: boolean } => {
      if (this.model?.key === keys.S1) return this.model.value;
      if (!inputs.model) throw new StageMiss('S1');
      const { welded, audit, known } = inputs.model;
      this.model = timed('S1', () => keep(null, keys.S1, (arena) => {
        // Past G1.8's limit, a worker told that an import has checked the mesh whole builds the copy alone,
        // as the whole solid holds 1.3 GB of its heap; the pipeline ends the worker that checked it.
        const copy = known && this.simplifier ? importFromCopy(arena, welded, known, this.simplifier, this.limits.limit, this.limits.target) : null;
        if (copy) return { solid: copy, outcome: copy.mesh === welded ? PLAIN_IMPORT : { key: `import:${keys.S1}`, soup: false, mesh: copy.mesh, openLoops: [] }, simplified: copy.simplified, whole: false };
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
        return { solid, outcome, simplified: [], whole: true };
      }));
      return this.model.value;
    };
    const model = (): ImportedSolid => imported().solid;
    /**
     * G1.8: what every Manifold step after the import uses. Past the limit, a whole import's solid gives way
     * to its simplified copy, made the first time a step needs it, in the model's own arena.
     */
    const manifoldModel = (): ImportedSolid => {
      const held = imported();
      if (held.whole && this.simplifier) {
        const arena = this.model!.arena;
        const path = timed('simplify', () => manifoldPathSolid(arena, held.solid, this.simplifier, this.limits.limit, this.limits.target));
        if (path.heavy) {
          // The whole solid has done its one job, the check, and the copy stands in for it from here on.
          arena.release(held.solid.solid!).delete();
          held.solid = { ...held.solid, solid: path.solid };
        }
        // A copy that is no closed solid leaves the whole mesh in use, which its own warning says.
        held.simplified = path.diagnostics;
        held.whole = false;
      }
      return held.solid;
    };

    const footprint = (): { footprint: Footprint; mesh: WeldedMesh; overlap: number } => {
      if (this.footprint?.key === keys.S2) return this.footprint;
      const imported = inputs.plane.needsTrim ? manifoldModel() : model();
      const value = timed('S2', () => withArena(api, (arena) => {
        const { candidate, transform, needsTrim } = inputs.plane;
        const mesh = { positions: transformPositions(imported.mesh.positions, transform), indices: imported.mesh.indices };
        const placed = needsTrim ? orientedSolid(arena, imported, { transform, needsTrim }) : null;
        const cap = placed ? arena.track(placed.slice(0.02)) : undefined;
        // Past G1.8's limit the trimmed model is the copy's, as everything after the import is; the export measures the whole one.
        const { overlapVolume } = imported.report;
        const overlap = placed && overlapVolume > 0 ? sharedVolume(arena, placed) : overlapVolume;
        return { footprint: buildFootprint(arena, mesh, candidate, params.base.minIsland, cap), mesh, overlap };
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
      const proxy = this.simplifier ? displayProxy(solid.mesh, this.simplifier) : null;
      const exterior = solid.joined ? exteriorMesh(solid.joined) : null;
      const joined = solid.joined ? { mesh: solid.joined, exterior: exterior === solid.joined ? null : exterior!.indices } : null;
      outputs.S1 = { report: solid.report, import: outcome, display: proxy ? { positions: proxy.positions, indices: proxy.indices } : null, joined };
    }

    if (want.includes('S2')) {
      const { footprint: print, mesh, overlap } = footprint();
      const { candidate, planeTol } = inputs.plane;
      outputs.S2 = timed('levels', () => ({ levels: classifyLevels(mesh, candidate, print, planeTol), diagnostics: print.diagnostics, overlap }));
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
      const imported = manifoldModel();
      outputs.S15 = timed('S15', () => withArena(api, (arena) => {
        const { planeTol, pocketDepth, transform, needsTrim } = inputs.plane;
        const diagnostics = [...print.diagnostics, ...layerDiagnostics(params.base.thickness, pocketDepth, params.print.layerHeight), ...this.model!.value.simplified];
        if (params.base.mode === 'merged') {
          const merged = buildMergedBase(arena, body, orientedSolid(arena, imported, { transform, needsTrim }), print, { planeTol, offsets: inputs.offsets });
          diagnostics.push(...merged.diagnostics);
          // Without a solid there is no merged base, and the plate alone shows what there is.
          return { ...meshOf(merged.base ?? body), diagnostics, merged: merged.base !== null };
        }
        const placed = orientedSolid(arena, imported, { transform, needsTrim });
        const section = placed ? arena.track(placed.slice(pocketDepth)) : triangleContour(arena, mesh, pocketDepth);
        const outline = pocketOutline(arena, print, section, params.base.pocketEnlarge);
        const glue = buildGlueBase(arena, body, outline, pocketDepth, inputs.offsets);
        diagnostics.push(...glue.diagnostics);
        return { ...meshOf(glue.base), diagnostics, merged: false };
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
