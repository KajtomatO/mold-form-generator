import { signal, type Signal } from '@preact/signals';
import type { DropResult } from '../core/analysis/validate';
import { DEFAULT_LAYERS, type LayerName, type LayerStyle } from '../view/layers';
import type { ExportWant } from '../workers/exportJob';
import { samePlane, type PlaneChoice } from '../workers/fieldStages';
import { downloadName, saveBytes } from './download';
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

  constructor(readonly pipeline: Pipeline) {
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
    this.pipeline.load(bytes, name);
  }

  setParam(path: ParamPath, value: unknown): void {
    this.pipeline.setParams((params) => setParamValue(params, path, value));
  }

  /** The same plane again changes nothing, so a second click on the chosen row keeps the pins and removed vents. */
  setPlane(plane: PlaneChoice): void {
    if (samePlane(plane, this.pipeline.project().plane)) return;
    this.lastMove.value = null;
    this.pipeline.setPlane(plane);
  }

  /** G2.6: stand on the level the report offered, by its offset, and trim the pad below; or false to go back down. */
  useUpperLevel(upper: number | false): void {
    this.setPlane({ ...this.pipeline.project().plane, upper });
  }

  /** The plane through a clicked triangle of the real mesh. */
  pickFace(triangle: number): void {
    this.pickMode.value = false;
    this.hoverTriangle.value = null;
    this.setPlane({ pick: triangle, upper: false });
  }

  /** A typed position, taken as a drop: snapped to the nearest valid place if it must be, and pinned. */
  moveOpening(id: string, x: number, y: number): void {
    const result = this.pipeline.dropOpening(id, x, y);
    this.lastMove.value = result ? { id, result } : null;
  }

  /** Lets a pinned opening go back to where placement puts it. */
  unpin(id: string): void {
    this.pipeline.setPins(this.pipeline.project().pins.filter((pin) => pin.id !== id));
    if (this.lastMove.value?.id === id) this.lastMove.value = null;
  }

  removeVent(id: string): void {
    this.pipeline.setRemoved([...this.pipeline.project().removed, id]);
  }

  restoreVents(): void {
    this.pipeline.setRemoved([]);
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
