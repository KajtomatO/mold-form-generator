import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEAD_BYTES, isLarge, LARGE_MODEL, minBytesToLook, clampTarget, defaultTarget, largeFigures, memoryQuote, simplifiedName, SIMPLIFIED_FLOW, simplifyQuote, SIMPLIFY_TARGET } from '../../src/app/largeModel';
import { fileKind, fileKindOfHead, packProject } from '../../src/app/projectArchive';
import { estimateTriangles } from '../../src/core/stl/estimate';
import { parseStl } from '../../src/core/stl/parse';
import { HEAVY_BLOCK, heightBlockStl, heightBlockTriangles } from '../fixtures/heavy';
import { asciiStl, box, toSoup } from '../fixtures/synthetic';

const examplesDir = join(import.meta.dirname, '..', '..', 'examples');
const examples = readdirSync(examplesDir).filter((name) => name.toLowerCase().endsWith('.stl'));
const head = (bytes: Uint8Array): Uint8Array => bytes.subarray(0, HEAD_BYTES);

/** A binary STL of `records` triangles whose header says `declared`. */
function binary(records: number, declared: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * records + padding);
  new DataView(bytes.buffer).setUint32(80, declared, true);
  const view = new DataView(bytes.buffer);
  // Corners (t, 0, 0), (t, 1, 0) and (t, 0, 1): a real triangle, none collapsed.
  for (let t = 0; t < records; t++) {
    const at = 84 + 50 * t + 12;
    view.setFloat32(at, t, true);
    view.setFloat32(at + 12, t, true);
    view.setFloat32(at + 16, 1, true);
    view.setFloat32(at + 24, t, true);
    view.setFloat32(at + 32, 1, true);
  }
  return bytes;
}

describe('MM2: an STL\'s triangles from its first 64 kB and its size', () => {
  it('counts every binary example exactly as parseStl reads it, and estimates the text ones within 3%', () => {
    let text = 0;
    for (const name of examples) {
      const bytes = new Uint8Array(readFileSync(join(examplesDir, name)));
      const estimate = estimateTriangles(head(bytes), bytes.length);
      const parsed = parseStl(bytes);
      expect(estimate.format, name).toBe(parsed.format);
      if (parsed.format === 'binary') {
        expect(estimate, name).toEqual({ format: 'binary', triangles: parsed.rawTriangleCount, exact: true });
      } else {
        text++;
        expect(estimate.exact, name).toBe(bytes.length <= HEAD_BYTES);
        expect(Math.abs(estimate.triangles / parsed.rawTriangleCount - 1), name).toBeLessThan(0.03);
      }
    }
    // The oil barrel at least, and the medieval barrel where this checkout has it.
    expect(text).toBeGreaterThanOrEqual(1);
  });

  it('reads a header count as parseStl does: 0, above and below what the size holds, and padding after the last record', () => {
    for (const [records, declared, padding] of [[100, 0, 0], [100, 250, 0], [100, 40, 0], [100, 100, 30], [100, 100, 0]] as const) {
      const bytes = binary(records, declared, padding);
      expect(estimateTriangles(head(bytes), bytes.length).triangles, `${records} ${declared} ${padding}`).toBe(parseStl(bytes).rawTriangleCount);
    }
  });

  it('a text file read whole is exact, a long one is estimated from its head, and one with no facet in its head falls back on 250 bytes a facet', () => {
    const small = asciiStl(toSoup(box([0, 0, 0], [1, 1, 1])));
    expect(estimateTriangles(small, small.length)).toEqual({ format: 'ascii', triangles: 12, exact: true });
    const long = asciiStl(new Float32Array(9 * 5000).map((_, k) => (k * 0.37) % 11));
    const estimate = estimateTriangles(head(long), long.length);
    expect(estimate.exact).toBe(false);
    expect(Math.abs(estimate.triangles / 5000 - 1)).toBeLessThan(0.03);
    // A long name before the first facet: the head holds none.
    const named = new TextEncoder().encode(`solid ${'x'.repeat(70_000)}\n`);
    expect(estimateTriangles(head(named), 2_500_000)).toEqual({ format: 'ascii', triangles: 10_000, exact: false });
  });

  it('tells an STL from its head and size as fileKind does from the whole file, for every example and the other kinds', () => {
    for (const name of examples) {
      const bytes = new Uint8Array(readFileSync(join(examplesDir, name)));
      expect(fileKindOfHead(name, head(bytes), bytes.length), name).toBe(fileKind(name, bytes));
      // With no name to go by, from the bytes alone.
      expect(fileKindOfHead('download', head(bytes), bytes.length), name).toBe(fileKind('download', bytes));
    }
    const zip = packProject('{}', new Uint8Array(84));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Uint8Array(200)]);
    for (const [name, bytes] of [['download', zip], ['photo', png], ['download', new TextEncoder().encode('{"a":1}')]] as const) expect(fileKindOfHead(name, head(bytes), bytes.length), name).toBe(fileKind(name, bytes));
  });
});

describe('MM2: the warning point', () => {
  it('is 500,000 triangles or 125 MB, set from the memory curve, and no file below 25 MB is ever looked at first', () => {
    expect(LARGE_MODEL).toEqual({ triangles: 500_000, bytes: 125_000_000 });
    expect(minBytesToLook(LARGE_MODEL)).toBe(25_000_084);
    expect(isLarge(499_999, 24_999_934, LARGE_MODEL)).toBe(false);
    expect(isLarge(500_000, 25_000_084, LARGE_MODEL)).toBe(true);
    expect(isLarge(400_000, 124_999_999, LARGE_MODEL)).toBe(false);
    expect(isLarge(400_000, 125_000_000, LARGE_MODEL)).toBe(true);
    // The largest binary file that cannot ask: one triangle under the point.
    expect(84 + 50 * 499_999).toBeLessThan(minBytesToLook(LARGE_MODEL));
  });

  it('no example asks, and the 3 million triangle test model does, counted exactly from its head', () => {
    for (const name of examples) {
      const bytes = new Uint8Array(readFileSync(join(examplesDir, name)));
      expect(bytes.length, name).toBeLessThan(minBytesToLook(LARGE_MODEL));
      expect(isLarge(parseStl(bytes).rawTriangleCount, bytes.length, LARGE_MODEL), name).toBe(false);
    }
    // A small block's head and size are all its count needs; the soak's, at n = 1224, has 3,011,040 triangles.
    const block = heightBlockStl({ ...HEAVY_BLOCK, n: 160 });
    expect(estimateTriangles(head(block), block.length)).toEqual({ format: 'binary', triangles: parseStl(block).rawTriangleCount, exact: true });
    expect(heightBlockTriangles(HEAVY_BLOCK.n)).toBe(3_011_040);
    const heavyHead = heightBlockStl({ ...HEAVY_BLOCK, n: 1224 }).subarray(0, HEAD_BYTES);
    expect(estimateTriangles(heavyHead, 84 + 50 * 3_011_040)).toEqual({ format: 'binary', triangles: 3_011_040, exact: true });
    expect(isLarge(3_011_040, 84 + 50 * 3_011_040, LARGE_MODEL)).toBe(true);
  });

  it('the copy\'s count: 300,000 by default, from 10,000 to 1,000,000 and under the model\'s own; its file name; and the figures the question quotes', () => {
    expect(defaultTarget(3_011_040)).toBe(SIMPLIFY_TARGET);
    expect(defaultTarget(250_000)).toBe(249_999);
    expect(clampTarget(5, 3_000_000)).toBe(10_000);
    expect(clampTarget(2_000_000, 3_000_000)).toBe(1_000_000);
    expect(clampTarget(123_456.7, 3_000_000)).toBe(123_457);
    expect(simplifiedName('statue.STL')).toBe('statue-simplified.stl');
    expect(simplifiedName('a.b.stl')).toBe('a.b-simplified.stl');
    expect(memoryQuote(300_000)).toBe('about 1.3 GB');
    expect(memoryQuote(500_000)).toBe('about 1.7 GB');
    expect(memoryQuote(1_000_000)).toBe('about 2.6 GB');
    expect(memoryQuote(2_000_000)).toBe('about 3.4 GB');
    // MM2's review: the 3 million triangle model's own peak, not 2 million's, which merged mode took higher.
    expect(memoryQuote(3_011_040)).toBe('about 2.9 GB');
    expect(memoryQuote(5_000_000)).toBe('more than about 2.9 GB');
    // What simplifying saved: the whole flow of the 3 million triangle model simplified, as measured, against it loaded.
    expect(simplifyQuote()).toBe(`In our tests a model of 3 million triangles took at most ${SIMPLIFIED_FLOW.gb.toFixed(1)} GB simplified, from opening to export, against 2.9 GB loaded as it is; its copy kept ${SIMPLIFIED_FLOW.copy.toLocaleString('en-US')} triangles and took ${SIMPLIFIED_FLOW.copySeconds} s to make.`);
    expect(SIMPLIFIED_FLOW.gb).toBeLessThan(SIMPLIFIED_FLOW.loadedGb);
    expect(largeFigures({ triangles: 3_011_040, exact: true, format: 'binary' }, 150_552_084)).toBe('3,011,040 triangles (150.6 MB)');
    expect(largeFigures({ triangles: 1_240_000, exact: false, format: 'ascii' }, 310e6)).toBe('about 1,240,000 triangles (310.0 MB of text)');
  });
});
