import { firstPourPeak, replicateOpenings, type OpeningPin } from '../core/analysis/placement';
import { withoutDoubledVoids, type GeometryReports } from '../core/analysis/reports';
import { dropOpening, openingSizes, placementSpace, type DropResult, type PlacementSpace } from '../core/analysis/validate';
import { pickable } from '../core/base/candidates';
import { transformPositions } from '../core/base/orient';
import { findStoredPlane, PLANE_MATCH_MM, planeGap, planeOf, type StoredPlane } from '../core/base/storedPlane';
import type { SolidReport } from '../core/mesh/shells';
import { meshBounds, type WeldedMesh } from '../core/mesh/weld';
import { defaultParams, resolveAuto } from '../core/params/defaults';
import { crossParameterErrors } from '../core/params/rules';
import { MANIFOLD_TRIANGLE_LIMIT } from '../core/mesh/simplify';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import type { CutOpening } from '../core/parts/openings';
import type { Diagnostic } from '../core/report/diagnostics';
import type { ExportInputs, ExportMeta, ExportOutputs, ExportRequest } from '../workers/exportJob';
import type { FieldWire, OrientedWire } from '../workers/fieldHost';
import { DEFAULT_PLANE, PLAIN_IMPORT, samePlane, type FieldOutput, type FieldWanted, type ImportInput, type ParsedModel, type PlacementOutput, type PlaneChoice } from '../workers/fieldStages';
import { type ExportJobMessage, type Fault, type FieldJobMessage, type FromWorker, type ReportsJobMessage, type SolidJobMessage, type WallsJobMessage, type WorkerLike } from '../workers/protocol';
import type { ReportsOutputs } from '../workers/reportStages';
import type { FootprintOutput, ImportOutput, PartMesh, SolidOutputs, SolidWanted } from '../workers/solidStages';
import type { WallCheck } from '../workers/wallCheck';
import { Budgets } from './budgets';
import { exportBlocked, siliconeAdvice } from './derived';
import { hashFloats, hashMesh, hashString } from './hash';
import { INIT_TIMEOUT_MS, JobGate, realTimers, type GateEvent, type GateTarget, type LogEntry, type Timers } from './jobGate';
import type { Project } from './project';
import { stageKeys, type StageId, type StageInputs } from './stages';
import { BUILD } from './buildInfo';
import { bodiesByPart, type SavedBy } from './version';
import { formatNormal } from '../ui/format';

export type { Project } from './project';

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

/** S8 and S9 for the field and placement on screen. */
interface ReportsTarget extends Target {
  field: FieldOutput;
  placement: PlacementOutput;
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
  slot: 'parsed' | 'oriented' | 'import' | 'footprint' | 'field' | 'placement' | 'cover' | 'base' | 'funnel' | 'reports';
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
  /**
   * S8 and S9, the analyses and reports, in a field.worker of their own once the preview's field and
   * placement are on screen, so they never hold up T1 or T2, and the export never waits for them.
   */
  reports?: boolean;
  /**
   * G1.8's limit, past which the solid workers take the simplified copy and the pipeline recycles them
   * around a whole import. Only a test sets it, with workers given the same, to reach that path cheaply.
   */
  manifoldLimit?: number;
}

/**
 * A project file's plane, checked against the first S2 of its model: `tried` once the choice did not
 * find it and another candidate or a picked face has been chosen in its place.
 */
interface PlaneCheck {
  file: string;
  stored: StoredPlane;
  /** The saved plane was looked for once already, so the next S2 is the one it found, or the best guess. */
  tried: boolean;
  /** The choice on screen is no longer the file's, so finding the plane is worth a note. */
  moved: boolean;
}

/** A 3D marker of the Show toggle: a pin at a point, and the line of a cut to it where there is one. */
export interface Marker {
  at: [number, number, number];
  seam?: [[number, number, number], [number, number, number]];
}

/**
 * A diagnostic as the card shows it. `exportCell` marks one read off the export field rather than the
 * preview's, and `byExport` one that the last export found, which holds while its geometry is current.
 */
export interface ShownDiagnostic extends Diagnostic {
  exportCell?: boolean;
  byExport?: boolean;
  /** Places to mark beyond its own `at`, such as every cut hint of the demold verdict. */
  markers?: Marker[];
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
  /** A step of exportSteps, or 'wait' while the preview catches up before the export starts. */
  step: string;
  done: number;
  total: number;
}

/** An export's result, with what it was built for, which exportKeyFor then tells apart from what shows now. */
export interface ExportResult extends ExportOutputs {
  key: string;
}

const ZIP_REQUEST: ExportRequest = { want: 'zip', fitTest: false };

/** A project this build writes, as the pins on screen are numbered. */
const CURRENT_FORMAT: SavedBy = { format: SCHEMA_VERSION, appVersion: BUILD.version };

/** Past this heap, the preview's solid worker is recycled before an export, so two heavy heaps never stand at once (M11). */
export const EXPORT_RECYCLE_BYTES = 1e9;

/** The single part each button saves, by its name in the ZIP. */
const PART_FILES: Partial<Record<ExportRequest['want'], string>> = { cover: 'cover.stl', base: 'base.stl', funnel: 'funnel.stl' };

function cancelledError(): Error {
  return Object.assign(new Error('Export cancelled.'), { name: 'Cancelled' });
}

/** Rows main works out itself for the state on screen, from the parameters, the rim and the parts. */
const MAIN_CODES = new Set(['bed-turn', 'bed-too-small', 'ridge-narrow', 'plastic-mass']);

/** A diagnostic as core has it, without the card's marks, for the files of an export. */
const plain = ({ code, severity, message }: Diagnostic): Diagnostic => ({ code, severity, message });

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

  /** The loaded STL. `sha256` is its hash once a save, an open or an export has worked it out off main. */
  private file: { id: string; name: string; bytes: Uint8Array; sha256: string | null } | null = null;
  private planeCheck: PlaneCheck | null = null;
  /**
   * M11c: the format and app version of the project on screen, until the import has said whether this model
   * joins parts into one body. Pins and removed vents name bodies by number, and internal builds before 1.0.1
   * numbered each part of the file as a body of its own. Since R1 the format tells which rule a file follows.
   */
  private numbering: { file: string; savedBy: SavedBy } | null = null;
  /**
   * Called when a project's saved plane was found under another choice than the file's, so the store
   * can mean the same face in the history it holds and in what it last saved.
   */
  onPlaneResolved: ((from: PlaneChoice, to: PlaneChoice) => void) | null = null;
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
  /** The union of the parts the import joined, for the section's cut, or null: see ImportOutput. */
  joined: ImportOutput['joined'] = null;
  footprint: Shown<FootprintOutput> | null = null;
  field: Shown<FieldOutput> & { mold: string } | null = null;
  placement: Shown<PlacementShown> | null = null;
  /** The cover and base also carry the rim key they were built on, so the view knows when its box proxies are newer. */
  cover: Shown<NonNullable<SolidOutputs['S13']>> & { mold: string } | null = null;
  base: Shown<NonNullable<SolidOutputs['S15']>> & { mold: string } | null = null;
  funnel: Shown<PartMesh | null> | null = null;
  /** S9 on screen, under its own key, which may lag what shows by a job. */
  reports: Shown<GeometryReports> | null = null;
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
  private readonly reportsGate: JobGate<ReportsTarget> | null;
  /** Why S9 could not be built for the state on screen, under its key. */
  private reportsFailure: { key: string; message: string } | null = null;
  /** In ms, per reports job, for the record: S8 only when it ran, S9 every time. */
  readonly reportTimes = { S8: [] as number[], S9: [] as number[] };
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly listeners = new Set<() => void>();
  private idleWaiters: { resolve: () => void; reports: boolean }[] = [];
  private debounce: { handle: unknown; signature: string } | null = null;
  private heavySignature = '';
  private heavyChangedAt = 0;
  /** A target that failed and must not be asked for again until something changes. */
  private failed = new Set<string>();
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
    this.reportsGate = options.reports
      ? new JobGate<ReportsTarget>({ ...common, name: 'reports', spawn: options.spawnField, derive: (t, c) => this.deriveReports(t, c), onEvent: (e) => this.onReports(e) })
      : null;
  }

  // ----- what the user does -----

  load(bytes: Uint8Array, name: string): void {
    this.startFile(bytes, name);
    this.changed();
  }

  /**
   * A project file's model with its parameters, plane, pins and removed vents, in one change, so no job
   * is asked for with the settings the page had before. `stored` is the plane the file was saved on,
   * which the model's first S2 checks the choice against, and `sha256` the hash its STL was checked by.
   */
  loadProject(bytes: Uint8Array, name: string, project: Project, stored: StoredPlane | null, sha256: string | null, savedBy: SavedBy = CURRENT_FORMAT): void {
    this.startFile(bytes, name);
    this.file!.sha256 = sha256;
    this.params = project.params;
    this.plane = project.plane;
    this.pins = project.pins;
    this.removed = project.removed;
    this.planeCheck = stored ? { file: this.file!.id, stored, tried: false, moved: false } : null;
    this.numbering = { file: this.file!.id, savedBy };
    this.changed();
  }

  /**
   * Settings for the model on screen, from an export ZIP or a lone project.json, as one change. With
   * the plane the file was saved on, the choice is checked against it as for a loaded project. `savedBy`
   * is the format and version of the file that holds the pins and removed vents in `project`.
   */
  applyProject(project: Project, stored: StoredPlane | null, savedBy: SavedBy = CURRENT_FORMAT): void {
    this.numbering = this.file ? { file: this.file.id, savedBy } : null;
    this.setProject(project);
    if (this.checkNumbering()) this.changed();
    if (!stored || !this.file) return;
    this.planeCheck = { file: this.file.id, stored, tried: false, moved: false };
    // The plane on screen may be the one the file chose already, and then no S2 is on its way to check it.
    if (this.checkPlane()) this.changed();
    else this.collectDiagnostics();
    this.notify();
  }

  /** What the check of a project's plane said belongs to the plane it said it of. */
  private dropPlaneNotes(): void {
    this.notes = this.notes.filter((note) => note.code !== 'plane-found' && note.code !== 'plane-mismatch');
  }

  private startFile(bytes: Uint8Array, name: string): void {
    // An export still waiting for the preview was asked for the model this one replaces, so it stops.
    this.exportWait?.();
    this.file = { id: `f${++this.loads}`, name, bytes, sha256: null };
    this.planeCheck = null;
    this.numbering = null;
    this.plane = DEFAULT_PLANE;
    this.importInput = PLAIN_IMPORT;
    this.pins = [];
    this.removed = [];
    this.dragState = null;
    this.crashScale = this.tuneScale = 1;
    this.budgets.restartT1();
    this.notes = [];
    this.parsed = this.oriented = this.imported = this.footprint = this.field = this.placement = this.cover = this.base = this.funnel = null;
    this.reports = null;
    this.reportsFailure = null;
    this.displayProxy = null;
    this.joined = null;
    this.walls = null;
    // Timings belong to the model they were taken on.
    for (const list of Object.values(this.timing)) list.length = 0;
    this.lastRebuild = null;
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
    // The user's own choice: what a project file saved is no longer the plane to find.
    this.planeCheck = null;
    this.dropPlaneNotes();
    this.plane = plane;
    this.pins = [];
    this.removed = [];
    this.changed();
  }

  /**
   * Undo and redo: the whole project at once, plane, pins and removed vents as they were, with one
   * change. Unlike setPlane, another plane here keeps the pins the snapshot holds for it.
   */
  setProject(project: Project): void {
    this.planeCheck = null;
    if (!samePlane(project.plane, this.plane)) this.dropPlaneNotes();
    this.params = project.params;
    this.plane = project.plane;
    this.pins = project.pins;
    this.removed = project.removed;
    this.dragState = null;
    this.changed();
  }

  /** T2b while the opening moves: only its copies are cut, into the cover already cut for the rest. */
  dragOpening(id: string, x: number, y: number): void {
    this.dragState = { id, x, y };
    this.changed();
  }

  /** Esc during a drag: the opening stays where it was, and the cover is cut for all openings again. */
  cancelDrag(): void {
    if (!this.dragState) return;
    this.dragState = null;
    this.changed();
  }

  /** The opening being dragged and where it is now, or null. */
  get dragging(): StageInputs['drag'] {
    return this.dragState;
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
    const result = dropOpening(shown.space, { kind: opening.kind, x, y }, others, firstPourPeak(shown.placement, id, this.params.silicone.t / 2));
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

  /** The loaded STL's bytes, exactly as they came, which a project file carries. Never changed in place. */
  get stlBytes(): Uint8Array | null {
    return this.file?.bytes ?? null;
  }

  /** SHA-256 of the loaded STL, once something has worked it out, or null. */
  get modelSha256(): string | null {
    return this.file?.sha256 ?? null;
  }

  /** Keeps a hash worked out off main, if the model it was worked out for is still the one loaded. */
  noteModelSha256(bytes: Uint8Array, sha256: string): void {
    if (this.file?.bytes === bytes) this.file.sha256 = sha256;
  }

  /**
   * The plane the model stands on, in the STL's own coordinates, for a project file: the one the choice
   * on screen found, or, while a project's saved plane is still being looked for, that one. Null until
   * S2 for the choice on screen is in, or if it failed.
   */
  storedPlane(): StoredPlane | null {
    if (this.planeCheck && this.planeCheck.file === this.file?.id) return this.planeCheck.stored;
    if (!this.oriented || this.oriented.key !== this.keys().S2) return null;
    return { ...planeOf(this.oriented.value.chosen), upper: this.plane.upper };
  }

  /** Whether the loaded STL has been read: false while it is being read, and when it cannot be. */
  modelParsed(): boolean {
    return this.file !== null && this.parsed?.key === this.keys().S1;
  }

  /** Resolves once S2 for the choice on screen is in, or once it cannot be: no file, or an error. */
  orientedReady(): Promise<void> {
    return new Promise((resolve) => {
      let off = (): void => {};
      const check = (): boolean => {
        if (this.file && this.error === null && this.oriented?.key !== this.keys().S2) return false;
        off();
        resolve();
        return true;
      };
      if (!check()) off = this.subscribe(() => void check());
    });
  }

  project(): Project {
    return { params: this.params, plane: this.plane, pins: this.pins, removed: this.removed };
  }

  /** The mesh the base plane orients: the welded one, or the import's when it flipped or rebuilt it. */
  /** G1.8: a mesh past this many triangles takes the Manifold path as its simplified copy. */
  private heavyMesh(mesh: WeldedMesh): boolean {
    return mesh.indices.length / 3 > (this.options.manifoldLimit ?? MANIFOLD_TRIANGLE_LIMIT);
  }

  modelMesh(): WeldedMesh | null {
    return this.importInput.mesh ?? this.parsed?.value.welded ?? null;
  }

  /**
   * Whether that mesh is a closed solid, which a filled section cut needs: true once the import made a
   * solid of it, false in soup mode, and null until the import has said.
   */
  modelClosed(): boolean | null {
    if (!this.parsed || this.imported?.key !== this.parsed.key) return null;
    return !this.importInput.soup;
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

  /** Resolves once no job runs or waits and what shows is current, or has failed: the reports too. */
  idle(): Promise<void> {
    return this.waitIdle(true);
  }

  private waitIdle(reports: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push({ resolve, reports });
      this.checkIdle();
    });
  }

  /** Why S9 failed for the state on screen, or null. */
  reportsError(): string | null {
    return this.reportsFailure !== null && this.reportsFailure.key === this.keys().S9 ? this.reportsFailure.message : null;
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

  /** Test hooks: a fault on the next job of a worker, or on the next export, and a recycle on demand. */
  armFault(gate: 'field' | 'solid' | 'export' | 'reports', fault: Fault): void {
    if (gate === 'export') this.exportFault = fault;
    else if (gate === 'reports') this.reportsGate?.armFault(fault);
    else (gate === 'field' ? this.fieldGate : this.solidGate).armFault(fault);
  }

  recycleSolid(): void {
    this.solidGate.recycle();
  }

  solidCached(): Partial<Record<StageId, string>> {
    return this.solidGate.cached;
  }

  readSolidHeap(): Promise<{ capacity: number | null; used: number | null; held: number; handles: number }> {
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
    this.reportsGate?.dispose();
    this.endExportWorker();
    this.cancelWalls();
    if (this.debounce) this.timers.clear(this.debounce.handle);
  }

  // ----- T3 -----

  /**
   * The last export of the mold, kept while the geometry it was built from is what the screen shows:
   * the single parts reuse its files, and the status strip shows its measured clearance.
   */
  private lastExport: { key: string; outputs: ExportOutputs } | null = null;
  /** The last export that failed, with why, kept in the same way. */
  private exportFailure: { key: string; message: string } | null = null;
  private exportFault: Fault | undefined;
  private exportActive = false;
  /** The preview solid worker's heap as its last result gave it. */
  private solidHeapBytes: number | null = null;
  /** The export's own worker while it runs, with its bootstrap timer until it says ready. */
  private exportWorker: { worker: WorkerLike; boot: unknown } | null = null;
  /** Set while an export waits for the preview: a new file ends that wait, as the model it was asked for is gone. */
  private exportWait: (() => void) | null = null;

  /** True from the request until the export ends, including any wait for the preview. */
  get exporting(): boolean {
    return this.exportActive;
  }

  /** Whether an export's own worker is alive, as far as the pipeline knows. */
  get exportWorkerAlive(): boolean {
    return this.exportWorker !== null;
  }

  /**
   * T3 in a fresh solid worker, terminated when it answers. Only Cancel ends it early: not a newer
   * change, nor a new file. A crash of the engine or the worker gets one retry at a coarser export
   * cell, as the preview's does. Any other error, such as the export's own check that its field fits
   * the rim, is a fault, shown as it is. A request made while the preview catches up waits for it, as
   * the export builds on the openings it placed; a new file during that wait ends it, and so does a
   * hard error the caught-up preview shows. A single part the last export already holds, for the
   * geometry on screen, is that export's file.
   */
  async exportParts(onProgress: (progress: ExportProgress) => void = () => {}, fault?: Fault, request: ExportRequest = ZIP_REQUEST): Promise<ExportResult> {
    if (this.exportActive) throw new Error('An export is already running.');
    this.exportActive = true;
    const armed = fault ?? this.exportFault;
    this.exportFault = undefined;
    let stop: (error: Error) => void = () => {};
    const ended = new Promise<never>((_, reject) => (stop = reject));
    ended.catch(() => {});
    this.cancelExport = () => {
      this.endExportWorker();
      stop(cancelledError());
    };
    const mold = request.want !== 'funnel' && request.want !== 'fit-test';
    try {
      if (mold && this.isStale() && this.error === null) {
        onProgress({ step: 'wait', done: 0, total: 1 });
        const asked = this.file?.name;
        this.exportWait = () => stop(Object.assign(new Error(`A new model was loaded while the export of ${asked} waited for the preview, so nothing was saved. Export again for the model now loaded.`), { name: 'Replaced' }));
        try {
          // The export builds its own reports, so it waits for the preview and not for them.
          await Promise.race([this.waitIdle(false), ended]);
        } finally {
          this.exportWait = null;
        }
      }
      // The buttons go by what showed at the click, and the rim's errors come with the field the wait was for.
      const blocked = mold ? exportBlocked(this) : null;
      if (blocked) throw Object.assign(new Error(blocked), { name: 'Blocked' });
      const key = this.exportKeyFor(request.want);
      const part = PART_FILES[request.want];
      // The funnel too is in the last export's files, which hold for as long as the mold's key does.
      const held = this.lastExport?.key === this.exportKey() ? this.lastExport.outputs : null;
      // The funnel's own build finds nothing about the mold, so it carries none of the mold's findings.
      if (part && held?.files[part]) return { ...held, want: request.want, files: { [part]: held.files[part] }, zip: new Uint8Array(), report: null, diagnostics: mold ? held.diagnostics : [], key };
      // M11: the export's own worker imports the model again, which for 3 million triangles grows its heap
      // to about 1 GB even from the simplified copy alone. The preview's worker would keep as much for as
      // long, so a heavy one goes first, freeing it, and comes back for the next change, which imports again.
      if (mold && ((this.solidHeapBytes ?? 0) > EXPORT_RECYCLE_BYTES || (this.parsed !== null && this.heavyMesh(this.parsed.value.welded)))) {
        this.solidGate.recycle();
        this.solidHeapBytes = null;
      }
      try {
        const outputs = await Promise.race([this.runExportWorker(request, onProgress, armed), ended]);
        if (mold) {
          const files = this.lastExport?.key === key ? { ...this.lastExport.outputs.files, ...outputs.files } : outputs.files;
          this.lastExport = { key, outputs: { ...outputs, files, zip: new Uint8Array() } };
          if (this.exportFailure?.key === key) this.exportFailure = null;
        }
        return { ...outputs, key };
      } catch (error) {
        if (mold && error instanceof Error && error.name !== 'Cancelled') this.exportFailure = { key, message: error.message };
        throw error;
      }
    } finally {
      this.exportActive = false;
      this.cancelExport = () => {};
      this.notify();
    }
  }

  /** Ends the export that runs, with no file. A no-op when none does. */
  cancelExport: () => void = () => {};

  private endExportWorker(): void {
    if (!this.exportWorker) return;
    this.timers.clear(this.exportWorker.boot);
    this.exportWorker.worker.terminate();
    this.exportWorker = null;
  }

  /**
   * What a request's result depends on, so a saved file can tell when what shows has moved on from it:
   * the mold's geometry for the ZIP, the cover and the base, the funnel's own stage for the funnel, and
   * every setting for the fit test, which reads the joint through the real builders.
   */
  exportKeyFor(want: ExportRequest['want']): string {
    if (want === 'funnel') return stageKeys(this.params, { ...this.inputs(), tier: 'export', cellScale: 1 }).S16;
    if (want === 'fit-test') return hashString(JSON.stringify(this.params));
    return this.exportKey();
  }

  /** What the last export found and measured, while the geometry it was built from is current. */
  currentExport(): ExportOutputs | null {
    // Most renders have no export to check, so the key is only worked out when there is one.
    return this.lastExport !== null && this.lastExport.key === this.exportKey() ? this.lastExport.outputs : null;
  }

  /** Why the last export failed, while the geometry it was asked for is current. */
  exportError(): string | null {
    return this.exportFailure !== null && this.exportFailure.key === this.exportKey() ? this.exportFailure.message : null;
  }

  /**
   * What only the export found, for the Diagnostics card: a failure, and the problems the preview does
   * not report itself, such as a raise of the margin or a retry at a coarser cell.
   */
  exportNotes(): ShownDiagnostic[] {
    const failed = this.exportError();
    if (failed) return [{ code: 'export-failed', severity: 'error', message: `The export failed: ${failed}`, exportCell: true, byExport: true }];
    const outputs = this.currentExport();
    if (!outputs) return [];
    const shown = new Set(this.diagnostics.map((d) => d.code));
    // Main works these out for the state on screen whatever the export said, so an old one would only mislead.
    return outputs.diagnostics.filter((d) => d.severity !== 'info' && !shown.has(d.code) && !MAIN_CODES.has(d.code)).map((d) => ({ ...d, exportCell: true, byExport: true }));
  }

  /**
   * What the export's result depends on: its own tier's stage keys, which hold every parameter and
   * input, and the openings it is given, which the preview placed on its own field.
   */
  private exportKey(): string {
    const keys = stageKeys(this.params, { ...this.inputs(), tier: 'export', cellScale: 1 });
    const openings = this.placement?.value.placement.openings.map(({ kind, x, y }) => [kind, x, y]) ?? [];
    return hashString(JSON.stringify([keys.S13, keys.S15, keys.S16, openings]));
  }

  /**
   * What main knows that the export does not work out again for itself: the file's own warnings, the
   * base plane and its levels, the placement of the openings it is given, the walls checked at the
   * export cell, and the advice on t. The import, the footprint, the field, the rim, the cover, the base
   * and the cross-parameter rules it finds afresh at its own cell, and the preview's notes on itself,
   * such as a coarser preview cell after a crash, say nothing about the mold.
   */
  private exportMeta(): ExportMeta {
    const parsed = this.parsed!.value, oriented = this.oriented!.value;
    const { normal, offset, area } = oriented.chosen;
    const notes = [
      ...parsed.diagnostics,
      ...oriented.diagnostics,
      ...(this.footprint?.value.levels.diagnostics ?? []),
      ...this.wallDiagnostics(),
      ...(this.placement?.value.placement.diagnostics ?? []),
      ...siliconeAdvice(this.params, this.field?.value.rim ?? null),
    ];
    return {
      model: this.file!.name,
      modelSha256: this.file!.sha256,
      basePlane: this.storedPlane(),
      triangles: { format: parsed.format, inFile: parsed.rawTriangles, kept: parsed.triangles },
      project: this.project(),
      plane: { normal: [normal[0], normal[1], normal[2]], offset, area, planeTol: oriented.planeTol },
      notes: notes.map(plain),
    };
  }

  private runExportWorker(request: ExportRequest, onProgress: (progress: ExportProgress) => void, fault?: Fault): Promise<ExportOutputs> {
    const parsed = this.parsed?.value, oriented = this.oriented?.value, placement = this.placement?.value;
    const mold = request.want !== 'funnel' && request.want !== 'fit-test';
    if (mold && (!parsed || !oriented || !placement || this.isStale())) return Promise.reject(new Error(this.error ?? 'Wait for the preview to finish before exporting.'));
    // Built afresh for each run, as the transfer detaches the arrays it sends.
    const inputsFor = (): ExportInputs | null =>
      mold
        ? {
            welded: { positions: parsed!.welded.positions.slice(), indices: parsed!.welded.indices.slice() },
            audit: parsed!.audit,
            candidate: { members: oriented!.chosen.members.slice(), holes: oriented!.chosen.holes },
            transform: oriented!.oriented.transform,
            needsTrim: oriented!.oriented.needsTrim,
            planeTol: oriented!.planeTol,
            openings: placement!.placement.openings.map(({ id, kind, x, y, pinned }) => ({ id, kind, x, y, pinned })),
            // Only for the ZIP's project.json, and only while main does not know its hash.
            stl: request.want === 'zip' && this.file!.sha256 === null ? this.file!.bytes.slice() : null,
            // M11: past G1.8's limit, the preview's import, which checked the whole mesh, so the export need not.
            importReport: this.heavyMesh(parsed!.welded) && this.imported?.key === this.keys().S1 ? this.imported.value : null,
          }
        : null;
    const params = this.params;
    const meta = mold ? this.exportMeta() : null;
    const file = this.file;
    const run = (cellScale: number, armed?: Fault): Promise<ExportOutputs> =>
      new Promise((resolve, reject) => {
        const worker = this.options.spawnSolid();
        const done = (): void => {
          if (this.exportWorker?.worker === worker) this.endExportWorker();
          else worker.terminate();
        };
        // The Workers rule: a worker that has not said ready within 20 s gets an inline error, not a stage bar for good.
        const boot = this.timers.set(() => {
          if (this.exportWorker?.worker !== worker) return;
          done();
          reject(Object.assign(new Error('The geometry engine did not start within 20 s, so nothing was exported. Try again, or reload the page.'), { name: 'InitTimeout' }));
        }, INIT_TIMEOUT_MS);
        this.exportWorker = { worker, boot };
        worker.onmessage = ({ data }: { data: FromWorker }) => {
          if (data.t === 'ready') this.timers.clear(boot);
          else if (data.t === 'progress') {
            this.timers.clear(boot);
            onProgress(data);
          } else if (data.t === 'exported') {
            done();
            if (file && data.outputs.modelSha256) this.noteModelSha256(file.bytes, data.outputs.modelSha256);
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
        const message: ExportJobMessage = { t: 'export', id: 1, ...request, params, inputs, meta, cellScale, ...(armed ? { fault: armed } : {}) };
        worker.postMessage(message, inputs ? [inputs.welded.positions.buffer, inputs.welded.indices.buffer, inputs.candidate.members.buffer, ...(inputs.stl ? [inputs.stl.buffer] : [])] : []);
      });
    const crashed = (error: unknown): error is Error => error instanceof Error && CRASH_NAMES.has(error.name);
    return run(1, fault).catch((error: unknown) => {
      if (!crashed(error)) throw error;
      return run(CRASH_SCALE).catch((again: unknown) => {
        if (!crashed(again)) throw again;
        // The engine's own words, such as "memory access out of bounds", tell a maker nothing to do.
        throw Object.assign(new Error(`The geometry engine failed twice, the second time at half the detail (${again.message}). Close other browser tabs to free memory and export again, or set a coarser Export cell under Advanced, Quality.`), { name: again.name });
      });
    });
  }

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
      this.requestReports(keys);
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

  /**
   * S8 and S9 go only once the whole preview for these keys is on screen and the solid worker is idle:
   * run beside the first T2 of a model, S8 slowed it by 60 to 100 ms in Chromium on this server. So a
   * drag or a burst of changes asks for them once, at its end, and the newest request is all that runs.
   */
  private requestReports(keys: Record<StageId, string>): void {
    const gate = this.reportsGate;
    if (!gate) return;
    const field = this.field?.key === keys.S6 && this.field.mold === keys.S10 ? this.field.value : null;
    const placement = this.placement?.key === keys.S7 ? this.placement.value : null;
    const previewDone = !this.isStale() && !this.solidGate.busy && this.debounce === null;
    if (this.reports?.key === keys.S9 || !previewDone || !field || !placement || this.oriented?.key !== keys.S2 || !this.modelMesh()) {
      gate.cancelPending();
      return;
    }
    const target = this.target<ReportsTarget>(keys, { field, placement }, ['reports', keys.S8, keys.S9]);
    if (!this.failed.has(target.id)) gate.request(target);
  }

  private deriveReports(target: ReportsTarget, cached: Partial<Record<StageId, string>>): { message: ReportsJobMessage; transfer: Transferable[] } {
    const { keys, params } = target;
    const { importInput, parsed, oriented } = target.source;
    const source = importInput.mesh ?? parsed?.welded ?? null;
    // The mesh only while the worker lacks S8, which is once per model and plane.
    const mesh = cached.S8 !== keys.S8 && source ? { positions: source.positions.slice(), indices: source.indices.slice() } : null;
    const values = target.field.field.values.slice();
    const transfer: Transferable[] = [values.buffer];
    if (mesh) transfer.push(mesh.positions.buffer, mesh.indices.buffer);
    const { placement } = target.placement;
    return {
      message: {
        t: 'reports',
        id: 0,
        keys,
        params,
        inputs: {
          mesh,
          transform: oriented!.oriented.transform,
          field: { ...target.field.field, values },
          raise: params.quality.tinTolPreview,
          rim: target.field.rim,
          tiles: target.field.mold.offsets.length,
          ceiling: { leaves: placement.ceilingLeaves, uncovered: placement.uncovered },
        },
      },
      transfer,
    };
  }

  private onReports(event: GateEvent<ReportsTarget>): void {
    const { target } = event;
    if (event.kind === 'result') {
      const outputs = event.message.outputs as ReportsOutputs;
      const { timings } = event.message;
      if (timings.S8 !== undefined) keep(this.reportTimes.S8, timings.S8);
      if (timings.S9 !== undefined) keep(this.reportTimes.S9, timings.S9);
      if (this.accept('reports', target, this.reports)) {
        this.reports = { key: target.keys.S9, rev: target.rev, value: outputs.S9 };
        if (this.reportsFailure?.key === target.keys.S9) this.reportsFailure = null;
      }
    } else if (event.kind === 'failed' || event.kind === 'crashed') {
      // The reports say nothing the mold needs, so their failure is a note and never blocks an export.
      if (target.modelKey === this.modelKey()) {
        this.failed.add(target.id);
        this.reportsFailure = { key: target.keys.S9, message: event.error.message };
      }
    }
    if (event.kind !== 'stage') this.collectDiagnostics();
    this.update();
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
    // M11: past G1.8's limit, the import that checked the whole mesh, so a fresh worker builds only the copy.
    const known = parsed && this.heavyMesh(parsed.welded) && this.imported?.key === keys.S1 ? this.imported.value : null;
    const model = needsModel && parsed ? { welded: { positions: parsed.welded.positions.slice(), indices: parsed.welded.indices.slice() }, audit: parsed.audit, known } : null;
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
          // Previews crop the tool to the rim, as their coarser cell can reach past the export's bounds (G6).
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
      if (outputs.S2 && this.accept('oriented', target, this.oriented)) {
        this.oriented = { key: target.keys.S2, rev: target.rev, value: outputs.S2 };
        // A project's plane found under another choice is a change of the pipeline's own, as a retry is.
        if (this.checkPlane()) {
          this.rev++;
          this.failed.clear();
          this.error = null;
        }
      }
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
        this.joined = outputs.S1.joined;
        // Field.worker started on the welded mesh. If the import changed it, S2 and all after it go again.
        if (outputs.S1.import.key !== this.importInput.key) {
          this.importInput = outputs.S1.import;
          this.rev++;
          // What failed on the welded mesh may well work on the import's: a mesh wound inside out has no
          // face to stand on until it is flipped. So this is a change like the user's.
          this.failed.clear();
          this.error = null;
        }
        if (this.checkNumbering()) this.rev++;
      }
      if (outputs.S2 && this.accept('footprint', target, this.footprint)) this.footprint = { key: target.keys.S2, rev: target.rev, value: outputs.S2 };
      if (outputs.S13 && this.accept('cover', target, this.cover)) this.cover = { key: target.keys.S13, mold: target.keys.S10, rev: target.rev, value: outputs.S13 };
      if (outputs.S15 && this.accept('base', target, this.base)) this.base = { key: target.keys.S15, mold: target.keys.S10, rev: target.rev, value: outputs.S15 };
      if (outputs.S16 !== undefined && this.accept('funnel', target, this.funnel)) this.funnel = { key: target.keys.S16, rev: target.rev, value: outputs.S16 };
      this.collectDiagnostics();
      const heap = event.message.heapBytes;
      this.solidHeapBytes = heap;
      // M11: the whole solid of a mesh past G1.8's limit leaves its heap at about 1.5 GB, and only the import
      // needs it, so the worker goes at once; the next job's fresh worker builds the copy alone.
      const checkedWhole = outputs.S1 !== undefined && target.source.parsed !== null && this.heavyMesh(target.source.parsed.welded);
      if (checkedWhole || (heap !== null && heap > this.budgets.settings.recycleBytes)) this.solidGate.recycle();
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
    if (gate === 'field' && event.kind === 'failed' && this.replaceUnusablePick()) return;
    if (event.kind === 'crashed' && this.crashScale < CRASH_SCALE) {
      this.crashScale = CRASH_SCALE;
      this.rescaled();
      this.notes = [{ code: 'preview-coarser', severity: 'warning', message: `The ${gate} worker failed, so the preview now runs at ${CRASH_SCALE} times the cell until the next load.` }];
      return;
    }
    this.failed.add(event.target.id);
    this.error = event.kind === 'crashed' ? `The geometry could not be built, even at a coarser cell: ${event.error.message}` : event.error.message;
  }

  /**
   * Once the import of a project's model is in: if it joins parts into one body and the project was saved by
   * a build that numbered each part as a body, its pins and removed vents are reset, with a warning, as
   * body 2 there is some other part here, or none. Returns whether it reset them.
   */
  private checkNumbering(): boolean {
    const check = this.numbering;
    if (!check || check.file !== this.file?.id || !this.parsed || this.imported?.key !== this.parsed.key) return false;
    this.numbering = null;
    const report = this.imported.value;
    const parts = report.shells.filter((shell) => shell.kind !== 'void').length;
    if (!bodiesByPart(check.savedBy) || report.bodies === parts || (this.pins.length === 0 && this.removed.length === 0)) return false;
    this.pins = [];
    this.removed = [];
    // Only internal builds wrote formats before 4. Their numbers would read as newer than a public one, such
    // as 1.0.0 beside the header's v0.1.0, so the build is named as a test build, its number only in brackets.
    const { appVersion } = check.savedBy;
    const by = /^\d+\.\d+\.\d+/.test(appVersion) ? `an early test build of the app (${appVersion})` : 'an early test build of the app';
    this.notes.push({ code: 'openings-reset', severity: 'warning', message: `This project was saved by ${by}, from before the public versions, which took each part of the file for a model of its own. Parts that overlap or touch are now one model, so the openings it moved and the vents it removed were reset: move or remove them again.` });
    return true;
  }

  /**
   * A project file's choice of plane depends on how this version ranks candidates and welds the mesh,
   * so the plane it was saved on is checked against the plane the choice finds, within PLANE_MATCH_MM
   * across the model. If they differ, the ranked candidate or level that is that plane is chosen
   * instead, or else the largest triangle on it is picked; failing both, the nearest candidate within
   * the plane tolerance slider's reach, with a warning. Returns whether it changed the choice, which
   * keeps the pins and removed vents the project holds for that face.
   */
  private checkPlane(): boolean {
    const check = this.planeCheck, mesh = this.modelMesh();
    if (!check || check.file !== this.file?.id || !this.oriented || this.oriented.key !== this.keys().S2 || !mesh) return false;
    const oriented = this.oriented.value;
    const bounds = meshBounds(mesh.positions);
    const gap = planeGap(planeOf(oriented.chosen), check.stored, bounds);
    const saved = `The base face saved with this project, facing ${formatNormal(check.stored.normal)}${check.stored.upper === false ? '' : `, on its level ${check.stored.upper.toFixed(2)} mm up`},`;
    if (gap <= PLANE_MATCH_MM) {
      this.planeCheck = null;
      if (check.moved) this.notes.push({ code: 'plane-found', severity: 'info', message: `${saved} is ${choiceName(this.plane)} in this version of the app, which numbers the faces differently, so the model stands on it as saved.` });
      return false;
    }
    if (!check.tried) {
      check.tried = true;
      const found = findStoredPlane(check.stored, oriented.candidates, mesh, oriented.planeTol, bounds);
      if (found && !samePlane(found.choice, this.plane)) {
        const from = this.plane;
        this.plane = found.choice;
        check.moved = true;
        this.onPlaneResolved?.(from, found.choice);
        return true;
      }
    }
    // The best guess stands: the nearest plane found, or the saved choice as this version reads it.
    this.planeCheck = null;
    const off = Number.isFinite(gap) ? `up to ${gap.toFixed(2)} mm off it across the model` : `which faces ${formatNormal(oriented.chosen.normal)}`;
    this.notes.push({ code: 'plane-mismatch', severity: 'warning', message: `${saved} is not one this version of the app finds, so the model stands on ${choiceName(this.plane)}, ${off}. Check the base face before you export.` });
    return false;
  }

  /**
   * S2 refuses a picked triangle this mesh does not have, which a project file from a version that welds
   * the model otherwise can name. The model then stands on the best-ranked face, as a user's choice that
   * failed must not be taken for an engine crash, and a saved plane is looked for from there as for any
   * project. Without one, a warning says the face was not found. Returns whether it did this.
   */
  private replaceUnusablePick(): boolean {
    const mesh = this.modelMesh();
    if (!('pick' in this.plane) || !mesh || pickable(mesh, this.plane.pick)) return false;
    const from = this.plane;
    this.plane = DEFAULT_PLANE;
    const check = this.planeCheck?.file === this.file?.id ? this.planeCheck : null;
    if (check) check.moved = true;
    else this.notes.push({ code: 'plane-mismatch', severity: 'warning', message: `The face picked as the base, triangle ${from.pick + 1}, is not a face of this model as this version of the app reads it, so the model stands on ${choiceName(this.plane)}. Check the base face before you export.` });
    this.onPlaneResolved?.(from, this.plane);
    // A change of the pipeline's own, as a project's plane found under another choice is.
    this.rev++;
    this.failed.clear();
    this.error = null;
    return true;
  }

  private collectDiagnostics(): void {
    const all: ShownDiagnostic[] = [...this.notes, ...crossParameterErrors(this.params)];
    if (this.parsed) all.push(...this.parsed.value.diagnostics);
    // A hole's Show marks the middle of its rim; the cavity's warning marks only the holes facing up.
    if (this.imported) all.push(...this.imported.value.diagnostics.map((d) => (d.code === 'missing-surface' ? { ...d, markers: this.holeMarkers(false) } : d)));
    if (this.oriented) all.push(...this.oriented.value.diagnostics.map((d) => (d.code === 'missing-top-surface' ? { ...d, markers: this.holeMarkers(true) } : d)));
    if (this.displayProxy && this.parsed) {
      const drawn = (this.displayProxy.indices.length / 3).toLocaleString('en-US'), whole = this.parsed.value.triangles.toLocaleString('en-US');
      all.push({ code: 'display-proxy', severity: 'info', message: `The view draws this model simplified to ${drawn} of its ${whole} triangles, to keep it quick to turn; the mold is built from the whole mesh.` });
    }
    if (this.footprint) all.push(...this.footprint.value.diagnostics, ...this.footprint.value.levels.diagnostics);
    all.push(...this.wallDiagnostics());
    if (this.field) all.push(...this.field.value.diagnostics, ...this.field.value.rim.diagnostics);
    if (this.placement) all.push(...this.placement.value.placement.diagnostics);
    if (this.cover) all.push(...this.cover.value.diagnostics);
    if (this.base) all.push(...this.base.value.diagnostics);
    if (this.reports) {
      // The verdict's Show marks every place to cut, with the line of the cut.
      const hints: Marker[] = this.reports.value.demold.hints.map((h) => ({ at: h.at, seam: h.seam }));
      all.push(...this.reports.value.diagnostics.map((d) => (d.code === 'demold-verdict' && hints.length > 0 ? { ...d, markers: hints } : d)));
    }
    const reportsError = this.reportsError();
    if (reportsError) all.push({ code: 'reports-failed', severity: 'warning', message: `The demold and air reports could not be worked out: ${reportsError}` });
    const seen = new Set<string>();
    this.diagnostics = withoutDoubledVoids(all, this.reports?.value ?? null).filter((d) => {
      const key = `${d.code}|${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Each hole of an open mesh at the middle of its rim, in mold coordinates; with `up`, only those whose missing cap faces up. */
  private holeMarkers(up: boolean): Marker[] {
    const mesh = this.modelMesh(), transform = this.oriented?.value.oriented.transform;
    if (!mesh || !transform) return [];
    const [, , , , , , g, h, i] = transform.rotation;
    return this.importInput.openLoops
      .filter(({ capNormal: [x, y, z] }) => !up || g * x + h * y + i * z > 0)
      .map(({ vertices }): Marker => {
        const middle = new Float32Array(3);
        for (const v of vertices) for (let k = 0; k < 3; k++) middle[k] += mesh.positions[v * 3 + k] / vertices.length;
        const [x, y, z] = transformPositions(middle, transform);
        return { at: [x, y, z] };
      });
  }

  /** The wall check's findings for the state on screen, all read at the export cell. */
  private wallDiagnostics(): ShownDiagnostic[] {
    const walls = this.wallStatus().result;
    if (!walls) return [];
    const found: ShownDiagnostic[] = walls.diagnostics.map((d) => ({ ...d, exportCell: true }));
    // A check that passed says so too, so the card shows that the walls were looked at.
    const problem = walls.diagnostics.some((d) => d.code === 'tiles-merged' || d.code === 'thin-tile-wall' || d.code === 'wall-check-failed');
    if (!problem && walls.minWall !== null) found.push({ code: 'tile-walls', severity: 'info', message: `The thinnest wall between models is ${walls.minWall.toFixed(2)} mm, enough to print.`, exportCell: true });
    return found;
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
    // The reports come after the preview: done, failed, or not wanted at all.
    const reportsDone = !this.reportsGate || !this.file || this.error !== null || (!this.reportsGate.busy && (this.reports?.key === this.keys().S9 || this.reportsError() !== null));
    const ready = this.idleWaiters.filter((w) => !w.reports || reportsDone);
    if (ready.length === 0) return;
    this.idleWaiters = this.idleWaiters.filter((w) => !ready.includes(w));
    ready.forEach((w) => w.resolve());
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

/** A plane choice as a maker reads it in a message. */
function choiceName(plane: PlaneChoice): string {
  const face = 'rank' in plane ? `candidate ${plane.rank + 1}` : 'a face picked on the model';
  return plane.upper === false ? face : `${face}, on its level ${plane.upper.toFixed(2)} mm up`;
}
