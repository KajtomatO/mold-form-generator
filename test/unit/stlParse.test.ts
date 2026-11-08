import { describe, expect, it } from 'vitest';
import { parseStl, StlError, type StlErrorCode } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { asciiStl, box, toSoup } from '../fixtures/synthetic';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function expectStlError(bytes: Uint8Array, code: StlErrorCode): void {
  let caught: unknown;
  try {
    parseStl(bytes);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StlError);
  expect((caught as StlError).code).toBe(code);
}

describe('STL format detection', () => {
  it('reads a binary file whose header starts with solid as binary, because the size fits', () => {
    const bytes = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    bytes.set(encode('solid looks like ascii'), 0);
    const parsed = parseStl(bytes);
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(12);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('reads ASCII, with exponents, upper case and CRLF line ends', () => {
    const text = 'solid part\r\nfacet normal 0 0 1\r\nouter loop\r\nVERTEX 1e0 2.5E+1 -3.25\r\nvertex 4 5 6\r\nvertex 7 8 9e-1\r\nendloop\r\nendfacet\r\nendsolid part\r\n';
    const parsed = parseStl(encode(text));
    expect(parsed.format).toBe('ascii');
    expect(Array.from(parsed.positions)).toEqual(Array.from(Float32Array.from([1, 25, -3.25, 4, 5, 6, 7, 8, 0.9])));
  });

  it('accepts an upper case solid keyword', () => {
    const parsed = parseStl(encode('SOLID part\nFACET NORMAL 0 0 1\nOUTER LOOP\nVERTEX 0 0 0\nVERTEX 1 0 0\nVERTEX 0 1 0\nENDLOOP\nENDFACET\nENDSOLID part\n'));
    expect(parsed.format).toBe('ascii');
    expect(parsed.triangleCount).toBe(1);
  });

  it('ignores the word vertex in the solid name', () => {
    const parsed = parseStl(asciiStl(TRIANGLE, 'vertex 9 9 9 is in my name'));
    expect(parsed.triangleCount).toBe(1);
    expect(Array.from(parsed.positions)).toEqual(TRIANGLE);
  });

  const FACET_TEXT = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';

  it.each([
    ['leading spaces', '   '],
    ['a leading newline', '\r\n\n'],
    ['a byte order mark', '\ufeff'],
    ['a byte order mark and a blank line', '\ufeff\n'],
  ])('reads ASCII with %s before the solid keyword', (_, prefix) => {
    const parsed = parseStl(encode(`${prefix}solid part\n${FACET_TEXT}endsolid part\n`));
    expect(parsed.format).toBe('ascii');
    expect(Array.from(parsed.positions)).toEqual(TRIANGLE);
  });

  it('reads an ASCII file written on one line', () => {
    const line = `solid part ${FACET_TEXT.replaceAll('\n', ' ')}${FACET_TEXT.replaceAll('\n', ' ')}endsolid part`;
    const parsed = parseStl(encode(line));
    expect(parsed.format).toBe('ascii');
    expect(parsed.triangleCount).toBe(2);
    expect(Array.from(parsed.positions.subarray(0, 9))).toEqual(TRIANGLE);
  });

  it('reads several solids on one line', () => {
    const flat = FACET_TEXT.replaceAll('\n', ' ');
    expect(parseStl(encode(`solid a ${flat}endsolid a solid b ${flat}endsolid b`)).triangleCount).toBe(2);
  });

  it('negative control: on one line, a name that only mentions facet is not facet data', () => {
    const parsed = parseStl(encode(`solid facet model vertex 9 9 9\n${FACET_TEXT}endsolid x\n`));
    expect(Array.from(parsed.positions)).toEqual(TRIANGLE);
  });

  it('reads every solid in a file holding several', () => {
    const one = new TextDecoder().decode(asciiStl(TRIANGLE, 'first'));
    const parsed = parseStl(encode(one + one.replaceAll('first', 'second')));
    expect(parsed.triangleCount).toBe(2);
  });

  it('clamps a header count that is too large and warns, keeping the triangles that fit', () => {
    const bytes = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    new DataView(bytes.buffer).setUint32(80, 5000, true);
    const parsed = parseStl(bytes);
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(12);
    expect(parsed.diagnostics).toEqual([{ code: 'stl-count-mismatch', severity: 'warning', message: 'The file header says 5000 triangles but the file holds only 12, so it looks cut off: the 12 were read. Export the STL again from the program that made it.' }]);
  });

  it('keeps only the declared triangles when the file holds more, and warns', () => {
    const full = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    const bytes = new Uint8Array(full.length + 7);
    bytes.set(full);
    new DataView(bytes.buffer).setUint32(80, 3, true);
    const parsed = parseStl(bytes);
    expect(parsed.triangleCount).toBe(3);
    expect(parsed.diagnostics).toEqual([{ code: 'stl-count-mismatch', severity: 'warning', message: 'The file header says 3 triangles but the file has room for 12, so the first 3 were read and the rest left out, and the file may be damaged. Export the STL again from the program that made it.' }]);
  });

  it.each([[1], [2], [10], [49]])('reads a binary file with %i bytes of padding after the triangles its header counts, with nothing to say', (extra) => {
    const full = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    for (const header of [null, 'solid but really binary']) {
      const bytes = new Uint8Array(full.length + extra);
      bytes.set(full);
      if (header) bytes.set(encode(header), 0);
      const parsed = parseStl(bytes);
      expect(parsed.format).toBe('binary');
      expect(parsed.triangleCount).toBe(12);
      expect(parsed.diagnostics).toEqual([]);
    }
  });

  it('reads the records of a binary file whose header count was left at 0, and warns', () => {
    const bytes = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    new DataView(bytes.buffer).setUint32(80, 0, true);
    const parsed = parseStl(bytes);
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(12);
    expect(parsed.diagnostics).toEqual([{ code: 'stl-count-mismatch', severity: 'warning', message: 'The file header gives no triangle count, so the 12 triangles its size holds were read.' }]);
  });

  it('falls back to clamped binary when a solid header has no ASCII behind it', () => {
    const full = writeBinaryStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    full.set(encode('solid but really binary'), 0);
    // Cutting bytes off breaks the exact size match, which is what normally spots binary.
    const parsed = parseStl(full.subarray(0, full.length - 20));
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(11);
    expect(parsed.diagnostics.map((d) => d.code)).toEqual(['stl-count-mismatch']);
  });
});

describe('STL rejection', () => {
  it('rejects non-finite values in binary files', () => {
    const soup = new Float32Array(TRIANGLE);
    soup[4] = NaN;
    expectStlError(writeBinaryStl(soup), 'non-finite');
    soup[4] = Infinity;
    expectStlError(writeBinaryStl(soup), 'non-finite');
  });

  it('rejects non-finite values in ASCII files', () => {
    expectStlError(asciiStl([0, 0, 0, 1, 0, 0, 0, NaN, 0]), 'non-finite');
    expectStlError(asciiStl([0, 0, 0, 1, 0, 0, 0, Infinity, 0]), 'non-finite');
    expectStlError(encode('solid x\nfacet\nvertex 1 2 oops\nvertex 4 5 6\nvertex 7 8 9\nendsolid x'), 'non-finite');
  });

  it('rejects an ASCII file that stops in the middle of a triangle', () => {
    expectStlError(encode('solid x\nfacet\nvertex 1 2 3\nvertex 4 5 6\n'), 'truncated');
    // M11: cut off in a vertex line, it is truncated too, not a number that is wrong.
    expectStlError(encode('solid x\nfacet\nvertex 1 2 3\nvertex 4 5 6\nvertex 7 '), 'truncated');
    expectStlError(encode('solid x\nfacet\nvertex 1 2 3\nvertex 4 5 6\nvertex'), 'truncated');
    expect(() => parseStl(encode('solid x\nfacet\nvertex 1 2 3\n'))).toThrow('The ASCII STL ends in the middle of a triangle, so it looks cut off.');
  });

  // Twelve facets of a box, as an exporter writes them, cut at every kind of place a transfer can stop.
  const BOX = new TextDecoder().decode(asciiStl(toSoup(box([0, 0, 0], [1.25, 1.25, 1.25])), 'box'));
  const upTo = (at: number): Uint8Array => encode(BOX.slice(0, at));

  it.each([
    ['in the middle of a number with an exponent', `${BOX.slice(0, BOX.lastIndexOf('vertex'))}vertex 1 2 1.5e`],
    ['in the middle of a number after its sign', `${BOX.slice(0, BOX.lastIndexOf('vertex'))}vertex 1 2 -`],
    ['in the middle of an exponent', `${BOX.slice(0, BOX.lastIndexOf('vertex'))}vertex 1 2 1e+`],
    ['at a lone point', `${BOX.slice(0, BOX.lastIndexOf('vertex'))}vertex 1 2 .`],
  ])('calls a file cut %s cut off, not a value that is not a number', (_, text) => {
    expectStlError(encode(text), 'truncated');
  });

  it.each([
    ['inside the last value, which still reads as a number', () => upTo(BOX.lastIndexOf('1.25') + 3)],
    ['after the last endloop', () => upTo(BOX.lastIndexOf('endloop') + 'endloop'.length)],
    ['inside a facet normal line', () => upTo(BOX.lastIndexOf('facet normal') + 'facet norm'.length)],
    ['after facet normal, before any vertex', () => upTo(BOX.lastIndexOf('outer loop'))],
  ])('refuses a file that stops inside a facet: %s', (_, bytes) => {
    expectStlError(bytes(), 'truncated');
  });

  it('loads a file that stops between facets with no endsolid, with a warning that it may be cut off', () => {
    for (const at of [BOX.lastIndexOf('endsolid'), BOX.lastIndexOf('endsolid') + 'endsol'.length, BOX.lastIndexOf('endfacet') + 'endfacet'.length]) {
      const parsed = parseStl(upTo(at));
      expect(parsed.triangleCount).toBe(12);
      expect(parsed.diagnostics).toEqual([{ code: 'stl-no-end', severity: 'warning', message: 'The ASCII STL has no endsolid line at its end, so it may be cut off: 12 triangles were read. If the model looks incomplete, export the STL again from the program that made it.' }]);
    }
    // Cut after an earlier facet: what it holds, said so.
    expect(parseStl(upTo(BOX.indexOf('endfacet') + 'endfacet'.length)).diagnostics[0].message).toContain(': 1 triangle was read.');
    // Negative control: the whole file, and a second solid after the first, say nothing.
    expect(parseStl(encode(BOX)).diagnostics).toEqual([]);
    expect(parseStl(encode(BOX + BOX)).diagnostics).toEqual([]);
  });

  it.each([[4], [2]])('rejects a facet with %i vertices instead of regrouping them into wrong triangles', (corners) => {
    const vertices = ['vertex 0 0 0', 'vertex 1 0 0', 'vertex 1 1 0', 'vertex 0 1 0'].slice(0, corners).join('\n');
    const facet = `facet normal 0 0 1\nouter loop\n${vertices}\nendloop\nendfacet\n`;
    // Three quads make 12 vertices, a whole number of triangles if nothing looked at the facets.
    expectStlError(encode(`solid x\n${facet.repeat(3)}endsolid x\n`), 'bad-facet');
  });

  it('rejects a file too small to be an STL', () => {
    expectStlError(encode('hello'), 'not-stl');
  });

  it('rejects text with a wrong extension, even though its bytes make finite floats', () => {
    expectStlError(encode('this is plainly not a mesh file, just a paragraph of lower case text '.repeat(40)), 'not-stl');
  });

  it('rejects a file with no triangles', () => {
    expectStlError(writeBinaryStl(new Float32Array(0)), 'empty');
    // A count of 0 and bytes after the header, but less than one whole record.
    expectStlError(new Uint8Array(84 + 49), 'empty');
    // M11: a text STL with no facet is an empty one, said so, where M1 called it too small to be an STL.
    expectStlError(encode('solid x\nendsolid x\n'), 'empty');
    expectStlError(encode(`solid ${'a long name '.repeat(20)}\nendsolid\n`), 'empty');
    expect(() => parseStl(encode('solid x\nendsolid x\n'))).toThrow('The STL file contains no usable triangles.');
    // An empty file says that, rather than that it is too small.
    expectStlError(new Uint8Array(0), 'empty');
    expect(() => parseStl(new Uint8Array(0))).toThrow('The file is empty.');
  });
});

describe('collapsed triangles', () => {
  it('drops triangles with two identical corners, and counts them', () => {
    const soup = [...TRIANGLE, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 3, 3, 3, 5, 5, 5, 6, 6, 6, 6, 6, 6];
    const parsed = parseStl(writeBinaryStl(Float32Array.from(soup)));
    expect(parsed.rawTriangleCount).toBe(4);
    expect(parsed.degenerateCount).toBe(3);
    expect(parsed.triangleCount).toBe(1);
    expect(Array.from(parsed.positions)).toEqual(TRIANGLE);
  });

  it('treats -0 and +0 as the same corner', () => {
    const soup = Float32Array.from([...TRIANGLE, 0, 1, 2, -0, 1, 2, 5, 6, 7]);
    expect(parseStl(writeBinaryStl(soup)).degenerateCount).toBe(1);
  });

  it('keeps a collinear triangle with three distinct corners, since it closes T-junctions', () => {
    const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const parsed = parseStl(writeBinaryStl(soup));
    expect(parsed.degenerateCount).toBe(0);
    expect(parsed.triangleCount).toBe(1);
  });

  it('keeps a triangle whose corners differ only in the last bit', () => {
    const near = new Float32Array([1, 0, 0]);
    new Uint32Array(near.buffer)[0] += 1;
    const soup = Float32Array.from([1, 0, 0, near[0], 0, 0, 0, 1, 0]);
    expect(parseStl(writeBinaryStl(soup)).degenerateCount).toBe(0);
  });

  it('rejects a file where every triangle collapses', () => {
    expectStlError(writeBinaryStl(Float32Array.from([1, 1, 1, 1, 1, 1, 2, 2, 2])), 'empty');
  });
});
