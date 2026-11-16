import type { ParamDef } from '../core/params/schema';
import { formatNumber, units } from './format';
import { ResetArrow } from './icons';
import { OPTION_LABELS } from './layout';

/** A setting's default as its mark's tooltip says it: "3 mm", "on", "Glue in (A)", or "automatic". */
export function defaultText(def: ParamDef): string {
  if (def.kind === 'auto') return 'automatic';
  if (def.kind === 'flag') return def.default ? 'on' : 'off';
  if (def.kind === 'choice') return OPTION_LABELS[def.default] ?? def.default;
  return `${formatNumber(def.default, 4)}${def.unit ? ` ${units(def.unit)}` : ''}`;
}

/**
 * The control a keyboard user is left on once a mark or a section's Reset has gone: the row's slider if it can
 * move, else its number box, its checkbox, its default's option, which is the one pressed once the reset is
 * done (not the one pressed before it), or its list, whichever comes first in the row.
 */
export function rowControl(row: Element | null): HTMLElement | null {
  return row?.querySelector<HTMLElement>('input[type="range"]:not(:disabled), input.num, input[type="checkbox"], .segmented button[data-default], select') ?? null;
}

/**
 * CS: whether a setting holds its default, after PrusaSlicer, as the user asked on 2026-11-09 (R40, D22). At
 * its default, a grey dot, which is no button and takes no focus. Changed, a curved arrow that sets it back,
 * as a double-click on the row's name or slider does. Its name never holds the default, so a search for a
 * row's options by name, such as M3 in Bolt size, finds the option alone. The arrow goes once the setting is
 * back, so focus moves to the row's control first, and a keyboard user stays where they were.
 */
export function ResetMark({ def, changed, onReset, control }: { def: ParamDef; changed: boolean; onReset: () => void; control?: (row: Element | null) => HTMLElement | null }) {
  const auto = def.kind === 'auto';
  if (!changed) return <span class="mark dot" aria-hidden="true" title={auto ? 'At its default: automatic.' : `At its default, ${defaultText(def)}.`} />;
  return (
    <button
      type="button"
      class="mark reset"
      aria-label={`Reset ${def.label}`}
      title={auto ? 'Set by you; its default is automatic. Click to make it automatic again.' : `Changed from its default, ${defaultText(def)}. Click to reset it.`}
      onClick={(event) => {
        const row = event.currentTarget.closest('.row');
        const target = (control ?? rowControl)(row);
        onReset();
        target?.focus({ preventScroll: true });
      }}
    >
      <ResetArrow />
    </button>
  );
}
