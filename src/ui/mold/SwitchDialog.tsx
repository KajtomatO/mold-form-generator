import { useEffect, useRef, useState } from 'preact/hooks';
import type { SwitchPlan, SwitchRow } from '../../app/moldSwitch';
import type { ParamPath } from '../../app/stages';
import { useStore } from '../context';
import { defOf, GROUP_TITLES } from '../layout';
import { defaultText } from '../ResetMark';

/**
 * MT: the mold type switch window (D27), the app's one dialog, which the user asked for after PrusaSlicer's when its
 * configuration changes. A native <dialog> opened with showModal(), so the page behind it takes no clicks or focus.
 * It lists every setting the user changed whose value differs from the new type's default (their rule, literally),
 * each ticked at first; Transfer selected changes keeps the ticked ones, Discard all changes sets every one to the
 * new default, and Cancel, Esc or the dialog's own cancel change nothing. A click on the backdrop does nothing.
 * Focus starts on Transfer, stays in the window, and returns to the tile clicked.
 */
export function SwitchDialog() {
  const store = useStore();
  const plan = store.switching.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const transfer = useRef<HTMLButtonElement>(null);
  const all = useRef<HTMLInputElement>(null);
  // The ticks belong to the plan they were made on: a new question starts with every row ticked.
  const [ticks, setTicks] = useState<{ plan: SwitchPlan | null; set: ReadonlySet<ParamPath> }>({ plan: null, set: new Set() });
  const ticked = ticks.plan === plan ? ticks.set : new Set(plan?.rows.map((row) => row.path) ?? []);
  const setTicked = (set: ReadonlySet<ParamPath>): void => setTicks({ plan, set });
  const shownFor = useRef<SwitchPlan | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (plan && shownFor.current !== plan) {
      shownFor.current = plan;
      if (!element.open) element.showModal();
      transfer.current?.focus();
    } else if (!plan && element.open) {
      const to = shownFor.current?.to;
      shownFor.current = null;
      element.close();
      // Back to the tile clicked, whatever the answer.
      if (to) document.querySelector<HTMLButtonElement>(`.mold-tile[data-type="${to}"]`)?.focus();
    }
  }, [plan]);

  // The header box: ticked for all, clear for none, and between for some.
  const free = plan?.rows.filter((row) => !row.locked) ?? [];
  const some = free.filter((row) => ticked.has(row.path)).length;
  useEffect(() => {
    if (all.current) all.current.indeterminate = some > 0 && some < free.length;
  });

  const name = plan ? store.moldTypeName(plan.to) : '';
  const from = plan ? store.moldTypeName(plan.from) : '';
  // MP5: the vents removed by hand go with the switch, which the lead says.
  const back = plan ? store.removedBack(plan.to) : null;
  const toggle = (path: ParamPath, on: boolean): void => {
    const next = new Set(ticked);
    if (on) next.add(path);
    else next.delete(path);
    setTicked(next);
  };
  const setAll = (on: boolean): void => setTicked(new Set(plan!.rows.filter((row) => on || row.locked).map((row) => row.path)));

  // Tab and Shift+Tab go round the window's own controls, and never out of it to the browser's.
  const trap = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
    if (controls.length === 0) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialog}
      class="switch-dialog"
      data-testid="switch-dialog"
      aria-labelledby="switch-title"
      aria-describedby="switch-lead"
      onKeyDown={trap}
      // Esc: the window decides, so it closes only through the store, which records nothing.
      onCancel={(event) => {
        event.preventDefault();
        store.answerSwitch('cancel');
      }}
      // Closed by the browser itself, as Chromium does on a second Esc: the question goes with it.
      onClose={() => {
        if (store.switching.value) store.answerSwitch('cancel');
      }}
    >
      {plan ? (
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <h2 id="switch-title">Switching to {name}</h2>
          <p id="switch-lead" class="lead">
            These settings were changed by you and differ from the {name} defaults. Ticked settings keep your value.
            {back ? ` ${back}` : null}
          </p>
          <div class="switch-table-wrap">
            <table class="switch-table">
              <thead>
                <tr>
                  <th scope="col" class="tick">
                    <input
                      ref={all}
                      type="checkbox"
                      data-testid="switch-all"
                      aria-label="Keep your value in every setting"
                      checked={free.length > 0 && some === free.length}
                      disabled={free.length === 0}
                      onChange={(event) => setAll(event.currentTarget.checked)}
                    />
                  </th>
                  <th scope="col">Setting</th>
                  <th scope="col">Your value</th>
                  <th scope="col">New default</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <Row key={row.path} row={row} from={from} ticked={ticked.has(row.path)} onToggle={(on) => toggle(row.path, on)} />
                ))}
              </tbody>
            </table>
          </div>
          <div class="switch-buttons">
            <button type="button" class="btn" data-testid="switch-discard" onClick={() => store.answerSwitch('discard')}>
              Discard all changes
            </button>
            <button type="button" class="btn primary" data-testid="switch-transfer" ref={transfer} onClick={() => store.answerSwitch('transfer', [...ticked])}>
              Transfer selected changes
            </button>
            <button type="button" class="btn" data-testid="switch-cancel" onClick={() => store.answerSwitch('cancel')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/** The decimals a slider row's box shows (SliderRow), so a value reads the same in the window as in its row. */
const ROW_DIGITS = 3;

/**
 * One setting: its box, named with its label and described by the old default, its group and label, your value and
 * the new default, the old in its title too. A locked row's new value is the one the type holds, as the sidebar shows it.
 */
function Row({ row, from, ticked, onToggle }: { row: SwitchRow; from: string; ticked: boolean; onToggle: (on: boolean) => void }) {
  const def = defOf(row.path);
  const group = GROUP_TITLES[row.path.split('.')[0]];
  const id = `switch-${row.path.replace('.', '-')}`;
  const old = `The ${from} default is ${defaultText(def, row.oldDefault, ROW_DIGITS)}.`;
  const shown = row.locked ? `${defaultText(def, row.holds, ROW_DIGITS)} (held by this type)` : defaultText(def, row.newDefault, ROW_DIGITS);
  return (
    <tr data-param={row.path} data-locked={row.locked ? '' : undefined} title={old}>
      <td class="tick">
        <input id={id} type="checkbox" aria-label={def.label} aria-describedby={`${id}-old`} checked={ticked || row.locked !== null} disabled={row.locked !== null} onChange={(event) => onToggle(event.currentTarget.checked)} />
      </td>
      <td>
        <label for={id}>
          <span class="group">{group} ›</span> {def.label}
        </label>
        <span class="visually-hidden" id={`${id}-old`}>
          {old}
        </span>
        {row.sameInBoth ? <span class="tag">same default in both</span> : null}
        {row.locked ? (
          <span class="locked" data-testid="switch-locked">
            {row.locked}
          </span>
        ) : null}
      </td>
      <td data-testid="switch-yours">{defaultText(def, row.yours, ROW_DIGITS)}</td>
      <td data-testid="switch-default">{shown}</td>
    </tr>
  );
}
