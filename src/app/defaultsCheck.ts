import { crossParameterErrors } from '../core/params/rules';
import { PARAM_SCHEMA, type ParamDef, type Params } from '../core/params/schema';
import { entryDef } from '../ui/layout';
import { DIAGNOSTIC_PARAM } from './derived';
import { paramDef, type ParamPath } from './stages';

/**
 * CS: the check of src/core/params/defaults.json, which holds every setting's default and which a builder may
 * tune (README.md, "Tuning the defaults"; the user's note of 2026-11-16, D22). vite.config.ts runs it before
 * anything is built or served, so a mistake stops scripts/serve.sh, the GitHub Pages build and the test
 * servers with these problems printed, rather than giving a page that breaks; test/unit/defaultsFile.test.ts
 * runs it in scripts/ci.sh. Pure: one plain sentence per problem, each naming the setting by its label and path.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the build says, in the same words, when the file is no JSON at all, before it can load this check. */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return `The file is not valid JSON: ${(error as Error).message}. JSON takes no comments, and no comma after a group's last value.`;
  }
}

/** A value as a problem names it: text in quotes, and a list or an object by what it is. */
function shown(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return 'a list';
  if (isObject(value)) return 'an object';
  return String(value);
}

const nameOf = (path: ParamPath, def: ParamDef): string => `${def.label} (${path})`;
const unitOf = (def: ParamDef): string => ('unit' in def && def.unit ? ` ${def.unit}` : '');
/** "a", "a or b", "a, b or c". */
const either = (items: string[]): string => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/**
 * Where the file holds a number to less than its control takes, with why. Infill is a fraction of solid, which
 * a maker who thinks of it in percent might write as 5 for 5 percent: the box takes that, as 500 percent.
 */
const FILE_CEILINGS: Partial<Record<ParamPath, { max: number; why: string }>> = {
  'print.infill': { max: 1, why: 'it is a fraction of solid, so 0.05 is 5 percent' },
};

/** The range a number takes: its control's (the schema's, with the controls' own floor where 0 means nothing), within FILE_CEILINGS. */
function rangeOf(path: ParamPath): { low: number; high: number | undefined } {
  const range = entryDef(path) as ParamDef & { min?: number; max?: number };
  return { low: range.min ?? 0, high: FILE_CEILINGS[path]?.max ?? range.max };
}

/** The range a number takes, in words. */
function span(path: ParamPath, def: ParamDef): string {
  const { low, high } = rangeOf(path), unit = unitOf(def);
  return high === undefined ? `at least ${low}${unit}` : `from ${low} to ${high}${unit}`;
}

/** What a setting takes, as a missing or mistyped one is told. */
function takes(path: ParamPath, def: ParamDef): string {
  if (def.kind === 'flag') return 'true or false';
  if (def.kind === 'choice') return either(def.options.map((option) => `"${option}"`));
  if (def.kind === 'auto') return 'null, as it is automatic';
  return `${def.integer ? 'a whole number' : 'a number'} ${span(path, def)}`;
}

/** Edits from one name to another, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The setting an unknown one was most likely meant to be: a near spelling, a third of its letters or two off at
 * most, in its own group before another.
 */
function nearest(group: string, key: string): ParamPath | null {
  let best: ParamPath | null = null, score = Math.max(2, Math.floor(key.length / 3)) + 1;
  for (const [g, defs] of Object.entries(PARAM_SCHEMA)) {
    for (const k of Object.keys(defs)) {
      const s = distance(key, k) + (g === group ? 0 : 1);
      if (s < score) [best, score] = [`${g}.${k}` as ParamPath, s];
    }
  }
  return best;
}

/** One setting's value: its type, then its range, its options, or for an automatic one null. */
function valueProblem(path: ParamPath, def: ParamDef, value: unknown): string | null {
  const name = nameOf(path, def);
  if (value === undefined) return `${name} is missing: give it ${takes(path, def)}.`;
  if (def.kind === 'auto') return value === null ? null : `${name} must be null, not ${shown(value)}: it is automatic (${def.rule}), and null keeps it following that rule, which stays in the code.`;
  if (def.kind === 'flag') return typeof value === 'boolean' ? null : `${name} must be true or false, not ${shown(value)}.`;
  if (def.kind === 'choice') return typeof value === 'string' && def.options.includes(value) ? null : `${name} must be ${takes(path, def)}, not ${shown(value)}.`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be ${takes(path, def)}, not ${shown(value)}.`;
  const { low, high = Infinity } = rangeOf(path);
  const why = FILE_CEILINGS[path] ? `: ${FILE_CEILINGS[path].why}` : '';
  if (value < low || value > high) return `${name} is ${value}${unitOf(def)}, but must be ${span(path, def)}${why}.`;
  if (def.integer && !Number.isInteger(value)) return `${name} is ${value}, but must be ${takes(path, def)}.`;
  return null;
}

/**
 * Every problem in a parsed defaults.json, empty when there is none: a setting missing, unknown or misspelt
 * (with the one it was likely meant to be), of the wrong type, outside its range or not whole where it must
 * be, a choice that is none of its options, and an automatic setting that is not null, as null is its edited
 * flag. Only once each value passes are the defaults held to the rules between settings (crossParameterErrors),
 * each named by the setting its note shows under in the app.
 */
export function checkDefaults(json: unknown): string[] {
  const groups = Object.keys(PARAM_SCHEMA);
  if (!isObject(json)) return [`The file must hold one object, with a group of settings for each of ${groups.join(', ')}, not ${shown(json)}.`];
  const problems: string[] = [];
  for (const [group, defs] of Object.entries(PARAM_SCHEMA) as [string, Record<string, ParamDef>][]) {
    const given = json[group];
    if (given === undefined) {
      const settings = Object.entries(defs).map(([key, def]) => nameOf(`${group}.${key}` as ParamPath, def));
      problems.push(`The group ${group} is missing, with its ${settings.length} settings: ${settings.join(', ')}.`);
      continue;
    }
    if (!isObject(given)) {
      problems.push(`${group} must be an object of settings, not ${shown(given)}.`);
      continue;
    }
    for (const [key, def] of Object.entries(defs)) {
      const problem = valueProblem(`${group}.${key}` as ParamPath, def, given[key]);
      if (problem) problems.push(problem);
    }
    for (const key of Object.keys(given)) {
      if (Object.hasOwn(defs, key)) continue;
      const near = nearest(group, key);
      problems.push(near ? `${group}.${key} is not a setting: did you mean ${nameOf(near, paramDef(near))}?` : `${group}.${key} is not a setting of ${group}, so take it out.`);
    }
  }
  for (const group of Object.keys(json)) {
    if (Object.hasOwn(PARAM_SCHEMA, group)) continue;
    const near = groups.filter((g) => distance(group, g) <= 2).sort((a, b) => distance(group, a) - distance(group, b))[0];
    problems.push(near ? `${group} is not a group of settings: did you mean ${near}?` : `${group} is not a group of settings, so take it out.`);
  }
  if (problems.length > 0) return problems;
  const params = json as unknown as Params;
  for (const diagnostic of crossParameterErrors(params)) {
    // The app tells a maker to set the pocket themselves, which the file, where it must stay null, cannot do:
    // there the layer it follows is what to change.
    if (diagnostic.code === 'pocket-range') {
      const { min, max } = PARAM_SCHEMA.base.pocketDepth;
      problems.push(`${nameOf('print.layerHeight', paramDef('print.layerHeight'))} is ${params.print.layerHeight} mm, but must be from ${min} to ${max} mm, as the automatic ${nameOf('base.pocketDepth', paramDef('base.pocketDepth'))} follows it and takes only that range.`);
      continue;
    }
    const path = DIAGNOSTIC_PARAM[diagnostic.code];
    problems.push(path ? `${nameOf(path, paramDef(path))} breaks a rule between settings: ${diagnostic.message}` : `The defaults break a rule between settings: ${diagnostic.message}`);
  }
  return problems;
}

/**
 * The paths a JSON text gives twice in one object, which JSON.parse lets the last of win without a word.
 * Only for text that parses, so its strings and brackets are well formed.
 */
export function givenTwice(text: string): string[] {
  const found: string[] = [];
  const stack: { keys: Set<string>; path: string }[] = [];
  let pending = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const key = JSON.parse(text.slice(i, j + 1)) as string;
      i = j;
      let k = i + 1;
      while (/\s/.test(text[k] ?? '')) k++;
      const frame = stack.at(-1);
      if (text[k] !== ':' || !frame) continue;
      const path = frame.path ? `${frame.path}.${key}` : key;
      if (frame.keys.has(key)) found.push(path);
      frame.keys.add(key);
      pending = path;
    } else if (c === '{' || c === '[') {
      stack.push({ keys: new Set(), path: pending });
    } else if (c === '}' || c === ']') {
      stack.pop();
    }
  }
  return found;
}

/**
 * The file's text without the byte-order mark an editor may save at its start ("UTF-8 with BOM"), which JSON.parse
 * refuses and Vite and Node, which load the file for the app and its tests, pass over.
 */
export const withoutBom = (text: string): string => text.replace(/^\uFEFF/, '');

/** The whole check of the file's text, as the build runs it: JSON at all, each setting once, then checkDefaults. */
export function checkDefaultsText(file: string): string[] {
  const text = withoutBom(file);
  const syntax = jsonProblem(text);
  if (syntax) return [syntax];
  const twice = givenTwice(text).map((path) => {
    const [group, key] = path.split('.');
    const defs = Object.hasOwn(PARAM_SCHEMA, group) ? (PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>)[group] : {};
    const def = Object.hasOwn(defs, key ?? '') ? defs[key] : undefined;
    return `${def ? nameOf(path as ParamPath, def) : path} is given twice: give it once, as only the last would count.`;
  });
  return [...twice, ...checkDefaults(JSON.parse(text))];
}
