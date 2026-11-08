/**
 * Time budgets of the preview tiers. The plan gives targets, and docs/BENCHMARKS.md gives what each stage
 * costs in Node on the server. M0 measured Chromium at 0.96 to 1.1 times Node, so those costs stand for
 * the browser as they are. A slow machine shows itself in the rolling medians, and the budgets adapt:
 * the preview cell grows until T1 fits. The test flag freezes all of it, so tests see fixed values.
 */

/** M0, docs/BENCHMARKS.md: Chromium against Node, 0.96 to 1.1. */
export const BROWSER_TO_NODE = 1.0;

/**
 * The plan's preview tiers, in ms. They are what the user was promised, so a single model is held to
 * them as an upper limit, apart from its own budget. They are no floor: a budget comes from the tables.
 */
export const PLAN_TARGETS = { t1: 150, t2: 2000, t2b: 200 } as const;

/** T1, T2, and T2b's full cut after a drop. A drag step has no row in these tables. */
export type TableTier = 't1' | 't2' | 'cut';

/**
 * Node at plan defaults on the server, preview cell 0.5 and TIN tolerance 0.1, from docs/BENCHMARKS.md.
 * T1 is the Field column of the preview table (S3 to S6). T2 is TIN, tool solid, cover body, base body
 * and Mode A of that table, plus "Cut, preview" from Openings. The cut is "Cut, preview" alone, which
 * Openings also has for the two grids.
 */
export const NODE_PREVIEW_MS: Record<string, Partial<Record<TableTier, number>>> = {
  benchy: { t1: 31.5, t2: 286.3 + 18.9, cut: 18.9 },
  goddess: { t1: 16, t2: 60 + 24.5, cut: 24.5 },
  vis35: { t1: 24.5, t2: 79.4 + 22.8, cut: 22.8 },
  jersey: { t1: 2.9, t2: 18.6 + 11, cut: 11 },
  x8: { t1: 22.2, t2: 125 + 95.9, cut: 95.9 },
  barrel: { t1: 4.1, t2: 30.5 + 11.6, cut: 11.6 },
  wolf: { t1: 19.7, t2: 247.8 + 26.7, cut: 26.7 },
  'benchy 2 x 3': { cut: 114.6 },
  'x8 3 x 3': { cut: 965.2 },
};

/**
 * The budget a measured job is held to: twice what Node took, times the M0 ratio, plus what a job costs
 * on top of its stages (messages, copies, transfers).
 */
export const BUDGET_FACTOR = 2;
export const JOB_OVERHEAD_MS = 50;
export function budgetFromNode(nodeMs: number): number {
  return BUDGET_FACTOR * nodeMs * BROWSER_TO_NODE + JOB_OVERHEAD_MS;
}

/** The budget from the tables above, or null where they have no row for it. */
export function tableBudgetMs(model: string, tier: TableTier): number | null {
  const ms = NODE_PREVIEW_MS[model]?.[tier];
  return ms === undefined ? null : budgetFromNode(ms);
}

export interface BudgetSettings {
  /** Rule 4: a job is ended only when a newer request waits and it has run past max(this, factor x median). */
  terminateFloorMs: number;
  terminateFactor: number;
  /** T2 waits this long after the last change. */
  debounceMs: number;
  /** Rule 6: recycle the solid worker between jobs past this heap. */
  recycleBytes: number;
  /** T1's target. Past it, on a slow machine, the preview cell grows. */
  t1TargetMs: number;
}

export const DEFAULT_BUDGETS: BudgetSettings = {
  terminateFloorMs: 8000,
  terminateFactor: 4,
  debounceMs: 400,
  recycleBytes: 1.5e9,
  t1TargetMs: PLAN_TARGETS.t1,
};

const WINDOW = 9;
/** Samples at the cell in use before the median is trusted to move it. */
export const ADAPT_AFTER = 5;
/** The tuning never grows the preview cell past this factor, so the preview keeps its shape. */
export const MAX_TUNE_SCALE = 2;

class RollingMedian {
  private samples: number[] = [];

  push(value: number): void {
    this.samples.push(value);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  get count(): number {
    return this.samples.length;
  }

  median(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
}

/** The preview's two workers, and the field.worker of S8 and S9. */
export type GateName = 'field' | 'solid' | 'reports';

export class Budgets {
  settings: BudgetSettings;
  private readonly jobs: Record<GateName, RollingMedian> = { field: new RollingMedian(), solid: new RollingMedian(), reports: new RollingMedian() };
  /** T1 at the preview cell in use only: it starts again whenever that cell changes. */
  private readonly t1 = new RollingMedian();
  /** Set by the test flag: nothing below adapts any more. */
  frozen: boolean;

  constructor(frozen = false, settings: Partial<BudgetSettings> = {}) {
    this.frozen = frozen;
    this.settings = { ...DEFAULT_BUDGETS, ...settings };
  }

  freeze(settings: Partial<BudgetSettings> = {}): void {
    this.frozen = true;
    this.settings = { ...this.settings, ...settings };
  }

  recordJob(gate: GateName, ms: number): void {
    this.jobs[gate].push(ms);
  }

  /** A T1 taken at the preview cell in use. */
  recordT1(ms: number): void {
    this.t1.push(ms);
  }

  /** The preview cell changed, so what T1 took before says nothing about it any more. */
  restartT1(): void {
    this.t1.clear();
  }

  /** How long a job may run before a newer request may end it. Frozen, the floor alone. */
  terminateAfterMs(gate: GateName): number {
    const { terminateFloorMs, terminateFactor } = this.settings;
    const median = this.frozen ? null : this.jobs[gate].median();
    return Math.max(terminateFloorMs, median === null ? 0 : terminateFactor * median);
  }

  /**
   * The tuning factor on the preview cell that brings T1 back within its target, from what T1 has
   * taken at the cell in use. Node count goes with the square of the cell, and so does most of T1. A
   * step starts the window again, so the next one is judged only on samples at the cell it set, and
   * asking again before those exist changes nothing.
   */
  previewCellScale(current: number): number {
    if (this.frozen || this.t1.count < ADAPT_AFTER) return current;
    const median = this.t1.median()!;
    const target = this.settings.t1TargetMs;
    let next = current;
    if (median > 2 * target) next = Math.min(MAX_TUNE_SCALE, current * Math.min(1.5, Math.sqrt(median / target)));
    else if (median < target / 3 && current > 1) next = Math.max(1, current / 1.25);
    if (next !== current) this.t1.clear();
    return next;
  }

  /** The machine's speed as it changes the cell, for a test to read. */
  snapshot(): { frozen: boolean; settings: BudgetSettings; medians: Record<GateName | 't1', number | null> } {
    return { frozen: this.frozen, settings: { ...this.settings }, medians: { field: this.jobs.field.median(), solid: this.jobs.solid.median(), reports: this.jobs.reports.median(), t1: this.t1.median() } };
  }
}
