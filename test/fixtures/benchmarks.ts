import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const path = join(import.meta.dirname, '..', '..', 'docs', 'BENCHMARKS.md');

/**
 * Rewrites one "## " section of BENCHMARKS.md and leaves the others alone, whatever their order, as
 * separate test files and the browser run each own their part of it. Vitest files run side by side,
 * so the read and write stay synchronous and next to each other.
 */
export function recordSection(heading: string, body: string): void {
  const text = readFileSync(path, 'utf8');
  const title = `## ${heading}`;
  const start = text.indexOf(`${title}\n`);
  const section = `${title}\n\n${body}\n`;
  if (start < 0) {
    writeFileSync(path, `${text.trimEnd()}\n\n${section}`);
    return;
  }
  const after = text.slice(start + title.length).search(/^## /m);
  const rest = after < 0 ? '' : `\n${text.slice(start + title.length + after)}`;
  writeFileSync(path, `${text.slice(0, start)}${section}${rest}`);
}
