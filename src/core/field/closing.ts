import type { Field } from './grid';

/**
 * Half-width m in nodes of the square element for `closeWidth`. The element spans 2m cells, the
 * smallest such span not under closeWidth. A valley narrower than closeWidth holds at most 2m nodes,
 * so the element's 2m + 1 nodes cannot fit inside it, which is what gets it filled.
 */
export function closingHalfWidth(closeWidth: number, cell: number): number {
  // The slack stops a width that is already a whole number of cells gaining a node through float noise.
  return Math.max(0, Math.ceil(closeWidth / (2 * cell) - 1e-9));
}

interface LineBuffers {
  /** Holds a line with m nodes of -Infinity on each side, so a window past the end needs no case. */
  line: Float32Array;
  prefix: Float32Array;
  suffix: Float32Array;
}

/** Running max by van Herk: cost per node stays the same however wide the element is. */
function runningMax(buffers: LineBuffers, n: number, m: number): void {
  const { line, prefix, suffix } = buffers;
  const width = 2 * m + 1;
  const total = n + 2 * m;
  for (let i = 0; i < total; i++) {
    prefix[i] = i % width === 0 || line[i] > prefix[i - 1] ? line[i] : prefix[i - 1];
  }
  for (let i = total - 1; i >= 0; i--) {
    suffix[i] = i === total - 1 || (i + 1) % width === 0 || line[i] > suffix[i + 1] ? line[i] : suffix[i + 1];
  }
  for (let i = 0; i < n; i++) line[i] = suffix[i] > prefix[i + 2 * m] ? suffix[i] : prefix[i + 2 * m];
}

/** One flat square pass: the running max along rows, then along columns. Sign -1 makes it a min. */
function sweep(field: Field, m: number, sign: 1 | -1, buffers: LineBuffers): void {
  const { nx, ny, values } = field;
  const { line } = buffers;
  const load = (start: number, stride: number, n: number): void => {
    line.fill(-Infinity, 0, n + 2 * m);
    for (let i = 0, at = start; i < n; i++, at += stride) line[i + m] = sign * values[at];
    runningMax(buffers, n, m);
    // The added 0 turns a negated empty node from -0 back into 0.
    for (let i = 0, at = start; i < n; i++, at += stride) values[at] = sign * line[i] + 0;
  };
  for (let y = 0; y < ny; y++) load(y * nx, 1, nx);
  for (let x = 0; x < nx; x++) load(x, nx, ny);
}

/**
 * G5: grayscale closing by a flat square of side closeWidth, in place. Plastic at any level is then
 * a union of such squares, so no fin narrower than the element is left. It can only raise H, and it
 * needs just three line buffers however large the field is.
 */
export function applyClosing(field: Field, closeWidth: number): void {
  const m = closingHalfWidth(closeWidth, field.cell);
  if (m <= 0) return;
  const longest = Math.max(field.nx, field.ny) + 2 * m;
  const buffers: LineBuffers = { line: new Float32Array(longest), prefix: new Float32Array(longest), suffix: new Float32Array(longest) };
  sweep(field, m, 1, buffers);
  sweep(field, m, -1, buffers);
}
