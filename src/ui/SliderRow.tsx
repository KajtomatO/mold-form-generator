import { useEffect, useRef, useState } from 'preact/hooks';
import type { ShownDiagnostic } from '../app/pipeline';
import type { AutoDef, NumberDef } from '../core/params/schema';
import { formatNumber, units } from './format';
import { parseEntry } from './layout';

export interface SliderRowProps {
  /** Becomes data-param and the ids, so tests and labels can find the row. */
  name: string;
  label: string;
  unit?: string;
  def: NumberDef | AutoDef;
  /** The parameter's own value; null for an auto one that follows its rule. */
  value: number | null;
  /** What the rule gives while it is followed, or null before a model is loaded. */
  auto: number | null;
  range: [number, number];
  step: number;
  hint?: string;
  problems?: ShownDiagnostic[];
  onChange: (value: number | null) => void;
  /** The slider pressed (true) and let go (false), so a drag of any length, pauses and all, is one step. */
  onHold?: (held: boolean) => void;
}

/** Rounds a stepped value to the step's own decimals, so 0.1 steps never show 3.0000000004. */
export function stepped(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(decimals));
}

function clamp(value: number, def: NumberDef | AutoDef): number {
  return Math.min(def.max ?? Infinity, Math.max(def.min ?? 0, value));
}

/**
 * One numeric parameter: label with its unit, slider, and a number box that takes typing. Double-click
 * on the label or slider resets to the default, which for an auto parameter means following its rule
 * again. The wheel steps the slider or the box once it has focus: Shift ten steps, Ctrl a tenth of one.
 */
export function SliderRow(props: SliderRowProps) {
  const { name, label, unit, def, value, auto, range, step, hint, problems = [], onChange, onHold } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const shown = value ?? auto;
  // The wheel listener lives outside Preact so it can be non-passive; these keep it on the latest props.
  const latest = useRef({ shown, step, def, onChange });
  latest.current = { shown, step, def, onChange };

  useEffect(() => {
    const element = row.current!;
    const wheel = (event: WheelEvent): void => {
      const { shown: current, step: base, def: d, onChange: change } = latest.current;
      // Only a control the user has picked takes the wheel. Otherwise every row scrolling past the
      // pointer would step its value and stop the sidebar scrolling.
      const target = event.target as HTMLElement;
      if (current === null || target.tagName !== 'INPUT' || target !== document.activeElement) return;
      // Ctrl and the wheel would zoom the page, and a Shift-wheel scroll it sideways, so the control takes both.
      event.preventDefault();
      const delta = event.deltaY || event.deltaX;
      if (delta === 0) return;
      const size = event.shiftKey ? base * 10 : event.ctrlKey || event.metaKey ? base / 10 : base;
      const next = clamp(stepped(current + (delta < 0 ? size : -size), size), d);
      setDraft(null);
      setError(null);
      change(d.kind === 'number' && d.integer ? Math.round(next) : next);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const reset = (): void => {
    setDraft(null);
    setError(null);
    onChange(def.default);
  };

  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseEntry(draft, def);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setDraft(null);
    setError(null);
    if (parsed.value !== shown || value === null) onChange(parsed.value);
  };

  const id = `p-${name.replace('.', '-')}`;
  const following = def.kind === 'auto' && value === null;
  const slider = shown === null ? range[0] : Math.min(range[1], Math.max(range[0], shown));
  return (
    <div class="row" data-param={name} title={hint} ref={row}>
      <label for={id} onDblClick={reset}>
        {label}
        {unit ? <span class="unit">{units(unit)}</span> : null}
        {def.kind === 'auto' ? <span class="tag">{following ? 'auto' : 'set'}</span> : null}
      </label>
      <input
        type="range"
        aria-label={label}
        min={range[0]}
        max={range[1]}
        step={step}
        value={slider}
        disabled={shown === null}
        onPointerDown={() => {
          if (!onHold) return;
          onHold(true);
          // The release can land anywhere on the page once the thumb is dragged off the track.
          const release = (): void => {
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', release);
            onHold(false);
          };
          window.addEventListener('pointerup', release);
          window.addEventListener('pointercancel', release);
        }}
        onInput={(event) => {
          setDraft(null);
          setError(null);
          onChange(Number(event.currentTarget.value));
        }}
        onDblClick={reset}
      />
      <input
        id={id}
        class={`num${following ? ' auto' : ''}${error ? ' invalid' : ''}`}
        type="text"
        inputMode="decimal"
        autocomplete="off"
        spellcheck={false}
        // With nothing typed and not yet committed, the box shows the project's value, and Ctrl+Z is the app's.
        data-undo={draft === null ? 'app' : undefined}
        placeholder={shown === null ? 'auto' : undefined}
        value={draft ?? (shown === null ? '' : formatNumber(shown, 3))}
        aria-invalid={error ? true : undefined}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setDraft(null);
            setError(null);
          }
        }}
        onBlur={commit}
      />
      {error ? <p class="note error">{error}</p> : null}
      {problems.map((problem) => (
        <p key={problem.code} class={`note ${problem.severity}`} data-code={problem.code}>
          {units(problem.message)}
        </p>
      ))}
    </div>
  );
}
