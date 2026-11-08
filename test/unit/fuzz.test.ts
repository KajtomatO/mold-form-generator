import type { ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allDiagnostics, autoValue, exportBlocked, exportPitch, previewSilicone } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { projectFile, projectJson } from '../../src/app/project';
import { readProjectJson } from '../../src/app/projectFile';
import { stageKeys, type ParamPath, type StageInputs } from '../../src/app/stages';
import { placementSettings } from '../../src/core/analysis/placement';
import { openingSizes } from '../../src/core/analysis/validate';
import { exportPlan, fieldSettings, planField } from '../../src/core/field/grid';
import { defaultParams, resolveAuto } from '../../src/core/params/defaults';
import { crossParameterErrors } from '../../src/core/params/rules';
import { PARAM_SCHEMA, type ParamDef, type Params } from '../../src/core/params/schema';
import { coverBottom } from '../../src/core/parts/cover';
import { deriveRim, moldBounds } from '../../src/core/parts/rim';
import type { Diagnostic } from '../../src/core/report/diagnostics';
import { withArena } from '../../src/core/solid/arena';
import { entryDef, sliderRange } from '../../src/ui/layout';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';
import { orientedExample } from '../fixtures/fieldRuns';
import { exampleBytes, EXAMPLE_FILES, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { FUZZ_REGRESSIONS } from '../fixtures/fuzzSeeds';

/**
 * M11: seeded random parameter sets over the whole schema. Each must either give finite numbers and sound
 * solids, or say what is wrong as an inline error, never throw, hang or give NaN. The quick suite runs a
 * few hundred sets through the pure parts and a dozen through real builds on jersey; CFG_SOAK=1 runs many
 * more of both, with other seeds. A failing seed found here is kept in test/fixtures/fuzzSeeds.ts.
 */
const SOAK = process.env.CFG_SOAK === '1';
const PURE_SETS = SOAK ? 3000 : 300;
const BUILD_SETS = SOAK ? 120 : 8;
const EXPORT_SETS = SOAK ? 16 : 2;
/** Set n draws from seed SEED + n, so any one set can be drawn again from its seed alone. */
const SEED = SOAK ? 1_100_000 : 110_000;
/** No preview of jersey takes near this, so a set that does has hung. */
const BUILD_LIMIT_MS = 60_000;

/** mulberry32: small, fast, and the same sequence in every engine for a seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) => Object.keys(defs).map((key) => `${group}.${key}` as ParamPath));

interface Draw {
  /** Grid counts a build can afford: jersey 20 x 20 is 400 tiles. */
  maxTiles?: [number, number];
  /** The share of parameters drawn; the rest keep their defaults, so more sets pass the rules and build. */
  share?: number;
}

/**
 * One random set. Each number lies where its control takes it: the schema's range, with the control's
 * floor where the schema has none, and the slider's travel past that; one in ten goes up to twice the
 * slider's end, as a typed value may. An auto setting follows its rule half the time.
 */
export function randomParams(random: () => number, draw: Draw = {}): Params {
  const params = defaultParams();
  const within = (lo: number, hi: number): number => lo + (hi - lo) * random();
  for (const path of PATHS) {
    if (draw.share !== undefined && random() >= draw.share) continue;
    const def = entryDef(path) as ParamDef;
    const [group, key] = path.split('.') as [keyof Params, string];
    const target = params[group] as Record<string, unknown>;
    if (def.kind === 'flag') target[key] = random() < 0.5;
    else if (def.kind === 'choice') target[key] = def.options[Math.floor(random() * def.options.length)];
    else if (def.kind === 'auto' && random() < 0.5) target[key] = null;
    else if (def.kind === 'auto' && def.options) target[key] = def.options[Math.floor(random() * def.options.length)];
    else {
      const [lo, slider] = sliderRange(path, def);
      const hi = random() < 0.1 ? Math.min(def.max ?? Infinity, 2 * slider) : slider;
      let value = within(lo, hi);
      if (def.kind === 'number' && def.integer) value = Math.min(Math.floor(value), def.max ?? Infinity);
      // Three decimals, as typed values are, so a failing set reads back exactly from its report.
      else value = Math.round(value * 1000) / 1000;
      target[key] = Math.max(lo, value);
    }
  }
  if (draw.maxTiles) {
    params.grid.nx = 1 + Math.floor(random() * draw.maxTiles[0]);
    params.grid.ny = 1 + Math.floor(random() * draw.maxTiles[1]);
  }
  return params;
}

/** Every number in a value that is NaN or infinite, by its path, so a report says where. */
function nonFinitePaths(value: unknown, path = '', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const array = value as unknown as ArrayLike<number>;
    for (let i = 0; i < array.length; i++) {
      if (!Number.isFinite(array[i])) {
        out.push(`${path}[${i}] = ${array[i]}`);
        break;
      }
    }
  } else if (Array.isArray(value)) value.forEach((v, k) => nonFinitePaths(v, `${path}[${k}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nonFinitePaths(v, path ? `${path}.${k}` : k, out);
  return out;
}

/** A null where report.json has a number: JSON.stringify writes NaN and an infinity as null, so the parsed file shows them so. */
function nullsWhereNumbers(written: unknown, read: unknown, path = '', out: string[] = []): string[] {
  if (typeof written === 'number') {
    if (read === null) out.push(`${path} read back as null`);
  } else if (Array.isArray(written) && Array.isArray(read)) written.forEach((v, k) => nullsWhereNumbers(v, read[k], `${path}[${k}]`, out));
  else if (written && typeof written === 'object' && read && typeof read === 'object') for (const [k, v] of Object.entries(written)) nullsWhereNumbers(v, (read as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  return out;
}

/** An inline message is a sentence a maker can read: no NaN, undefined or Infinity standing in for a number. */
function plainWords(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((d) => /NaN|undefined|Infinity|\[object/.test(d.message) || d.message.trim() === '').map((d) => `${d.code}: ${d.message}`);
}

/** What one set does to the pure parts on one model: the problems found, empty when sound. */
function pureProblems(params: Params, id: ExampleId): string[] {
  const problems: string[] = [];
  const { mesh, bounds } = orientedExample(id);
  const errors = crossParameterErrors(params);
  problems.push(...plainWords(errors));
  if (errors.some((d) => d.severity !== 'error')) problems.push('a cross-parameter rule that is not an error');
  const auto = resolveAuto(params, bounds);
  problems.push(...nonFinitePaths(auto, 'resolveAuto'));
  const settings = fieldSettings(params, bounds, 0.5);
  const preview = planField(bounds, settings);
  const exported = exportPlan(bounds, settings);
  problems.push(...nonFinitePaths({ preview: { ...preview, diagnostics: [] }, exported: { ...exported, diagnostics: [] } }, 'plan'));
  // G4: the preview's margin is the export's, as the box around it is, even when the export raises its cell.
  if (Math.abs(preview.rEff - exported.rEff) > 1e-9) problems.push(`the preview's r_eff ${preview.rEff} is not the export's ${exported.rEff}`);
  // G6: every preview tile within half a cell of the export's offset.
  for (const [shifts, pitch] of [[preview.shiftsX, exported.pitchXmm], [preview.shiftsY, exported.pitchYmm]] as const) {
    shifts.forEach((shift, k) => {
      if (Math.abs(shift * preview.cell - k * pitch) > preview.cell / 2 + 1e-9) problems.push(`tile ${k} sits ${shift * preview.cell - k * pitch} mm off`);
    });
  }
  const mold = moldBounds(mesh, bounds, settings);
  const rim = deriveRim(mold, params);
  problems.push(...nonFinitePaths({ ...rim, diagnostics: [] }, 'rim'), ...plainWords(rim.diagnostics));
  const rimErrors = rim.diagnostics.filter((d) => d.severity === 'error');
  if (rimErrors.length === 0) {
    // A sound rim nests: cavity bound, base top, box, and the flat top over the base's top.
    const inside = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a): boolean => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;
    if (!inside(rim.D, rim.B) || !inside(rim.B, rim.O)) problems.push('the rim does not nest');
    if (!(rim.Zt > 0) || !(rim.Tb > 0) || !(rim.Zt > coverBottom(rim))) problems.push(`box heights Zt ${rim.Zt}, Tb ${rim.Tb}`);
  }
  problems.push(...nonFinitePaths(placementSettings(params, bounds), 'placement'), ...nonFinitePaths(openingSizes(params), 'sizes'));
  problems.push(...nonFinitePaths(exportPitch(params, bounds), 'pitch'));
  // The stage keys: a key per stage, the same from the same values, and from the values a project file gives back.
  const inputs: StageInputs = { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null };
  const keys = stageKeys(params, inputs);
  if (Object.values(keys).some((k) => typeof k !== 'string' || k.length === 0)) problems.push('a stage without a key');
  const project = { params, plane: DEFAULT_PLANE, pins: [], removed: [] };
  const back = readProjectJson(projectJson(projectFile(project, 'jersey-barrier.stl', { modelSha256: null, basePlane: null })));
  if (JSON.stringify(stageKeys(back.file.params, inputs)) !== JSON.stringify(keys)) problems.push(`a project file gives other keys back: ${back.notes.map((n) => n.message).join(' ')}`);
  return problems;
}

describe('parameter fuzz on the pure parts', () => {
  it(`${PURE_SETS} sets on jersey, x8 and the barrel give finite numbers and plain inline errors, never a throw`, () => {
    const failures: string[] = [];
    const codes = new Map<string, number>();
    for (let n = 0; n < PURE_SETS; n++) {
      const params = randomParams(seeded(SEED + n));
      const id = (['jersey', 'x8', 'barrel'] as ExampleId[])[n % 3];
      try {
        const problems = pureProblems(params, id);
        if (problems.length > 0) failures.push(`seed ${SEED + n} on ${id}: ${problems.join('; ')}`);
      } catch (error) {
        failures.push(`seed ${SEED + n} on ${id} threw: ${error instanceof Error ? error.stack : String(error)}`);
      }
      for (const d of crossParameterErrors(params)) codes.set(d.code, (codes.get(d.code) ?? 0) + 1);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // The draws reach the rules, or the fuzz would test only sound sets.
    expect([...codes.keys()]).toEqual(expect.arrayContaining(['seat-too-deep', 'funnel-top-small']));
  });

  it('the kept failing seeds stay fixed', () => {
    for (const seed of FUZZ_REGRESSIONS.pure) {
      const params = randomParams(seeded(seed.seed));
      expect(pureProblems(params, seed.model), `seed ${seed.seed}: ${seed.found}`).toEqual([]);
    }
  });
});

let api: ManifoldToplevel;
const pipelines: Pipeline[] = [];
beforeAll(async () => {
  api = await loadManifold();
});
afterAll(() => pipelines.splice(0).forEach((p) => p.dispose()));

/** Each part a closed solid in one piece with a positive volume, inside the rim's box. */
function solidProblems(part: { positions: Float32Array; indices: Uint32Array } | null | undefined, name: string, box?: { min: number[]; max: number[] }): string[] {
  if (!part) return [`no ${name}`];
  return withArena(api, (arena) => {
    let solid;
    try {
      solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: part.positions, triVerts: part.indices }));
    } catch (error) {
      return [`the ${name} is no closed solid: ${error instanceof Error ? error.message : String(error)}`];
    }
    const problems: string[] = [];
    if (!(solid.volume() > 0)) problems.push(`the ${name} has volume ${solid.volume()}`);
    const pieces = arena.trackAll(solid.decompose()).length;
    if (pieces !== 1) problems.push(`the ${name} is ${pieces} pieces`);
    if (box) {
      const { min, max } = solid.boundingBox();
      if ([0, 1, 2].some((k) => min[k] < box.min[k] - 1e-3 || max[k] > box.max[k] + 1e-3)) problems.push(`the ${name} reaches past its box: ${[...min]} to ${[...max]} against ${box.min} to ${box.max}`);
    }
    return problems;
  });
}

async function withLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)));
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** One set built for real, as the app's preview builds it, on jersey; and exported, when asked. */
async function buildProblems(params: Params, exportToo: boolean): Promise<{ problems: string[]; blocked: boolean; hard: string[] }> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  pipelines.push(p);
  try {
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await withLimit(p.idle(), BUILD_LIMIT_MS);
    p.setParams((target) => Object.assign(target, structuredClone(params)));
    await withLimit(p.idle(), BUILD_LIMIT_MS);
    const problems: string[] = [];
    // A crash of a worker is a throw, whatever the pipeline then makes of it.
    for (const entry of p.log) if (entry.event === 'crashed') problems.push(`the ${entry.gate} worker crashed: ${entry.detail}`);
    const shown = allDiagnostics(p);
    problems.push(...plainWords(shown));
    const error = p.status().error;
    const hard = shown.filter((d) => d.severity === 'error');
    const blocked = exportBlocked(p) !== null;
    const codes = hard.map((d) => d.code);
    if (crossParameterErrors(params).length > 0 && !blocked) problems.push('a hard rule is broken and the export is not blocked');
    if (error !== null) {
      // An error the user's input explains is inline and fine; one from the geometry engine is not.
      if (/ManifoldError|not a closed solid|could not be built/i.test(error)) problems.push(`the build failed: ${error}`);
      return { problems, blocked, hard: codes };
    }
    if (hard.length > 0 && blocked) return { problems, blocked, hard: codes };
    const field = p.field?.value;
    if (!field) return { problems: [...problems, 'no field'], blocked, hard: codes };
    problems.push(...nonFinitePaths({ field: field.field.values, rim: { ...field.rim, diagnostics: [] } }, 'field'));
    const silicone = previewSilicone(p);
    if (!silicone || !Number.isFinite(silicone.ml) || !(silicone.ml > 0)) problems.push(`silicone ${silicone?.ml}`);
    for (const path of ['base.pocketDepth', 'silicone.printMargin', 'vents.persistence', 'base.planeTol', 'grid.spacing', 'grid.edge'] as ParamPath[]) {
      const value = autoValue(path, p);
      if (value !== null && !Number.isFinite(value)) problems.push(`${path} follows ${value}`);
    }
    const { rim } = field;
    const box = { min: [rim.O.x0, rim.O.y0, coverBottom(rim)], max: [rim.O.x1, rim.O.y1, rim.Zt] };
    problems.push(...solidProblems(p.cover?.value, 'cover', box));
    problems.push(...solidProblems(p.base?.value, 'base', params.base.mode === 'glue' ? { min: [rim.O.x0, rim.O.y0, -rim.Tb], max: [rim.O.x1, rim.O.y1, rim.ridgeHeight] } : undefined));
    if (p.funnel?.value) problems.push(...solidProblems(p.funnel.value, 'funnel'));
    if (exportToo && !blocked) {
      try {
        const outputs = await withLimit(p.exportParts(), BUILD_LIMIT_MS * 3);
        // The report as built, before JSON.stringify turns a NaN or an infinity into null, and the file as written.
        problems.push(...plainWords(outputs.diagnostics), ...nonFinitePaths(outputs.report, 'report'));
        problems.push(...nullsWhereNumbers(outputs.report, JSON.parse(new TextDecoder().decode(outputs.files['report.json'])), 'report.json'));
        problems.push(...outputs.diagnostics.filter((d) => d.severity === 'error').map((d) => `the export found ${d.code}: ${d.message}`));
      } catch (error) {
        problems.push(`the export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { problems, blocked, hard: codes };
  } finally {
    p.dispose();
    pipelines.splice(pipelines.indexOf(p), 1);
  }
}

/** One build set in three draws all of the schema; the rest a tenth of it, as those mostly pass the rules and build. */
const buildDraw = (seed: number): Draw => ({ maxTiles: [3, 2], share: seed % 3 === 0 ? undefined : 0.1 });

describe('parameter fuzz through real builds on jersey', () => {
  it(`${BUILD_SETS} sets build sound solids or say why inline, ${EXPORT_SETS} of them exported`, async () => {
    const failures: string[] = [];
    let built = 0;
    const codes = new Map<string, number>();
    for (let n = 0; n < BUILD_SETS; n++) {
      const seed = SEED + 50_000 + n;
      const params = randomParams(seeded(seed), buildDraw(seed));
      try {
        const { problems, blocked, hard } = await buildProblems(params, n < 2 * EXPORT_SETS && seed % 3 !== 0);
        if (!blocked) built++;
        for (const code of hard) codes.set(code, (codes.get(code) ?? 0) + 1);
        if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join('; ')}`);
      } catch (error) {
        failures.push(`seed ${seed} threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`fuzz builds: ${built} of ${BUILD_SETS} built, the rest stopped by ${[...codes].map(([code, count]) => `${code} ${count}`).join(', ')}`);
    expect(failures.slice(0, 3)).toEqual([]);
    // Most sets drawn over the whole schema break some rule, so the sparse ones must build for this to test the solids.
    expect(built).toBeGreaterThanOrEqual(BUILD_SETS / 3);
  }, SOAK ? 3_600_000 : 600_000);

  it('the kept failing seeds stay fixed', async () => {
    for (const seed of FUZZ_REGRESSIONS.build) {
      const params = randomParams(seeded(seed.seed), buildDraw(seed.seed));
      expect((await buildProblems(params, seed.exportToo)).problems, `seed ${seed.seed}: ${seed.found}`).toEqual([]);
    }
  }, 600_000);
});
