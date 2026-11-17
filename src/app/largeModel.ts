import type { TriangleEstimate } from '../core/stl/estimate';

/**
 * MM2: the large-model question and the simplified copy (R42, D24). Past the warning point the app asks before
 * it reads a file whole, and offers a copy with fewer triangles, made in a solid worker of its own.
 */

/** The warning point: a model of this many triangles or more, or a file of this many bytes or more. */
export interface LargeLimits {
  triangles: number;
  bytes: number;
}

/**
 * Set from the memory curve measured at MM2 on 92724e8 (docs/PLAN.md, MM2): Firefox's whole-browser peak first
 * passes 1.5 GB between 0.40 and 0.45 million triangles, which rounds to 0.5 million, a 25 MB binary STL. A text
 * STL of that many triangles is 126 to 155 MB at the examples' 252 to 309 bytes a facet, and main and the field
 * worker each hold a text file's bytes, so a text file of 125 MB asks whatever it counts.
 */
export const LARGE_MODEL: LargeLimits = { triangles: 500_000, bytes: 125_000_000 };

/** How much of a file main reads to count its triangles before reading it whole. */
export const HEAD_BYTES = 65_536;

/** The copy's triangles unless the maker asks for another count: at or under it nothing in the app takes a shortcut. */
export const SIMPLIFY_TARGET = 300_000;
/** The counts the question takes (the user's answer of 2026-11-16, question 2). */
export const TARGET_RANGE = { min: 10_000, max: 1_000_000, step: 10_000 } as const;
/**
 * How far the copy's surface may lie from the file's, in mm, measured: fixed (the user's answer, question 2), as
 * finer than the 0.125 mm grid the mold is built on and the export's 0.05 mm surface tolerance.
 */
export const SIMPLIFY_MAX_ERROR_MM = 0.05;

/** A file below this many bytes cannot reach the warning point in any format, so it is never looked at first. */
export function minBytesToLook(limits: LargeLimits): number {
  return Math.min(84 + 50 * limits.triangles, limits.bytes);
}

/** Whether a model past the warning point: by its triangles, as counted or estimated, or by its file's size. */
export function isLarge(triangles: number, size: number, limits: LargeLimits): boolean {
  return triangles >= limits.triangles || size >= limits.bytes;
}

/** The count the question starts at for a model of `triangles`: the default, or one under the model's own. */
export function defaultTarget(triangles: number): number {
  return clampTarget(SIMPLIFY_TARGET, triangles);
}

/**
 * A count the maker typed, brought into the question's range and under the model's own count. Every model past
 * the warning point has room for the whole range; one under 10,000 triangles, as tests reach with the point
 * lowered, takes counts under its own.
 */
export function clampTarget(target: number, triangles: number): number {
  const top = Math.max(1, Math.min(TARGET_RANGE.max, triangles - 1));
  const low = top < TARGET_RANGE.min ? 1 : TARGET_RANGE.min;
  const whole = Number.isFinite(target) ? Math.round(target) : SIMPLIFY_TARGET;
  return Math.min(top, Math.max(low, whole));
}

/** What Save simplified STL names the copy: statue.stl gives statue-simplified.stl. */
export function simplifiedName(name: string): string {
  return `${name.replace(/\.stl$/i, '')}-simplified.stl`;
}

/**
 * The whole browser's highest memory in Firefox at MM2, in GB, as the prompt quotes it: each entry the highest
 * peak measured at or below its count (memory is not monotone in triangles, so a smaller model can take more),
 * up to 2 million triangles, whose merged mode unions its whole solid. Past it, the 3 million triangle test
 * model's own peak loaded as it is, with the race MM2 fixed: quoting 2 million's would overstate it (MM2's
 * review).
 */
export const MEMORY_ANCHORS: readonly { upTo: number; gb: number }[] = [
  { upTo: 300_000, gb: 1.3 },
  { upTo: 400_000, gb: 1.5 },
  { upTo: 450_000, gb: 1.6 },
  { upTo: 500_000, gb: 1.7 },
  { upTo: 600_000, gb: 1.9 },
  { upTo: 750_000, gb: 2.1 },
  { upTo: 1_500_000, gb: 2.6 },
  { upTo: 2_000_000, gb: 3.4 },
  { upTo: 3_011_040, gb: 2.9 },
];

/** "about 2.6 GB" for a model of this many triangles; "more than about 2.9 GB" past the largest measured. */
export function memoryQuote(triangles: number): string {
  const anchor = MEMORY_ANCHORS.find((a) => triangles <= a.upTo);
  return anchor ? `about ${anchor.gb.toFixed(1)} GB` : `more than about ${MEMORY_ANCHORS[MEMORY_ANCHORS.length - 1].gb.toFixed(1)} GB`;
}

/**
 * MM2's review: what simplifying saved in our tests, measured on the whole flow and not taken from the curve at the
 * count asked for, as a copy can keep more triangles than asked and the export reads the file again: the 3 million
 * triangle test model simplified on opening, in Firefox on the test server (docs/PLAN.md, Measured at MM2): 2,504 MiB
 * at most, in its export, against 2,769 loaded as it is; its copy step took 95.7 s.
 */
export const SIMPLIFIED_FLOW = { triangles: 3_011_040, copy: 752_814, gb: 2.6, loadedGb: 2.9, copySeconds: 96 } as const;

/** The prompt's sentence on what simplifying saved, from SIMPLIFIED_FLOW. */
export function simplifyQuote(): string {
  const f = SIMPLIFIED_FLOW;
  return `In our tests a model of ${(f.triangles / 1e6).toFixed(0)} million triangles took at most ${f.gb.toFixed(1)} GB simplified, from opening to export, against ${f.loadedGb.toFixed(1)} GB loaded as it is; its copy kept ${f.copy.toLocaleString('en-US')} triangles and took ${f.copySeconds} s to make.`;
}

/** What the question says of the file: its count, exact or estimated to 3 figures, and its size. */
export function largeFigures(estimate: Pick<TriangleEstimate, 'triangles' | 'exact' | 'format'>, size: number): string {
  const step = estimate.exact ? 1 : 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, estimate.triangles))) - 2);
  const count = (Math.round(estimate.triangles / step) * step).toLocaleString('en-US');
  const mb = (size / 1e6).toFixed(1);
  return estimate.exact ? `${count} triangles (${mb} MB)` : `about ${count} triangles (${mb} MB of ${estimate.format === 'ascii' ? 'text' : 'data'})`;
}
