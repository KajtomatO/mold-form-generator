import { replicateOpenings, type OpeningPin } from '../core/analysis/placement';
import { dropOpening, openingSizes, placementSpace, type DropResult, type PlacementSpace } from '../core/analysis/validate';
import type { SolidReport } from '../core/mesh/shells';
import type { WeldedMesh } from '../core/mesh/weld';
import { defaultParams, resolveAuto } from '../core/params/defaults';
import { crossParameterErrors } from '../core/params/rules';
import type { Params } from '../core/params/schema';
import type { CutOpening } from '../core/parts/openings';
import type { Diagnostic } from '../core/report/diagnostics';
import type { ExportOutputs } from '../workers/exportJob';
import type { FieldWire, OrientedWire } from '../workers/fieldHost';
import { DEFAULT_PLANE, PLAIN_IMPORT, samePlane, type FieldOutput, type FieldWanted, type ImportInput, type ParsedModel, type PlacementOutput, type PlaneChoice } from '../workers/fieldStages';
import { type ExportJobMessage, type Fault, type FieldJobMessage, type FromWorker, type SolidJobMessage, type WallsJobMessage, type WorkerLike } from '../workers/protocol';
import type { FootprintOutput, PartMesh, SolidOutputs, SolidWanted } from '../workers/solidStages';
import type { WallCheck } from '../workers/wallCheck';
import { Budgets } from './budgets';
import { hashFloats, hashMesh, hashString } from './hash';
import { JobGate, realTimers, type GateEvent, type GateTarget, type LogEntry, type Timers } from './jobGate';
import { stageKeys, type StageId, type StageInputs } from './stages';

/**
 * Everything a job needs, taken when it was asked for. A job is derived at dispatch, and by then main may
 * hold another file, so it must not read main's current state. The values are never changed in place.
 */
interface Target extends GateTarget {
  keys: Record<StageId, string>;
  params: Params;
  inputs: StageInputs;
  source: {
    bytes: Uint8Array | null;
    importInput: ImportInput;
    parsed: ParsedModel | null;
    oriented: OrientedWire | null;
  };
}

interface FieldTarget extends Target {
  want: FieldWanted[];
}

interface SolidTarget extends Target {
  want: SolidWanted[];
  /** The opening being dragged, with its copies where it is now and the copies of all the others. */
  drag: { rest: CutOpening[]; moved: CutOpening[] } | null;
  copies: CutOpening[];
  field: FieldOutput | null;
}

/** A result on screen: which keys it was built for, and the request it answered. */
interface Shown<T> {
  key: string;
  rev: number;
  value: T;
}

export interface PlacementShown extends PlacementOutput {
  space: PlacementSpace;
  copies: CutOpening[];
}

export interface PipelineEvent {
  kind: 'applied' | 'rejected';
  slot: 'parsed' | 'oriented' | 'import' | 'footprint' | 'field' | 'placement' | 'cover' | 'base' | 'funnel';
  rev: number;
  /** The result was older than the latest request when it arrived, so it shows with the badge. */
  stale: boolean;
  /** The value of t it was built for, which a test of a burst follows. */
  t: number;
  at: number;
  /** Why it was rejected. */
  reason?: string;
}

export interface PipelineOptions {
  spawnField: () => WorkerLike;
  spawnSolid: () => WorkerLike;
  now?: () => number;
  timers?: Timers;
  /** The ?test=1 flag: budgets frozen, so tests see fixed values. */
  frozen?: boolean;
  /**
   * Once the preview has settled on a grid, check the walls between tiles on the export field, in a
   * field.worker of its own that any newer change terminates. G6 keeps that check off the coarse preview.
   */
  checkWalls?: boolean;
}

/** A diagnostic as the card shows it. `exportCell` marks one read off the export field rather than the preview's. */
export interface ShownDiagnostic extends Diagnostic {
  exportCell?: boolean;
}

/** What the user has chosen, in one plain object, which undo and project files can keep as it is. */
export interface Project {
  params: Params;
  plane: PlaneChoice;
  pins: OpeningPin[];
  /** Automatic vents the user deleted. */
  removed: string[];
}

/** The wall check: running for the current state, done for it, or neither. */
export interface WallStatus {
  running: boolean;
  /** The result for the current state, or null until one exists. */
  result: WallCheck | null;
}

/** The plan's out-of-date badge and the error line, as the UI shows them. */
export interface PipelineStatus {
  stale: boolean;
  busy: boolean;
  error: string | null;
}

export interface PipelineSnapshot {
  bytes: Uint8Array;
  name: string;
  params: Params;
  plane: PlaneChoice;
  pins: OpeningPin[];
  removed: string[];
  crashScale: number;
  tuneScale: number;
}

/** Rule 5: a crash doubles the preview cell once. A crash at the doubled cell is shown as an error. */
export const CRASH_SCALE = 2;

/** The job log and the events are for tests and diagnosis. Past this many, the oldest go, so a long session does not grow main's heap. */
export const KEPT_ENTRIES = 2000;

function keep<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > KEPT_ENTRIES) list.shift();
}

/** Errors that mean the engine or its worker gave out, which a coarser cell may avoid. Anything else is a fault to show as it is. */
const CRASH_NAMES = new Set(['RuntimeError', 'RangeError', 'WorkerError']);

export interface ExportProgress {
  step: string;
  done: number;
  total: number;
}

/**
 * The worker pipeline. Main holds every input, both workers' caches are only ever what they say, and
 * the stage keys of src/app/stages.ts decide what each job must build. Results are applied in request
 * order: one for the current model and plane that is newer than what shows is drawn, with the badge if
 * a newer request is already waiting, and anything else is dropped.
 */
export class Pipeline {
  params: Params = defaultParams();
  readonly budgets: Budgets;
  readonly log: LogEntry[] = [];
  readonly events: PipelineEvent[] = [];

  private file: { id: string; name: string; bytes: Uint8Array } | null = null;
  private loads = 0;
  private plane: PlaneChoice = DEFAULT_PLANE;
  private importInput: ImportInput = PLAIN_IMPORT;
  private pins: OpeningPin[] = [];
  private removed: string[] = [];
  private dragState: StageInputs['drag'] = null;
  /**
   * Factors on the preview cell, kept apart so neither undoes the other: the crash's, 1 or CRASH_SCALE,
   * which stays until the next load, and the tuning's on a slow machine, 1 to 2. The cell is their product.
   */
  private crashScale = 1;
  private tuneScale = 1;
  /** Bumped by every change, the user's or the pipeline's own. Requests carry it, and results are applied in its order. */
  private rev = 0;

  parsed: Shown<ParsedModel> | null = null;
  oriented: Shown<OrientedWire> | null = null;
  imported: Shown<SolidReport> | null = null;
  /** G1.8: the lighter copy the viewport draws above 300k triangles, from the import. */
  displayProxy: PartMesh | null = null;
  footprint: Shown<FootprintOutput> | null = null;
  field: Shown<FieldOutput> & { mold: string } | null = null;
  placement: Shown<PlacementShown> | null = null;
  /** The cover and base also carry the rim key they were built on, so the view knows when its box proxies are newer. */
  cover: Shown<NonNullable<SolidOutputs['S13']>> & { mold: string } | null = null;
  base: Shown<NonNullable<SolidOutputs['S15']>> & { mold: string } | null = null;
  funnel: Shown<PartMesh | null> | null = null;
  diagnostics: ShownDiagnostic[] = [];
  /** What the pipeline itself has to say, such as a coarser cell after a crash. Kept until the next file. */
  private notes: Diagnostic[] = [];
  error: string | null = null;
  /**
   * In ms, from dispatch to the result on main: T1 until the field arrives, T2 for a job that builds the
   * base too, and T2b for one that only cuts, apart for a drag and for the full cut after a drop.
   */
  readonly timing = { t1: [] as number[], t2: [] as number[], drag: [] as number[], cut: [] as number[] };
  /** The latest solid rebuild of any kind, which the status strip shows: one that only cuts is a rebuild too. */
  lastRebuild: { kind: 't2' | 'cut' | 'drag'; ms: number } | null = null;

  private readonly fieldGate: JobGate<FieldTarget>;
  private readonly solidGate: JobGate<SolidTarget>;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly listeners = new Set<() => void>();
  private idleWaiters: (() => void)[] = [];
  private debounce: { handle: unknown; signature: string } | null = null;
  private heavySignature = '';
  private heavyChangedAt = 0;
  /** A target that failed and must not be asked for again until something changes. */
  private failed = new Set<string>();
  private exportWorker: WorkerLike | null = null;
  private walls: { key: string; value: WallCheck } | null = null;
  private wallJob: { key: string; worker: WorkerLike } | null = null;
  /** In ms, per wall check that finished, for the record. */
  readonly wallTimes: number[] = [];

  constructor(private readonly options: PipelineOptions) {
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? realTimers;
    this.budgets = new Budgets(options.frozen ?? false);
    const common = { budgets: this.budgets, now: this.now, timers: this.timers, log: (entry: LogEntry) => keep(this.log, entry) };
    this.fieldGate = new JobGate<FieldTarget>({ ...common, name: 'field', spawn: options.spawnField, derive: (t, c) => this.deriveField(t, c), onEvent: (e) => this.onField(e) });
    this.solidGate = new JobGate<SolidTarget>({ ...common, name: 'solid', spawn: options.spawnSolid, derive: (t, c) => this.deriveSolid(t, c), onEvent: (e) => this.onSolid(e) });
  }

  // ----- what the user does -----

  load(bytes: Uint8Array, name: string): void {
    this.file = { id: `f${++this.loads}`, name, bytes };
    this.plane = DEFAULT_PLANE;
    this.importInput = PLAIN_IMPORT;
    this.pins = [];
    this.removed = [];
    this.dragState = null;
    this.crashScale = this.tuneScale = 1;
    this.budgets.restartT1();
    this.notes = [];
    this.parsed = this.oriented = this.imported = this.footprint = this.field = this.placement = this.cover = this.base = this.funnel = null;
    this.displayProxy = null;
    this.walls = null;
    // Timings belong to the model they were taken on.
    for (const list of Object.values(this.timing)) list.length = 0;
    this.lastRebuild = null;
    this.changed();
  }

  setParams(change: (params: Params) => void): void {
    const next = structuredClone(this.params);
    change(next);
    this.params = next;
    this.changed();
  }

  /** Another plane places the openings afresh, so pins and removed vents go. The same plane again is no change. */
  setPlane(plane: PlaneChoice): void {
    if (samePlane(plane, this.plane)) return;
    this.plane = plane;
    this.pins = [];
    this.removed = [];
    this.changed();
  }

  /** T2b while the opening moves: only its copies are cut, into the cover already cut for the rest. */
  dragOpening(id: string, x: number, y: number): void {
    this.dragState = { id, x, y };
    this.changed();
  }

  /** The drop: snapped to the nearest valid place if needed, pinned there, and placed and cut again in full. */
  dropOpening(id: string, x: number, y: number): DropResult | null {
    this.dragState = null;
    const shown = this.placement?.value;
    const opening = shown?.placement.openings.find((o) => o.id === id);
    if (!shown || !opening) {
      this.changed();
      return null;
    }
    const others = shown.placement.openings.filter((o) => o.id !== id);
    const result = dropOpening(shown.space, { kind: opening.kind, x, y }, others);
    this.pins = [...this.pins.filter((pin) => pin.id !== id), { id, kind: opening.kind, x: result.x, y: result.y }];
    this.changed();
    return result;
  }

  setPins(pins: OpeningPin[]): void {
    this.pins = pins;
    this.changed();
  }

  /** The automatic vents the user deleted, by id. Placement leaves them out. */
  setRemoved(removed: string[]): void {
    this.removed = removed;
    this.changed();
  }

  // ----- what the UI reads -----

  get modelName(): string | null {
    return this.file?.name ?? null;
  }

  /** The loaded file's size in bytes. */
  get fileBytes(): number {
    return this.file?.bytes.length ?? 0;
  }

  project(): Project {
    return { params: this.params, plane: this.plane, pins: this.pins, removed: this.removed };
  }

  /** The mesh the base plane orients: the welded one, or the import's when it flipped or rebuilt it. */
  modelMesh(): WeldedMesh | null {
    return this.importInput.mesh ?? this.parsed?.value.welded ?? null;
  }

  wallStatus(): WallStatus {
    const key = this.wallKey();
    return { running: this.wallJob?.key === key, result: this.walls?.key === key ? this.walls.value : null };
  }

  status(): PipelineStatus {
    return { stale: this.isStale(), busy: this.fieldGate.busy || this.solidGate.busy || this.debounce !== null, error: this.error };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once no job runs or waits and what shows is current, or has failed. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.checkIdle();
    });
  }

  /** The keys of what the screen should show now. */
  keys(): Record<StageId, string> {
    return stageKeys(this.params, this.inputs());
  }

  /**
   * Hashes of what is on screen: the field by its values, each part as a set of triangles. Equal hashes
   * mean equal geometry, whichever worker or browser made it.
   */
  geometryHash(): { field: string | null; openings: string | null; cover: string | null; base: string | null; all: string } {
    const field = this.field ? hashFloats(this.field.value.field.values) : null;
    const openings = this.placement ? hashString(JSON.stringify(this.placement.value.copies)) : null;
    const cover = this.cover ? hashMesh(this.cover.value.positions, this.cover.value.indices) : null;
    const base = this.base ? hashMesh(this.base.value.positions, this.base.value.indices) : null;
    return { field, openings, cover, base, all: hashString([field, openings, cover, base].join('|')) };
  }

  /** Test hooks: a fault on the next job of a worker, and a recycle on demand. */
  armFault(gate: 'field' | 'solid', fault: Fault): void {
    (gate === 'field' ? this.fieldGate : this.solidGate).armFault(fault);
  }

  recycleSolid(): void {
    this.solidGate.recycle();
  }

  solidCached(): Partial<Record<StageId, string>> {
    return this.solidGate.cached;
  }

  readSolidHeap(): Promise<{ capacity: number | null; used: number | null; held: number }> {
    return this.solidGate.readHeap();
  }

  /** The factor on the preview cell in use: the crash's times the tuning's. */
  cellScale(): number {
    return this.crashScale * this.tuneScale;
  }

  /** What a fresh build needs to reach the same state from nothing. */
  snapshot(): PipelineSnapshot | null {
    if (!this.file) return null;
    return { bytes: this.file.bytes, name: this.file.name, params: this.params, plane: this.plane, pins: this.pins, removed: this.removed, crashScale: this.crashScale, tuneScale: this.tuneScale };
  }

  restore(snapshot: PipelineSnapshot): void {
    this.load(snapshot.bytes, snapshot.name);
    this.params = snapshot.params;
    this.plane = snapshot.plane;
    this.pins = snapshot.pins;
    this.removed = snapshot.removed;
    this.crashScale = snapshot.crashScale;
    this.tuneScale = snapshot.tuneScale;
    this.changed();
  }

  dispose(): void {
    this.fieldGate.dispose();
    this.solidGate.dispose();
    this.exportWorker?.terminate();
    this.cancelWalls();
    if (this.debounce) this.timers.clear(this.debounce.handle);
  }

  // ----- T3 -----

  /**
   * T3 in a fresh solid worker, terminated when it answers. Only Cancel ends it early. A crash of the
   * engine or the worker gets one retry at a coarser export cell, as the preview's does. Any other
   * error, such as the export's own check that its field fits the rim, is a fault, shown as it is.
   */
  async exportParts(onProgress: (progress: ExportProgress) => void = () => {}, fault?: Fault): Promise<ExportOutputs> {
    const parsed = this.parsed?.value, oriented = this.oriented?.value, placement = this.placement?.value;
    if (!parsed || !oriented || !placement || this.isStale()) throw new Error('Wait for the preview to finish before exporting.');
    // Built afresh for each run, as the transfer detaches the arrays it sends.
    const inputsFor = (): ExportJobMessage['inputs'] => ({
      welded: { positions: parsed.welded.positions.slice(), indices: parsed.welded.indices.slice() },
      audit: parsed.audit,
      candidate: { members: oriented.chosen.members.slice(), holes: oriented.chosen.holes },
      transform: oriented.oriented.transform,
      needsTrim: oriented.oriented.needsTrim,
      planeTol: oriented.planeTol,
      openings: placement.placement.openings.map(({ kind, x, y }) => ({ kind, x, y })),
    });
    const params = this.params;
    const run = (cellScale: number, armed?: Fault): Promise<ExportOutputs> =>
      new Promise((resolve, reject) => {
        const worker = this.options.spawnSolid();
        this.exportWorker = worker;
        const done = (): void => {
          worker.terminate();
          if (this.exportWorker === worker) this.exportWorker = null;
        };
        worker.onmessage = ({ data }: { data: FromWorker }) => {
          if (data.t === 'progress') onProgress(data);
          else if (data.t === 'exported') {
            done();
            resolve(data.outputs);
          } else if (data.t === 'error') {
            done();
            reject(Object.assign(new Error(data.message), { name: data.name }));
          }
        };
        worker.onerror = (event) => {
          event.preventDefault?.();
          done();
          reject(Object.assign(new Error(event.message ?? 'The export worker failed.'), { name: 'WorkerError' }));
        };
        const inputs = inputsFor();
        const message: ExportJobMessage = { t: 'export', id: 1, params, inputs, cellScale, ...(armed ? { fault: armed } : {}) };
        worker.postMessage(message, [inputs.welded.positions.buffer, inputs.welded.indices.buffer, inputs.candidate.members.buffer]);
        this.cancelExport = () => {
          done();
          reject(Object.assign(new Error('Export cancelled.'), { name: 'Cancelled' }));
        };
      });
    try {
      return await run(1, fault);
    } catch (error) {
      if (!(error instanceof Error) || !CRASH_NAMES.has(error.name)) throw error;
      return run(CRASH_SCALE);
    } finally {
      this.cancelExport = () => {};
    }
  }

  cancelExport: () => void = () => {};

  // ----- the flow -----

  private inputs(): StageInputs {
    return {
      file: this.file?.id ?? '',
      import: this.importInput.key,
      plane: JSON.stringify(this.plane),
      tier: 'preview',
      cellScale: this.cellScale(),
      pins: this.pins,
      removed: this.removed,
      drag: this.dragState,
    };
  }

  private modelKey(): string {
    return `${this.file?.id ?? ''}|${JSON.stringify(this.plane)}`;
  }

  private changed(): void {
    this.rev++;
    this.failed.clear();
    this.error = null;
    this.cancelWalls();
    this.update();
  }

  /**
   * The preview cell changed on the pipeline's own account. It is a change of its own, so it gets a
   * revision, as results are only applied in revision order, and T1's window starts again at the new cell.
   */
  private rescaled(): void {
    this.budgets.restartT1();
    this.rev++;
  }

  /** Asks each worker for what the screen lacks. Called after every change and every result. */
  private update(): void {
    if (this.file) {
      const keys = this.keys();
      this.requestField(keys);
      this.requestSolid(keys);
    }
    this.notify();
    this.checkIdle();
    this.startWalls();
  }

  private target<T extends Target>(keys: Record<StageId, string>, extra: Omit<T, keyof Target>, idParts: unknown[]): T {
    const source = { bytes: this.file?.bytes ?? null, importInput: this.importInput, parsed: this.parsed?.value ?? null, oriented: this.oriented?.value ?? null };
    return { id: hashString(JSON.stringify(idParts)), rev: this.rev, modelKey: this.modelKey(), keys, params: this.params, inputs: this.inputs(), source, ...extra } as T;
  }

  private requestField(keys: Record<StageId, string>): void {
    const want: FieldWanted[] = [];
    if (this.parsed?.key !== keys.S1) want.push('S1');
    if (this.oriented?.key !== keys.S2) want.push('S2');
    if (this.field?.key !== keys.S6 || this.field.mold !== keys.S10) want.push('S6');
    if (this.placement?.key !== keys.S7) want.push('S7');
    if (want.length === 0) {
      this.fieldGate.cancelPending();
      return;
    }
    const target = this.target<FieldTarget>(keys, { want }, ['field', keys.S1, keys.S2, keys.S6, keys.S7, keys.S10, want]);
    if (!this.failed.has(target.id)) this.fieldGate.request(target);
  }

  private requestSolid(keys: Record<StageId, string>): void {
    // T2's debounce counts from the change, which is when these keys move, and not from when the field for them arrives.
    const signature = [keys.S11, keys.S12, keys.S14, keys.S15, keys.S16].join();
    if (signature !== this.heavySignature) {
      this.heavySignature = signature;
      this.heavyChangedAt = this.now();
    }
    const want: SolidWanted[] = [];
    const parsed = this.parsed?.key === keys.S1 ? this.parsed.value : null;
    if (parsed && this.imported?.key !== keys.S1) want.push('S1');
    // The footprint's level report is what base confirmation shows, so it goes with the import, ahead of T2.
    if (parsed && this.oriented?.key === keys.S2 && this.footprint?.key !== keys.S2) want.push('S2');
    // T2 builds on a field, a placement and a plane that are all current, never on stale ones.
    const field = this.field?.key === keys.S6 && this.field.mold === keys.S10 ? this.field.value : null;
    const ready = parsed && field && this.oriented?.key === keys.S2 && this.placement?.key === keys.S7;
    if (ready) {
      if (this.cover?.key !== keys.S13) want.push('S13');
      if (this.base?.key !== keys.S15) want.push('S15');
      if (this.funnel?.key !== keys.S16) want.push('S16');
    }
    if (want.length === 0) {
      this.solidGate.cancelPending();
      return;
    }

    // T2 waits for the changes to stop. T2b, which only cuts, and the first build of a model go at once.
    const heavy = want.includes('S15') || want.includes('S16') || (want.includes('S13') && this.solidGate.cached.S12 !== keys.S12);
    const first = this.cover === null;
    const wait = this.budgets.settings.debounceMs - (this.now() - this.heavyChangedAt);
    if (ready && heavy && !first && wait > 0) {
      // An older T2 still waiting in the gate would only be thrown away when this one comes.
      this.solidGate.cancelPending();
      if (this.debounce?.signature !== signature) {
        if (this.debounce) this.timers.clear(this.debounce.handle);
        this.debounce = { signature, handle: this.timers.set(() => {
          this.debounce = null;
          this.update();
        }, wait) };
      }
      // The import and the footprint do not wait for the debounce.
      const quick = want.filter((stage) => stage === 'S1' || stage === 'S2');
      if (quick.length === 0) return;
      want.splice(0, want.length, ...quick);
    }

    const placement = this.placement?.value;
    let drag: SolidTarget['drag'] = null;
    if (ready && this.dragState && placement) {
      const dragged = placement.placement.openings.find((o) => o.id === this.dragState!.id);
      if (dragged) {
        const others = placement.placement.openings.filter((o) => o.id !== dragged.id);
        drag = { rest: replicateOpenings(others, placement.space), moved: replicateOpenings([{ kind: dragged.kind, x: this.dragState.x, y: this.dragState.y }], placement.space) };
      }
    }
    const target = this.target<SolidTarget>(keys, { want, drag, copies: ready && placement ? placement.copies : [], field: ready ? field : null }, ['solid', keys, want]);
    if (!this.failed.has(target.id)) this.solidGate.request(target);
  }

  private deriveField(target: FieldTarget, cached: Partial<Record<StageId, string>>): { message: FieldJobMessage; transfer: Transferable[] } {
    const { keys } = target;
    // The file goes as a copy, so main keeps its own for the next respawn.
    const file = cached.S1 !== keys.S1 && target.source.bytes ? target.source.bytes.slice().buffer : null;
    const imported = target.source.importInput;
    const mesh = imported.mesh && cached.S2 !== keys.S2 ? { positions: imported.mesh.positions.slice(), indices: imported.mesh.indices.slice() } : null;
    const transfer: Transferable[] = [];
    if (file) transfer.push(file);
    if (mesh) transfer.push(mesh.positions.buffer, mesh.indices.buffer);
    const { pins, removed, cellScale } = target.inputs;
    const plane = JSON.parse(target.inputs.plane) as PlaneChoice;
    return {
      message: { t: 'field', id: 0, keys, want: target.want, params: target.params, inputs: { file, import: { ...imported, mesh }, plane, cellScale, pins, removed } },
      transfer,
    };
  }

  private deriveSolid(target: SolidTarget, cached: Partial<Record<StageId, string>>): { message: SolidJobMessage; transfer: Transferable[] } {
    const { keys, want, params } = target;
    const transfer: Transferable[] = [];
    const { parsed, oriented } = target.source;
    const needsModel = (want.includes('S1') || want.includes('S2') || want.includes('S15')) && cached.S1 !== keys.S1;
    const model = needsModel && parsed ? { welded: { positions: parsed.welded.positions.slice(), indices: parsed.welded.indices.slice() }, audit: parsed.audit } : null;
    if (model) transfer.push(model.welded.positions.buffer, model.welded.indices.buffer);
    const needsField = want.includes('S13') && cached.S12 !== keys.S12 && cached.S11 !== keys.S11;
    const field = needsField && target.field ? { ...target.field.field, values: target.field.field.values.slice() } : null;
    if (field) transfer.push(field.values.buffer);
    // A job that only imports has no field yet, and none of its stages reads the rim.
    const rim = target.field?.rim ?? null;
    const offsets = target.field?.mold.offsets ?? [];
    const bounds = oriented?.bounds;
    const members = oriented ? oriented.chosen.members.slice() : new Uint32Array();
    transfer.push(members.buffer);
    return {
      message: {
        t: 'solid',
        id: 0,
        keys,
        want,
        params,
        inputs: {
          model,
          plane: {
            candidate: oriented ? { ...oriented.chosen, members } : { normal: [0, 0, -1], support: 0, offset: 0, area: 0, members, levels: [], source: 'histogram', holes: [], faceArea: 0 },
            transform: oriented?.oriented.transform ?? { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] },
            needsTrim: oriented?.oriented.needsTrim ?? false,
            planeTol: oriented?.planeTol ?? 0,
            pocketDepth: bounds ? resolveAuto(params, bounds).pocketDepth : params.print.layerHeight,
          },
          rim,
          offsets,
          field,
          // Previews crop the tool to the rim, as their field can run a cell per tile wider (G6).
          clip: rim ? rim.D : null,
          tol: params.quality.tinTolPreview,
          copies: target.copies,
          drag: target.drag,
        },
      },
      transfer,
    };
  }

  private accept<T>(slot: PipelineEvent['slot'], target: Target, shown: Shown<T> | null): boolean {
    const t = target.params.silicone.t;
    if (target.modelKey !== this.modelKey()) {
      keep(this.events, { kind: 'rejected', slot, rev: target.rev, stale: true, t, at: this.now(), reason: 'model' });
      return false;
    }
    if (shown && target.rev <= shown.rev) {
      keep(this.events, { kind: 'rejected', slot, rev: target.rev, stale: true, t, at: this.now(), reason: 'older' });
      return false;
    }
    keep(this.events, { kind: 'applied', slot, rev: target.rev, stale: target.rev < this.rev, t, at: this.now() });
    return true;
  }

  /**
   * T1 tunes the preview cell on a slow machine. Only a sample taken at the cell in use counts, and only
   * a new sample can move it, so a step is never taken twice on the same evidence.
   */
  private tune(target: FieldTarget, ms: number): void {
    if (target.modelKey !== this.modelKey() || target.inputs.cellScale !== this.cellScale()) return;
    this.budgets.recordT1(ms);
    const tune = this.budgets.previewCellScale(this.tuneScale);
    if (tune === this.tuneScale) return;
    this.tuneScale = tune;
    this.rescaled();
  }

  private onField(event: GateEvent<FieldTarget>): void {
    const { target } = event;
    if (event.kind === 'stage' || event.kind === 'result') {
      const outputs = event.message.outputs as FieldWire;
      // T1 ends when the field arrives. A stage message without one is the parsed model, sent ahead of a failure.
      const t1 = event.kind === 'stage' && outputs.S6 !== undefined;
      if (t1) keep(this.timing.t1, event.ms);
      if (outputs.S1 && this.accept('parsed', target, this.parsed)) this.parsed = { key: target.keys.S1, rev: target.rev, value: outputs.S1 };
      if (outputs.S2 && this.accept('oriented', target, this.oriented)) this.oriented = { key: target.keys.S2, rev: target.rev, value: outputs.S2 };
      if (outputs.S6 && this.accept('field', target, this.field)) this.field = { key: target.keys.S6, mold: target.keys.S10, rev: target.rev, value: outputs.S6 };
      if (outputs.S7) {
        // The space must be the field placement ran on, which is the one shown when their keys agree.
        if (this.field?.key === target.keys.S6 && this.field.mold === target.keys.S10 && this.accept('placement', target, this.placement)) {
          const { field, rim, mold } = this.field.value;
          const space = placementSpace(field, rim, mold.offsets, openingSizes(target.params));
          space.clearance = outputs.S7.clearance;
          space.fits = outputs.S7.fits;
          this.placement = { key: target.keys.S7, rev: target.rev, value: { ...outputs.S7, space, copies: replicateOpenings(outputs.S7.placement.openings, space) } };
        } else if (this.field?.key !== target.keys.S6) {
          keep(this.events, { kind: 'rejected', slot: 'placement', rev: target.rev, stale: true, t: target.params.silicone.t, at: this.now(), reason: 'field' });
        }
      }
      if (t1) this.tune(target, event.ms);
      if (event.kind === 'result') this.collectDiagnostics();
    } else {
      this.handleFailure('field', event);
    }
    this.update();
  }

  private onSolid(event: GateEvent<SolidTarget>): void {
    const { target } = event;
    if (event.kind === 'result') {
      const outputs = event.message.outputs as SolidOutputs;
      const kind = outputs.S15 ? 't2' : outputs.S13 ? (outputs.S13.provisional ? 'drag' : 'cut') : null;
      if (kind) {
        keep(this.timing[kind], event.ms);
        this.lastRebuild = { kind, ms: event.ms };
      }
      if (outputs.S1 && this.accept('import', target, this.imported)) {
        this.imported = { key: target.keys.S1, rev: target.rev, value: outputs.S1.report };
        this.displayProxy = outputs.S1.display;
        // Field.worker started on the welded mesh. If the import changed it, S2 and all after it go again.
        if (outputs.S1.import.key !== this.importInput.key) {
          this.importInput = outputs.S1.import;
          this.rev++;
          // What failed on the welded mesh may well work on the import's: a mesh wound inside out has no
          // face to stand on until it is flipped. So this is a change like the user's.
          this.failed.clear();
          this.error = null;
        }
      }
      if (outputs.S2 && this.accept('footprint', target, this.footprint)) this.footprint = { key: target.keys.S2, rev: target.rev, value: outputs.S2 };
      if (outputs.S13 && this.accept('cover', target, this.cover)) this.cover = { key: target.keys.S13, mold: target.keys.S10, rev: target.rev, value: outputs.S13 };
      if (outputs.S15 && this.accept('base', target, this.base)) this.base = { key: target.keys.S15, mold: target.keys.S10, rev: target.rev, value: outputs.S15 };
      if (outputs.S16 !== undefined && this.accept('funnel', target, this.funnel)) this.funnel = { key: target.keys.S16, rev: target.rev, value: outputs.S16 };
      this.collectDiagnostics();
      const heap = event.message.heapBytes;
      if (heap !== null && heap > this.budgets.settings.recycleBytes) this.solidGate.recycle();
    } else if (event.kind !== 'stage') {
      this.handleFailure('solid', event);
    }
    this.update();
  }

  /**
   * Rule 5: a crash is retried once at twice the cell, which then stays until the next load, and a
   * crash at that cell is shown inline. So the retry is counted by the cell and not by revision, and
   * revisions the pipeline makes itself cannot grant another. An overrun that was ended for a newer
   * request needs nothing, and nor does a failure of a request that is no longer the latest: the newer
   * one is already on its way.
   */
  private handleFailure(gate: 'field' | 'solid', event: Exclude<GateEvent<Target>, { kind: 'stage' | 'result' }>): void {
    if (event.kind === 'terminated') return;
    if (event.target.rev !== this.rev) return;
    if (event.kind === 'crashed' && this.crashScale < CRASH_SCALE) {
      this.crashScale = CRASH_SCALE;
      this.rescaled();
      this.notes = [{ code: 'preview-coarser', severity: 'warning', message: `The ${gate} worker failed, so the preview now runs at ${CRASH_SCALE} times the cell until the next load.` }];
      return;
    }
    this.failed.add(event.target.id);
    this.error = event.kind === 'crashed' ? `The geometry could not be built, even at a coarser cell: ${event.error.message}` : event.error.message;
  }

  private collectDiagnostics(): void {
    const all: ShownDiagnostic[] = [...this.notes, ...crossParameterErrors(this.params)];
    if (this.parsed) all.push(...this.parsed.value.diagnostics);
    if (this.imported) all.push(...this.imported.value.diagnostics);
    if (this.oriented) all.push(...this.oriented.value.diagnostics);
    if (this.footprint) all.push(...this.footprint.value.diagnostics, ...this.footprint.value.levels.diagnostics);
    const walls = this.wallStatus().result;
    if (walls) {
      all.push(...walls.diagnostics.map((d) => ({ ...d, exportCell: true })));
      // A check that passed says so too, so the card shows that the walls were looked at.
      const problem = walls.diagnostics.some((d) => d.code === 'tiles-merged' || d.code === 'thin-tile-wall' || d.code === 'wall-check-failed');
      if (!problem && walls.minWall !== null) all.push({ code: 'tile-walls', severity: 'info', message: `The thinnest wall between models is ${walls.minWall.toFixed(2)} mm, enough to print.`, exportCell: true });
    }
    if (this.field) all.push(...this.field.value.diagnostics, ...this.field.value.rim.diagnostics);
    if (this.placement) all.push(...this.placement.value.placement.diagnostics);
    if (this.cover) all.push(...this.cover.value.diagnostics);
    if (this.base) all.push(...this.base.value.diagnostics);
    const seen = new Set<string>();
    this.diagnostics = all.filter((d) => {
      const key = `${d.code}|${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private isStale(): boolean {
    if (!this.file) return false;
    const keys = this.keys();
    return (
      this.field?.key !== keys.S6 ||
      this.field.mold !== keys.S10 ||
      this.placement?.key !== keys.S7 ||
      this.footprint?.key !== keys.S2 ||
      this.cover?.key !== keys.S13 ||
      this.base?.key !== keys.S15 ||
      this.funnel?.key !== keys.S16
    );
  }

  private checkIdle(): void {
    if (this.idleWaiters.length === 0) return;
    const quiet = !this.fieldGate.busy && !this.solidGate.busy && this.debounce === null;
    if (!quiet || (this.isStale() && this.error === null && this.file !== null)) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  // ----- the export field's wall check -----

  /** The export-tier key of the conditioned field, which is all the wall check reads. */
  private wallKey(): string {
    return stageKeys(this.params, { ...this.inputs(), tier: 'export', cellScale: 1 }).S6;
  }

  private cancelWalls(): void {
    this.wallJob?.worker.terminate();
    this.wallJob = null;
  }

  /** Starts the check once nothing else runs or waits and what shows is current: it is the lowest priority there is. */
  private startWalls(): void {
    const { nx, ny } = this.params.grid;
    if (!this.options.checkWalls || !this.file || nx * ny < 2) return;
    const quiet = !this.fieldGate.busy && !this.solidGate.busy && this.debounce === null;
    const mesh = this.modelMesh(), oriented = this.oriented?.value;
    if (!quiet || this.error !== null || this.isStale() || !mesh || !oriented) return;
    const key = this.wallKey();
    if (this.walls?.key === key || this.wallJob?.key === key) return;
    this.cancelWalls();
    const worker = this.options.spawnField();
    this.wallJob = { key, worker };
    const done = (): boolean => {
      worker.terminate();
      if (this.wallJob?.worker !== worker) return false;
      this.wallJob = null;
      return true;
    };
    worker.onmessage = ({ data }: { data: FromWorker }) => {
      if (data.t === 'walls-done' && done()) {
        this.walls = { key, value: data.result };
        keep(this.wallTimes, data.result.ms);
      } else if (data.t === 'error' && done()) {
        this.walls = { key, value: { minWall: null, merged: false, requiredWall: 0, cell: this.params.quality.cellFinal, ms: 0, diagnostics: [{ code: 'wall-check-failed', severity: 'warning', message: `The walls between models could not be checked at the export cell: ${data.message}` }] } };
      } else return;
      this.collectDiagnostics();
      this.notify();
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (!done()) return;
      this.walls = { key, value: { minWall: null, merged: false, requiredWall: 0, cell: this.params.quality.cellFinal, ms: 0, diagnostics: [{ code: 'wall-check-failed', severity: 'warning', message: `The walls between models could not be checked at the export cell: ${event.message ?? 'the worker failed'}.` }] } };
      this.collectDiagnostics();
      this.notify();
    };
    const sent = { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
    const message: WallsJobMessage = { t: 'walls', id: 1, params: this.params, inputs: { mesh: sent, transform: oriented.oriented.transform } };
    worker.postMessage(message, [sent.positions.buffer, sent.indices.buffer]);
  }
}
