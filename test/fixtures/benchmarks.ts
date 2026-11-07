import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const path = join(import.meta.dirname, '..', '..', 'docs', 'BENCHMARKS.md');

/** The text with one "## " section replaced, or added at the end. Every other section stays, in its place. */
export function withSection(text: string, heading: string, body: string): string {
  const title = `## ${heading}`;
  const start = text.indexOf(`${title}\n`);
  const section = `${title}\n\n${body}\n`;
  if (start < 0) return `${text.trimEnd()}\n\n${section}`;
  const after = text.slice(start + title.length).search(/^## /m);
  const rest = after < 0 ? '' : `\n${text.slice(start + title.length + after)}`;
  return `${text.slice(0, start)}${section}${rest}`;
}

/** The text with the part before its first "## " replaced, which the browser run owns, and the sections kept. */
export function withPreamble(text: string, preamble: string): string {
  const sections = text.search(/^## /m);
  return preamble + (sections < 0 ? '' : `\n${text.slice(sections)}`);
}

/**
 * Rewrites one "## " section of BENCHMARKS.md and leaves the others alone, whatever their order, as
 * separate test files and the browser run each own their part of it. Vitest files run side by side,
 * so the read and write stay synchronous and next to each other.
 */
export function recordSection(heading: string, body: string): void {
  writeFileSync(path, withSection(readFileSync(path, 'utf8'), heading, body));
}

/**
 * A section whose table several runs fill, such as one browser each. Each run owns the rows `owns`
 * picks out: its new rows replace those, and every other row stays.
 */
export function withRows(text: string, heading: string, intro: string, header: string, rows: string[], owns: (row: string) => boolean): string {
  const start = text.indexOf(`## ${heading}\n`);
  let kept: string[] = [];
  if (start >= 0) {
    const after = text.slice(start + heading.length + 4);
    const end = after.search(/^## /m);
    const body = end < 0 ? after : after.slice(0, end);
    // A header line starts with the same first cell, whatever columns it had before the table changed.
    const firstCell = header.split('|')[1];
    kept = body.split('\n').filter((line) => /^\| (?!-)/.test(line) && line.split('|')[1] !== firstCell && !owns(line));
  }
  return withSection(text, heading, [intro, '', header, ...[...kept, ...rows].sort()].join('\n'));
}
