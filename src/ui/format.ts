/** How numbers read in the sidebar and status strip. Shared with the browser tests, which compare against Node. */

import type { ModelOrigin } from '../app/simplified';
import { MEMORY_SOURCES, MEMORY_WARN_BYTES, type MemorySource, type WorkerMemory } from '../app/memory';

/** Up to `digits` decimals, without trailing zeros: 3, 0.2, 0.125. */
export function formatNumber(value: number, digits = 3): string {
  return String(Number(value.toFixed(digits)));
}

/** Units as they read on screen: core's messages and the schema write mm2, mm3 and cm3 in plain text. */
export function units(text: string): string {
  return text.replace(/\bmm2\b/g, 'mm²').replace(/\bmm3\b/g, 'mm³').replace(/\bcm3\b/g, 'cm³');
}

/** Fixed decimals, with no "-0.00" for a value that rounds to zero, such as a float's residue off an axis. */
export function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

export function formatMm(value: number, digits = 1): string {
  return `${value.toFixed(digits)} mm`;
}

/** Three sizes as the status strip shows them: 60.0 × 31.0 × 48.0 mm. */
export function formatSize(size: readonly number[]): string {
  return `${size.map((v) => v.toFixed(1)).join(' × ')} mm`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** A plane's outward normal as an axis, such as −Z, or as its tilt from the nearest one. */
export function formatNormal(normal: readonly number[]): string {
  const axis = normal.reduce((best, value, k) => (Math.abs(value) > Math.abs(normal[best]) ? k : best), 0);
  const name = `${normal[axis] < 0 ? '−' : '+'}${'XYZ'[axis]}`;
  const tilt = (Math.acos(Math.min(1, Math.abs(normal[axis]))) * 180) / Math.PI;
  return tilt < 0.05 ? name : `${name} ${tilt.toFixed(1)}°`;
}

/** Names as a sentence lists them: "A", "A and B", "A, B and C", or the first `shown` and how many more. */
export function namedList(names: readonly string[], shown = 4): string {
  if (names.length <= shown) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/**
 * Memory in decimal units, as the docs give it: the status strip's figure to 10 MB below 1 GB and to 0.1 GB
 * from there, so it rarely changes as the meter reads again; `precise`, the tooltip's, to 1 MB and 0.01 GB.
 */
export function formatMemory(bytes: number, precise = false): string {
  if (precise) return bytes < 999.5e6 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(2)} GB`;
  return bytes < 995e6 ? `${Math.round(bytes / 1e7) * 10} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Each part of the memory meter, as its tooltip names it. */
export const MEMORY_LABELS: Record<MemorySource, string> = {
  page: 'This page (model, parts, view)',
  field: 'Preview worker',
  solid: 'Geometry engine',
  reports: 'Reports worker',
  export: 'Export',
  simplify: 'Simplify',
  repair: 'Repair',
};

/**
 * What the memory meter does not count, true in Firefox and in Chromium alike, with MM1's figures from the
 * server's tests (docs/PLAN.md, Measured at MM1): the rest of the browser, which a system monitor adds in,
 * other tabs and extensions too, 0.5 to 0.6 GB of PSS with the app open alone and no model; plain JavaScript
 * objects, such as the reports; the parts' copies on the graphics card; and a step's working memory, which
 * the meter sees only as far as it is left when the step ends, as a worker says what it holds only between
 * steps. With the 3 million triangle test model the browser held up to 2.0 GB more than the meter showed in
 * Chromium and 2.6 GB more in Firefox, most of it while the model opened, and in Firefox in its main
 * process, which holds the opened file and which no page can see into. MM2's review: while a simplified
 * copy is made, the meter's Simplify part follows the lock loop's arrays each half round, but not
 * meshoptimizer's own working memory, which no page can read. RM: while a mesh is repaired, its Repair part
 * follows every large array of each step as it grows, and counts meshoptimizer's working memory as estimated
 * from the triangles it is given (120 bytes each, as measured at RM).
 */
export const MEMORY_NOT_COUNTED =
  "Not counted: the rest of the browser, with your other tabs and its extensions (on the test computer, 0.5 to 0.6 GB with only this page open and no model); the app's plain JavaScript data; copies of the parts on the graphics card; the memory a step uses while it runs, of which the meter sees only what is left when the step ends (opening a large model uses the most); and, while a simplified copy is made, the simplifier's own working memory. While a mesh is repaired, the Repair part counts that working memory too, as an estimate. So a system monitor shows more: on the test computer, up to 2.6 GB more with a 3 million triangle model. No web page can see how much memory the computer has free.";

/** Past MEMORY_WARN_BYTES, what to do. */
export const MEMORY_ADVICE = 'That is a lot for one web page: close other browser tabs to free memory, or open a model with fewer triangles.';
/** MM2: the same, where the Model section offers Simplify… for the model on screen. */
export const MEMORY_ADVICE_SIMPLIFY = 'That is a lot for one web page: close other browser tabs to free memory, or use Simplify… in the Model section to make the model lighter.';

type Reading = { total: number; parts: Partial<Record<MemorySource, WorkerMemory>> };

/** Whether a worker has said what it holds yet: until then main's share alone would read low. */
const heard = (reading: Reading): boolean => MEMORY_SOURCES.some((source) => source !== 'page' && reading.parts[source] !== undefined);

/** The strip's text: the total to 10 MB or 0.1 GB, or an ellipsis until the first worker has said what it holds. */
export function memoryText(reading: Reading): string {
  return `App memory ${heard(reading) ? formatMemory(reading.total) : '…'}`;
}

/**
 * The memory meter's tooltip: the total, what to do past the warning figure (MM2: Simplify… where the Model
 * section offers it, `simplify`), each part that holds half a megabyte or more (less would read 0 MB, which says nothing), the export's whether it runs or not, and
 * what is not counted.
 */
export function memoryTitle(reading: Reading, warnAt = MEMORY_WARN_BYTES, simplify = false): string {
  const lines = [`Memory this app holds: ${heard(reading) ? formatMemory(reading.total, true) : '…'}`];
  if (reading.total >= warnAt) lines.push(simplify ? MEMORY_ADVICE_SIMPLIFY : MEMORY_ADVICE);
  for (const source of MEMORY_SOURCES) {
    const part = reading.parts[source];
    const shown = part ? formatMemory(part.wasm + part.arrays, true) : null;
    if (source === 'export') lines.push(`  ${MEMORY_LABELS.export}: ${shown ?? 'not running'}`);
    else if (shown !== null && shown !== '0 MB') lines.push(`  ${MEMORY_LABELS[source]}: ${shown}`);
  }
  lines.push(MEMORY_NOT_COUNTED);
  return lines.join('\n');
}

/** The file row's and the status strip's word on a copy: simplified (MM2), repaired (RM), or both. */
export function originLabel(origin: ModelOrigin | null): string {
  if (!origin) return '';
  if (origin.repair) return origin.repair.record.simplified ? ' (repaired, simplified)' : ' (repaired)';
  return ' (simplified)';
}
