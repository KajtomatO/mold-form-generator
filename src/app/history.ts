import { samePlane, type PlaneChoice } from '../workers/fieldStages';
import type { Project } from './project';

/** Slider and wheel changes to one control this close together are one step, as the plan's State section has it. */
export const GROUP_MS = 400;

/** Steps kept. A Project is a few kB, so this bounds a long session to well under a megabyte. */
export const HISTORY_LIMIT = 200;

interface Step {
  /** The project as it was before the step, for undo, or after it, for redo. */
  project: Project;
  /** What the step did, worded to follow "Undo" or "Redo": "the change to Silicone thickness". */
  label: string;
  /** Changes with the same group, each within GROUP_MS of the last, join one step. Null never joins. */
  group: string | null;
  /** When the step last grew, in ms. */
  at: number;
  /** The order steps were recorded in, which a project's plane resolution uses to leave older steps alone. */
  seq: number;
}

/**
 * Undo and redo over snapshots of the project: parameters, which hold the pocket's edited flag, the
 * base plane, pins and removed vents. Nothing else the user sees, such as the camera, the theme, the
 * section or the explode slider, is in a snapshot, so undo never touches those.
 */
export class History {
  private past: Step[] = [];
  private future: Step[] = [];
  /** Set by undo, redo and a step dropped, so the next change starts a step of its own even within GROUP_MS of the last. */
  private sealed = false;
  /**
   * A slider the pointer holds down: its changes join one step whatever the time between them. A press
   * starts a step of its own, so two drags of one slider are two steps however close together.
   */
  private held: { group: string; started: boolean } | null = null;
  private seq = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Called once a change has happened, with the project before and after it. A change in the same group
   * as the last step, while its slider is held or within GROUP_MS of that step's latest change, is part
   * of it: its before stays the one from the step's start, so a slider drag undoes in one go. A step
   * that ends back where it began is no step, so it goes.
   */
  record(before: Project, label: string, group: string | null, after: Project): void {
    const now = this.now();
    const last = this.past.at(-1);
    this.future = [];
    const held = this.held?.group === group ? this.held : null;
    const joins = held ? held.started : now - (last?.at ?? -Infinity) < GROUP_MS;
    if (held) held.started = true;
    if (!this.sealed && group !== null && last && last.group === group && joins) {
      last.at = now;
      if (sameProject(last.project, after)) {
        this.past.pop();
        // The step under it is an older change, which the same drag going on must not join.
        this.sealed = true;
      }
      return;
    }
    this.sealed = false;
    this.past.push({ project: before, label, group, at: now, seq: this.seq++ });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
  }

  /** A slider of this group pressed, or null once it is let go. */
  hold(group: string | null): void {
    this.held = group === null ? null : { group, started: false };
  }

  /** The project to go back to, given the one on screen, which redo will bring back. Null with nothing to undo. */
  undo(current: Project): Project | null {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push({ project: current, label: step.label, group: null, at: 0, seq: step.seq });
    this.sealed = true;
    return step.project;
  }

  redo(current: Project): Project | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push({ project: current, label: step.label, group: null, at: 0, seq: step.seq });
    this.sealed = true;
    return step.project;
  }

  /** The number the next step recorded gets: steps from it on are newer than now. */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * A project's saved plane found under another choice than its file's: a step recorded since the file
   * was opened (`since`, from nextSeq) that stands on the file's choice means that face, so it takes the
   * new choice too, and undo never brings back the old one. Older steps are the user's own, in this
   * version's numbering, and stay.
   */
  replacePlane(from: PlaneChoice, to: PlaneChoice, since: number): void {
    for (const step of [...this.past, ...this.future]) {
      if (step.seq >= since && samePlane(step.project.plane, from)) step.project = { ...step.project, plane: to };
    }
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.sealed = false;
    this.held = null;
  }

  /** What undo would take back, or null. */
  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  get depth(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }
}

/** Two projects that would build the same mold: a change that ends where it started is no step. */
export function sameProject(a: Project, b: Project): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
