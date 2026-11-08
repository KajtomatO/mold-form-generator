import { useEffect, useRef } from 'preact/hooks';
import { useStore } from '../context';
import { FileButton, OPEN_LABEL, OPEN_TITLE } from '../files';
import { formatCount, formatNormal, formatNumber, units } from '../format';
import { Cross } from '../icons';
import { ParamRow } from '../ParamRow';
import { Section } from './Section';

/**
 * Load, then confirm the base (G2.4): the ranked planes with the top one chosen, a face picked on the
 * model instead, the plane tolerance, and G2.6's offer to stand on the upper level. Save project sits
 * beside Open, as the pair a maker knows from every program's File menu.
 */
export function ModelSection() {
  const store = useStore();
  const { pipeline } = store;
  const parsed = pipeline.parsed?.value;
  const oriented = pipeline.oriented?.value;
  const plane = store.project.value.plane;
  const keys = pipeline.modelName ? pipeline.keys() : null;
  // Only a report for the plane on screen may offer a move, or a second click would move it twice.
  const footprint = keys && pipeline.footprint?.key === keys.S2 && pipeline.oriented?.key === keys.S2 ? pipeline.footprint.value : null;
  const upper = footprint?.levels.useUpper ?? null;
  const offset = oriented?.chosen.offset ?? 0;
  // S2 stands on the named level only if it still finds it; otherwise a warning says so.
  const standing = oriented !== undefined && plane.upper !== false && Math.abs(offset - plane.upper) <= oriented.planeTol;
  const error = store.pipeline.status().error;
  const project = store.projectName.value, notice = store.fileNotice.value, busy = store.fileBusy.value, saving = store.saving.value, replacing = store.replacing.value;
  const saveName = store.projectFileName();
  const canSave = store.canSave();
  const unsaved = store.unsaved();
  const saveTitle = canSave
    ? `Save the STL with its settings, base face, moved openings and removed vents as ${saveName}, to open again later (Ctrl+S). The view (camera, section, explode, parts shown) and the Export box's options are not kept.`
    : pipeline.modelName === null
      ? 'Load a model to save it as a project'
      : error
        ? 'The STL could not be read, so it cannot be saved as a project'
        : 'Reading the model…';
  // A save's line would read as if the work were on disk after a change: it says so once it is not.
  const message = notice?.saved && unsaved ? `Changed since you saved ${notice.saved}.` : notice?.message;

  // What a file dropped on the view led to shows here, which may be scrolled away or folded up: an error,
  // a warning or a question opens the sidebar, and each scrolls into sight, as nothing else on screen changes.
  const attention = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!busy && !notice && !replacing) return;
    if (replacing || (notice && notice.severity !== 'info')) store.sidebarCollapsed.value = false;
    const frame = requestAnimationFrame(() => {
      const el = attention.current, box = el?.closest<HTMLElement>('[data-testid="sections"]');
      if (!el || !box || el.offsetHeight === 0) return;
      const at = el.getBoundingClientRect(), view = box.getBoundingClientRect();
      // The Model section's head too, so the file the notice is about shows with it.
      if (at.top < view.top) box.scrollTop = 0;
      else if (at.bottom > view.bottom) box.scrollTop += at.bottom - view.bottom + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, notice, replacing]);

  return (
    <Section id="model" title="Model">
      <div class="file-row">
        <FileButton store={store} label={OPEN_LABEL} title={OPEN_TITLE} primary={!pipeline.modelName} />
        <button type="button" class="btn" data-testid="save-project" disabled={!canSave || saving} title={saveTitle} onClick={() => void store.saveProject()}>
          {saving ? 'Saving…' : 'Save project'}
        </button>
      </div>
      <p class="file-name">
        {project ? (
          <span class="project">
            <span data-testid="project-name">{project}</span>
            {unsaved ? (
              <span class="changed" data-testid="project-changed" title="Changed since it was opened or saved: Save project keeps the changes">
                {' '}
                (changed)
              </span>
            ) : null}
          </span>
        ) : null}
        <span class="name" data-testid="file-name">
          {pipeline.modelName ? `${pipeline.modelName}${parsed ? `, ${formatCount(parsed.triangles)} triangles` : ''}` : 'Or drop an STL or a project on the view.'}
        </span>
      </p>
      <div ref={attention}>
        {busy ? (
          <p class="lead file-busy" data-testid="file-busy" role="status">
            <span class="spinner" aria-hidden="true" />
            {busy}
          </p>
        ) : null}
        {replacing ? (
          <div class="note warning file-replace" data-testid="replace-prompt" role="alert">
            <p>
              {replacing.model} has changes that are not saved. Opening {replacing.name} replaces it, and its undo history with it.
            </p>
            <div class="file-replace-buttons">
              <button type="button" class="btn small primary" disabled={!canSave || saving} onClick={() => void store.answerReplace('save')}>
                {saving ? 'Saving…' : 'Save, then open'}
              </button>
              <button type="button" class="btn small" onClick={() => void store.answerReplace('discard')}>
                Open without saving
              </button>
              <button type="button" class="btn small" onClick={() => void store.answerReplace('cancel')}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {/* What opening or saving a project file found, here and never in a dialog. */}
        {notice ? (
          <div class={`note file-notice ${notice.severity}`} data-testid="file-notice" data-severity={notice.severity} role={notice.severity === 'error' ? 'alert' : 'status'}>
            <div class="file-notice-head">
              <span>{message}</span>
              <button type="button" class="mini" aria-label="Dismiss" title="Dismiss" onClick={() => (store.fileNotice.value = null)}>
                <Cross />
              </button>
            </div>
            {notice.notes.length > 0 ? (
              <ul>
                {notice.notes.map((note, k) => (
                  <li key={k} class={note.severity}>
                    {units(note.message)}
                  </li>
                ))}
              </ul>
            ) : null}
            {notice.details ? (
              <details class="file-notice-details">
                <summary>Details</summary>
                <p data-testid="file-notice-details">{notice.details}</p>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* A file that is no STL, or has no face to stand on, says why right here, next to Open. */}
      {!oriented && error ? (
        <p class="note error" data-testid="model-error">
          {units(error)}
        </p>
      ) : null}
      {oriented ? (
        <>
          <h3>Base face</h3>
          <p class="lead">The flat face the model stands on. The best guess is chosen; check it, or pick another.</p>
          <ul class="candidates" role="listbox" aria-label="Base face candidates" onMouseLeave={() => (store.hoverCandidate.value = null)}>
            {oriented.candidates.map((candidate, rank) => {
              const selected = 'rank' in plane && plane.rank === rank;
              return (
                <li key={rank}>
                  <button
                    type="button"
                    class="candidate"
                    role="option"
                    aria-selected={selected}
                    data-rank={rank}
                    title={`Outward normal (${candidate.normal.map((v) => v.toFixed(3)).join(', ')}), ${candidate.members.length} triangles`}
                    onMouseEnter={() => (store.hoverCandidate.value = rank)}
                    onFocus={() => (store.hoverCandidate.value = rank)}
                    onBlur={() => (store.hoverCandidate.value = null)}
                    // The chosen row again is no change: it would drop the pins and removed vents, and an upper level.
                    onClick={() => (selected ? undefined : store.setPlane({ rank, upper: false }))}
                  >
                    <span class="dot" />
                    <span class="rank">{rank + 1}</span>
                    <span>
                      {formatNormal(candidate.normal)}
                      {candidate.source === 'hole' ? ', open hole' : ''}
                      {candidate.offset > 0 ? `, ${formatNumber(candidate.offset, 2)} mm in` : ''}
                    </span>
                    <span class="area">{formatCount(Math.round(candidate.area))} mm²</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div class="pick-row">
            <button type="button" class="btn" aria-pressed={store.pickMode.value} data-testid="pick-face" onClick={() => (store.pickMode.value = !store.pickMode.value)}>
              Pick a face on the model
            </button>
            {'pick' in plane ? <span class="lead">Using a picked face.</span> : null}
          </div>
          {store.pickMode.value ? <p class="lead">Click the face the model stands on. Esc cancels.</p> : null}
          <ParamRow path="base.planeTol" />
          {upper ? (
            <div class="note warning" data-testid="upper-level">
              {units(footprint!.levels.diagnostics.find((d) => d.code === 'upper-level')?.message ?? '')}
              <div>
                {/* The very level the warning names: the report knows which one silicone can reach. */}
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(upper.offset)}>
                  Use upper level
                </button>
              </div>
            </div>
          ) : null}
          {standing ? (
            <div class="note" data-testid="on-upper-level">
              The model stands on the level {formatNumber(offset, 2)} mm up, and what lies below it is trimmed off.
              <div>
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(false)}>
                  Use the lower level
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
