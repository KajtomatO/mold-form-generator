import { DEFAULT_MOLD_TYPE, lockOf, MOLD_TYPES, moldTypeOf, NOT_BUILT_YET, type MoldTypeId, type TypeContext } from '../core/mold/types';
import { defaultOf, isDefaultIn } from '../core/params/defaults';
import type { Params } from '../core/params/schema';
import { PARAM_PATHS, paramValue, setParamValue, type ParamPath } from './stages';

/**
 * MT: what switching the mold type does to the settings (docs/PLAN.md, MT; R44, D27), pure, so the window, the
 * store and the tests share it. The user's rule, literally (their answer of 2026-11-22): the window lists every
 * setting they changed whose value differs from the new type's default.
 */

/** One row of the switch window. */
export interface SwitchRow {
  path: ParamPath;
  /** The user's value, which Transfer keeps. */
  yours: unknown;
  /** The new type's default, which Discard sets and an unticked row takes. */
  newDefault: unknown;
  /** The type left's default, which the row's title gives. */
  oldDefault: unknown;
  /** Whether the default is the same in both types, which the row says; never for a locked row, which shows what the type holds. */
  sameInBoth: boolean;
  /** The new type's lock on it, with its reason, or null: the value is kept, but the type holds it at the lock's. */
  locked: string | null;
  /** The value the new type holds a locked setting at, which the row gives as its new value, as the sidebar will show it; undefined when not locked. */
  holds: unknown;
}

export interface SwitchPlan {
  from: MoldTypeId;
  to: MoldTypeId;
  /** The settings before the switch, from which applySwitch works. */
  params: Params;
  rows: SwitchRow[];
}

/**
 * A setting is a row when it is not `mold.type`, applies to the new type, is changed from its default under the old
 * type (an automatic one when it differs from that type's default, null or the type's number), and its value
 * differs from the new type's default. A setting the new type locks is a row only when its value differs from the
 * lock's too: one already at it shows the same in the sidebar whatever the answer. No rows: the switch is made at
 * once, with no window.
 */
export function planSwitch(params: Params, to: MoldTypeId): SwitchPlan {
  const from = moldTypeOf(params).id as MoldTypeId;
  const target = MOLD_TYPES[to];
  const rows: SwitchRow[] = [];
  for (const path of PARAM_PATHS) {
    if (path === 'mold.type' || !target.applies(path)) continue;
    const yours = paramValue(params, path);
    if (isDefaultIn(path, yours, from) || isDefaultIn(path, yours, to)) continue;
    const oldDefault = defaultOf(path, from), newDefault = defaultOf(path, to);
    const lock = target.locked.find((l) => l.path === path);
    if (lock && yours === lock.value) continue;
    rows.push({ path, yours, newDefault, oldDefault, sameInBoth: !lock && oldDefault === newDefault, locked: lock ? lock.reason : null, holds: lock ? lock.value : undefined });
  }
  return { from, to, params, rows };
}

/**
 * The settings after the switch: the type set; a setting not changed takes the new default; a changed one already
 * equal to the new default is kept, now at its default; one that does not apply keeps its value, hidden; and each
 * row keeps the user's value when `keep` holds it, or takes the new default. Discard passes none; Transfer the ticked.
 */
export function applySwitch(plan: SwitchPlan, keep: ReadonlySet<ParamPath> | readonly ParamPath[]): Params {
  const kept = new Set(keep);
  const listed = new Set(plan.rows.map((row) => row.path));
  const target = MOLD_TYPES[plan.to];
  const next = structuredClone(plan.params);
  for (const path of PARAM_PATHS) {
    if (path === 'mold.type' || !target.applies(path)) continue;
    const yours = paramValue(plan.params, path);
    if (listed.has(path)) {
      if (!kept.has(path)) setParamValue(next, path, defaultOf(path, plan.to));
      continue;
    }
    if (isDefaultIn(path, yours, plan.from)) setParamValue(next, path, defaultOf(path, plan.to));
  }
  setParamValue(next, 'mold.type', plan.to);
  return next;
}

/** The notice of a project opened as the default type, as its own is not available here: what happened, and why. */
export function unavailableNotice(type: string, reason: string, opened: string): string {
  const rest = `It opened as a ${opened}, with every other setting as saved.`;
  if (reason === NOT_BUILT_YET) return `This project is a ${type}, which this version does not build yet. ${rest}`;
  return `This project is a ${type}, which cannot be used for this model, because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. ${rest}`;
}

/**
 * A project's settings as they open here (MT): its own type, with no window, when it can be chosen for this model, or
 * else the default type, every other value kept as the file has them, with the reason the type is unavailable.
 */
export function typeOnOpen(params: Params, ctx: TypeContext): { params: Params; unavailable: { type: MoldTypeId; reason: string } | null } {
  const type = moldTypeOf(params);
  const reason = type.unavailable(ctx);
  if (reason === null) return { params, unavailable: null };
  const next = structuredClone(params);
  setParamValue(next, 'mold.type', DEFAULT_MOLD_TYPE);
  return { params: next, unavailable: { type: type.id as MoldTypeId, reason } };
}

/** Whether a setting is held by the type `params` are for, with the lock's reason: what a locked row shows. */
export function lockedReason(path: ParamPath, params: Params): string | null {
  return lockOf(path, params)?.reason ?? null;
}
