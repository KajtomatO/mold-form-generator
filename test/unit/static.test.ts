import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (/\.tsx?$/.test(entry)) files.push(path);
  }
  return files;
}
const all = sources(join(root, 'src')).map((path) => ({
  path: relative(root, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('source rules', () => {
  it('uses no API that needs a secure context', () => {
    const forbidden = [
      'crypto.subtle',
      'randomUUID',
      'navigator.storage',
      'navigator.gpu',
      'navigator.clipboard',
      'serviceWorker',
      'showSaveFilePicker',
      'SharedArrayBuffer',
      // MM1: the memory meter's sources are the app's own; these two need cross-origin isolation or a
      // secure context, are Chromium's alone, and the first is rough besides (docs/REQUIREMENTS.md, D23).
      'measureUserAgentSpecificMemory',
      'deviceMemory',
    ];
    // The diagnostics page reports whether these exist, which is its job.
    const checked = all.filter((f) => !f.path.startsWith('src/diag/'));
    for (const file of checked) {
      for (const word of forbidden) {
        expect(file.text.includes(word), `${file.path} uses ${word}`).toBe(false);
      }
    }
  });

  it('reads no memory figure the browser rounds or delays, and the memory meter never probes a heap', () => {
    // MM1 (D23): Chromium's main-thread heap figure refreshes at most every 20 minutes and is rounded, and
    // covers main alone; the heap probe grows the heap each time it reads it, and is for tests only.
    // Outside the diagnostics page the code uses `performance` for its clock alone, so the figure cannot be
    // read through a cast, a bracket or another name for `performance` either; nor by its fields' names.
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const rounded = /\bperformance\b(?!\s*\.\s*now\b)|(used|total)JSHeapSize|jsHeapSizeLimit/;
    const checked = all.filter((f) => !f.path.startsWith('src/diag/'));
    for (const file of checked) expect(rounded.exec(code(file.text))?.[0] ?? null, `${file.path} reads Chromium's rounded heap figure, or uses performance for more than its clock`).toBeNull();
    // The meter's own code: its files whole, and in the others, each method and closure that works out a figure.
    const probe = /readSolidHeap|readHeap|usedHeap|t: 'heap'/;
    const meter = all.filter((f) => ['src/app/memory.ts', 'src/app/store.ts', 'src/ui/StatusStrip.tsx', 'src/ui/format.ts', 'src/ui/main.tsx'].includes(f.path));
    expect(meter).toHaveLength(5);
    for (const file of meter) expect(probe.test(file.text), `${file.path} probes a heap`).toBe(false);
    /** The body of the block that starts at the first `{` after `at`, braces matched. */
    const block = (text: string, at: number): string => {
      const open = text.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
      }
      throw new Error('unbalanced braces');
    };
    const bodies: string[] = [];
    for (const file of all) {
      for (const match of file.text.matchAll(/\bheldArrays\(\): unknown\[\] \{|\bexport function solidMemory\(/g)) bodies.push(`${file.path}: ${block(file.text, match.index)}`);
      // The hosts' figures are one-line closures.
      for (const match of file.text.matchAll(/\bconst memory = \(.*$/gm)) bodies.push(`${file.path}: ${match[0]}`);
    }
    // Pipeline, PreviewScene, Picker, HeightPreview and the three caches' heldArrays, solidMemory, and the two hosts' figures.
    expect(bodies.length).toBeGreaterThanOrEqual(10);
    for (const body of bodies) expect(probe.test(body), body.slice(0, 200)).toBe(false);
  });

  it('imports three only under src/view', () => {
    for (const file of all) {
      if (file.path.startsWith('src/view/')) continue;
      expect(/from 'three(['/])/.test(file.text), `${file.path} imports three`).toBe(false);
    }
  });

  it('creates Manifolds and CrossSections from meshes and polygons only in the arena', () => {
    // Catches `new Manifold(`, `new api.Manifold(` and the static forms that do the same job, plus
    // toPolygons, extrude and revolve, whose leaks only the arena's own calls plug.
    const direct = /new\s+[\w.]*\b(Manifold|CrossSection)\s*\(|\.(ofMesh|ofPolygons|toPolygons)\s*\(|(?<!arena)\.(extrude|revolve)\s*\(/;
    for (const file of all) {
      if (file.path === 'src/core/solid/arena.ts') continue;
      expect(direct.test(file.text), `${file.path} builds a handle outside the arena`).toBe(false);
    }
  });

  it('has no reflection or scale anywhere in core, so transforms stay rigid', () => {
    for (const file of all.filter((f) => f.path.startsWith('src/core/'))) {
      expect(/\.(mirror|scale)\s*\(/.test(file.text), `${file.path} mirrors or scales`).toBe(false);
    }
  });

  it('keeps the field code free of Manifold at run time, so field.worker can load it without WASM', () => {
    const byPath = new Map(all.map((file) => [file.path, file.text]));
    const seen = new Set<string>();
    const queue = all.filter((file) => file.path.startsWith('src/core/field/')).map((file) => file.path);
    expect(queue.length).toBeGreaterThan(5);
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      // A line that starts `import type` is erased at build time, so it pulls nothing in.
      for (const [, from] of byPath.get(path)!.matchAll(/^import (?!type )[^;]*?from '([^']+)'(?: with \{ type: 'json' \})?;/gm)) {
        expect(from, `${path} loads ${from}`).not.toMatch(/^manifold-3d|^three/);
        if (!from.startsWith('.')) continue;
        // CS: a JSON file, such as the defaults, is data, which loads nothing in its turn.
        if (from.endsWith('.json')) {
          expect(existsSync(join(root, dirname(path), from)), `${path} imports ${from}`).toBe(true);
          continue;
        }
        const target = join(dirname(path), from).replaceAll('\\', '/') + '.ts';
        expect(byPath.has(target), `${path} imports ${from}`).toBe(true);
        queue.push(target);
      }
    }
    expect(seen.has('src/core/mesh/shells.ts')).toBe(true);
    expect(seen.has('src/core/solid/arena.ts')).toBe(false);
  });

  it('keeps the analyses and rules free of Manifold at run time, so field.worker and a drag on the main thread can load them', () => {
    const byPath = new Map(all.map((file) => [file.path, file.text]));
    const seen = new Set<string>();
    const queue = [...all.filter((file) => file.path.startsWith('src/core/analysis/')).map((file) => file.path), 'src/core/params/rules.ts', 'src/core/parts/funnelProfile.ts'];
    expect(queue.length).toBeGreaterThan(6);
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const [, from] of byPath.get(path)!.matchAll(/^import (?!type )[^;]*?from '([^']+)'(?: with \{ type: 'json' \})?;/gm)) {
        expect(from, `${path} loads ${from}`).not.toMatch(/^manifold-3d|^three/);
        if (!from.startsWith('.')) continue;
        // CS: a JSON file, such as the defaults, is data, which loads nothing in its turn.
        if (from.endsWith('.json')) {
          expect(existsSync(join(root, dirname(path), from)), `${path} imports ${from}`).toBe(true);
          continue;
        }
        const target = join(dirname(path), from).replaceAll('\\', '/') + '.ts';
        expect(byPath.has(target), `${path} imports ${from}`).toBe(true);
        queue.push(target);
      }
    }
    expect(seen.has('src/core/analysis/validate.ts')).toBe(true);
    expect(seen.has('src/core/solid/arena.ts')).toBe(false);
  });

  it('never reads mesh genus where it counts bodies or places openings', () => {
    for (const file of all.filter((f) => f.path.startsWith('src/core/analysis/'))) {
      expect(/genus/.test(file.text.replace(/^.*Never from mesh genus.*$/gm, '')), `${file.path} reads genus`).toBe(false);
    }
  });

  it('keeps core free of DOM and three', () => {
    for (const file of all.filter((f) => f.path.startsWith('src/core/'))) {
      expect(/\b(document|window)\./.test(file.text), `${file.path} touches the DOM`).toBe(false);
    }
  });
});
