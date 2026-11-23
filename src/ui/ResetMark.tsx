import type { ParamDef } from '../core/params/schema';
import { formatNumber, units } from './format';
import { ResetArrow } from './icons';
import { OPTION_LABELS } from './layout';

/**
 * A setting's value as its mark's tooltip and the switch window say it: "3 mm", "on", "Glue in (A)", or "automatic"
 * for an automatic one's null. Without a value, its default in defaults.json.
 */
export function defaultText(def: ParamDef, value: unknown = def.default, digits = 4): string {
  if (value === null) return 'automatic';
  if (def.kind === 'flag') return value ? 'on' : 'off';
  if (def.kind === 'choice') return OPTION_LABELS[value as string] ?? String(value);
  return `${formatNumber(value as number, digits)}${'unit' in def && def.unit ? ` ${units(def.unit)}` : ''}`;
}

/**
 * MT: the default a mark reads, in the type on screen: its value, and the type's name where it is not the one-piece
 * cover, whose marks keep their words ("Changed from its Two-part cover default, 0 mm.").
 */
export interface DefaultAt {
  value: unknown;
  type: string | null;
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
export function ResetMark({ def, changed, onReset, control, at }: { def: ParamDef; changed: boolean; onReset: () => void; control?: (row: Element | null) => HTMLElement | null; at?: DefaultAt }) {
  const value = at ? at.value : def.default;
  const its = at?.type ? `its ${at.type} default` : 'its default';
  const auto = value === null;
  if (!changed) return <span class="mark dot" aria-hidden="true" title={auto ? `At ${its}: automatic.` : `At ${its}, ${defaultText(def, value)}.`} />;
  return (
    <button
      type="button"
      class="mark reset"
      aria-label={`Reset ${def.label}`}
      title={auto ? `Set by you; ${its} is automatic. Click to make it automatic again.` : `Changed from ${its}, ${defaultText(def, value)}. Click to reset it.`}
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
