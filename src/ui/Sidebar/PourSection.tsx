import { useState } from 'preact/hooks';
import { openingLabel, refusalReason } from '../../app/derived';
import type { PlacedOpening } from '../../core/analysis/placement';
import { useStore } from '../context';
import { fixed, units } from '../format';
import { Cross, Pin, TopView } from '../icons';
import { SECTION_PARAMS } from '../layout';
import { ParamRow } from '../ParamRow';
import { Section } from './Section';

/** Why a typed spot was moved, in brackets, so a maker sees which rule it broke (FL: a flange's, most often). */
const reasonOf = (reason: string | null): string => (reason ? ` (${reason})` : '');

/** A coordinate box: typing a value and pressing Enter moves the opening there and pins it. */
function CoordBox({ axis, value, onCommit, onBad }: { axis: 'x' | 'y'; value: number; onCommit: (value: number) => void; onBad: (bad: boolean) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBadState] = useState(false);
  const setBad = (next: boolean): void => {
    setBadState(next);
    onBad(next);
  };
  const commit = (): void => {
    if (draft === null) return;
    const next = Number(draft.trim().replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(next)) {
      setBad(true);
      return;
    }
    setDraft(null);
    setBad(false);
    if (next !== Number(value.toFixed(2))) onCommit(next);
  };
  return (
    <label class="coord">
      {axis.toUpperCase()}
      <input
        class={`num${bad ? ' invalid' : ''}`}
        type="text"
        inputMode="decimal"
        autocomplete="off"
        data-axis={axis}
        // As in a parameter's box: with no typing pending, Ctrl+Z undoes the last step, such as a drop.
        data-undo={draft === null ? 'app' : undefined}
        value={draft ?? fixed(value, 2)}
        aria-invalid={bad ? true : undefined}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setDraft(null);
            setBad(false);
          }
        }}
        onBlur={commit}
      />
    </label>
  );
}

function OpeningRow({ opening, label }: { opening: PlacedOpening; label: string }) {
  const store = useStore();
  const move = (x: number, y: number): void => store.moveOpening(opening.id, x, y);
  // While its ring is dragged in the view, the boxes follow the pointer.
  const drag = store.drag.value?.id === opening.id ? store.drag.value : null;
  const at = drag ?? opening;
  const last = store.lastMove.value?.id === opening.id ? store.lastMove.value.result : null;
  const removable = opening.kind === 'vent' && !opening.pinned;
  // Typing that is no number moves nothing, and the row says so, as a slider row does.
  const [bad, setBad] = useState({ x: false, y: false });
  return (
    <div class={`opening${opening.valid ? '' : ' invalid'}${drag ? ' moving' : ''}`} data-opening={opening.id} data-kind={opening.kind} data-pinned={opening.pinned}>
      <span class={`kind ${opening.kind}`} title={opening.valid ? `${label}, placed at the ${opening.role === 'pinned' ? 'position you gave' : opening.role}` : `${label} is not valid where it is`}>
        <i />
        {label}
      </span>
      <CoordBox axis="x" value={at.x} onCommit={(x) => move(x, opening.y)} onBad={(b) => setBad((now) => ({ ...now, x: b }))} />
      <CoordBox axis="y" value={at.y} onCommit={(y) => move(opening.x, y)} onBad={(b) => setBad((now) => ({ ...now, y: b }))} />
      <button
        type="button"
        class="mini"
        aria-pressed={opening.pinned}
        aria-label={opening.pinned ? `Unpin ${label}` : `${label} is placed automatically`}
        title={opening.pinned ? 'Pinned where you put it. Click to let placement move it again.' : 'Placed automatically. Drag its ring in the view, or type a position, to pin it there.'}
        disabled={!opening.pinned}
        onClick={() => store.unpin(opening.id)}
      >
        <Pin />
      </button>
      <button
        type="button"
        class="mini"
        aria-label={`Remove ${label}`}
        title={removable ? 'Remove this vent. Air at its peak then has no way out, which Diagnostics will say.' : 'Only an automatic vent can be removed.'}
        disabled={!removable}
        onClick={() => store.removeVent(opening.id)}
      >
        <Cross />
      </button>
      {last?.snapped && last.valid ? <p class="note">That spot was not valid{reasonOf(refusalReason(last.refused, opening.kind))}, so it moved to the nearest place that is.</p> : null}
      {last && !last.valid ? <p class="note error">No valid place was found for it, so it stays where you put it.</p> : null}
      {last?.valid
        ? last.warnings.map((warning) => (
            <p key={warning.code} class="note warning" data-code={warning.code}>
              {units(warning.message)}
            </p>
          ))
        : null}
      {bad.x || bad.y ? <p class="note error">Enter a number.</p> : null}
      {!opening.valid && !last ? <p class="note error">{opening.pinned ? 'Not valid where it is: move it, or unpin it.' : 'Not valid where it was placed: drag it or type a position to move it.'}</p> : null}
    </div>
  );
}

/** Counts and sizes, then every opening of the first tile with its position and pin, which a drag of its ring in the view also sets. */
export function PourSection() {
  const store = useStore();
  const openings = store.pipeline.placement?.value.placement.openings ?? [];
  const removed = store.project.value.removed;
  return (
    <Section id="pour" title="Pour & funnel">
      {SECTION_PARAMS.pour.map((path) => (
        <ParamRow key={path} path={path} />
      ))}
      {openings.length > 0 ? (
        <div class="openings" data-testid="openings">
          <p class="lead drag-lead">
            Drag a ring on the cover's top in the view to move an opening on every copy, or type a position.
            <button
              type="button"
              class="btn small"
              data-testid="top-view"
              title="Look straight down at the top, with Diagnostics folded out of the way"
              onClick={() => {
                store.diagnosticsFolded.value = true;
                store.topView.value++;
              }}
            >
              <TopView />
              Top view
            </button>
          </p>
          <div class="opening-head">
            <span>Opening</span>
            <span>X mm</span>
            <span>Y mm</span>
            <span />
          </div>
          {openings.map((opening) => (
            <OpeningRow key={opening.id} opening={opening} label={openingLabel(openings, opening.id)} />
          ))}
          {removed.length > 0 ? (
            <p class="lead">
              {removed.length === 1 ? 'One automatic vent removed. ' : `${removed.length} automatic vents removed. `}
              <button type="button" class="btn small" onClick={() => store.restoreVents()}>
                Restore
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
