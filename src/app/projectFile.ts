import type { OpeningPin } from '../core/analysis/placement';
import { PARAM_SCHEMA, SCHEMA_VERSION, type ParamDef, type Params } from '../core/params/schema';
import { DEFAULT_PLANE, type PlaneChoice } from '../workers/fieldStages';
import { entryDef } from '../ui/layout';
import type { ProjectFile, StoredPlane } from './project';
import type { ParamPath } from './stages';

/**
 * Reading project.json: migrating an older version one step at a time, then checking every field.
 * Nothing here trusts the file. A wrong type is refused with the reason, as no value can be guessed from
 * it; an unknown setting is left out, a missing one takes its default and one out of range is brought
 * into it, each with a note, as the rest of the project is still worth having.
 */

/**
 * A project file the app cannot use: the reason in a maker's words, naming the file and what to do next,
 * and `details` with the field or the reader's own words, for whoever wants them. Shown inline, never
 * thrown at the user.
 */
export class ProjectError extends Error {
  constructor(
    message: string,
    readonly details: string | null = null,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** What to do with a file that is damaged or cannot be used. */
export const OPEN_AGAIN = 'Open an earlier copy, or open the STL and set it up again.';
/** What to open instead of a file that is no project at all. */
export const OPEN_INSTEAD = 'Open a .moldproj that Save project made, the ZIP that Export ZIP made, or an STL.';

type Json = Record<string, unknown>;

/** What reading a file changed or could not check: info for what is only so, a warning where the project differs from the file. */
export interface ProjectNote {
  severity: 'info' | 'warning';
  message: string;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One version to the next. It may add notes for what the older file could not say. */
export type Migration = (file: Json, notes: ProjectNote[]) => Json;

/** Version 1, M6b's export ZIP, recorded neither the STL's hash nor the plane itself, so both are unknown. */
const v1ToV2: Migration = (file) => ({ ...file, modelSha256: null, basePlane: null });

/**
 * Version 2 had no bolts, so its molds were taped: the bolts come in off, at the values version 3 started
 * with, written out here so a later change of the defaults never changes what an old file opens to.
 */
const v2ToV3: Migration = (file) => {
  const params = isObject(file.params) ? file.params : {};
  return { ...file, params: { ...params, bolts: { enabled: false, size: 'M3', length: null, holeClearance: 0.2, nutClearance: 0.15, minWall: 1.2 } } };
};

/**
 * Version 4 holds the same fields as 3. What it adds is a promise: its pins and removed vents number bodies
 * as joined parts. Whether a version 3 file kept that rule depends on the build that wrote it, which the
 * pipeline checks once the model's import has said whether it joins parts (bodiesByPart in version.ts).
 */
const v3ToV4: Migration = (file) => file;

/** Each older version's step to the one after it. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = { 1: v1ToV2, 2: v2ToV3, 3: v3ToV4 };

export interface Migrated {
  file: Json;
  /** The version the file was written in. */
  from: number;
  notes: ProjectNote[];
}

/**
 * Brings a parsed project.json up to `current`, one step per version, so each step only knows its own
 * change. `name` is the file the maker opened, which every reason names.
 */
export function migrate(raw: unknown, steps: Readonly<Record<number, Migration>> = MIGRATIONS, current = SCHEMA_VERSION, name = PROJECT_JSON): Migrated {
  if (!isObject(raw)) throw new ProjectError(`${name} holds no settings this app can read. ${OPEN_AGAIN}`, 'project.json is not a JSON object.');
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new ProjectError(`${name} does not say which project format it is in, so there is no telling how to read it. ${OPEN_AGAIN}`, 'project.json has no valid schemaVersion.');
  if (version > current) {
    const by = typeof raw.appVersion === 'string' ? ` (app version ${raw.appVersion})` : '';
    // A web page cannot be updated by its visitor, so the maker is told where the newer version is: a new
    // format reaches the beta site first, whose versions carry -beta+.
    const where = typeof raw.appVersion === 'string' && raw.appVersion.includes('-beta+') ? 'Open it on the beta site that saved it, at the app\'s web address with beta/ at the end.' : 'Open it in the version of the app that saved it.';
    throw new ProjectError(`${name} was saved by a newer version of the app${by}, in project format ${version}; this one reads formats up to ${current}. ${where}`);
  }
  let file: Json = raw;
  const notes: ProjectNote[] = [];
  for (let v = version; v < current; v++) {
    const step = steps[v];
    if (!step) throw new ProjectError(`${name} was saved in project format ${version}, which is older than any this app can read. Open its STL and set it up again.`);
    file = { ...step(file, notes), schemaVersion: v + 1 };
  }
  if (version < current) notes.unshift({ severity: 'info', message: `Saved in project format ${version} by an earlier version of the app, and brought up to format ${current}.` });
  return { file, from: version, notes };
}

/** A value as a message names it: short, and never the whole of a large object. */
function shown(value: unknown): string {
  if (typeof value === 'string') return `"${value.length > 24 ? `${value.slice(0, 24)}…` : value}"`;
  if (Array.isArray(value)) return 'a list';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The name readProjectJson's reasons use when it is not told the file's. */
const PROJECT_JSON = 'project.json';

/** A field that cannot be used: `what` in a maker's words, `detail` with the field as project.json has it. */
class Refusal {
  constructor(
    readonly what: string,
    readonly detail: string,
  ) {}
}

function refuse(what: string, detail: string): never {
  throw new Refusal(what, detail);
}

/** Every parameter of the schema from the file's, with the notes on what had to change. */
function readParams(raw: unknown, notes: ProjectNote[]): Params {
  if (!isObject(raw)) refuse('it holds no settings', `"params" must be an object, not ${shown(raw)}.`);
  const out: Record<string, Record<string, unknown>> = {};
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const [group, defs] of Object.entries(PARAM_SCHEMA) as [string, Record<string, ParamDef>][]) {
    const given = raw[group];
    if (given !== undefined && !isObject(given)) refuse('its settings are not laid out as this app writes them', `"params.${group}" must be an object, not ${shown(given)}.`);
    out[group] = {};
    for (const [key, def] of Object.entries(defs)) {
      const path = `${group}.${key}` as ParamPath;
      const value = given?.[key];
      if (value === undefined) {
        out[group][key] = def.default;
        missing.push(def.label);
        continue;
      }
      out[group][key] = readParam(path, def, value, notes);
    }
    for (const key of Object.keys(given ?? {})) if (!(key in defs)) unknown.push(`${group}.${key}`);
  }
  for (const group of Object.keys(raw)) if (!(group in PARAM_SCHEMA)) unknown.push(group);
  if (missing.length > 0) notes.push({ severity: 'warning', message: `Not in the file, so at their defaults: ${missing.join(', ')}.` });
  if (unknown.length > 0) notes.push({ severity: 'warning', message: `Settings this version does not know, left out: ${unknown.join(', ')}.` });
  return out as unknown as Params;
}

/** One parameter: its type must be right, and a number is brought into the range its control takes. */
function readParam(path: ParamPath, def: ParamDef, value: unknown, notes: ProjectNote[]): unknown {
  const name = `${def.label} (${path})`;
  const where = `In project.json: params.${path}.`;
  if (def.kind === 'flag') {
    if (typeof value !== 'boolean') refuse(`its ${def.label} must be on or off, not ${shown(value)}`, where);
    return value;
  }
  if (def.kind === 'choice') {
    if (typeof value !== 'string' || !def.options.includes(value)) refuse(`its ${def.label} must be one of ${def.options.map((o) => `"${o}"`).join(', ')}, not ${shown(value)}`, where);
    return value;
  }
  // An auto setting's null is its "not edited", which is what follows its rule.
  if (def.kind === 'auto' && value === null) return null;
  if (!finite(value)) refuse(`its ${def.label} must be a number, not ${shown(value)}`, `${where} It takes a number${def.kind === 'auto' ? ', or null to follow its rule' : ''}.`);
  // The range a control takes: the schema's, with the controls' own floor where 0 has no meaning.
  const range = entryDef(path) as typeof def;
  const low = range.min ?? 0, high = range.max ?? Infinity;
  let kept = Math.min(high, Math.max(low, value));
  if (def.kind === 'number' && def.integer) kept = Math.round(kept);
  // A setting that takes only listed values, such as the lengths screws are sold in, takes the nearest of them.
  if (def.kind === 'auto' && def.options) {
    const options = def.options;
    kept = options.reduce((best, option) => (Math.abs(option - kept) < Math.abs(best - kept) ? option : best), options[0]);
    if (kept !== value) {
      notes.push({ severity: 'warning', message: `${name} was ${value}${def.unit ? ` ${def.unit}` : ''}, which is not one of ${options.join(', ')}, so it is ${kept}${def.unit ? ` ${def.unit}` : ''}.` });
      return kept;
    }
  }
  if (kept !== value) {
    const unit = def.unit ? ` ${def.unit}` : '';
    const span = def.kind === 'number' && def.integer && value >= low && value <= high ? 'a whole number' : high === Infinity ? `at least ${low}${unit}` : `from ${low} to ${high}${unit}`;
    notes.push({ severity: 'warning', message: `${name} was ${value}${unit}, but must be ${span}, so it is ${kept}${unit}.` });
  }
  return kept;
}

const PLANE_FACE = 'the base face it names is not a valid choice';

function readPlane(raw: unknown): PlaneChoice {
  if (!isObject(raw)) refuse(PLANE_FACE, `"plane" must be an object, not ${shown(raw)}.`);
  const index = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
  const upper = raw.upper;
  if (upper !== false && !(finite(upper) && upper >= 0)) refuse(PLANE_FACE, `"plane.upper" must be false or a level's depth in mm, not ${shown(upper)}.`);
  if (('rank' in raw) === ('pick' in raw)) refuse(PLANE_FACE, '"plane" must name either a ranked face ("rank") or a picked triangle ("pick").');
  if ('rank' in raw) {
    if (!index(raw.rank)) refuse(PLANE_FACE, `"plane.rank" must be a whole number from 0, not ${shown(raw.rank)}.`);
    return { rank: raw.rank, upper };
  }
  if (!index(raw.pick)) refuse(PLANE_FACE, `"plane.pick" must be a triangle's index, not ${shown(raw.pick)}.`);
  return { pick: raw.pick, upper };
}

const BASE_PLANE = 'the base face it saved is not a valid plane';

function readBasePlane(raw: unknown): StoredPlane | null {
  if (raw === null) return null;
  if (!isObject(raw)) refuse(BASE_PLANE, `"basePlane" must be an object or null, not ${shown(raw)}.`);
  const { normal, offset, upper } = raw;
  if (!Array.isArray(normal) || normal.length !== 3 || !normal.every(finite)) refuse(BASE_PLANE, '"basePlane.normal" must be three numbers.');
  if (Math.abs(Math.hypot(normal[0], normal[1], normal[2]) - 1) > 1e-6) refuse(BASE_PLANE, '"basePlane.normal" must be a unit vector.');
  if (!finite(offset)) refuse(BASE_PLANE, `"basePlane.offset" must be a number, not ${shown(offset)}.`);
  if (upper !== false && !(finite(upper) && upper >= 0)) refuse(BASE_PLANE, `"basePlane.upper" must be false or a level's depth in mm, not ${shown(upper)}.`);
  return { normal: [normal[0], normal[1], normal[2]], offset, upper };
}

function readPins(raw: unknown): OpeningPin[] {
  if (!Array.isArray(raw)) refuse('its moved openings are not a list', `"pins" must be a list, not ${shown(raw)}.`);
  return raw.map((pin, k) => {
    if (!isObject(pin) || typeof pin.id !== 'string' || (pin.kind !== 'pour' && pin.kind !== 'vent') || !finite(pin.x) || !finite(pin.y)) {
      refuse(`its moved opening ${k + 1} has no valid place`, `"pins[${k}]" must have an id, a kind of "pour" or "vent", and an x and y in mm.`);
    }
    return { id: pin.id, kind: pin.kind, x: pin.x, y: pin.y };
  });
}

const KNOWN = new Set(['schemaVersion', 'appVersion', 'model', 'modelSha256', 'basePlane', 'params', 'plane', 'pins', 'removed']);

/**
 * A migrated project.json checked field by field: the project, or a ProjectError naming `name` with the
 * first reason it cannot be used. The model and the settings must be there; any other field the file
 * lacks takes its default, or is unknown, with a note.
 */
export function validateProject(file: Json, notes: ProjectNote[] = [], name = PROJECT_JSON): ProjectFile {
  try {
    return readFields(file, notes);
  } catch (error) {
    if (error instanceof Refusal) throw new ProjectError(`${name} cannot be used: ${error.what}. ${OPEN_AGAIN}`, error.detail);
    throw error;
  }
}

function readFields(file: Json, notes: ProjectNote[]): ProjectFile {
  if (typeof file.model !== 'string' || file.model === '') refuse('it does not name its STL', '"model" must be the STL\'s file name.');
  const missing = (key: string): boolean => file[key] === undefined;
  const defaulted = [missing('plane') && 'the base face, so candidate 1', missing('pins') && 'moved openings, so none', missing('removed') && 'removed vents, so none'].filter(Boolean);
  // A missing hash needs no note here: whoever matches the model by it says what its absence means.
  const unknown = [missing('appVersion') && 'the app version that saved it', missing('basePlane') && 'the base plane itself'].filter(Boolean);
  if (defaulted.length > 0) notes.push({ severity: 'warning', message: `Not in the file, so as for a new model: ${defaulted.join('; ')}.` });
  if (unknown.length > 0) notes.push({ severity: 'info', message: `Not in the file, so not known: ${unknown.join(', ')}.` });
  const appVersion = file.appVersion ?? 'unknown';
  if (typeof appVersion !== 'string') refuse('the app version it names is not text', `"appVersion" must be text, not ${shown(appVersion)}.`);
  const sha = file.modelSha256 ?? null;
  if (sha !== null && !(typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha))) refuse("its record of the model's contents is not valid", '"modelSha256" must be 64 hex digits or null.');
  const removed = file.removed ?? [];
  if (!Array.isArray(removed) || !removed.every((id) => typeof id === 'string')) refuse('its removed vents are not a list of vents', '"removed" must be a list of vent ids.');
  const extra = Object.keys(file).filter((key) => !KNOWN.has(key));
  if (extra.length > 0) notes.push({ severity: 'warning', message: `Fields this version does not know, left out: ${extra.join(', ')}.` });
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion,
    model: file.model,
    modelSha256: sha,
    basePlane: readBasePlane(file.basePlane ?? null),
    params: readParams(file.params, notes),
    plane: missing('plane') ? DEFAULT_PLANE : readPlane(file.plane),
    pins: readPins(file.pins ?? []),
    removed: [...removed] as string[],
  };
}

export interface ReadProject {
  file: ProjectFile;
  from: number;
  notes: ProjectNote[];
}

/** project.json's text to a checked, current project. `name` is the file the maker opened, which holds it. */
export function readProjectJson(text: string, steps: Readonly<Record<number, Migration>> = MIGRATIONS, name = PROJECT_JSON): ReadProject {
  let raw: unknown;
  try {
    // A byte-order mark is what Windows' Notepad puts in front of a file it saves as UTF-8.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ProjectError(`${name} is damaged: its settings cannot be read. ${OPEN_AGAIN}`, `project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const migrated = migrate(raw, steps, SCHEMA_VERSION, name);
  const notes = [...migrated.notes];
  return { file: validateProject(migrated.file, notes, name), from: migrated.from, notes };
}
