import { autoValue } from '../app/derived';
import { paramValue, type ParamPath } from '../app/stages';
import type { AutoDef, ChoiceDef, FlagDef } from '../core/params/schema';
import { useProblems, useStore } from './context';
import { units } from './format';
import { defOf, entryDef, HINTS, OPTION_LABELS, sliderRange, stepOf } from './layout';
import { SliderRow } from './SliderRow';

/** The one control of one schema parameter, of the kind its definition says. */
export function ParamRow({ path }: { path: ParamPath }) {
  const store = useStore();
  const def = defOf(path);
  const problems = useProblems(path);
  const value = paramValue(store.project.value.params, path);
  const hint = HINTS[path];
  const set = (next: unknown): void => store.setParam(path, next);

  if (def.kind === 'flag') return <FlagRow path={path} def={def} value={value as boolean} hint={hint} problems={problems} onChange={set} />;
  if (def.kind === 'choice') return <ChoiceRow path={path} def={def} value={value as string} hint={hint} problems={problems} onChange={set} />;
  if (def.kind === 'auto' && def.options) return <ListRow path={path} def={def} value={value as number | null} auto={autoValue(path, store.pipeline)} hint={hint} problems={problems} onChange={set} />;
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
    />
  );
}

function FlagRow({ path, def, value, hint, problems, onChange }: { path: ParamPath; def: FlagDef; value: boolean; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: boolean) => void }) {
  const id = `p-${path.replace('.', '-')}`;
  return (
    <div class="row flag" data-param={path} title={hint}>
      <label for={id} onDblClick={() => onChange(def.default)}>
        {def.label}
      </label>
      <input id={id} type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} />
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

function ChoiceRow({ path, def, value, hint, problems, onChange }: { path: ParamPath; def: ChoiceDef; value: string; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: string) => void }) {
  return (
    <div class="row" data-param={path} title={hint}>
      <span class="label" onDblClick={() => onChange(def.default)}>
        {def.label}
      </span>
      <div class="segmented wide" role="group" aria-label={def.label}>
        {def.options.map((option) => (
          <button key={option} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>
            {OPTION_LABELS[option] ?? option}
          </button>
        ))}
      </div>
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}

/** An auto setting that takes only listed values, such as screw lengths: auto, or one of the list. */
function ListRow({ path, def, value, auto, hint, problems, onChange }: { path: ParamPath; def: AutoDef; value: number | null; auto: number | null; hint?: string; problems: ReturnType<typeof useProblems>; onChange: (v: number | null) => void }) {
  const id = `p-${path.replace('.', '-')}`;
  const unit = def.unit ? ` ${def.unit}` : '';
  // A project file can only hold a listed value, but one written by hand is shown as it is rather than lost.
  const options = value !== null && !def.options!.includes(value) ? [...def.options!, value] : def.options!;
  return (
    <div class="row" data-param={path} title={hint}>
      <label for={id} onDblClick={() => onChange(null)}>
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
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}
