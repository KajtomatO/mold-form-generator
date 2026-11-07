import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPreamble, withSection } from '../fixtures/benchmarks';

const SAMPLE = '# Benchmarks\n\nFirst table.\n\n## Field stages\n\nfield\n\n## Solid stages\n\nsolid\n\n## Openings\n\nopenings\n';

describe('recording benchmarks keeps every other section', () => {
  it.each(['Field stages', 'Solid stages', 'Openings'])('a rewrite of %s leaves the rest as it was', (heading) => {
    const text = withSection(SAMPLE, heading, 'new');
    expect(text).toContain(`## ${heading}\n\nnew\n`);
    for (const other of ['Field stages', 'Solid stages', 'Openings'].filter((h) => h !== heading)) {
      expect(text).toContain(`## ${other}\n\n${other === 'Field stages' ? 'field' : other === 'Solid stages' ? 'solid' : 'openings'}\n`);
    }
    expect(text.startsWith('# Benchmarks\n\nFirst table.\n')).toBe(true);
    expect(text.match(/^## /gm)).toHaveLength(3);
  });

  it('a new section goes at the end', () => {
    const text = withSection('# Benchmarks\n\n## Field stages\n\nfield\n', 'Openings', 'new');
    expect(text).toBe('# Benchmarks\n\n## Field stages\n\nfield\n\n## Openings\n\nnew\n');
  });

  it('the browser run\'s rewrite keeps all the sections in order', () => {
    const text = withPreamble(SAMPLE, '# New top\n\nA table.\n');
    expect(text).toBe('# New top\n\nA table.\n\n## Field stages\n\nfield\n\n## Solid stages\n\nsolid\n\n## Openings\n\nopenings\n');
  });

  it('the real file has its sections', () => {
    const text = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'BENCHMARKS.md'), 'utf8');
    expect(text).toContain('## Field stages\n');
    expect(text).toContain('## Solid stages\n');
    expect(text).toContain('## Openings\n');
    // Replacing a section with itself changes nothing, so a --record run touches only what it measured.
    const field = /## Field stages\n\n([\s\S]*?)\n(?=## |$)/.exec(text)![1].trimEnd();
    expect(withSection(text, 'Field stages', field)).toBe(text);
  });
});
