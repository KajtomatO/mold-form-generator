import { autoValue } from '../app/derived';
import { paramValue, type ParamPath } from '../app/stages';
import { DEFAULT_MOLD_TYPE, lockOf, moldTypeOf, type MoldTypeId } from '../core/mold/types';
import { defaultOf, isDefaultAt } from '../core/params/defaults';
import type { AutoDef, ChoiceDef, FlagDef } from '../core/params/schema';
import { useProblems, useStore } from './context';
import { units } from './format';
import { defOf, entryDef, hintOf, OPTION_LABELS, sliderRange, stepOf } from './layout';
import { ResetMark, type DefaultAt } from './ResetMark';
import { SliderRow } from './SliderRow';

/**
 * What every row kind takes besides its own: whether it is off its default (CS), the reset, the default in the type
 * on screen (MT), and why that type holds the setting, which turns the row off and is said under it (MT).
 */
interface Marked {
  changed: boolean;
  onReset: () => void;
  at: DefaultAt;
  locked: string | null;
}

/**
 * The one control of one schema parameter, of the kind its definition says, with its mark (CS). MT: a setting the
 * mold type holds shows the type's value, off, with the reason, and no mark: the user's own value stays in the
 * project for switching back, and a Reset leaves it.
 */
export function ParamRow({ path }: { path: ParamPath }) {
  const store = useStore();
  const def = defOf(path);
  const problems = useProblems(path);
  const params = store.project.value.params;
  const lock = lockOf(path, params);
  const value = lock ? lock.value : paramValue(params, path);
  const type = moldTypeOf(params).id as MoldTypeId;
  // MT: the type's own hint where its default changes what the row does.
  const hint = hintOf(path, type);
  const set = (next: unknown): void => store.setParam(path, next);
  const at: DefaultAt = { value: defaultOf(path, type), type: type === DEFAULT_MOLD_TYPE ? null : store.moldTypeName(type) };
  const marked: Marked = { changed: !lock && !isDefaultAt(path, params), onReset: () => store.resetParam(path), at, locked: lock?.reason ?? null };

  if (def.kind === 'flag') return <FlagRow path={path} def={def} value={value as boolean} hint={hint} problems={problems} onChange={set} {...marked} />;
  if (def.kind === 'choice') {
    // Merged mode needs a closed solid, which an open mesh in soup mode does not have.
    const off = path === 'base.mode' && store.pipeline.modelClosed() === false ? { merged: 'Merged mode needs a closed solid, and this mesh has holes.' } : {};
    return <ChoiceRow path={path} def={def} value={value as string} hint={hint} problems={problems} off={off} onChange={set} {...marked} />;
  }
  if (def.kind === 'auto' && def.options) return <ListRow path={path} def={def} value={value as number | null} auto={autoValue(path, store.pipeline)} hint={hint} problems={problems} onChange={set} {...marked} />;
  return (
    <SliderRow
      name={path}
      label={def.label}
      unit={def.unit}
      def={entryDef(path) as typeof def}
      value={value as number | null}
      auto={def.kind === 'auto' ? autoValue(path, store.pipeline) : null}
      range={sliderRange(path, def)}
      step={stepOf(path, def)}
      hint={hint}
      problems={problems}
      onChange={set}
      onHold={(held) => store.holdParam(held ? path : null)}
      changed={marked.changed}
      onReset={marked.onReset}
      defaultAt={at}
      locked={marked.locked}
    />
  );
}

/** A checkbox, with its mark in the column of the sliders' marks. */
function FlagRow({ path, def, value, hint, problems, onChange, changed, onReset, at, locked }: { path: ParamPath; def: FlagDef; value: boolean; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: boolean) => void } & Marked) {
  const id = `p-${path.replace('.', '-')}`;
  return (
    <div class="row flag" data-param={path} data-changed={changed ? '' : undefined} data-locked={locked ? '' : undefined} title={locked ?? hint}>
      <label for={id} onDblClick={locked ? undefined : onReset}>
        {def.label}
      </label>
      <input id={id} type="checkbox" checked={value} disabled={locked !== null} onChange={(event) => onChange(event.currentTarget.checked)} />
      <Mark def={def} changed={changed} onReset={onReset} at={at} locked={locked} />
      <LockedReason locked={locked} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

/**
 * `off` names the options that cannot be chosen now, with why, which the button's tooltip says. The options
 * keep the room of the slider and the box, and the mark sits right after them, as a column of its own would
 * put "Merged (B)" on two lines (D22).
 */
function ChoiceRow({ path, def, value, hint, problems, off, onChange, changed, onReset, at, locked }: { path: ParamPath; def: ChoiceDef; value: string; hint?: string; problems: ReturnType<typeof useProblems>; off: Partial<Record<string, string>>; onChange: (v: string) => void } & Marked) {
  return (
    <div class="row" data-param={path} data-changed={changed ? '' : undefined} data-locked={locked ? '' : undefined} title={locked ?? hint}>
      <span class="label" onDblClick={locked ? undefined : onReset}>
        {def.label}
      </span>
      <div class="segmented wide" role="group" aria-label={def.label}>
        {def.options.map((option) => (
          // One chosen before it went off, as from a project file, stays pressable, so it can be chosen away.
          // The default's own option is marked, so a reset leaves focus on it, the one pressed once it is done (rowControl).
          <button key={option} type="button" aria-pressed={option === value} data-default={option === at.value ? '' : undefined} disabled={locked !== null || (off[option] !== undefined && option !== value)} title={off[option]} onClick={() => onChange(option)}>
            {OPTION_LABELS[option] ?? option}
          </button>
        ))}
      </div>
      <Mark def={def} changed={changed} onReset={onReset} at={at} locked={locked} />
      <LockedReason locked={locked} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

/** An auto setting that takes only listed values, such as screw lengths: auto, or one of the list, with its mark after the list. */
function ListRow({ path, def, value, auto, hint, problems, onChange, changed, onReset, at, locked }: { path: ParamPath; def: AutoDef; value: number | null; auto: number | null; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: number | null) => void } & Marked) {
  const id = `p-${path.replace('.', '-')}`;
  const unit = def.unit ? ` ${def.unit}` : '';
  // A project file can only hold a listed value, but one written by hand is shown as it is rather than lost.
  const options = value !== null && !def.options!.includes(value) ? [...def.options!, value] : def.options!;
  return (
    <div class="row" data-param={path} data-changed={changed ? '' : undefined} data-locked={locked ? '' : undefined} title={locked ?? hint}>
      <label for={id} onDblClick={locked ? undefined : onReset}>
        {def.label}
        {def.unit ? <span class="unit">{units(def.unit)}</span> : null}
        <span class="tag">{value === null ? 'auto' : 'set'}</span>
      </label>
      <select id={id} class="wide list" disabled={locked !== null} value={value === null ? 'auto' : String(value)} onChange={(event) => onChange(event.currentTarget.value === 'auto' ? null : Number(event.currentTarget.value))}>
        <option value="auto">{auto === null ? 'Auto' : `Auto, ${auto}${unit}`}</option>
        {options.map((option) => (
          <option key={option} value={String(option)}>
            {option}
            {unit}
          </option>
        ))}
      </select>
      <Mark def={def} changed={changed} onReset={onReset} at={at} locked={locked} />
      <LockedReason locked={locked} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

/** The row's mark, or in its place a blank of the same room while the type holds the setting (MT). */
function Mark({ def, changed, onReset, at, locked }: { def: FlagDef | ChoiceDef | AutoDef } & Marked) {
  return locked ? <span class="mark" aria-hidden="true" /> : <ResetMark def={def} changed={changed} onReset={onReset} at={at} />;
}

/** MT: why the type holds this setting, under the row, as its title says it too. */
function LockedReason({ locked }: { locked: string | null }) {
  return locked ? (
    <p class="note locked" data-testid="locked-reason">
      {locked}
    </p>
  ) : null;
}
