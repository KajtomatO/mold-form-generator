import { autoValue } from '../app/derived';
import { paramValue, type ParamPath } from '../app/stages';
import { isDefault } from '../core/params/defaults';
import type { AutoDef, ChoiceDef, FlagDef } from '../core/params/schema';
import { useProblems, useStore } from './context';
import { units } from './format';
import { defOf, entryDef, HINTS, OPTION_LABELS, sliderRange, stepOf } from './layout';
import { ResetMark } from './ResetMark';
import { SliderRow } from './SliderRow';

/** What every row kind takes besides its own: whether it is off its default (CS), and the reset. */
interface Marked {
  changed: boolean;
  onReset: () => void;
}

/** The one control of one schema parameter, of the kind its definition says, with its mark (CS). */
export function ParamRow({ path }: { path: ParamPath }) {
  const store = useStore();
  const def = defOf(path);
  const problems = useProblems(path);
  const value = paramValue(store.project.value.params, path);
  const hint = HINTS[path];
  const set = (next: unknown): void => store.setParam(path, next);
  const marked: Marked = { changed: !isDefault(def, value), onReset: () => store.resetParam(path) };

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
      {...marked}
    />
  );
}

/** A checkbox, with its mark in the column of the sliders' marks. */
function FlagRow({ path, def, value, hint, problems, onChange, changed, onReset }: { path: ParamPath; def: FlagDef; value: boolean; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: boolean) => void } & Marked) {
  const id = `p-${path.replace('.', '-')}`;
  return (
    <div class="row flag" data-param={path} data-changed={changed ? '' : undefined} title={hint}>
      <label for={id} onDblClick={onReset}>
        {def.label}
      </label>
      <input id={id} type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} />
      <ResetMark def={def} changed={changed} onReset={onReset} />
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
function ChoiceRow({ path, def, value, hint, problems, off, onChange, changed, onReset }: { path: ParamPath; def: ChoiceDef; value: string; hint?: string; problems: ReturnType<typeof useProblems>; off: Partial<Record<string, string>>; onChange: (v: string) => void } & Marked) {
  return (
    <div class="row" data-param={path} data-changed={changed ? '' : undefined} title={hint}>
      <span class="label" onDblClick={onReset}>
        {def.label}
      </span>
      <div class="segmented wide" role="group" aria-label={def.label}>
        {def.options.map((option) => (
          // One chosen before it went off, as from a project file, stays pressable, so it can be chosen away.
          // The default's own option is marked, so a reset leaves focus on it, the one pressed once it is done (rowControl).
          <button key={option} type="button" aria-pressed={option === value} data-default={option === def.default ? '' : undefined} disabled={off[option] !== undefined && option !== value} title={off[option]} onClick={() => onChange(option)}>
            {OPTION_LABELS[option] ?? option}
          </button>
        ))}
      </div>
      <ResetMark def={def} changed={changed} onReset={onReset} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

/** An auto setting that takes only listed values, such as screw lengths: auto, or one of the list, with its mark after the list. */
function ListRow({ path, def, value, auto, hint, problems, onChange, changed, onReset }: { path: ParamPath; def: AutoDef; value: number | null; auto: number | null; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: number | null) => void } & Marked) {
  const id = `p-${path.replace('.', '-')}`;
  const unit = def.unit ? ` ${def.unit}` : '';
  // A project file can only hold a listed value, but one written by hand is shown as it is rather than lost.
  const options = value !== null && !def.options!.includes(value) ? [...def.options!, value] : def.options!;
  return (
    <div class="row" data-param={path} data-changed={changed ? '' : undefined} title={hint}>
      <label for={id} onDblClick={onReset}>
        {def.label}
        {def.unit ? <span class="unit">{units(def.unit)}</span> : null}
        <span class="tag">{value === null ? 'auto' : 'set'}</span>
      </label>
      <select id={id} class="wide list" value={value === null ? 'auto' : String(value)} onChange={(event) => onChange(event.currentTarget.value === 'auto' ? null : Number(event.currentTarget.value))}>
        <option value="auto">{auto === null ? 'Auto' : `Auto, ${auto}${unit}`}</option>
        {options.map((option) => (
          <option key={option} value={String(option)}>
            {option}
            {unit}
          </option>
        ))}
      </select>
      <ResetMark def={def} changed={changed} onReset={onReset} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}
