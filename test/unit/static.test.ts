import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
    ];
    // The diagnostics page reports whether these exist, which is its job.
    const checked = all.filter((f) => !f.path.startsWith('src/diag/'));
    for (const file of checked) {
      for (const word of forbidden) {
        expect(file.text.includes(word), `${file.path} uses ${word}`).toBe(false);
      }
    }
  });

  it('imports three only under src/view', () => {
    for (const file of all) {
      if (file.path.startsWith('src/view/')) continue;
      expect(/from 'three(['/])/.test(file.text), `${file.path} imports three`).toBe(false);
    }
  });

  it('creates Manifolds only through the arena', () => {
    for (const file of all) {
      if (file.path === 'src/core/solid/arena.ts') continue;
      expect(file.text.includes('new Manifold('), `${file.path} calls new Manifold`).toBe(false);
    }
  });

  it('keeps core free of DOM and three', () => {
    for (const file of all.filter((f) => f.path.startsWith('src/core/'))) {
      expect(/\b(document|window)\./.test(file.text), `${file.path} touches the DOM`).toBe(false);
    }
  });
});
