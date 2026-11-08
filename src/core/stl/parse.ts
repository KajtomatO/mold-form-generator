import type { Diagnostic } from '../report/diagnostics';

export type StlErrorCode = 'not-stl' | 'non-finite' | 'truncated' | 'empty' | 'bad-facet';

/** A file the app cannot use. The message is shown inline to the user. */
export class StlError extends Error {
  constructor(
    readonly code: StlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StlError';
  }
}

export interface ParsedStl {
  format: 'binary' | 'ascii';
  /** Triangle soup, 9 floats per triangle, with collapsed triangles already removed. */
  positions: Float32Array;
  triangleCount: number;
  /** Triangles in the file, before collapsed ones were dropped. */
  rawTriangleCount: number;
  degenerateCount: number;
  diagnostics: Diagnostic[];
}

// Text read as binary floats is finite but astronomically large, so the finite check alone
// would accept a mislabelled file. No printable model comes near 10 km.
const MAX_COORDINATE = 1e7;

function checkCoordinate(value: number): void {
  if (Math.abs(value) <= MAX_COORDINATE) return;
  if (!Number.isFinite(value)) throw new StlError('non-finite', 'The file has a vertex coordinate that is not a finite number.');
  throw new StlError('not-stl', 'This does not look like an STL file: a vertex coordinate is impossibly large.');
}

function readBinary(bytes: Uint8Array, count: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(count * 9);
  let w = 0;
  for (let t = 0; t < count; t++) {
    // Each record is a 12-byte normal, 36 bytes of corners and a 2-byte attribute.
    let o = 84 + 50 * t + 12;
    for (let i = 0; i < 9; i++, o += 4) {
      const value = view.getFloat32(o, true);
      checkCoordinate(value);
      positions[w++] = value;
    }
  }
  return positions;
}

function isSpace(byte: number): boolean {
  return byte === 32 || (byte >= 9 && byte <= 13);
}

const word = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const SOLID = word('solid');
const ENDSOLID = word('endsolid');
const VERTEX = word('vertex');
const FACET = word('facet');
const NORMAL = word('normal');
const ENDLOOP = word('endloop');
const ENDFACET = word('endfacet');

/** `| 32` folds upper case, because some exporters write VERTEX. */
function isWord(bytes: Uint8Array, start: number, end: number, word: number[]): boolean {
  return end - start === word.length && word.every((c, k) => (bytes[start + k] | 32) === c);
}

/** Where the text starts, past a byte order mark and blank space, which some exporters leave. */
function textStart(bytes: Uint8Array): number {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && isSpace(bytes[i])) i++;
  return i;
}

/** Text has no control bytes but blank space, where a binary STL's count and floats hold zeros and more. */
function looksLikeText(bytes: Uint8Array): boolean {
  for (let i = 0, end = Math.min(bytes.length, 4096); i < end; i++) {
    const byte = bytes[i];
    if (byte < 32 && !isSpace(byte)) return false;
  }
  return true;
}

function startsWithSolid(bytes: Uint8Array): boolean {
  const start = textStart(bytes);
  return bytes.length >= start + SOLID.length && SOLID.every((c, i) => (bytes[start + i] | 32) === c);
}

/** What to do about a file that loads but is cut off or damaged, after its own reason. A file refused gets it from the caller. */
const EXPORT_AGAIN = 'Export the STL again from the program that made it.';

/**
 * Returns null when the file holds no vertex at all, so it was never really ASCII. A file that stops
 * inside a facet is cut off, and refused, as its last triangle may be wrong; one that stops between
 * facets with no endsolid may be cut off too, and loads what it holds with a warning in `diagnostics`.
 */
function readAscii(bytes: Uint8Array, diagnostics: Diagnostic[]): Float32Array | null {
  let positions = new Float32Array(9 * 1024);
  let w = 0;
  const end = bytes.length;

  // A solid's name runs to the end of the "solid <name>" and "endsolid <name>" lines, and it may
  // contain any word, even "vertex". A file written on one line carries on with "facet normal".
  let i = textStart(bytes);
  const skipToken = (): void => {
    while (i < end && !isSpace(bytes[i])) i++;
  };
  const skipBlanks = (): void => {
    while (i < end && isSpace(bytes[i]) && bytes[i] !== 10 && bytes[i] !== 13) i++;
  };
  const skipName = (): void => {
    while (i < end && bytes[i] !== 10 && bytes[i] !== 13) {
      const start = i;
      skipToken();
      const after = i;
      skipBlanks();
      const next = i;
      skipToken();
      if (isWord(bytes, start, after, FACET) && isWord(bytes, next, i, NORMAL)) {
        i = start;
        return;
      }
      i = next;
    }
  };
  skipToken();
  skipName();

  // Vertices since the last facet boundary. A boundary is where a wrong count first shows, and
  // grouping by threes would otherwise turn a quad into wrong triangles without a word.
  let cornerCount = 0;
  // A facet begun and not yet ended, and whether the last solid was ended: how a file cut off shows.
  let inFacet = false;
  let ended = false;
  const cutOff = (): StlError => new StlError('truncated', 'The ASCII STL ends in the middle of a triangle, so it looks cut off.');
  const checkFacet = (): void => {
    if (cornerCount !== 0 && cornerCount !== 3) throw new StlError('bad-facet', `The ASCII STL has a facet with ${cornerCount} vertices, and only triangles can be read.`);
    cornerCount = 0;
  };

  while (i < end) {
    while (i < end && isSpace(bytes[i])) i++;
    const start = i;
    while (i < end && !isSpace(bytes[i])) i++;
    if (start === i) break;
    if (isWord(bytes, start, i, SOLID) || isWord(bytes, start, i, ENDSOLID)) {
      ended = isWord(bytes, start, i, ENDSOLID);
      skipName();
      continue;
    }
    if (isWord(bytes, start, i, FACET) || isWord(bytes, start, i, ENDLOOP) || isWord(bytes, start, i, ENDFACET)) {
      checkFacet();
      if (!isWord(bytes, start, i, ENDLOOP)) inFacet = isWord(bytes, start, i, FACET);
      if (inFacet) ended = false;
      continue;
    }
    if (!isWord(bytes, start, i, VERTEX)) continue;
    ended = false;

    cornerCount++;
    if (w + 3 > positions.length) {
      const grown = new Float32Array(positions.length * 2);
      grown.set(positions);
      positions = grown;
    }
    for (let axis = 0; axis < 3; axis++) {
      while (i < end && isSpace(bytes[i])) i++;
      const from = i;
      while (i < end && !isSpace(bytes[i])) i++;
      // A number never needs 64 characters, and the spread would overflow on a huge junk token.
      // A file cut off in a vertex line runs out of numbers, or ends inside one, such as "1.5e": that is
      // the truncation, not a bad number.
      if (from >= end) throw cutOff();
      const token = String.fromCharCode(...bytes.subarray(from, Math.min(i, from + 64)));
      const value = token === '' ? NaN : Number(token);
      if (Number.isNaN(value) && i >= end) throw cutOff();
      if (Number.isNaN(value)) throw new StlError('non-finite', `The ASCII STL has a vertex value that is not a number: "${token.slice(0, 20)}".`);
      checkCoordinate(value);
      positions[w++] = value;
    }
  }
  if (w === 0) return null;
  // Its last value may be cut short too, as "1.25" read as "1.2", so a facet left open refuses the file.
  if (w % 9 !== 0 || inFacet) throw cutOff();
  if (!ended) diagnostics.push({ code: 'stl-no-end', severity: 'warning', message: `The ASCII STL has no endsolid line at its end, so it may be cut off: ${w === 9 ? '1 triangle was' : `${w / 9} triangles were`} read. If the model looks incomplete, export the STL again from the program that made it.` });
  return positions.subarray(0, w);
}

/**
 * Drops triangles with two identical corners, in place. Collinear triangles with three distinct
 * corners also have zero area but must stay, because they fill T-junctions: Benchy has 552 of
 * the first kind and 11 of the second, and dropping those 11 as well opens 29 edges.
 */
function dropCollapsed(soup: Float32Array): number {
  let kept = 0;
  const count = soup.length / 9;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
    const bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5];
    const cx = soup[i + 6], cy = soup[i + 7], cz = soup[i + 8];
    const collapsed =
      (ax === bx && ay === by && az === bz) || (ax === cx && ay === cy && az === cz) || (bx === cx && by === cy && bz === cz);
    if (collapsed) continue;
    if (kept !== t) soup.copyWithin(kept * 9, i, i + 9);
    kept++;
  }
  return kept;
}

function finish(format: ParsedStl['format'], soup: Float32Array, diagnostics: Diagnostic[]): ParsedStl {
  const rawTriangleCount = soup.length / 9;
  const triangleCount = dropCollapsed(soup);
  if (triangleCount === 0) throw new StlError('empty', 'The STL file contains no usable triangles.');
  return {
    format,
    positions: soup.subarray(0, triangleCount * 9),
    triangleCount,
    rawTriangleCount,
    degenerateCount: rawTriangleCount - triangleCount,
    diagnostics,
  };
}

/**
 * Size decides first because a binary STL may legally start with "solid", as 3dbenchy.stl does.
 * Only positions are kept: stored normals are often wrong and winding is checked later anyway.
 */
export function parseStl(bytes: Uint8Array): ParsedStl {
  if (bytes.length === 0) throw new StlError('empty', 'The file is empty.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = bytes.length >= 84 ? view.getUint32(80, true) : -1;
  if (declared >= 0 && bytes.length === 84 + 50 * declared) return finish('binary', readBinary(bytes, declared), []);

  if (startsWithSolid(bytes)) {
    const diagnostics: Diagnostic[] = [];
    const ascii = readAscii(bytes, diagnostics);
    if (ascii) return finish('ascii', ascii, diagnostics);
    // A text STL with no facet in it, as some programs write for an empty scene, is no binary file either.
    if (looksLikeText(bytes)) throw new StlError('empty', 'The STL file contains no usable triangles.');
  }

  if (bytes.length < 84) throw new StlError('not-stl', 'This does not look like an STL file: it is too small.');
  const fits = Math.floor((bytes.length - 84) / 50);
  // A header count of 0 with records after it is a writer that never filled the count in. Otherwise the
  // count is clamped to what the size holds: min(declared, fits).
  const count = declared === 0 ? fits : Math.min(declared, fits);
  if (count === 0) throw new StlError('empty', 'The STL file contains no usable triangles.');
  // Under a record's worth of bytes after the last one the header counts is padding some writers add.
  if (declared === fits) return finish('binary', readBinary(bytes, count), []);
  const message =
    declared === 0
      ? `The file header gives no triangle count, so the ${fits} triangles its size holds were read.`
      : declared > fits
        ? `The file header says ${declared} triangles but the file holds only ${fits}, so it looks cut off: the ${fits} were read. ${EXPORT_AGAIN}`
        : `The file header says ${declared} triangles but the file has room for ${fits}, so the first ${declared} were read and the rest left out, and the file may be damaged. ${EXPORT_AGAIN}`;
  return finish('binary', readBinary(bytes, count), [{ code: 'stl-count-mismatch', severity: 'warning', message }]);
}
