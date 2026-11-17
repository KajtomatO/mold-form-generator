/**
 * MM2: how many triangles an STL holds, from its first bytes and its size alone, so the app can ask before it
 * reads a large file whole. It follows parseStl's order: a binary file of the size its count gives is exact; a
 * text file is counted by its facets in the head and scaled by its size; any other file is read as binary with
 * its count clamped to what the size holds, as parseStl reads it. Pure, for main and the tests.
 */
export interface TriangleEstimate {
  format: 'binary' | 'ascii';
  /** The triangles parseStl reads, as far as the head tells: exact for binary, and for text the head holds whole. */
  triangles: number;
  exact: boolean;
}

/** A text STL with no facet in its head: about this many bytes per facet, as the examples run 252 to 309. */
export const ASCII_BYTES_PER_FACET = 250;

const isSpace = (byte: number): boolean => byte === 32 || (byte >= 9 && byte <= 13);

/** Past a byte order mark and blank space, as parseStl reads it. */
function textStart(head: Uint8Array): number {
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && isSpace(head[i])) i++;
  return i;
}

const lower = (byte: number): number => byte | 32;

function startsWith(head: Uint8Array, at: number, word: string): boolean {
  if (head.length < at + word.length) return false;
  for (let k = 0; k < word.length; k++) if (lower(head[at + k]) !== word.charCodeAt(k)) return false;
  return true;
}

/** Text has no control bytes but blank space, as parseStl's looksLikeText checks in its first 4 kB. */
function looksLikeText(head: Uint8Array): boolean {
  for (let i = 0, end = Math.min(head.length, 4096); i < end; i++) if (head[i] < 32 && !isSpace(head[i])) return false;
  return true;
}

/**
 * `head` is the file's first bytes, the whole file when it is short, and `size` its length. For a text file
 * read whole the count is exact; otherwise it is the facets in the head times the file's size over the bytes
 * up to the end of the last whole facet, or size / 250 where the head holds none.
 */
export function estimateTriangles(head: Uint8Array, size: number): TriangleEstimate {
  const declared = head.length >= 84 && size >= 84 ? new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(80, true) : -1;
  if (declared >= 0 && size === 84 + 50 * declared) return { format: 'binary', triangles: declared, exact: true };
  const start = textStart(head);
  if (startsWith(head, start, 'solid') && looksLikeText(head)) {
    let facets = 0, end = 0;
    for (let i = start; i + 8 <= head.length; i++) {
      if (lower(head[i]) === 101 && startsWith(head, i, 'endfacet')) {
        facets++;
        end = i + 8;
        i += 7;
      }
    }
    const whole = head.length >= size;
    if (whole) return { format: 'ascii', triangles: facets, exact: true };
    return { format: 'ascii', triangles: facets > 0 ? Math.round((facets * size) / end) : Math.round(size / ASCII_BYTES_PER_FACET), exact: false };
  }
  if (size < 84) return { format: 'binary', triangles: 0, exact: true };
  const fits = Math.floor((size - 84) / 50);
  return { format: 'binary', triangles: declared === 0 ? fits : Math.min(Math.max(declared, 0), fits), exact: true };
}
