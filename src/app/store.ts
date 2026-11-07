import { signal, type Signal } from '@preact/signals';
import type { DropResult } from '../core/analysis/validate';
import { DEFAULT_LAYERS, type LayerName, type LayerStyle } from '../view/layers';
import { samePlane, type PlaneChoice } from '../workers/fieldStages';
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

  constructor(readonly pipeline: Pipeline) {
    this.project = signal(pipeline.project());
    pipeline.subscribe(() => {
      const next = pipeline.project(), now = this.project.value;
      if (next.params !== now.params || next.plane !== now.plane || next.pins !== now.pins || next.removed !== now.removed) this.project.value = next;
      this.tick.value++;
    });
  }

  load(bytes: Uint8Array, name: string): void {
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
