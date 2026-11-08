import { signal, type Signal } from '@preact/signals';
import type { DropResult, OpeningKind } from '../core/analysis/validate';
import { PARAM_SCHEMA, type ParamDef } from '../core/params/schema';
import type { Rim } from '../core/parts/rim';
import { DEFAULT_LAYERS, type LayerName, type LayerStyle } from '../view/layers';
import type { ExportWant } from '../workers/exportJob';
import { samePlane, type PlaneChoice } from '../workers/fieldStages';
import { dragCheck, moldBox, openingLabel, type DragCheck } from './derived';
import { downloadName, saveBytes } from './download';
import { History, sameProject } from './history';
import type { Pipeline, Project } from './pipeline';
import { setParamValue, type ParamPath } from './stages';

export type Theme = 'dark' | 'light';

/** The viewer's own choice, read by the inline script in index.html before the first paint. */
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

  constructor(
    readonly pipeline: Pipeline,
    now?: () => number,
  ) {
    this.history = new History(now);
    this.project = signal(pipeline.project());
    pipeline.subscribe(() => {
      const next = pipeline.project(), now = this.project.value;
      if (next.params !== now.params || next.plane !== now.plane || next.pins !== now.pins || next.removed !== now.removed) this.project.value = next;
      this.tick.value++;
    });
  }

  load(bytes: Uint8Array, name: string): void {
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
    this.pipeline.load(bytes, name);
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
    const [group, key] = path.split('.');
    const def = (PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>)[group][key];
    this.change(`the change to ${def.label}`, paramGroup(path), () => this.pipeline.setParams((params) => setParamValue(params, path, value)));
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
      const outputs = await this.pipeline.exportParts((progress) => (this.exportState.value = { phase: 'running', want, ...progress }), undefined, request);
      saveBytes(name, save.file ? outputs.files[save.file] : outputs.zip, save.mime);
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
