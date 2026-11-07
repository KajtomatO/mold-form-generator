import { useEffect, useRef } from 'preact/hooks';
import { exportBlocked } from '../app/derived';
import type { ExportState } from '../app/store';
import type { ExportWant } from '../workers/exportJob';
import { useStore } from './context';
import { units } from './format';

/**
 * The stage bar takes Export ZIP's place, with Cancel at its right end, so the second click of a
 * double-click on the button would land on Cancel. Clicks that soon after the bar appears are not taken.
 */
const CANCEL_GUARD_MS = 400;

/** What the stage bar says at each step the export worker reports, and before it reports any. */
const STEP_LABELS: Record<string, string> = {
  start: 'Starting the geometry engine',
  wait: 'Waiting for the preview to finish',
  import: 'Reading the model',
  field: 'Building the cavity at full detail',
  tool: 'Shaping the cavity',
  cover: 'Cutting the cover',
  base: 'Building the base',
  clearance: 'Measuring the silicone clearance',
  raise: 'Building again with a wider margin',
  files: 'Writing the STL files',
  'fit-test': 'Building the fit-test pieces',
  zip: 'Packing the ZIP',
  funnel: 'Building the funnel',
};

const SINGLES: { want: ExportWant; label: string; title: string }[] = [
  { want: 'cover', label: 'Cover', title: 'The cover alone, as an STL in its print pose.' },
  { want: 'base', label: 'Base', title: 'The base alone, as an STL in its print pose.' },
  { want: 'funnel', label: 'Funnel', title: 'One funnel, as an STL, rim down. Print one per pour opening.' },
  { want: 'fit-test', label: 'Fit test', title: 'Small test pieces of the joint, with your clearances, as a ZIP of their own.' },
];

const WHAT: Record<ExportWant, string> = { zip: 'ZIP', cover: 'cover', base: 'base', funnel: 'funnel', 'fit-test': 'fit test' };

function StageBar({ state, onCancel }: { state: Extract<ExportState, { phase: 'running' }>; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const shownAt = useRef(performance.now());
  // The button that was pressed has gone, which leaves the focus on the page: Cancel is what a keyboard needs next.
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) cancel.current?.focus();
  }, []);
  const label = STEP_LABELS[state.step] ?? state.step;
  // Counted by steps begun, so the bar moves on as each one starts and is never full before the end.
  const counted = state.step !== 'start' && state.step !== 'wait';
  const width = counted ? Math.max(4, (100 * (state.done + 1)) / (state.total + 1)) : 4;
  return (
    <div class="stagebar" data-testid="stage-bar" data-step={state.step}>
      <span class="stage-text">
        <span class="stage-label" data-testid="stage-label">
          {label}…
        </span>
        {counted ? (
          <span class="stage-count">
            {state.done + 1} of {state.total}
          </span>
        ) : null}
      </span>
      <span class="stage-track" role="progressbar" aria-label={`Exporting the ${WHAT[state.want]}`} aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={counted ? state.done : 0} aria-valuetext={label}>
        <i style={{ width: `${width}%` }} />
      </span>
      <button
        type="button"
        class="btn"
        ref={cancel}
        data-testid="export-cancel"
        title="Stop the export. Nothing is saved."
        onClick={() => {
          if (performance.now() - shownAt.current >= CANCEL_GUARD_MS) onCancel();
        }}
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * The export block, always in view at the foot of the sidebar: Export ZIP, then each part on its own, the
 * stage bar with Cancel while one runs, and what the last export found. Every button runs T3 in a fresh
 * worker, so a part saved alone is the one the ZIP holds.
 */
export function ExportBox() {
  const store = useStore();
  const { pipeline } = store;
  const state = store.exportState.value;
  const running = state.phase === 'running';
  const blocked = exportBlocked(pipeline);
  const params = store.project.value.params;
  const current = pipeline.currentExport();
  // A failure has its own line below, from how the last export ended.
  const found = pipeline.exportNotes().filter((d) => d.code !== 'export-failed');
  const reasonFor = (want: ExportWant): string | null => {
    if (running) return 'An export is running.';
    if (blocked) return blocked;
    if (want === 'funnel' && !params.funnel.generate) return 'The funnel is turned off under Pour & funnel.';
    return null;
  };
  // A button that is off for a reason of its own says so under the buttons too, not only on hover.
  const ownReasons = running || blocked ? [] : SINGLES.flatMap(({ want }) => (reasonFor(want) ? [{ want, reason: reasonFor(want)! }] : []));
  // A file saved before a later change no longer matches the screen, which the outcome must say.
  const saved = state.phase === 'saved' ? { ...state, outdated: state.key !== pipeline.exportKeyFor(state.want) } : null;

  // When the stage bar goes, Cancel goes with it: the focus goes back to Export ZIP rather than the page.
  const zipButton = useRef<HTMLButtonElement>(null);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && (document.activeElement === null || document.activeElement === document.body)) zipButton.current?.focus();
    wasRunning.current = running;
  }, [running]);

  return (
    <div class="export" data-testid="export" aria-busy={running}>
      <h2>Export</h2>
      {running ? (
        <StageBar state={state} onCancel={() => store.cancelExport()} />
      ) : (
        <button
          type="button"
          class="btn primary"
          ref={zipButton}
          data-testid="export-zip"
          disabled={blocked !== null}
          title={blocked ?? 'Cover, base, funnel and model, with a README for printing and pouring, in one ZIP named after the model.'}
          onClick={() => void store.exportFile('zip')}
        >
          Export ZIP
        </button>
      )}
      <div class="singles">
        {SINGLES.map(({ want, label, title }) => {
          const reason = reasonFor(want);
          return (
            <button key={want} type="button" class="btn" data-testid={`export-${want}`} disabled={reason !== null} title={reason ?? title} onClick={() => void store.exportFile(want)}>
              {label}
            </button>
          );
        })}
      </div>
      <label class="option" title="The fit-test pieces go into the ZIP as fit_test/, with their own README.">
        <input type="checkbox" data-testid="export-fit-option" checked={store.fitTestInZip.value} disabled={running} onChange={(event) => (store.fitTestInZip.value = event.currentTarget.checked)} />
        <span>Add the fit-test pieces to the ZIP</span>
      </label>
      {blocked && !running ? (
        <p class="export-note" data-testid="export-reason">
          {blocked}
        </p>
      ) : null}
      {ownReasons.map(({ want, reason }) => (
        <p key={want} class="export-note" data-testid={`export-reason-${want}`}>
          {reason}
        </p>
      ))}
      {saved && saved.outdated ? (
        <p class="export-note warning" data-testid="export-outcome">
          Saved {saved.file}, made with the settings before your last change. Export again for the current ones.
        </p>
      ) : saved && saved.error ? (
        <p class="export-note error" data-testid="export-outcome">
          Saved {saved.file}, but the export found an error: {units(saved.error)}
        </p>
      ) : saved ? (
        <p class="export-note done" data-testid="export-outcome">
          Saved {saved.file}.
          {/* A line of its own, so the figure never parts from its unit and the file name stays whole. */}
          {current?.clearance && saved.want !== 'funnel' && saved.want !== 'fit-test' ? <span class="line"> Measured clearance {current.clearance.measured.toFixed(2)} mm.</span> : null}
        </p>
      ) : null}
      {state.phase === 'cancelled' ? (
        <p class="export-note" data-testid="export-outcome">
          Export cancelled. Nothing was saved.
        </p>
      ) : null}
      {state.phase === 'failed' ? (
        <p class="export-note error" data-testid="export-outcome">
          The {WHAT[state.want]} could not be exported. {units(state.message)}
        </p>
      ) : null}
      {found.map((d) => (
        <p key={`${d.code}|${d.message}`} class={`export-note ${d.severity}`} data-code={d.code}>
          {units(d.message)}
        </p>
      ))}
    </div>
  );
}
