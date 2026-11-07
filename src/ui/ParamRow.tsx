import { autoValue } from '../app/derived';
import { paramValue, type ParamPath } from '../app/stages';
import type { ChoiceDef, FlagDef } from '../core/params/schema';
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
  if (def.kind === 'choice') return <ChoiceRow path={path} def={def} value={value as string} hint={hint} onChange={set} />;
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

function ChoiceRow({ path, def, value, hint, onChange }: { path: ParamPath; def: ChoiceDef; value: string; hint?: string; onChange: (v: string) => void }) {
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
    </div>
  );
}
