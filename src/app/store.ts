import { signal, type Signal } from '@preact/signals';
import type { DropResult, OpeningKind } from '../core/analysis/validate';
import type { Rim } from '../core/parts/rim';
import { DEFAULT_LAYERS, type LayerName, type LayerStyle } from '../view/layers';
import type { ExportWant } from '../workers/exportJob';
import { samePlane, type PlaneChoice } from '../workers/fieldStages';
import { dragCheck, moldBox, openingLabel, type DragCheck } from './derived';
import { downloadName, saveBytes } from './download';
import { History, sameProject } from './history';
import { realTimers, type Timers } from './jobGate';
import { arrayBytes, type MemorySource, type WorkerMemory } from './memory';
import type { Pipeline, Project, RepairOffer } from './pipeline';
import { projectFile, type ProjectFile, type StoredPlane } from './project';
import { fileKind, fileKindOfHead, holdsModel, PROJECT_EXTENSION } from './projectArchive';
import { OPEN_INSTEAD, ProjectError, type ProjectNote } from './projectFile';
import type { ProjectFiles } from './projectFiles';
import { changedPaths, PARAM_PATHS, paramDef, setParamValue, type ParamPath } from './stages';
import { PACK_FAILED, READ_IN_WORKER_BYTES, readStl, type Opened } from '../workers/projectJob';
import type { PrepareStep } from '../workers/prepareJob';
import { estimateTriangles } from '../core/stl/estimate';
import { clampTarget, defaultTarget, HEAD_BYTES, isLarge, LARGE_MODEL, minBytesToLook, repairedName, SIMPLIFY_MAX_ERROR_MM, simplifiedName, type LargeLimits } from './largeModel';
import type { ModelSimplifier } from './modelSimplifier';
import { repairedEntry, simplifiedEntry, type ModelOrigin, type OriginalImport, type OriginalSource } from './simplified';
import { autoRepairCell, cellFacts, repairCellLimit, repairCellProblem, type CellFacts } from '../core/mesh/repair';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import { BUILD } from './buildInfo';
import type { SavedBy } from './version';
import { creditOf, GALLERY, galleryEntry, type GalleryCredit, type GalleryEntry } from '../gallery/catalogue';
import { fetchGalleryModel } from '../gallery/open';
import { DEFAULT_MOLD_TYPE, MOLD_TYPE_LIST, MOLD_TYPES, moldTypeOf, type MoldType, type MoldTypeId, type TypeContext } from '../core/mold/types';
import { defaultOf } from '../core/params/defaults';
import { MOLD_TYPE_UI, type MoldTypeUi } from '../ui/mold/moldTypeUi';
import { applySwitch, planSwitch, typeOnOpen, unavailableNotice, type SwitchPlan } from './moldSwitch';

export type Theme = 'dark' | 'light';

/**
 * The viewer's own choice, read by the inline script in index.html before the first paint. The key keeps
 * the app's first name, as no one reads it, so a theme chosen before a rename survives every rename.
 */
export const THEME_KEY = 'cfg-theme';

/** localStorage can be missing or throw, in a private window or with storage blocked; the theme then lasts the visit. */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Nothing to do: the choice still holds until the page is closed.
  }
}

/**
 * Where the Export box stands: an export running with its step, or how the last one ended. A saved
 * file keeps what it was built for, so the box can say once the screen has moved on from it, and the
 * first error the export itself found, as such a file was saved all the same.
 */
export type ExportState =
  | { phase: 'idle' }
  | { phase: 'running'; want: ExportWant; step: string; done: number; total: number }
  | { phase: 'saved'; want: ExportWant; file: string; key: string; error: string | null }
  | { phase: 'cancelled'; want: ExportWant }
  | { phase: 'failed'; want: ExportWant; message: string };

export type SectionAxis = 'x' | 'y' | 'z';

/**
 * The section view: one clipping plane across the axis, at `at` mm along it in mold coordinates, or
 * the middle of the mold while `at` is null. It keeps the side away from the first view's camera, or
 * the other side when flipped. A way of looking, so undo never touches it.
 */
export interface SectionState {
  on: boolean;
  axis: SectionAxis;
  flip: boolean;
  at: number | null;
}

/** The mold's outer box in mm, from the base's underside to the flat top. */
export interface MoldExtent {
  min: [number, number, number];
  max: [number, number, number];
}

export const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/**
 * Which side each axis keeps: the far side from the first view's camera, which looks from the front
 * (-y), the right (+x) and above, so the cut faces it. Flip keeps the other side.
 */
const KEPT: Record<SectionAxis, [number, number, number]> = { x: [-1, 0, 0], y: [0, 1, 0], z: [0, 0, -1] };

/** Where a section plane can go along its axis: across the mold's outer box. */
export function sectionRange(axis: SectionAxis, box: MoldExtent): [number, number] {
  const k = AXIS_INDEX[axis];
  return [box.min[k], box.max[k]];
}

/** The plane of a section: its normal towards the side kept, and its place along the axis, kept inside the box. */
export function sectionPlane(state: SectionState, box: MoldExtent): { normal: [number, number, number]; point: [number, number, number]; at: number } {
  const [low, high] = sectionRange(state.axis, box);
  const at = Math.min(high, Math.max(low, state.at ?? (low + high) / 2));
  const point: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  point[AXIS_INDEX[state.axis]] = at;
  // Adding 0 turns a flipped -0 into 0, so equal planes compare equal.
  const normal = KEPT[state.axis].map((n) => (state.flip ? -n : n) + 0) as [number, number, number];
  return { normal, point, at };
}

/**
 * The exploded view: the cover and funnels go up and the base down, by `distance` mm, moved and never
 * turned. Null follows the box: a quarter of its height, and each model loads with it so.
 */
export interface ExplodeState {
  on: boolean;
  distance: number | null;
}

/** The explode slider's far end: one and a half times the box's height, from the base's underside to the top. */
export function explodeMax(rim: Rim | null): number {
  return Math.max(10, Math.ceil(rim ? moldBox(rim)[2] * 1.5 : 60));
}

/** The distance the view moves the parts by, kept on the slider's range whatever box it was set on. */
export function explodeDistance(state: ExplodeState, rim: Rim | null): number {
  const start = rim ? Math.round(moldBox(rim)[2] / 4) : 10;
  return Math.min(explodeMax(rim), Math.max(0, state.distance ?? start));
}

/** An opening being dragged in the view: where it is now on the first tile, whether it may stand there, and the pointer. */
export interface OpeningDrag {
  id: string;
  kind: OpeningKind;
  label: string;
  x: number;
  y: number;
  check: DragCheck;
  /** The pointer, in CSS pixels from the viewport's top left, where the drag's note follows it. */
  pointer: { x: number; y: number };
}

/** What the last open or save of a project file had to say, under the file row. */
export interface FileNotice {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** What reading the file changed or could not check, one line each. */
  notes: ProjectNote[];
  /** The field or the reader's own words behind an error, shown folded away. */
  details?: string | null;
  /** A save's notice, which the Model section rewords once the project has changed since. */
  saved?: string;
}

/** A file that would replace the model on screen while it has changes not saved, waiting for the maker's answer. */
export interface Replacing {
  name: string;
  model: string;
}

/** The memory meter's reading (MM1): what the app holds for the model, in bytes, in all and by where it is. */
export interface MemoryReading {
  total: number;
  parts: Partial<Record<MemorySource, WorkerMemory>>;
}

/** What the memory meter needs of the page: whether it is hidden, and word when that changes. */
export interface MeterPage {
  hidden(): boolean;
  onVisibility(listener: () => void): void;
}

/** The memory meter reads at most this often, in ms, unless a figure falls. */
export const MEMORY_THROTTLE_MS = 500;

/**
 * MM2: a model past the warning point, held back until the maker answers (R42): an STL not read yet, a
 * .moldproj opened but its model not handed over, or the model on screen, from Simplify….
 */
export interface LargePrompt {
  kind: 'stl' | 'moldproj' | 'loaded';
  /** The file chosen: the STL, or the .moldproj. */
  name: string;
  /** The STL's own name. */
  model: string;
  /** The STL's size in bytes. */
  size: number;
  triangles: number;
  /** False where the count is estimated from a text file's first bytes. */
  exact: boolean;
  format: 'binary' | 'ascii';
  /** The count the copy is asked for, which the question's number box holds. */
  target: number;
  /** Why simplifying did not work, after which only Load anyway and Cancel are offered. */
  refused?: string;
}

/** MM2: a copy being made: of which file, to how many triangles, and how far it is. */
export interface Simplifying {
  name: string;
  target: number;
  step: PrepareStep;
  round: number;
}

/** RM: a repair being made: of which file, on what grid (null for auto), and how far it is. */
export interface Repairing {
  name: string;
  /** The grid asked for, or null for auto; `auto` is what auto comes to for this file. */
  cell: number | null;
  auto: number | null;
  step: PrepareStep;
  round: number;
  /** A rebuild's z-slabs: `done` of `total`. */
  done: number;
  total: number;
}

/** A project carried onto another model of the same object: the copy, or the file again (MM2). */
interface Carried {
  project: Project;
  stored: StoredPlane | null;
  savedBy: SavedBy;
}

/** What the large-model question holds while it waits: the file, unread, and for a .moldproj what it opened to. */
interface LargeWaiting {
  file: Blob;
  source: OriginalSource;
  opened?: Opened;
}

/** The project a project file holds. */
const projectOf = (file: ProjectFile): Project => ({ params: file.params, plane: file.plane, pins: file.pins, removed: file.removed });

/** MM2: a .moldproj's project, carried onto the copy of its model: a picked face becomes the plane it is found on. */
function carriedFrom(opened: Opened): Carried {
  const { file } = opened;
  const plane = 'pick' in file.plane ? { rank: 0, upper: file.plane.upper } : file.plane;
  return { project: { ...projectOf(file), plane }, stored: file.basePlane, savedBy: { format: opened.from, appVersion: file.appVersion } };
}

/** The history group of one parameter's control, so its slider and wheel steps join one step. */
function paramGroup(path: ParamPath): string {
  return `param:${path}`;
}

/** What each button saves, named after the model: a file of the export's, or its ZIP. */
const SAVES: Record<ExportWant, { suffix: string; file: string | null; mime: string }> = {
  zip: { suffix: '-mold.zip', file: null, mime: 'application/zip' },
  cover: { suffix: '-cover.stl', file: 'cover.stl', mime: 'application/octet-stream' },
  base: { suffix: '-base.stl', file: 'base.stl', mime: 'application/octet-stream' },
  funnel: { suffix: '-funnel.stl', file: 'funnel.stl', mime: 'application/octet-stream' },
  'fit-test': { suffix: '-fit-test.zip', file: null, mime: 'application/zip' },
};

/**
 * The UI's state. The project, which is what undo and project files will keep, is the pipeline's:
 * every action here goes to the pipeline, and `project` mirrors it after each change, so there is one
 * copy of the truth. Everything else is how the user is looking at it.
 */
export class Store {
  /** Bumped on every change the pipeline makes, so components read its results afresh. */
  readonly tick = signal(0);
  readonly project: Signal<Project>;
  readonly theme = signal<Theme>(readTheme());
  readonly sidebarCollapsed = signal(false);
  readonly wireframe = signal(false);
  readonly perspective = signal(true);
  readonly layers = signal<Record<LayerName, LayerStyle>>(structuredClone(DEFAULT_LAYERS));
  /** Click-to-pick of the base face on the model. */
  readonly pickMode = signal(false);
  /** The candidate row under the pointer, by rank. */
  readonly hoverCandidate = signal<number | null>(null);
  /** The triangle under the pointer in pick mode. */
  readonly hoverTriangle = signal<number | null>(null);
  /** Diagnostics with their Show toggle on, by code and message. */
  readonly shown = signal<string[]>([]);
  /** What the last typed position of an opening did: where it went, and whether it had to move. */
  readonly lastMove = signal<{ id: string; result: DropResult } | null>(null);
  /** The renderer's name, once the view has one. */
  readonly renderer = signal('');
  readonly exportState = signal<ExportState>({ phase: 'idle' });
  /** The Export box's option to put the fit-test pieces in the ZIP as fit_test/. */
  readonly fitTestInZip = signal(false);
  readonly section = signal<SectionState>({ on: false, axis: 'x', flip: false, at: null });
  readonly explode = signal<ExplodeState>({ on: false, distance: null });
  /** The opening the pointer drags in the view, or null. */
  readonly drag = signal<OpeningDrag | null>(null);
  /** Bumped by the Top view button; the view looks straight down at the top each time it moves. */
  readonly topView = signal(0);
  /** The Diagnostics card folded to its title, by its own toggle or by Top view. */
  readonly diagnosticsFolded = signal(false);
  readonly history: History;
  /** Bumped whenever the history changes, so the undo and redo buttons read it afresh. */
  readonly historyTick = signal(0);
  /** The .moldproj the model came from, by its file name, or null for an STL opened on its own. */
  readonly projectName = signal<string | null>(null);
  readonly fileNotice = signal<FileNotice | null>(null);
  /** A project file being opened, said under the file row. */
  readonly fileBusy = signal<string | null>(null);
  readonly saving = signal(false);
  /** A file held back from replacing the model while it has changes not saved, until the maker answers. */
  readonly replacing = signal<Replacing | null>(null);
  private replaceWith: (() => void) | null = null;
  /** What that file holds while it waits, its bytes or the opened project, which the memory meter counts. */
  private replaceHeld: unknown = null;
  /** MM2: a model past the warning point, waiting for the maker's answer (R42). */
  readonly large = signal<LargePrompt | null>(null);
  private largeWaiting: LargeWaiting | null = null;
  /** MM2: a simplified copy being made, which the Model section says with a Cancel button. */
  readonly simplifying = signal<Simplifying | null>(null);
  /** RM: a repair being made, which the Model section says with a Cancel button (R43). */
  readonly repairing = signal<Repairing | null>(null);
  /** RM: the grid the maker typed for a rebuild, in mm, or null for auto. A new model clears it. */
  readonly repairCell = signal<number | null>(null);
  /** RM: the facts the auto grid follows, for the model on screen, worked out once a model. */
  private cellFor: { bytes: Uint8Array; facts: CellFacts } | null = null;
  /** MM2: the warning point, which the test hooks lower so a small model reaches it. */
  largeLimits: LargeLimits = LARGE_MODEL;
  /** GA: the example gallery's models, which the test hooks add a third-party fixture to (R47). */
  readonly gallery = signal<readonly GalleryEntry[]>(GALLERY);
  /** GA: the id of the gallery model on screen, as opened from the gallery, which never asks before it is replaced (D29). */
  readonly galleryModel = signal<string | null>(null);
  /** GA: the default model's id while it is fetched on a page load, which the empty view says in place of its drop hint. */
  readonly galleryPending = signal<string | null>(null);
  /** GA: the open whose fetch the busy line says, so a fetch overtaken clears only its own line. */
  private fetchBusy = 0;
  /** GA: the Model section's Examples panel, open or not. */
  readonly examplesOpen = signal(false);
  /** GA: how a gallery model's STL is fetched, which Node tests replace. */
  galleryFetch: (entry: GalleryEntry) => Promise<Blob> = fetchGalleryModel;
  /**
   * MT: the mold types the switch shows, in order, with their words: the registry's, to which the test hooks add a
   * fixture type to see a third tile wrap (src/app/testHooks.ts). Only a type of MOLD_TYPES can be switched to.
   */
  readonly moldTypes = signal<readonly MoldType[]>(MOLD_TYPE_LIST);
  readonly moldTypeUi = signal<Readonly<Record<string, MoldTypeUi>>>(MOLD_TYPE_UI);
  /** MT: the switch window's question while it is open (D27): the settings changed that differ from the new type's defaults. */
  readonly switching = signal<SwitchPlan | null>(null);
  /**
   * MM2: the maker's file the model on screen came from, kept unread: Simplify… and Save project of a copy read
   * it in their workers. Null for a load by bytes, which then gives a Blob of the bytes when one is needed.
   */
  private source: OriginalSource | null = null;
  /**
   * The memory meter (MM1): main's arrays and the view's, counted here, with the workers' figures from the
   * pipeline's ledger. Only set again when a figure changed, so the strip's item draws only then.
   */
  readonly memory = signal<MemoryReading>({ total: 0, parts: {} });
  /** The view's arrays, which main.tsx hands over, as the store knows no scene. */
  private viewRoots: () => unknown[] = () => [];
  private meter: { page: MeterPage; timers: Timers; now: () => number; last: number; pending: unknown } | null = null;
  /** The project as the last save, load or Export ZIP holds it, to tell whether leaving the page loses anything. */
  private saved: Project | null = null;
  /** Bumped by every open and load: a file read or unpacked after a newer one was asked for is dropped. */
  private opens = 0;
  /**
   * The history's first step recorded on a project file's own plane choice: the file's resolution of
   * that choice rewrites steps from here on, and leaves older ones, which are the user's own, alone.
   */
  private fileSteps = Infinity;

  constructor(
    readonly pipeline: Pipeline,
    now?: () => number,
    /** Saving and opening project files, in a worker per job. Null where none can be spawned. */
    readonly files: ProjectFiles | null = null,
    /** MM2: the simplified copy of a large model, in a worker per job. Null where none can be spawned. */
    readonly simplifier: ModelSimplifier | null = null,
  ) {
    this.history = new History(now);
    this.project = signal(pipeline.project());
    pipeline.onPlaneResolved = (from, to) => {
      this.history.replacePlane(from, to, this.fileSteps);
      // What counts as saved is always the file's project or one saved since it was opened, as only a
      // project opened in full has its plane checked, and that sets it.
      if (this.saved && samePlane(this.saved.plane, from)) this.saved = { ...this.saved, plane: to };
    };
    pipeline.subscribe(() => {
      const next = pipeline.project(), now = this.project.value;
      if (next.params !== now.params || next.plane !== now.plane || next.pins !== now.pins || next.removed !== now.removed) this.project.value = next;
      this.tick.value++;
      this.scheduleMemory();
    });
  }

  /** The view's arrays for the memory meter, from main.tsx, which holds the scene. */
  setViewRoots(roots: () => unknown[]): void {
    this.viewRoots = roots;
  }

  /**
   * Starts the memory meter (MM1). It reads after each change the pipeline makes and each figure a worker
   * sends, at most every MEMORY_THROTTLE_MS; a figure that falls, as when a worker is ended, it shows at once,
   * so the meter never stands above what the app holds for long. Main's arrays change only with the
   * pipeline's results, and the workers' figures come with their messages, so with nothing happening it
   * reads nothing; it has no clock of its own, as one ticking while main was busy changed which came first,
   * a job's overrun check or its result, and so which jobs ran (docs/PLAN.md, MM1). While the page is hidden
   * it reads nothing at all, and it reads again as soon as the page shows. Main.tsx starts it; Node tests
   * start it with their own page and timers, or not at all.
   */
  startMemoryMeter(page: MeterPage, timers: Timers = realTimers, now: () => number = () => performance.now()): void {
    if (this.meter) return;
    const meter = (this.meter = { page, timers, now, last: -Infinity, pending: null as unknown });
    this.pipeline.memory.subscribe((source, dropped) => {
      // The page's own figure is the meter's reading itself.
      if (source === 'page') return;
      if (!dropped) this.scheduleMemory();
      else if (!page.hidden()) this.measureMemory();
    });
    page.onVisibility(() => {
      if (!page.hidden()) {
        this.measureMemory();
        return;
      }
      if (meter.pending !== null) meter.timers.clear(meter.pending);
      meter.pending = null;
    });
    if (!page.hidden()) this.measureMemory();
  }

  /**
   * One reading of the memory meter: main's arrays, the view's and a file waiting on the replace question,
   * walked now, each buffer once, with what the workers last said. A tenth of a millisecond on main with the
   * 3 million triangle test model loaded (MM1). It runs inside the handlers of the workers' messages and of
   * the pipeline's changes, so it never throws: a walk that fails leaves the page's last figure standing.
   */
  measureMemory(): void {
    const ledger = this.pipeline.memory;
    try {
      ledger.report('page', { wasm: 0, arrays: arrayBytes([...this.pipeline.heldArrays(), ...this.viewRoots(), this.replaceHeld]) });
    } catch {
      // The meter reads stale rather than stop a result, an export or a change on its way.
    }
    const meter = this.meter;
    if (meter) {
      meter.last = meter.now();
      if (meter.pending !== null) meter.timers.clear(meter.pending);
      meter.pending = null;
    }
    const total = ledger.total(), parts = ledger.parts(), shown = this.memory.value;
    if (shown.total !== total || JSON.stringify(shown.parts) !== JSON.stringify(parts)) this.memory.value = { total, parts };
  }

  /** A reading now, as a figure fell, unless the meter is off or the page hidden. */
  private memoryFell(): void {
    if (this.meter && !this.meter.page.hidden()) this.measureMemory();
  }

  /** A reading soon: now if the last was MEMORY_THROTTLE_MS ago, else once that time is up. */
  private scheduleMemory(): void {
    const meter = this.meter;
    if (!meter || meter.pending !== null || meter.page.hidden()) return;
    const wait = MEMORY_THROTTLE_MS - (meter.now() - meter.last);
    if (wait <= 0) {
      this.measureMemory();
      return;
    }
    meter.pending = meter.timers.set(() => {
      meter.pending = null;
      if (!meter.page.hidden()) this.measureMemory();
    }, wait);
  }

  load(bytes: Uint8Array, name: string, source: OriginalSource | null = null): void {
    this.beforeLoad();
    this.pipeline.load(bytes, name);
    this.source = source;
    this.saved = this.pipeline.project();
    // GA: a gallery model shows its credit if it is not ours, and is replaced with no question.
    const entry = source?.kind === 'gallery' && source.id !== undefined ? galleryEntry(source.id, this.gallery.value) : null;
    if (entry) {
      this.pipeline.setGallery(creditOf(entry));
      this.galleryModel.value = entry.id;
    }
  }

  /**
   * GA: opens a gallery model (R47): its STL fetched relative to the page, then opened as any chosen file, through
   * openFile, so the large-model check, the notices, the cleared history, Repair mesh and MM2 all hold. A file opened
   * while it is fetched wins. `initial` is the default model of a page load (D29): it opens only while nothing else
   * has been asked for, and a failed fetch leaves the empty page, saying so only in the console.
   */
  async openGallery(id: string, initial = false): Promise<void> {
    const entry = galleryEntry(id, this.gallery.value);
    if (!entry) {
      console.warn(`The gallery has no model "${id}".`);
      return;
    }
    if (initial && (this.opens !== 0 || this.pipeline.modelName !== null)) return;
    const ticket = ++this.opens;
    if (!initial) this.switching.value = null;
    const busy = initial ? null : `Fetching ${entry.title}…`;
    if (busy) {
      this.fileNotice.value = null;
      this.fileBusy.value = busy;
      this.fetchBusy = ticket;
    } else this.galleryPending.value = entry.id;
    // A newer open says its own busy line or none: this fetch's line goes only while it is still the one shown.
    const superseded = (): boolean => {
      if (ticket === this.opens && !(initial && this.pipeline.modelName !== null)) return false;
      if (busy && this.fetchBusy === ticket && this.fileBusy.value === busy) this.fileBusy.value = null;
      return true;
    };
    let blob: Blob;
    try {
      blob = await this.galleryFetch(entry);
    } catch (error) {
      if (superseded()) return;
      this.fileBusy.value = null;
      if (initial) console.warn(error instanceof Error ? error.message : String(error));
      else this.fileNotice.value = { severity: 'error', message: `The example ${entry.title} could not be fetched. Check the connection and try again.`, notes: [], details: error instanceof Error ? error.message : String(error) };
      return;
    } finally {
      if (initial) this.galleryPending.value = null;
    }
    // A model loaded by other means meanwhile, as the test hooks' load, wins over the default too.
    if (superseded()) return;
    this.fileBusy.value = null;
    await this.openFile(new File([blob as Blob], entry.file), entry);
  }

  /** What every new model resets: how the user was looking at the last one, and its history. */
  private beforeLoad(): void {
    this.opens++;
    // MT: a switch asked about is for the settings on screen, which the new model's replace.
    this.switching.value = null;
    // The pipeline's load follows at once, and the meter reads after it.
    this.dropReplacing(false);
    // A question about another file, or a copy being made of one, is for a model that is not coming.
    this.dropLarge();
    this.simplifier?.cancel();
    this.simplifying.value = null;
    this.repairing.value = null;
    this.repairCell.value = null;
    // The grid's facts were the last model's, and kept its STL alive outside the meter (RM's review).
    this.cellFor = null;
    this.source = null;
    this.galleryModel.value = null;
    this.fileSteps = Infinity;
    this.projectName.value = null;
    this.fileNotice.value = null;
    this.fileBusy.value = null;
    // An export that runs goes on, for the model it was asked for; how an earlier one ended is history.
    if (this.exportState.value.phase !== 'running') this.exportState.value = { phase: 'idle' };
    this.pickMode.value = false;
    this.hoverCandidate.value = this.hoverTriangle.value = null;
    this.shown.value = [];
    this.lastMove.value = null;
    this.drag.value = null;
    // A distance set on another model's box could be past this one's slider: start again at a quarter of it.
    this.explode.value = { ...this.explode.value, distance: null };
    // The steps of another model would build nothing that makes sense on this one.
    this.history.clear();
    this.historyTick.value++;
  }

  /**
   * A chosen or dropped file. An STL loads as it is; a .moldproj loads its model with everything it
   * holds; an export ZIP or a lone project.json brings its settings to the model on screen. A project
   * file that cannot be used says why under the file row, and the model on screen stays as it was.
   */
  async openFile(file: File, gallery: GalleryEntry | null = null): Promise<void> {
    const ticket = ++this.opens;
    // MT: a model or project opened while the switch window is open cancels it first (D27).
    this.switching.value = null;
    // GA: a gallery model's source names it, so it loads with its credit.
    const stlSource: OriginalSource = gallery ? { kind: 'gallery', blob: file, id: gallery.id } : { kind: 'stl', blob: file };
    // A newer file supersedes one still waiting for an answer, and a copy being made of another, or a repair.
    this.dropReplacing();
    this.dropLarge();
    this.cancelSimplify();
    this.cancelRepair();
    // MM2: a file that could pass the warning point is counted from its first bytes before it is read whole (R42).
    if (file.size >= minBytesToLook(this.largeLimits)) {
      const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
      if (ticket !== this.opens) return;
      if (fileKindOfHead(file.name, head, file.size) === 'stl') {
        const estimate = estimateTriangles(head, file.size);
        if (isLarge(estimate.triangles, file.size, this.largeLimits)) {
          this.askLarge({ kind: 'stl', name: file.name, model: file.name, size: file.size, ...estimate, target: defaultTarget(estimate.triangles) }, { file, source: stlSource });
          return;
        }
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ticket !== this.opens) return;
    const kind = fileKind(file.name, bytes);
    if (kind === 'stl') await this.openStl(bytes, file.name, ticket, stlSource);
    else if (kind === 'other') this.fileNotice.value = { severity: 'error', message: `${file.name} is not an STL or a project file, so it was not opened. ${OPEN_INSTEAD}`, notes: [] };
    else await this.openProject(bytes, file.name, kind, ticket, file);
  }

  /** MM2: the question before a large model loads, which the Model section shows. */
  private askLarge(prompt: LargePrompt, waiting: LargeWaiting): void {
    this.fileNotice.value = null;
    this.fileBusy.value = null;
    this.largeWaiting = waiting;
    this.large.value = prompt;
  }

  private dropLarge(): void {
    this.largeWaiting = null;
    this.large.value = null;
  }

  /** The maker's count in the question's number box, kept in range. */
  setLargeTarget(target: number): void {
    const prompt = this.large.value;
    if (prompt) this.large.value = { ...prompt, target: clampTarget(target, prompt.triangles) };
  }

  /**
   * MM2: the maker's answer to the large-model question. Load anyway goes on as any file does, from reading it;
   * Simplify makes the copy and loads it; Cancel leaves the page as it was. A newer file drops the question.
   */
  async answerLarge(answer: 'simplify' | 'load' | 'cancel', target?: number): Promise<void> {
    const prompt = this.large.value, waiting = this.largeWaiting;
    if (!prompt || !waiting) return;
    this.dropLarge();
    // The model on screen is loaded already: its question has no Load anyway.
    if (answer === 'cancel' || (answer === 'load' && prompt.kind === 'loaded')) return;
    const ticket = ++this.opens;
    if (answer === 'simplify') {
      this.cancelRepair();
      await this.simplifyFrom(prompt, waiting, clampTarget(target ?? prompt.target, prompt.triangles), ticket);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await waiting.file.arrayBuffer());
    } catch (error) {
      if (ticket === this.opens) this.fileNotice.value = { severity: 'error', message: `${prompt.name} could not be read: it may have been moved, renamed or changed since you chose it. Open it again.`, notes: [], details: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (ticket !== this.opens) return;
    if (prompt.kind === 'stl') await this.openStl(bytes, prompt.name, ticket, waiting.source);
    else await this.openProject(bytes, prompt.name, 'zip', ticket, waiting.file, false);
  }

  /** MM2: ends the copy being made, leaving the page as it was. */
  cancelSimplify(): void {
    if (!this.simplifying.value) return;
    this.simplifying.value = null;
    this.simplifier?.cancel();
  }

  /**
   * MM2: makes the copy in its worker and loads it: from the question on opening, after the replace question
   * as any file; from Simplify…, at once, with the project on screen carried. A copy the job refuses, as one that
   * would open holes, leaves the question up with the reason, offering Load anyway and Cancel.
   */
  private async simplifyFrom(prompt: LargePrompt, waiting: LargeWaiting, target: number, ticket: number): Promise<void> {
    const simplifier = this.simplifier;
    if (!simplifier) {
      this.fileNotice.value = { severity: 'error', message: `${prompt.model} cannot be simplified: this page has no way to start the geometry engine for it.`, notes: [] };
      return;
    }
    this.fileNotice.value = null;
    this.simplifying.value = { name: prompt.model, target, step: 'read', round: 0 };
    // A heavy preview's solid worker goes first, so its heap never stands beside the job's (the export's rule).
    if (prompt.kind === 'loaded') this.pipeline.recycleForPrepare();
    try {
      const prepared = await simplifier.run(waiting.source, prompt.model, { target, maxErrorMm: SIMPLIFY_MAX_ERROR_MM }, (progress) => {
        if (ticket === this.opens && this.simplifying.value) this.simplifying.value = { ...this.simplifying.value, step: progress.step, round: progress.round };
      });
      if (ticket !== this.opens) return;
      this.simplifying.value = null;
      // The project as it stands now the copy is made: the page stays editable while it is made, and an edit made
      // meanwhile is the maker's (MM2's review).
      const carried = prompt.kind === 'loaded' ? this.carried() : waiting.opened ? carriedFrom(waiting.opened) : null;
      const origin: ModelOrigin = { original: waiting.source, from: prepared.from, record: prepared.record, repair: null };
      const projectName = prompt.kind === 'moldproj' ? prompt.name : prompt.kind === 'loaded' ? this.projectName.value : null;
      // GA: a gallery model simplified on opening keeps its credit and id from the entry it was fetched for (R48).
      const entry = waiting.source.kind === 'gallery' && waiting.source.id !== undefined ? galleryEntry(waiting.source.id, this.gallery.value) : null;
      const credit = entry ? creditOf(entry) : (waiting.opened?.file.gallery ?? null);
      const run = (): void => this.loadPrepared(prepared.stl, origin, carried, projectName, prompt.kind === 'loaded', 'simplified', credit, entry?.id ?? null);
      if (prompt.kind === 'loaded') run();
      else this.replaceOrAsk(prompt.model, run, prepared.stl);
    } catch (error) {
      if (ticket !== this.opens) return;
      this.simplifying.value = null;
      const e = error instanceof Error ? error : new Error(String(error));
      if (e.name === 'Cancelled') return;
      // The job's own reason is a maker's sentence; anything else is the engine's, kept for Details.
      const inline = e.name === 'InlineError' || e.name === 'StlError';
      if (prompt.kind !== 'loaded' && inline) {
        this.askLarge({ ...prompt, refused: e.message }, waiting);
        return;
      }
      this.fileNotice.value = inline
        ? { severity: 'error', message: e.message, notes: [] }
        : { severity: 'error', message: `${prompt.model} could not be simplified, as the geometry engine failed. ${prompt.kind === 'loaded' ? 'The model on screen stays as it was.' : 'Try again, or load it anyway.'}`, notes: [], details: e.message };
    }
  }

  /**
   * MM2: the copy loads as a model of its own, named after the file, with the project carried where there is one.
   * Simplify… (`again`) keeps what counts as saved, as the project is the one on screen; a file opened afresh has
   * nothing to lose yet. RM: a repaired copy loads the same way, its plane found again as the repaired one's.
   */
  private loadPrepared(stl: Uint8Array, origin: ModelOrigin, carried: Carried | null, projectName: string | null, again: boolean, reason: 'simplified' | 'repaired', credit: GalleryCredit | null = null, galleryId: string | null = null): void {
    const keepSaved = this.saved;
    // GA: a copy of a gallery model keeps its credit, and its id, so it is replaced with no question too.
    const keepGallery = again ? { credit: this.pipeline.gallery(), id: this.galleryModel.value } : { credit, id: galleryId };
    this.beforeLoad();
    if (carried) this.pipeline.loadProject(stl, origin.from.name, carried.project, carried.stored, origin.from.sha256, carried.savedBy, origin, reason);
    else this.pipeline.load(stl, origin.from.name, origin);
    this.source = origin.original;
    this.saved = again ? keepSaved : this.pipeline.project();
    this.fileSteps = carried ? this.history.nextSeq : Infinity;
    this.projectName.value = projectName;
    this.pipeline.setGallery(keepGallery.credit);
    this.galleryModel.value = keepGallery.id;
  }

  /**
   * MM2: the project on screen, to carry onto the copy or back onto the file: the settings, the base face as the
   * plane itself, the moved openings and the removed vents. A picked face's triangle means nothing on another
   * mesh, so it becomes the ranked face its plane is found on.
   */
  private carried(): Carried {
    const project = this.pipeline.project();
    const plane = 'pick' in project.plane ? { rank: 0, upper: project.plane.upper } : project.plane;
    return { project: { ...project, plane }, stored: this.pipeline.storedPlane(), savedBy: { format: SCHEMA_VERSION, appVersion: BUILD.version } };
  }

  /** MM2: whether Simplify… is offered: a model past the warning point that is no copy already. */
  canSimplify(): boolean {
    const parsed = this.pipeline.parsed?.value;
    if (!this.simplifier || !parsed || !this.pipeline.modelParsed() || this.pipeline.modelOrigin() || this.simplifying.value || this.repairing.value || this.large.value) return false;
    return isLarge(parsed.triangles, this.pipeline.fileBytes, this.largeLimits);
  }

  /**
   * RM: why the Model section offers Repair mesh for the model on screen, or null where it does not (decision B): a
   * preparer to run it, the import in for this file and finding a soup or folds, and no copy, repair or question on
   * its way.
   */
  repairOffer(): RepairOffer | null {
    // RM's review: a file being read, a file held back or a project being saved goes first, as a repair would drop it.
    if (!this.simplifier || this.simplifying.value || this.repairing.value || this.large.value || this.fileBusy.value !== null || this.replacing.value || this.saving.value) return null;
    return this.pipeline.repairOffer();
  }

  /** RM: what the automatic grid comes to for the model on screen, and the facts it follows, worked out once a model. */
  repairCellFacts(): { auto: number; facts: CellFacts } | null {
    const parsed = this.pipeline.parsed?.value, bytes = this.pipeline.stlBytes;
    if (!parsed || !bytes) return null;
    if (this.cellFor?.bytes !== bytes) this.cellFor = { bytes, facts: cellFacts(parsed.welded) };
    return { auto: autoRepairCell(this.cellFor.facts), facts: this.cellFor.facts };
  }

  /**
   * RM: why the grid typed cannot be used on this model, or null when it can; with the box empty, why no grid suits
   * a model to be rebuilt, as its automatic one is checked too (RM's review). A fill takes no grid.
   */
  repairCellProblem(): string | null {
    const cell = this.repairCell.value, known = this.repairCellFacts();
    if (!known) return null;
    if (cell !== null) return repairCellProblem(known.facts, cell);
    const limit = this.pipeline.repairOffer()?.fill === false ? repairCellLimit(known.facts, known.auto) : null;
    return limit ? `This model cannot be rebuilt on any grid this app takes: the coarsest that suits it, ${known.auto.toFixed(2)} mm, ${limit}.` : null;
  }

  /** RM: the grid box: a number, or null (empty) for auto. */
  setRepairCell(cell: number | null): void {
    this.repairCell.value = cell === null || !Number.isFinite(cell) ? null : cell;
  }

  /**
   * RM: Repair mesh (R43): repairs the maker's file in a fresh solid.worker and loads the closed copy as the model,
   * with the project on screen carried, its plane found again, and the undo history cleared, as Simplify… does. The
   * file is read again from where it was opened, never a simplified copy, so nothing is repaired from a copy; where a
   * simplified copy was on screen, the repaired one keeps to its count (decision F). Cancel, a newer file, Use the
   * original and Simplify… end it and leave the page as it was. A repair the file cannot be given says why under the
   * file row, and the offer stays.
   */
  async repairMesh(): Promise<void> {
    const offer = this.repairOffer(), preparer = this.simplifier, imported = this.pipeline.imported?.value, bytes = this.pipeline.stlBytes, name = this.pipeline.modelName;
    if (!offer || !preparer || !imported || !bytes || name === null || this.repairCellProblem()) return;
    const ticket = ++this.opens;
    const origin = this.pipeline.modelOrigin();
    const cell = this.repairCell.value;
    this.fileNotice.value = null;
    this.repairing.value = { name, cell, auto: offer.fill ? null : (this.repairCellFacts()?.auto ?? null), step: 'read', round: 0, done: 0, total: 1 };
    // A heavy preview's solid worker goes first, so its heap never stands beside the job's (MM2's rule).
    this.pipeline.recycleForPrepare();
    // The maker's own file, as it was opened: a simplified copy's is its original.
    const source = origin?.original ?? this.source ?? { kind: 'stl' as const, blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) };
    // How the file imports as it is, which model_oriented.stl follows: a simplified copy's import stands for its file's, as MM2's export takes it.
    const facts: OriginalImport = { route: imported.route, flipped: imported.flipped, inverted: imported.diagnostics.some((d) => d.code === 'shell-inverted') };
    const simplify = origin?.record ? { target: origin.record.target, maxErrorMm: origin.record.maxErrorMm } : null;
    try {
      const prepared = await preparer.prepare(source, origin?.from.name ?? name, { simplify, repair: { cell, facts } }, (progress) => {
        const now = this.repairing.value;
        if (ticket !== this.opens || !now) return;
        if (now.step !== progress.step || now.round !== progress.round || now.done !== progress.done || now.total !== progress.total) this.repairing.value = { ...now, ...progress };
      });
      if (ticket !== this.opens || !prepared.repair) return;
      this.repairing.value = null;
      // The project as it stands now the copy is made: the page stays editable while it is made (MM2's review).
      const carried = this.carried();
      const repaired: ModelOrigin = { original: source, from: prepared.from, record: null, repair: { record: prepared.repair, outside: prepared.outside } };
      this.loadPrepared(prepared.stl, repaired, carried, this.projectName.value, true, 'repaired');
    } catch (error) {
      if (ticket !== this.opens) return;
      this.repairing.value = null;
      const e = error instanceof Error ? error : new Error(String(error));
      if (e.name === 'Cancelled') return;
      // The job's own reason is a maker's sentence; anything else is the engine's, kept for Details.
      const inline = e.name === 'InlineError' || e.name === 'StlError';
      this.fileNotice.value = inline
        ? { severity: 'warning', message: e.message, notes: [] }
        : { severity: 'error', message: `${name} could not be repaired, as the geometry engine failed. The model on screen stays as it was.`, notes: [], details: e.message };
    }
  }

  /** RM: ends the repair being made, leaving the page as it was. */
  cancelRepair(): void {
    if (!this.repairing.value) return;
    this.repairing.value = null;
    this.simplifier?.cancel();
  }

  /** RM: Save repaired STL: the repaired copy the mold is made from, as <name>-repaired.stl. */
  saveRepaired(): void {
    const origin = this.pipeline.modelOrigin(), bytes = this.pipeline.stlBytes;
    if (!origin?.repair || !bytes) return;
    saveBytes(repairedName(origin.from.name), bytes, 'application/octet-stream');
  }

  /** MM2: Simplify… in the Model section: the question in its form for the model on screen. */
  simplifyLoaded(): void {
    const parsed = this.pipeline.parsed?.value, bytes = this.pipeline.stlBytes, model = this.pipeline.modelName;
    if (!this.canSimplify() || !parsed || !bytes || model === null) return;
    const source = this.source ?? { kind: 'stl' as const, blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) };
    this.askLarge({ kind: 'loaded', name: model, model, size: bytes.length, triangles: parsed.triangles, exact: true, format: parsed.format, target: defaultTarget(parsed.triangles) }, { file: source.blob, source });
  }

  /**
   * MM2: Use the original: the maker's file again, as it is, with the project on screen carried, and no question,
   * however large it is. The undo history is cleared, as for any other model. RM: from a repaired copy too, after
   * which the file is the soup or the folded mesh it was, so Repair mesh is offered again.
   */
  async useOriginal(): Promise<void> {
    const origin = this.pipeline.modelOrigin();
    if (!origin || !this.files) return;
    const ticket = ++this.opens;
    this.cancelRepair();
    const name = origin.from.name, projectName = this.projectName.value;
    this.fileNotice.value = null;
    this.fileBusy.value = `Reading ${name}…`;
    try {
      const raw = new Uint8Array(await origin.original.blob.arrayBuffer());
      if (ticket !== this.opens) return;
      let bytes: Uint8Array, sha: string | null;
      if (origin.original.kind !== 'moldproj') {
        const checked = raw.length < READ_IN_WORKER_BYTES ? { bytes: raw, ...readStl(raw, name, true) } : await this.files.check(raw, name, true);
        bytes = checked.bytes;
        sha = checked.sha256;
      } else {
        const opened = await this.files.open(raw, projectName ?? name, 'zip', null, { original: true });
        bytes = opened.stl!;
        sha = opened.stlSha256;
      }
      if (ticket !== this.opens) return;
      // The project as it stands once the file is read, with any edit made meanwhile (MM2's review).
      const carried = this.carried(), keepSaved = this.saved, credit = this.pipeline.gallery(), id = this.galleryModel.value;
      this.beforeLoad();
      this.pipeline.loadProject(bytes, name, carried.project, carried.stored, sha, carried.savedBy, null, origin.repair ? 'repaired' : 'simplified');
      this.pipeline.setGallery(credit);
      this.galleryModel.value = id;
      this.source = origin.original;
      this.saved = keepSaved;
      this.fileSteps = this.history.nextSeq;
      this.projectName.value = projectName;
    } catch (error) {
      if (ticket !== this.opens) return;
      this.fileNotice.value =
        error instanceof ProjectError
          ? { severity: 'error', message: error.message, notes: [], details: error.details }
          : { severity: 'error', message: `${name} could not be read again: it may have been moved, renamed or changed since you opened it. Open it again.`, notes: [], details: error instanceof Error ? error.message : String(error) };
    } finally {
      if (ticket === this.opens) this.fileBusy.value = null;
    }
  }

  /** MM2: Save simplified STL: the copy the mold is made from, as <name>-simplified.stl. */
  saveSimplified(): void {
    const origin = this.pipeline.modelOrigin(), bytes = this.pipeline.stlBytes;
    if (!origin || !bytes) return;
    saveBytes(simplifiedName(origin.from.name), bytes, 'application/octet-stream');
  }

  /**
   * An STL is read first, so one that cannot be read says why under the file row and leaves the
   * model on screen as it was; one that reads with a warning, such as a header count its size does not
   * fit, loads and says so there, naming the file.
   */
  private async openStl(bytes: Uint8Array, name: string, ticket: number, source: OriginalSource | null = null): Promise<void> {
    if (!this.files) {
      this.replaceOrAsk(name, () => this.load(bytes, name, source), bytes);
      return;
    }
    this.fileNotice.value = null;
    this.fileBusy.value = `Reading ${name}…`;
    try {
      // A small file is read here at once; a large one in a worker, as reading 150 MB takes a second or two.
      const loaded = this.pipeline.modelName !== null;
      const checked = bytes.length < READ_IN_WORKER_BYTES ? { bytes, ...readStl(bytes, name, loaded) } : await this.files.check(bytes, name, loaded);
      if (ticket !== this.opens) return;
      this.replaceOrAsk(name, () => {
        this.load(checked.bytes, name, source);
        // A large file's hash is known now, so the export is not sent a copy of it to hash.
        if (checked.sha256) this.pipeline.noteModelSha256(checked.bytes, checked.sha256);
        if (checked.warnings.length > 0) this.fileNotice.value = { severity: 'warning', message: `Opened ${name}, with a warning.`, notes: checked.warnings.map((message) => ({ severity: 'warning', message })) };
      }, checked.bytes);
    } catch (error) {
      if (ticket !== this.opens) return;
      this.fileNotice.value =
        error instanceof ProjectError
          ? { severity: 'error', message: error.message, notes: [], details: error.details }
          : { severity: 'error', message: `${name} could not be opened, as reading it failed. Try again.`, notes: [], details: error instanceof Error ? error.message : String(error) };
    } finally {
      if (ticket === this.opens) this.fileBusy.value = null;
    }
  }

  /**
   * A file that replaces the model on screen, an STL or a .moldproj, goes ahead at once unless the model
   * has changes no file holds, which a new model would take with it, history and all; then the Model
   * section asks first. Settings alone never ask, as they are one step undo takes back. GA: nor does a gallery model
   * opened from the gallery, as nothing of the maker's is lost (D29), until Save project makes it the maker's own; leaving
   * the page still asks.
   */
  private replaceOrAsk(name: string, run: () => void, held: unknown): void {
    if (!this.unsaved() || this.galleryModel.value !== null) {
      run();
      return;
    }
    this.replaceWith = run;
    this.replaceHeld = held;
    this.replacing.value = { name, model: this.projectName.value ?? this.pipeline.modelName! };
    this.scheduleMemory();
  }

  /** The maker's answer: save the work first and then open, open without saving, or keep the model and drop the file. */
  async answerReplace(answer: 'save' | 'discard' | 'cancel'): Promise<void> {
    const run = this.replaceWith;
    if (!run) return;
    if (answer === 'save') {
      await this.saveProject();
      // A save that failed keeps the question, with its reason under the file row; a newer file has its own.
      if (this.replaceWith !== run || this.unsaved()) return;
    }
    // A file kept out leaves the meter at once; one that opens is the model's file once it loads.
    this.dropReplacing(answer === 'cancel');
    if (answer !== 'cancel') run();
  }

  private dropReplacing(fell = true): void {
    const held = this.replaceHeld !== null;
    this.replaceWith = null;
    this.replaceHeld = null;
    this.replacing.value = null;
    if (held && fell) this.memoryFell();
  }

  private async openProject(bytes: Uint8Array, name: string, kind: 'zip' | 'json', ticket: number, file: Blob | null = null, ask = true): Promise<void> {
    if (!this.files) {
      this.fileNotice.value = { severity: 'error', message: `${name} cannot be opened: this page has no way to read project files.`, notes: [] };
      return;
    }
    this.fileNotice.value = null;
    this.fileBusy.value = `Opening ${name}…`;
    // Settings alone are matched to the model on screen by its hash, which the job works out if main has
    // none. A ZIP that brings its own model needs none, so only one without is sent the model's bytes.
    const unknown = this.pipeline.modelName !== null && this.pipeline.modelSha256 === null;
    const loaded = unknown && (kind === 'json' || !holdsModel(bytes)) ? this.pipeline.stlBytes : null;
    // MM2: the file a .moldproj's model is kept as, for its model_oriented.stl, before its bytes go to the worker.
    const source: OriginalSource = { kind: 'moldproj', blob: file ?? new Blob([bytes.slice() as Uint8Array<ArrayBuffer>]) };
    try {
      // MM2: a .moldproj's model past the warning point is counted in the worker and asked about first (R42).
      const opened = await this.files.open(bytes, name, kind, loaded, { large: ask && file && kind === 'zip' ? this.largeLimits : null });
      if (ticket !== this.opens) return;
      if (loaded && opened.loadedSha256) this.pipeline.noteModelSha256(loaded, opened.loadedSha256);
      if (opened.large && file) {
        const { triangles, exact, format, bytes: size } = opened.large;
        this.askLarge({ kind: 'moldproj', name, model: opened.file.model, size, triangles, exact, format, target: defaultTarget(triangles) }, { file, source, opened });
        return;
      }
      if (opened.stl) this.replaceOrAsk(name, () => this.loadOpened(opened, name, source), opened);
      else this.applyOpened(opened, name);
    } catch (error) {
      if (ticket !== this.opens) return;
      this.fileNotice.value =
        error instanceof ProjectError
          ? { severity: 'error', message: error.message, notes: [], details: error.details }
          : { severity: 'error', message: `${name} could not be opened, as reading it failed. Try again.`, notes: [], details: error instanceof Error ? error.message : String(error) };
    } finally {
      if (ticket === this.opens) this.fileBusy.value = null;
    }
  }

  /**
   * A .moldproj: its model and its project in one load, which clears the history as a new file does. MM2: a
   * simplified project's copy loads as the copy of its model.stl, which `source` keeps for model_oriented.stl.
   */
  private loadOpened(opened: Opened, name: string, source: OriginalSource): void {
    const { file } = opened;
    this.beforeLoad();
    const entry = opened.simplified?.entry;
    // RM: a repaired project's copy, with the file's left-out parts cut from model.stl, loads with no job at all.
    const fixed = opened.repaired;
    const origin: ModelOrigin | null = entry && opened.stlSha256
      ? {
          original: source,
          from: { name: file.model, bytes: opened.simplified!.bytes, sha256: opened.stlSha256, ...entry.from },
          record: { triangles: entry.triangles, target: entry.target, maxErrorMm: entry.maxErrorMm, errorMm: entry.errorMm, stoppedBy: entry.stoppedBy, sha256: entry.sha256 },
          repair: null,
        }
      : fixed && opened.stlSha256
        ? (({ from, ...record }) => ({ original: source, from: { name: file.model, bytes: fixed.bytes, sha256: opened.stlSha256!, ...from }, record: null, repair: { record, outside: fixed.outside } }))(fixed.entry)
        : null;
    // MT: the file's type with no window, or the one-piece with a notice where its type is not available here. The
    // model's triangles are counted from the STL in memory, exactly, as its header or its text gives them; its bodies
    // are not known until its import, so only what is known counts (MP5 checks the rest).
    const triangles = estimateTriangles(opened.stl!, opened.stl!.length);
    const typed = this.typedProject(projectOf(file), { bodies: null, triangles: triangles.exact ? triangles.triangles : null, simplified: origin?.record != null });
    this.pipeline.loadProject(opened.stl!, file.model, typed.project, file.basePlane, opened.stlSha256, { format: opened.from, appVersion: file.appVersion }, origin);
    // GA: a project saved from a gallery model not ours shows its credit again, from the file alone.
    this.pipeline.setGallery(file.gallery ?? null);
    this.source = source;
    this.saved = this.pipeline.project();
    // The history is empty, so every step from here stands on the file's choice until the user picks.
    this.fileSteps = this.history.nextSeq;
    this.projectName.value = name;
    const notes = typed.note ? [typed.note, ...opened.notes] : opened.notes;
    if (notes.length > 0) {
      const warned = notes.some((note) => note.severity === 'warning');
      this.fileNotice.value = { severity: warned ? 'warning' : 'info', message: `Opened ${name}.`, notes };
    }
  }

  /**
   * Settings without a model, from an export ZIP or a project.json, for the model on screen, as one step
   * of the history. All of it if it was saved for this model, by its hash, or by its name where the file
   * has none; otherwise the parameters alone, as another model's base face and openings mean nothing here.
   */
  private applyOpened(opened: Opened, name: string): void {
    const { file } = opened;
    const current = this.pipeline.modelName;
    const notes = [...opened.notes];
    if (current === null) {
      this.fileNotice.value = { severity: 'warning', message: `${name} holds the settings for ${file.model}, but not the model itself. Open ${file.model} first, then open ${name} again to use them.`, notes };
      return;
    }
    // MT: a switch asked about while the file was read is for the settings it replaces, as beforeLoad cancels one.
    this.switching.value = null;
    const same = file.modelSha256 !== null ? file.modelSha256 === this.pipeline.modelSha256 : file.model === current;
    // MT: its type with no window, or the one-piece with a notice where the type is not available for this model.
    const typed = this.typedProject(same ? projectOf(file) : { ...this.pipeline.project(), params: file.params }, this.typeContext());
    const project = typed.project;
    if (typed.note) notes.unshift(typed.note);
    // Steps already in the history are the user's own: a resolution of the file's plane, even one found
    // during this very step, must not rewrite them, and the step's own "before" is one of them.
    this.fileSteps = Infinity;
    // Another model's settings keep the pins on screen, which this build numbered.
    this.change(`opening the settings of ${name}`, null, () => this.pipeline.applyProject(project, same ? file.basePlane : null, same ? { format: opened.from, appVersion: file.appVersion } : undefined));
    if (!same) {
      const why = file.model === current ? `another model of the same name, ${file.model}, whose contents differ from the one on screen` : `${file.model}, not ${current}`;
      this.fileNotice.value = { severity: 'warning', message: `${name} was saved for ${why}, so only its settings were applied: the model keeps its own base face, pinned openings and removed vents.`, notes };
      return;
    }
    this.fileSteps = this.history.nextSeq;
    // The file opens again to this project, so leaving now loses nothing.
    this.saved = this.pipeline.project();
    // MM2: the hash is the file's, whether a copy or the file itself is on screen, so the settings may have been
    // made on the other one, whose faces and bodies are numbered differently: nothing is simplified for it. RM: or
    // repaired for it.
    const onScreen = this.pipeline.modelOrigin();
    const madeOn = file.simplified?.sha256 ?? file.repaired?.sha256 ?? null;
    const shownOn = onScreen?.record?.sha256 ?? onScreen?.repair?.record.sha256 ?? null;
    if (madeOn !== shownOn) {
      const made = file.simplified ? `a copy of ${file.model} simplified to ${file.simplified.triangles.toLocaleString('en-US')} triangles` : file.repaired ? `a repaired copy of ${file.model}` : `${file.model} as it is`;
      const shown = onScreen?.record ? `a copy of it simplified to ${onScreen.record.triangles.toLocaleString('en-US')} triangles` : onScreen?.repair ? 'a repaired copy of it' : `${file.model} as it is`;
      notes.push({ severity: 'info', message: `These settings were made on ${made}; the model on screen is ${shown}, so check the base face and the openings before you export.` });
    }
    if (file.modelSha256 === null) notes.push({ severity: 'info', message: `${name} does not record its model's contents, so it was matched to ${current} by the file name alone.` });
    this.fileNotice.value = { severity: notes.some((note) => note.severity === 'warning') ? 'warning' : 'info', message: `Applied the settings of ${name} to ${current}.`, notes };
  }

  /**
   * MT: a project's settings as they open here: its own type, or the one-piece where that type is not available
   * for what is known of the model, with the notice that says so, every other value kept.
   */
  private typedProject(project: Project, ctx: TypeContext): { project: Project; note: ProjectNote | null } {
    const { params, unavailable } = typeOnOpen(project.params, ctx);
    if (!unavailable) return { project, note: null };
    const names = this.moldTypeUi.value;
    const message = unavailableNotice(names[unavailable.type]?.name ?? unavailable.type, unavailable.reason, names[DEFAULT_MOLD_TYPE].name);
    return { project: { ...project, params }, note: { severity: 'warning', message } };
  }

  /** MT: what the mold types' `unavailable` knows of the model on screen. */
  typeContext(): TypeContext {
    const origin = this.pipeline.modelOrigin();
    return {
      bodies: this.pipeline.imported?.value.bodies ?? null,
      triangles: this.pipeline.parsed?.value.triangles ?? null,
      simplified: origin?.record != null,
    };
  }

  /** MT: the type the settings on screen are for. */
  moldType(): MoldTypeId {
    return moldTypeOf(this.project.value.params).id as MoldTypeId;
  }

  /** MT: the name the marks and Resets give the type on screen, or null for the one-piece cover, whose words they keep. */
  typeShown(): string | null {
    const type = this.moldType();
    return type === DEFAULT_MOLD_TYPE ? null : this.moldTypeName(type);
  }

  /** MT: a type's name, as its tile and the window give it. */
  moldTypeName(id: string): string {
    return this.moldTypeUi.value[id]?.name ?? id;
  }

  /**
   * MT: a tile chosen (R44, D27). Nothing for the type already on, one that cannot be chosen here, or while the
   * replace prompt or a drag is on. With no setting to ask about, the switch is made at once, as one undo step;
   * otherwise the window opens with the plan, and answerSwitch makes it.
   */
  requestSwitch(to: string): void {
    if (this.replacing.value || this.drag.value || this.switching.value) return;
    if (!Object.hasOwn(MOLD_TYPES, to) || to === this.moldType()) return;
    const type = MOLD_TYPES[to as MoldTypeId];
    if (type.unavailable(this.typeContext()) !== null) return;
    const plan = planSwitch(this.pipeline.params, to as MoldTypeId);
    if (plan.rows.length === 0) this.makeSwitch(plan, []);
    else this.switching.value = plan;
  }

  /**
   * MT: the window's answer: Discard all changes sets every listed setting to the new default, Transfer selected
   * changes keeps the ticked ones and sets the rest, each one undo step; Cancel changes nothing and records nothing.
   */
  answerSwitch(answer: 'discard' | 'transfer' | 'cancel', keep: readonly ParamPath[] = []): void {
    const plan = this.switching.value;
    if (!plan) return;
    this.switching.value = null;
    if (answer === 'cancel') return;
    this.makeSwitch(plan, answer === 'transfer' ? keep : []);
  }

  private makeSwitch(plan: SwitchPlan, keep: readonly ParamPath[]): void {
    // A plan made on settings that have since changed would write the old ones back: nothing is made.
    if (plan.params !== this.pipeline.params) return;
    const next = applySwitch(plan, keep);
    this.change(`switching to ${this.moldTypeName(plan.to)}`, null, () =>
      this.pipeline.setParams((params) => {
        for (const group of Object.keys(next) as (keyof Params)[]) (params as Record<string, unknown>)[group] = next[group];
      }),
    );
  }

  /**
   * Saves the model and its project as <name>.moldproj: the STL as it was loaded and project.json, with
   * the plane itself beside the choice, so it waits for S2 of the choice on screen. Hashing and zipping
   * run in a worker; main copies the STL into it and makes the Blob of the result.
   */
  async saveProject(): Promise<void> {
    const bytes = this.pipeline.stlBytes, model = this.pipeline.modelName, name = this.projectFileName();
    if (!bytes || model === null || name === null || !this.files || this.saving.value) return;
    this.saving.value = true;
    try {
      await this.pipeline.orientedReady();
      // Another model loaded meanwhile: this save was asked for the one that has gone.
      if (this.pipeline.stlBytes !== bytes) return;
      // A project whose STL cannot be read would be refused when opened, so it is never written.
      if (!this.pipeline.modelParsed()) {
        this.fileNotice.value = { severity: 'error', message: `${model} cannot be saved as a project, as it could not be read. Open an STL that loads, then save.`, notes: [] };
        return;
      }
      const project = this.pipeline.project();
      // MM2: a copy's project keeps the maker's file as model.stl, which the worker reads, and the copy beside it.
      const origin = this.pipeline.modelOrigin();
      const file = projectFile(project, model, {
        modelSha256: this.pipeline.modelSha256,
        basePlane: this.pipeline.storedPlane(),
        ...(origin?.record ? { simplified: simplifiedEntry({ from: origin.from, record: origin.record }) } : {}),
        // RM: a repaired copy's project keeps the maker's file as model.stl and the copy beside it as repaired.stl.
        ...(origin?.repair ? { repaired: repairedEntry(origin.from, origin.repair.record) } : {}),
        gallery: this.pipeline.gallery(),
      });
      const { zip, sha256 } = await this.files.pack(file, bytes, origin?.original ?? null);
      // A type of its own, so no browser renames the file after the ZIP inside.
      saveBytes(name, zip, 'application/octet-stream');
      this.pipeline.noteModelSha256(bytes, sha256);
      if (this.pipeline.stlBytes !== bytes) return;
      this.saved = project;
      // GA: a gallery model saved is the maker's project now, which asks before it is replaced as any does (D29).
      this.galleryModel.value = null;
      this.fileNotice.value = { severity: 'info', message: `Saved ${name}.`, notes: [], saved: name };
    } catch (error) {
      // MM2: a maker's file moved or changed since it was opened says so, as trying again would not help.
      if (error instanceof ProjectError && error.message !== PACK_FAILED) this.fileNotice.value = { severity: 'error', message: error.message, notes: [], details: error.details };
      else {
        const details = error instanceof ProjectError ? [error.message, error.details].filter(Boolean).join(' ') : error instanceof Error ? error.message : String(error);
        this.fileNotice.value = { severity: 'error', message: `${name} could not be saved. Try again; Export ZIP keeps every setting too, in its project.json.`, notes: [], details };
      }
    } finally {
      this.saving.value = false;
    }
  }

  /** Whether Save project can save: a model whose STL has been read, as one that cannot be read would never open again. */
  canSave(): boolean {
    return this.files !== null && this.pipeline.modelName !== null && this.pipeline.modelParsed();
  }

  /** What Save project names the file: an opened project keeps its own name, and an STL gives <model>.moldproj. */
  projectFileName(): string | null {
    const model = this.pipeline.modelName;
    return model === null ? null : downloadName((this.projectName.value ?? model).replace(/\.moldproj$/i, ''), PROJECT_EXTENSION);
  }

  /** Whether leaving the page now would lose work: the project differs from what the last save, load or Export ZIP holds. */
  unsaved(): boolean {
    return this.pipeline.modelName !== null && this.saved !== null && !sameProject(this.saved, this.pipeline.project());
  }

  /**
   * Runs a change of the project, and records it as a step of the history if it changed anything.
   * `group` joins it to the step before, as a slider drag or wheel steps on one control.
   */
  private change(label: string, group: string | null, action: () => void): void {
    const before = this.pipeline.project();
    action();
    const after = this.pipeline.project();
    if (sameProject(before, after)) return;
    this.history.record(before, label, group, after);
    this.historyTick.value++;
  }

  setParam(path: ParamPath, value: unknown): void {
    this.change(`the change to ${paramDef(path).label}`, paramGroup(path), () => this.pipeline.setParams((params) => setParamValue(params, path, value)));
  }

  /**
   * CS: one setting back to its default, an auto one to following its rule (null), from its row's arrow or a
   * double-click. It takes the control's own group, so a reset within GROUP_MS of the same control's wheel step
   * joins that step, and one that lands where the step began takes the step away, as a slider's double-click
   * did before; otherwise it is a step of its own. A setting already at its default changes nothing, and the
   * pipeline is not woken; nor while an opening is dragged, as Reset and undo.
   */
  resetParam(path: ParamPath): void {
    if (this.drag.value || changedPaths(this.pipeline.params, [path]).length === 0) return;
    const def = paramDef(path);
    // MT: to the default of the type on screen.
    const value = defaultOf(path, this.moldType());
    this.change(`resetting ${def.label}`, paramGroup(path), () => this.pipeline.setParams((params) => setParamValue(params, path, value)));
  }

  /**
   * CS: every changed setting among `paths` back to its default in one change, so one undo step that never
   * joins another, labelled for Undo's title. Only settings: the base face, pinned openings and removed vents
   * stay (D22). Nothing changed, nothing is done, and the pipeline is not woken; nor during a drag, as undo.
   */
  resetParams(paths: readonly ParamPath[], label: string): void {
    if (this.drag.value) return;
    const changed = changedPaths(this.pipeline.params, paths);
    if (changed.length === 0) return;
    this.change(label, null, () =>
      this.pipeline.setParams((params) => {
        // MT: to the defaults of the type on screen, which stays.
        const type = this.moldType();
        for (const path of changed) setParamValue(params, path, defaultOf(path, type));
      }),
    );
  }

  /** CS: the header's Reset, every setting at once (D22). */
  resetAll(): void {
    this.resetParams(PARAM_PATHS, 'resetting every setting');
  }

  /** While a parameter's slider is held down, every change it makes is one step, however long the pointer rests. Null on release. */
  holdParam(path: ParamPath | null): void {
    this.history.hold(path === null ? null : paramGroup(path));
  }

  /** The same plane again changes nothing, so a second click on the chosen row keeps the pins and removed vents. */
  setPlane(plane: PlaneChoice, label = 'choosing another base face'): void {
    if (samePlane(plane, this.pipeline.project().plane)) return;
    this.lastMove.value = null;
    this.change(label, null, () => this.pipeline.setPlane(plane));
  }

  /** G2.6: stand on the level the report offered, by its offset, and trim the pad below; or false to go back down. */
  useUpperLevel(upper: number | false): void {
    this.setPlane({ ...this.pipeline.project().plane, upper }, upper === false ? 'going back to the lower level' : 'standing on the upper level');
  }

  /** The plane through a clicked triangle of the real mesh. */
  pickFace(triangle: number): void {
    this.pickMode.value = false;
    this.hoverTriangle.value = null;
    this.setPlane({ pick: triangle, upper: false }, 'picking a base face');
  }

  private openingName(id: string): string {
    return openingLabel(this.pipeline.placement?.value.placement.openings ?? [], id);
  }

  /** A typed position or a drop in the view: snapped to the nearest valid place if it must be, and pinned. */
  moveOpening(id: string, x: number, y: number): void {
    let result: DropResult | null = null;
    this.change(`moving ${this.openingName(id)}`, null, () => (result = this.pipeline.dropOpening(id, x, y)));
    this.lastMove.value = result ? { id, result } : null;
  }

  /** Lets a pinned opening go back to where placement puts it. */
  unpin(id: string): void {
    this.change(`unpinning ${this.openingName(id)}`, null, () => this.pipeline.setPins(this.pipeline.project().pins.filter((pin) => pin.id !== id)));
    if (this.lastMove.value?.id === id) this.lastMove.value = null;
  }

  removeVent(id: string): void {
    this.change(`removing ${this.openingName(id)}`, null, () => this.pipeline.setRemoved([...this.pipeline.project().removed, id]));
  }

  restoreVents(): void {
    this.change('restoring the removed vents', null, () => this.pipeline.setRemoved([]));
  }

  /** Back one step. Ignored while an opening is dragged: Esc ends a drag first. */
  undo(): void {
    if (this.drag.value) return;
    const project = this.history.undo(this.pipeline.project());
    if (!project) return;
    this.lastMove.value = null;
    this.historyTick.value++;
    this.pipeline.setProject(project);
  }

  redo(): void {
    if (this.drag.value) return;
    const project = this.history.redo(this.pipeline.project());
    if (!project) return;
    this.lastMove.value = null;
    this.historyTick.value++;
    this.pipeline.setProject(project);
  }

  /**
   * An opening dragged to (x, y) on the first tile, checked against the hard rules on main at once (T0),
   * while the pipeline cuts only its copies into the cover (T2b). Nothing is pinned until the drop.
   */
  dragOpening(id: string, x: number, y: number, pointer: { x: number; y: number }): void {
    const openings = this.pipeline.placement?.value.placement.openings ?? [];
    const opening = openings.find((o) => o.id === id);
    const check = dragCheck(this.pipeline, id, x, y);
    if (!opening || !check) return;
    this.drag.value = { id, kind: opening.kind, label: openingLabel(openings, id), x, y, check, pointer };
    this.pipeline.dragOpening(id, x, y);
  }

  /** The drop: one step of the history, snapped to the nearest valid place if the spot is not one. */
  dropDrag(): void {
    const drag = this.drag.value;
    if (!drag) return;
    this.drag.value = null;
    this.moveOpening(drag.id, drag.x, drag.y);
  }

  /** Esc during a drag: the opening goes back to where it was, and nothing is recorded. */
  cancelDrag(): void {
    if (!this.drag.value) return;
    this.drag.value = null;
    this.pipeline.cancelDrag();
  }

  setSection(change: Partial<SectionState>): void {
    this.section.value = { ...this.section.value, ...change };
  }

  setExplode(change: Partial<ExplodeState>): void {
    this.explode.value = { ...this.explode.value, ...change };
  }

  /**
   * Runs one of the Export box's buttons and saves what it makes, named after the model it was asked
   * for: the pipeline ends an export that waits for the preview when another file loads, so a file is
   * never named after one model and made from another. One export at a time. Cancel leaves no file,
   * and the box is ready again at once.
   */
  async exportFile(want: ExportWant): Promise<void> {
    if (this.exportState.value.phase === 'running') return;
    const save = SAVES[want];
    const name = downloadName(this.pipeline.modelName ?? 'mold', save.suffix);
    this.exportState.value = { phase: 'running', want, step: 'start', done: 0, total: 1 };
    try {
      const request = { want, fitTest: want === 'zip' && this.fitTestInZip.value };
      const bytes = this.pipeline.stlBytes;
      const outputs = await this.pipeline.exportParts((progress) => (this.exportState.value = { phase: 'running', want, ...progress }), undefined, request);
      saveBytes(name, save.file ? outputs.files[save.file] : outputs.zip, save.mime);
      // The ZIP's project.json opens again on this model, so what it holds counts as saved.
      const json = want === 'zip' ? outputs.files['project.json'] : undefined;
      if (json && this.pipeline.stlBytes === bytes) this.saved = projectOf(JSON.parse(new TextDecoder().decode(json)) as ProjectFile);
      const error = outputs.diagnostics.find((d) => d.severity === 'error')?.message ?? null;
      this.exportState.value = { phase: 'saved', want, file: name, key: outputs.key, error };
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.exportState.value = e.name === 'Cancelled' ? { phase: 'cancelled', want } : { phase: 'failed', want, message: e.message };
    }
  }

  cancelExport(): void {
    this.pipeline.cancelExport();
  }

  setTheme(theme: Theme): void {
    this.theme.value = theme;
    document.documentElement.dataset.theme = theme;
    writeTheme(theme);
  }

  setLayer(name: LayerName, style: Partial<LayerStyle>): void {
    this.layers.value = { ...this.layers.value, [name]: { ...this.layers.value[name], ...style } };
  }

  toggleShown(key: string): void {
    const list = this.shown.value;
    this.shown.value = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }
}
