import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { allDiagnostics, diagnosticMarkers } from '../app/derived';
import { useStore } from './context';
import { units } from './format';
import { Chevron } from './icons';

export function diagnosticKey(d: { code: string; message: string }): string {
  return `${d.code}|${d.message}`;
}

/** Rows of the list not wholly in view under the part of it that shows. */
function rowsBelow(list: HTMLUListElement | null): number {
  if (!list) return 0;
  const bottom = list.getBoundingClientRect().bottom;
  let hidden = 0;
  for (const row of list.children) if (row.getBoundingClientRect().bottom > bottom + 1) hidden++;
  return hidden;
}

/**
 * Floating: bottom left while all is well, top right once there is a warning or an error. One sentence
 * a row, and a Show toggle on each that names a place, which puts a marker there in the view. When the
 * list is longer than the card, a line under it says how many rows are below, as an overlay scrollbar
 * may not show at all. Its title folds it, and Top view folds it too, as it would cover the top.
 */
export function DiagnosticsCard() {
  const store = useStore();
  const { pipeline } = store;
  const list = useRef<HTMLUListElement>(null);
  const [below, setBelow] = useState(0);
  const measure = (): void => setBelow(rowsBelow(list.current));
  // After every render, as rows come and go with the pipeline, and when the window changes size.
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  if (!pipeline.modelName) return null;
  const all = allDiagnostics(pipeline);
  const warn = all.some((d) => d.severity !== 'info');
  const top = pipeline.field?.value.rim.Zt ?? 0;
  const shown = store.shown.value;
  // Folded to its title, so it covers none of the top while openings are placed; the title keeps the count.
  const folded = store.diagnosticsFolded.value;
  const count = (severity: string, one: string, many: string): string | null => {
    const n = all.filter((d) => d.severity === severity).length;
    return n === 0 ? null : n === 1 ? `1 ${one}` : `${n} ${many}`;
  };
  const summary = [count('error', 'error', 'errors'), count('warning', 'warning', 'warnings'), count('info', 'note', 'notes')].filter((s) => s !== null).join(', ') || 'no problems';
  return (
    <div class={`card diagnostics ${warn ? 'warn' : 'ok'}${folded ? ' folded' : ''}`} data-testid="diagnostics" role="status" aria-live="polite">
      <h2>
        <button type="button" class="fold" data-testid="diagnostics-fold" aria-expanded={!folded} title={folded ? 'Show the list' : 'Fold the card to its title'} onClick={() => (store.diagnosticsFolded.value = !folded)}>
          <Chevron />
          Diagnostics
          {folded ? <span class="summary">{summary}</span> : null}
        </button>
      </h2>
      {folded ? null : all.length === 0 ? (
        <div class="all-ok">
          <i />
          No problems found.
        </div>
      ) : (
        <ul ref={list} onScroll={measure}>
          {all.map((d) => {
            const key = diagnosticKey(d);
            const located = diagnosticMarkers(d, top).length > 0;
            return (
              <li class={`diagnostic ${d.severity}`} key={key} data-code={d.code}>
                <span class="sev" aria-label={d.severity} />
                <span>
                  {units(d.message)}
                  {d.byExport ? <span class="where">Found by the last export</span> : d.exportCell ? <span class="where">Checked at full export detail</span> : null}
                </span>
                {located ? (
                  <button type="button" class="btn small" aria-pressed={shown.includes(key)} onClick={() => store.toggleShown(key)}>
                    Show
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {below > 0 && all.length > 0 && !folded ? (
        <button type="button" class="more" data-testid="diagnostics-more" title="Scroll the list down" onClick={() => list.current?.scrollBy({ top: list.current.clientHeight * 0.8, behavior: 'smooth' })}>
          {below === 1 ? '1 more row below' : `${below} more rows below`}
        </button>
      ) : null}
    </div>
  );
}
