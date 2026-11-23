import type { ComponentChildren } from 'preact';
import { changedPaths, paramDef, type ParamPath } from '../../app/stages';
import { useStore } from '../context';
import { namedList } from '../format';
import { ResetArrow } from '../icons';
import { rowControl } from '../ResetMark';

/** A section of the sidebar; with `reset`, the settings its Reset sets back while any of them is changed (CS). */
export function Section({ id, title, reset, children }: { id: string; title: string; reset?: readonly ParamPath[]; children: ComponentChildren }) {
  return (
    <section class="section" data-section={id} aria-label={title}>
      <h2>{title}</h2>
      {reset ? <SectionReset paths={reset} title={title} /> : null}
      {children}
    </section>
  );
}

/**
 * CS: a section's Reset, at its top right on the heading's line, so it moves nothing as it comes and goes, or
 * `inline` in a line of its own, as in Advanced. It shows while a setting of the section is off its default, one
 * the bolts' toggle hides among them, and sets them all back as one undo step (D22). Its button goes with them,
 * so focus moves to the section's first row.
 */
export function SectionReset({ paths, title, inline = false }: { paths: readonly ParamPath[]; title: string; inline?: boolean }) {
  const label = `the ${title} settings`;
  const store = useStore();
  const changed = changedPaths(store.project.value.params, paths);
  if (changed.length === 0) return null;
  const labels = namedList(changed.map((path) => paramDef(path).label));
  // MT: a type other than the one-piece cover is named, as its defaults are the ones set.
  const named = store.typeShown();
  const type = named ? `${named} ` : '';
  return (
    <button
      type="button"
      class={inline ? 'btn small section-reset-inline' : 'section-reset'}
      data-testid={inline ? 'advanced-reset' : 'section-reset'}
      aria-label={`Reset ${label}`}
      title={`Reset ${changed.length === 1 ? 'the setting' : `the ${changed.length} settings`} changed in ${title} to ${changed.length === 1 ? `its ${type}default` : `their ${type}defaults`}: ${labels}. Undo takes it back (Ctrl+Z).`}
      onClick={(event) => {
        const first = rowControl(event.currentTarget.closest('section, details')?.querySelector('[data-param]') ?? null);
        store.resetParams(paths, `resetting ${label}`);
        first?.focus({ preventScroll: true });
      }}
    >
      <ResetArrow />
      Reset
    </button>
  );
}
