import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allDiagnostics, exportBlocked, moldBox, previewSilicone } from '../../src/app/derived';
import { downloadName, REVOKE_MS, saveBytes } from '../../src/app/download';
import { INIT_TIMEOUT_MS, realTimers } from '../../src/app/jobGate';
import { Pipeline, type ExportProgress, type ExportResult, type PipelineOptions } from '../../src/app/pipeline';
import { projectFile } from '../../src/app/project';
import { APP_VERSION } from '../../src/app/version';
import { defaultParams } from '../../src/core/params/defaults';
import { GROUP_TITLES, PARAM_SCHEMA, SCHEMA_VERSION } from '../../src/core/params/schema';
import { fitVariants } from '../../src/core/parts/fitTest';
import type { GeometryReports } from '../../src/core/analysis/reports';
import type { Diagnostic } from '../../src/core/report/diagnostics';
import { exportReadme, type ReadmeInput } from '../../src/core/report/readme';
import { parseStl } from '../../src/core/stl/parse';
import { exportSteps, type ExportOutputs, type ExportReport } from '../../src/workers/exportJob';
import type { WorkerLike } from '../../src/workers/protocol';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { asciiStl, box, toSoup, withoutTriangles } from '../fixtures/synthetic';
import { exampleBytes, EXAMPLE_FILES } from '../fixtures/loadExamples';
import { readPart } from '../fixtures/solidChecks';
import { OPENING_GOLDEN } from '../regression/golden';

const root = join(import.meta.dirname, '..', '..');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('names and versions', () => {
  it('the app version is the one package.json has', () => {
    expect(APP_VERSION).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  });

  it('a saved file is named after the model, with what Windows refuses replaced', () => {
    expect(downloadName('3dbenchy.stl', '-mold.zip')).toBe('3dbenchy-mold.zip');
    expect(downloadName('Goddess Statue.STL', '-cover.stl')).toBe('Goddess Statue-cover.stl');
    expect(downloadName('wolfinal(1).stl', '-fit-test.zip')).toBe('wolfinal(1)-fit-test.zip');
    expect(downloadName('a:b?<c>.stl', '-base.stl')).toBe('a_b__c_-base.stl');
    expect(downloadName('.stl', '-mold.zip')).toBe('mold-mold.zip');
  });

  it('a file is saved by a Blob and an anchor, and its object URL is revoked 10 s later, not before', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const anchor = { href: '', download: '', style: {} as Record<string, string>, click: () => events.push(`click ${anchor.download} ${anchor.href}`), remove: () => events.push('removed') };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: () => events.push('appended') } });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      events.push(`blob ${(blob as Blob).type} ${(blob as Blob).size}`);
      return 'blob:test/1';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void events.push(`revoked ${url}`));
    try {
      saveBytes('3dbenchy-mold.zip', new Uint8Array([1, 2, 3]), 'application/zip');
      expect(events).toEqual(['blob application/zip 3', 'appended', 'click 3dbenchy-mold.zip blob:test/1', 'removed']);
      expect(REVOKE_MS).toBe(10_000);
      vi.advanceTimersByTime(REVOKE_MS - 1);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revoke).toHaveBeenCalledWith('blob:test/1');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('project.json carries the schema version, the parameters, the plane, the pins and the removed vents', () => {
    const project = { params: defaultParams(), plane: { rank: 1, upper: 0.41 }, pins: [{ id: 'b0:pour:0', kind: 'pour' as const, x: 1, y: 2 }], removed: ['b0:vent:1'] };
    expect(projectFile(project, 'x.stl')).toEqual({ schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, model: 'x.stl', ...project });
  });

  it('each request counts its own steps, and only the ZIP packs README, report and project', () => {
    expect(exportSteps({ want: 'zip', fitTest: false })).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', 'zip']);
    expect(exportSteps({ want: 'zip', fitTest: true })).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', 'fit-test', 'zip']);
    // The base needs the cover still: a raise of the margin moves the rim of both.
    expect(exportSteps({ want: 'base', fitTest: false })).toContain('cover');
    expect(exportSteps({ want: 'cover', fitTest: false })).not.toContain('base');
    expect(exportSteps({ want: 'funnel', fitTest: false })).toEqual(['funnel']);
  });
});

/**
 * S9 as Benchy gives it at defaults, by hand: cut-required for the silicone in its cabin, which runs round
 * the cabin's posts, then the under-plug at its bow, its one underside pocket, and the tape at its 10 N floor.
 */
function sampleReports(): GeometryReports {
  return {
    demold: {
      verdict: 'cut-required',
      bodies: [{ verdict: 'cut-required', volume: 15550, footprints: 1, loopLock: false, underPlug: 6942, sandwiched: 8479 }],
      hints: [
        { id: 'sandwiched-0', reason: 'sandwiched', body: 0, volume: 8402, mouths: 1, walls: 6, footprints: 0, cuts: true, at: [2.4, 0.1, 23.4], seam: [[2.4, -14.6, 23.4], [2.4, 0.1, 23.4]] },
        { id: 'under-plug-1', reason: 'under-plug', body: 0, volume: 6942, mouths: 0, walls: 0, footprints: 0, cuts: false, at: [12.2, 3.6, 0.5], seam: [[12.2, -14.6, 0.5], [12.2, 3.6, 0.5]] },
      ],
    },
    air: { ceilingLeaves: 2, uncovered: [], underside: [{ x: 9.4, y: -6.6, z: 36.6, saddle: 34.1, persistence: 2.5, volume: 523, shell: 0 }], sealed: [], sealedAir: 0, filtered: { underside: 1, sealed: 8 } },
    lift: { forceN: 1.6, level: 87.6, area: 2600 },
    clamp: { holdN: 10, liftStrips: 1, across: [1, 1], strips: 2, stripN: 10 },
    tiles: 1,
    centre: [0, 0],
    diagnostics: [],
  };
}

describe('README.txt', () => {
  const warning: Diagnostic = { code: 'long-vent', severity: 'warning', message: 'A vent at (28.5, 80.5) runs 147 mm, 59 times its 2.5 mm diameter, so it may need clearing after printing and could be slow to fill.' };
  const note: Diagnostic = { code: 'silicone-tall', severity: 'info', message: 'This cavity is 162 mm tall, so 4 to 5 mm of silicone keeps a mold that size from sagging.' };
  function input(change: (i: ReadmeInput) => void = () => {}): ReadmeInput {
    const i: ReadmeInput = {
      app: 'Casting Form Generator',
      version: APP_VERSION,
      model: '3dbenchy.stl',
      params: defaultParams(),
      resolved: { 'base.pocketDepth': 0.2, 'base.planeTol': 0.05, 'silicone.printMargin': 0.1, 'vents.persistence': 1.5, 'grid.spacing': 9.77, 'grid.edge': 6.4 },
      files: ['cover.stl', 'base.stl', 'funnel.stl', 'model_oriented.stl', 'report.json', 'project.json'],
      pours: 1,
      vents: 2,
      tiles: 1,
      pitch: null,
      box: [70.31, 41.2, 61.44],
      clearance: { measured: 3.2136, error: 0.0066, raisedBy: 0 },
      silicone: { ml: 43.2, grams: 47.3 },
      reports: sampleReports(),
      reportsError: null,
      tape: { lift: sampleReports().lift, clamp: sampleReports().clamp },
      plastic: { solid: 312, printed: 160 },
      diagnostics: [warning, note],
    };
    change(i);
    return i;
  }

  /** Notepad's rules: plain ASCII, CRLF line endings and lines of at most 76 characters. */
  function notepad(readme: string): void {
    expect([...readme].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\r' && c !== '\n'))).toEqual([]);
    expect(readme.endsWith('\r\n')).toBe(true);
    expect(/[^\r]\n|\r[^\n]/.test(readme)).toBe(false);
    for (const line of readme.split('\r\n')) expect(line.length, line).toBeLessThanOrEqual(76);
  }

  it('reads well in Windows Notepad: plain ASCII, CRLF line endings, short lines', () => {
    notepad(exportReadme(input()));
  });

  it('keeps to those rules whatever the model is called: a long name, letters outside ASCII, one word longer than a line', () => {
    const polish = 'wilk łapa żółw - final version of the model from the scanner, cleaned and fixed.stl';
    const long = `${'x'.repeat(90)}.stl`;
    for (const model of [polish, long, 'Göttin.stl', 'mold™ 中.stl']) {
      const readme = exportReadme(input((i) => (i.model = model)));
      notepad(readme);
      // The title is underlined to its longest line.
      const lines = readme.split('\r\n');
      const rule = lines.findIndex((line) => /^=+$/.test(line));
      expect(lines[rule].length).toBe(Math.max(...lines.slice(0, rule).map((line) => line.length)));
    }
    // Accents come off, letters with no plain form take their nearest one, and the rest become '?'.
    const flat = exportReadme(input((i) => (i.model = polish))).replace(/\r\n\s*/g, ' ');
    expect(flat).toContain('wilk lapa zolw - final version of the model from the scanner');
    expect(exportReadme(input((i) => (i.model = 'Göttin.stl')))).toContain('Gottin: silicone casting mold');
    expect(exportReadme(input((i) => (i.model = 'mold™ 中.stl')))).toContain('moldTM ?: silicone casting mold');
    // The word too long for any line is broken where the line ends, and nothing of it is lost.
    expect(exportReadme(input((i) => (i.model = long))).replace(/\r\n/g, '')).toContain(`${'x'.repeat(90)}.stl.`);
  });

  it('lists every setting the mold was made with, auto ones with what they came to', () => {
    const readme = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    const at = readme.indexOf('SETTINGS');
    expect(at).toBeGreaterThan(readme.indexOf('ESTIMATES'));
    const settings = readme.slice(at);
    for (const [group, defs] of Object.entries(PARAM_SCHEMA)) {
      expect(settings, group).toContain(` ${GROUP_TITLES[group]} -`);
      for (const def of Object.values(defs)) expect(settings, def.label).toContain(`- ${def.label}: `);
    }
    for (const line of ['- Silicone thickness: 3 mm', '- Taper clearance per side: 0.1 mm', '- Groove clearance per side: 0.25 mm', '- Mode: glue (Mode A)', '- Pry notches: on', '- Infill: 0.35 (35 percent)', '- Pours per body: 1 ', '- Seat half angle: 30 deg', '- Pocket depth: auto, 0.2 mm', '- Edge distance: auto, 6.4 mm', '- Preview cell: auto, for the preview only']) {
      expect(settings).toContain(line);
    }
    // Every auto setting but the preview's own cell gets a figure from the export.
    expect(settings.match(/for the preview only/g)).toHaveLength(1);
    expect(exportReadme(input((i) => (i.params.joint.taperClearance = 0.15))).replace(/\r\n\s*/g, ' ')).toContain('- Taper clearance per side: 0.15 mm');
  });

  it('a Mode A grid says how many models to print and glue', () => {
    const one = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    expect(one).not.toContain('copies of it');
    const six = exportReadme(input((i) => {
      i.tiles = 6;
      i.pitch = [60.5, 30.25];
      i.params.grid.nx = 2;
      i.params.grid.ny = 3;
    })).replace(/\r\n\s*/g, ' ');
    expect(six).toContain('Print 6 copies of it, one for each of the 6 pockets in the base.');
    expect(six).toContain('Glue a model into each of the 6 pockets of the base');
    expect(six).toContain('2 x 3 copies of the model, every 60.50 x 30.25 mm.');
  });

  it('says what each file is and how to print it, with the funnel quantity', () => {
    const readme = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    for (const name of ['cover.stl', 'base.stl', 'model_oriented.stl', 'funnel.stl', 'report.json and project.json']) expect(readme).toContain(name);
    expect(readme).toContain('Print it as it is saved: it is already turned flat top down on the bed.');
    expect(readme).toContain('glue its flat face into the pocket');
    expect(readme).toContain('Print one. Print it as it is saved, wide rim down.');
    expect(readme).toContain('About 35 percent infill is enough.');
    expect(exportReadme(input((i) => (i.pours = 6))).replace(/\r\n\s*/g, ' ')).toContain('Print 6, one for each pour opening.');
  });

  it('has the workflow: fit, tape, Vaseline, pour until every vent shows silicone, cure, the sprue rule and the D2 demold', () => {
    const readme = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    const order = [
      'Cure-inhibition test',
      'Leak test',
      'POURING',
      'Glue the model into the pocket of the base',
      'Fit the base into the cover',
      'Tape the joint with at least 2 strips',
      'Vaseline in the groove',
      'until silicone shows at every vent',
      'Let it cure',
      'The sprue rule: if you pour without a funnel',
      'Cut that sprue at the floor of the seat',
      'DEMOLDING',
      'Cut the sprues',
      'slide the silicone out of the cover with the model still in it',
      'Cut the silicone with a sharp blade at the places to cut',
      'Take out the model.',
      'Put the silicone back into the cover',
    ];
    let at = -1;
    for (const phrase of order) {
      const next = readme.indexOf(phrase, at + 1);
      expect(next, phrase).toBeGreaterThan(at);
      at = next;
    }
  });

  it('says the demold estimate and where the silicone holds, the air, the tape to hold the cover and the plastic, all as estimates', () => {
    const readme = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    const order = [
      'Plastic: about 160 g at that infill, or 312 g printed solid. This is an estimate',
      // One strip holds the lift, and one each way presses the seal all round.
      'Tape the joint with at least 2 strips of tape at 10 N each, each running from a side wall of the cover across the base to the opposite wall: at least 1 from front to back and 1 from left to right',
      'no more than about 100 mm apart along any wall',
      'pushes the cover up with about 1.6 N, and the tape should hold twice that, and never less than 10 N: here 10.0 N, which one strip holds.',
      'DEMOLDING',
      'Estimate: cutting needed. Expect to cut the silicone to free the model where it holds the model in a loop',
      "This is worked out from the model's shape alone",
      'Cut the silicone at this place, where it holds the model in a loop, measured from the middle of the model',
      '- 8.4 ml of silicone between parts of the model that are joined round it in 6 places, 23 mm up, 2 mm right of the middle: it holds the model in a loop there, so cut in from the front of the silicone to there.',
      'It also holds the model here, but can stretch off:',
      '- 6.9 ml of silicone under an overhang, 1 mm up, 12 mm right of the middle, 4 mm to the back: stretch the silicone off the model there, or cut in from the front of the silicone to there if it would tear.',
      'Cut the sprues',
      'AIR',
      "All 2 peaks of the cover's ceiling have an opening",
      'Air stays in a pocket under an overhang of the model, 37 mm up, 9 mm right of the middle, 7 mm to the front, about 0.52 ml. No vent in the top reaches it: brush a first coat',
      'This assumes the silicone rises slowly and evenly',
      'THIS MOLD',
    ];
    let at = -1;
    for (const phrase of order) {
      const next = readme.indexOf(phrase, at + 1);
      expect(next, phrase).toBeGreaterThan(at);
      at = next;
    }
    // A grid says the estimate holds for every copy alike.
    expect(exportReadme(input((i) => (i.reports = { ...sampleReports(), tiles: 6 }))).replace(/\r\n\s*/g, ' ')).toContain('holds for each of the 6 copies alike');
    // A plausible model has no list of places, and a sealed void says it is harmless.
    const plain = sampleReports();
    plain.demold = { verdict: 'plausible', bodies: [], hints: [] };
    plain.air.sealed = [{ volume: 3432, area: 120, min: [-5, -5, 3], max: [5, 5, 30], onPlane: false, inModel: true }];
    const quiet = exportReadme(input((i) => (i.reports = plain))).replace(/\r\n\s*/g, ' ');
    expect(quiet).toContain('Estimate: pull out in the cover. The model should pull out of the silicone while the silicone stays in the cover.');
    expect(quiet).not.toContain('Where the silicone holds the model');
    expect(quiet).toContain('3.43 ml is a sealed hollow inside the model, which no silicone reaches.');
    // Its steps take the model out with the base, and slide the silicone out only if it holds.
    expect(quiet).toContain('pulling the model out of the silicone with it, while the silicone stays in the cover. 3. If the model holds, slide the silicone out of the cover');
    expect(quiet).not.toContain('places to cut');
    notepad(exportReadme(input((i) => (i.reports = plain))));
    // A plausible model with a little silicone that holds is told to flex it there, never to cut.
    const flex = sampleReports();
    flex.demold = { verdict: 'plausible', bodies: [], hints: [{ ...sampleReports().demold.hints[1], volume: 950 }] };
    const flexed = exportReadme(input((i) => (i.reports = flex))).replace(/\r\n\s*/g, ' ');
    expect(flexed).toContain('- 0.95 ml of silicone under an overhang, 1 mm up, 12 mm right of the middle, 4 mm to the back: flex the silicone there if the model holds.');
    expect(flexed).not.toContain('cut in from');
    // A model that holds but has no loop is told to stretch the silicone off, and to cut only where it would tear.
    const stretch = sampleReports();
    stretch.demold = { verdict: 'jacket-out', bodies: [], hints: [sampleReports().demold.hints[1]] };
    const stretched = exportReadme(input((i) => (i.reports = stretch))).replace(/\r\n\s*/g, ' ');
    expect(stretched).toContain('Where the silicone holds the model, measured from the middle of the model');
    expect(stretched).toContain('Stretch the silicone off the model where it holds. Cut it with a sharp blade, in a wavy line so the cut faces line up again, only where it would tear.');
    expect(stretched).not.toContain('Cut the silicone at');
  });

  it('when the reports failed, says so and gives the steps that work for any model, with the tape still counted', () => {
    const readme = exportReadme(input((i) => {
      i.reports = null;
      i.reportsError = 'the analysis found no solid in the model';
    })).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('The demold estimate could not be worked out for this export (the analysis found no solid in the model)');
    expect(readme).not.toContain('Estimate:');
    expect(readme).toContain('Stretch the silicone off the model where it holds.');
    expect(readme).toContain('The air report could not be worked out for this export.');
    expect(readme).toContain('Tape the joint with at least 2 strips');
  });

  it('without funnel seats the sprues are cut flush with the top, and no seat is named', () => {
    const readme = exportReadme(input((i) => (i.params.seat.enabled = false))).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('The pour openings have no funnel seat, so cut the silicone in each of them flush with the top.');
    expect(readme).toContain('1. Cut the silicone in each pour opening and each vent flush with the top.');
    expect(readme).not.toContain('floor of its seat');
  });

  it('when funnels collide, the pour step says to print the smaller funnel or pour through one at a time, not to fill every seat', () => {
    const collide: Diagnostic = { code: 'funnel-collision', severity: 'warning', message: 'Funnels of 40 mm collide, as two pours are only 22.0 mm apart. A top diameter of 21 mm would fit.' };
    const apart = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    expect(apart).toContain('Push a funnel into the seat of each pour opening.');
    const close = exportReadme(input((i) => (i.diagnostics = [collide, ...i.diagnostics]))).replace(/\r\n\s*/g, ' ');
    expect(close).not.toContain('Push a funnel into the seat of each pour opening.');
    expect(close).toContain('The funnels would touch at this spacing, so either print them with the smaller top diameter the funnel warning below suggests, or pour through one funnel at a time, moving it from seat to seat.');
    expect(close).toContain('A top diameter of 21 mm would fit.');
  });

  it('gives the thickness, the measured clearance, the silicone, the box, every warning, and that only a test pour confirms the estimates', () => {
    const readme = exportReadme(input()).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('Silicone thickness asked for: 3 mm.');
    expect(readme).toContain('Measured clearance: 3.21 mm at the thinnest point between the model and the cover, measured on a simplified copy of the model with its error of 0.007 mm taken off.');
    expect(readme).toContain('Silicone: about 43 ml, 47 g at 1.1 g/cm3.');
    expect(readme).toContain('Mold box: 70.3 x 41.2 x 61.4 mm');
    expect(readme).toContain(`Warning: ${warning.message}`);
    expect(readme).toContain(`NOTES ----- - ${note.message}`);
    expect(readme).toContain('only a test pour shows how your silicone flows');
    expect(readme).toContain('The 3 mm silicone thickness, which is the default,');
    expect(exportReadme(input((i) => (i.diagnostics = []))).replace(/\r\n\s*/g, ' ')).toContain('WARNINGS -------- None.');
  });

  it('says when the margin was raised, when nothing could be measured, and how Mode B differs', () => {
    expect(exportReadme(input((i) => (i.clearance = { measured: 3.05, error: 0, raisedBy: 0.12 }))).replace(/\r\n\s*/g, ' ')).toContain('so the safety margin was raised by 0.12 mm and the mold was built again');
    expect(exportReadme(input((i) => (i.clearance = null))).replace(/\r\n\s*/g, ' ')).toContain('The clearance could not be measured');
    const modeB = exportReadme(input((i) => {
      i.params.base.mode = 'merged';
      i.files = i.files.filter((f) => f !== 'model_oriented.stl');
    })).replace(/\r\n\s*/g, ' ');
    expect(modeB).not.toContain('model_oriented.stl');
    expect(modeB).not.toContain('Glue the model');
    expect(modeB).toContain('Mode B: the model is part of the base.');
    expect(modeB).toContain('may need supports');
  });
});

describe('the export of jersey in Node', () => {
  const pipelines: Pipeline[] = [];
  afterEach(() => {
    pipelines.splice(0).forEach((p) => p.dispose());
  });
  /** Counts the workers spawned, and which of them were terminated: a field set to null is not a dead worker. */
  function counting(make: () => WorkerLike = inProcessSolid): { spawn: () => WorkerLike; spawned: () => number; terminated: () => boolean[] } {
    const ended: boolean[] = [];
    return {
      spawn: () => {
        const worker = make();
        const k = ended.push(false) - 1;
        const end = worker.terminate.bind(worker);
        worker.terminate = () => {
          ended[k] = true;
          end();
        };
        return worker;
      },
      spawned: () => ended.length,
      terminated: () => [...ended],
    };
  }
  async function loaded(spawnSolid: () => WorkerLike = inProcessSolid, change: (p: Pipeline) => void = () => {}, options: Partial<PipelineOptions> = {}): Promise<Pipeline> {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid, frozen: true, ...options });
    pipelines.push(p);
    change(p);
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await p.idle();
    return p;
  }
  /** The real solid worker, with what it says about an export changed on the way to main. */
  function editing(edit: (data: { t: 'exported'; outputs: ExportOutputs } | { t: 'error'; message: string }) => unknown): () => WorkerLike {
    return () => {
      const real = inProcessSolid();
      const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: (m, t) => real.postMessage(m, t), terminate: () => real.terminate() };
      real.onmessage = (event) => worker.onmessage?.({ data: event.data.t === 'exported' ? (edit(event.data) as never) ?? event.data : event.data });
      real.onerror = (event) => worker.onerror?.(event);
      return worker;
    };
  }

  it('the ZIP holds the parts in print pose, model_oriented.stl with the input\'s triangles, README, report and project, and fit_test/ when asked', async () => {
    const p = await loaded();
    const steps: string[] = [];
    const outputs = await p.exportParts((s) => steps.push(s.step), undefined, { want: 'zip', fitTest: true });
    expect(steps).toEqual(exportSteps({ want: 'zip', fitTest: true }));
    const files = unzipSync(outputs.zip);
    const fit = fitVariants(p.params).flatMap((v) => [`fit_test/${v.id}_base.stl`, `fit_test/${v.id}_cover.stl`]);
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'base.stl', 'cover.stl', 'funnel.stl', 'model_oriented.stl', 'project.json', 'report.json', ...fit, 'fit_test/README.txt'].sort());
    for (const [name, bytes] of Object.entries(files).filter(([n]) => n.endsWith('.stl'))) {
      expect(text(bytes.subarray(0, 5)).toLowerCase(), name).not.toBe('solid');
      expect(parseStl(bytes).format, name).toBe('binary');
      expect(readPart(bytes).audit, name).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    }
    // The model from the file's own triangles, less the collapsed ones, standing on z = 0.
    const model = parseStl(files['model_oriented.stl']);
    expect(model.rawTriangleCount).toBe(parseStl(exampleBytes('jersey')).triangleCount);
    expect(Math.min(...model.positions.filter((_, k) => k % 3 === 2))).toBe(0);

    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(report).toMatchObject({ appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION, model: { file: EXAMPLE_FILES.jersey, triangles: model.rawTriangleCount }, plane: { choice: { rank: 0, upper: false }, normal: [0, 0, -1] } });
    expect(report.params).toEqual(p.params);
    expect(report.clearance.measured).toBe(outputs.clearance!.measured);
    expect(report.clearance.measured!).toBeGreaterThanOrEqual(3);
    expect(report.clearance).toMatchObject({ asked: 3, marginRaisedBy: 0, decimationError: 0, searchMm: 8 });
    const rim = p.field!.value.rim;
    const box = moldBox(rim);
    expect([report.box.x, report.box.y, report.box.z]).toEqual(box);
    expect(report.tiles).toEqual([[0, 0]]);
    const placed = p.placement!.value.placement.openings;
    expect(report.openings.map((o) => [o.id, o.kind, o.x, o.y, o.pinned, o.copies])).toEqual(placed.map((o) => [o.id, o.kind, o.x, o.y, o.pinned, 1]));
    // Read off the export field, so within a preview cell or two of the preview's own figures. The lowest
    // ceiling under the disc is never above the one at its centre, which the bore's length runs down to.
    report.openings.forEach((o, k) => {
      expect(Math.abs(o.zb - placed[k].zb)).toBeLessThan(1);
      expect(Math.abs(o.boreLength - placed[k].boreLength)).toBeLessThan(1);
      expect(report.box.Zt - o.zb).toBeGreaterThanOrEqual(o.boreLength);
    });
    for (const [name, part] of Object.entries(report.parts)) expect(part.triangles, name).toBe((files[name].length - 84) / 50);
    expect(report.parts['cover.stl'].volumeMm3!).toBeGreaterThan(0);
    expect(report.silicone.ml / previewSilicone(p)!.ml).toBeCloseTo(1, 1);
    // The plan's figure at the export cell, as M6b measured it, and the bores' share as M4 did on the same openings.
    expect(Math.abs(report.silicone.ml / 11.3591 - 1)).toBeLessThan(0.001);
    expect(Math.abs(report.silicone.boresMl / OPENING_GOLDEN.jersey.boreMl - 1)).toBeLessThan(0.01);
    expect(report.silicone.sealedAirMl).toBe(0);
    expect(report.silicone.grams).toBeCloseTo(report.silicone.ml * 1.1, 9);
    // The reports are part of the zip step, which is the one the timings leave out, so they have a line of their own.
    expect(Object.keys(report.timings)).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', 'fit-test', 'reports', 'total']);
    expect(JSON.parse(text(files['project.json']))).toEqual(JSON.parse(JSON.stringify(projectFile(p.project(), EXAMPLE_FILES.jersey))));
    const readme = text(files['README.txt']);
    expect(readme).toContain('The sprue rule');
    expect(readme).toContain('fit_test/');
    expect(readme).toContain(`Measured clearance: ${outputs.clearance!.measured.toFixed(2)} mm`);
    // Each auto setting with what it came to in this export, the preview's own cell apart.
    const settings = readme.slice(readme.indexOf('SETTINGS'));
    expect(settings.match(/: auto, for the preview only/g)).toHaveLength(1);
    expect(settings).toContain('- Pocket depth: auto, 0.2 mm');
    expect(settings).toContain(`- Edge distance: auto, ${Number(p.field!.value.rim.edge.minimum.toFixed(4))} mm`);
    expect(settings).toContain(`- Plane tolerance: auto, ${Number(p.oriented!.value.planeTol.toFixed(4))} mm`);
    // While the geometry is the one exported, the clearance it measured is what shows.
    expect(p.currentExport()?.clearance).toEqual(outputs.clearance);
  }, 60_000);

  it('each single part is the ZIP\'s own file, and a part the last export holds needs no worker', async () => {
    const solid = counting();
    const p = await loaded(solid.spawn);
    const single: Record<string, Uint8Array> = {};
    for (const want of ['cover', 'base', 'funnel'] as const) {
      const outputs = await p.exportParts(() => {}, undefined, { want, fitTest: false });
      expect(Object.keys(outputs.files)).toEqual([`${want}.stl`]);
      single[want] = outputs.files[`${want}.stl`];
    }
    // The gate's worker, then one per part: the base runs again, as the cover's export did not build it.
    expect(solid.spawned()).toBe(4);
    const zip = await p.exportParts();
    for (const want of ['cover', 'base', 'funnel'] as const) expect(single[want], want).toEqual(zip.files[`${want}.stl`]);
    const again = await p.exportParts(() => {}, undefined, { want: 'base', fitTest: false });
    expect(again.files['base.stl']).toEqual(zip.files['base.stl']);
    expect(solid.spawned()).toBe(5);
  }, 60_000);

  it('a part is reused only while the mold is the one last exported: a change builds it again, and changing back reuses it', async () => {
    const solid = counting();
    const p = await loaded(solid.spawn);
    const cover = (): Promise<ExportResult> => p.exportParts(() => {}, undefined, { want: 'cover', fitTest: false });
    const setT = async (t: number): Promise<void> => {
      p.setParams((params) => (params.silicone.t = t));
      await p.idle();
    };
    const zip = await p.exportParts();
    expect(solid.spawned()).toBe(2);
    await setT(3.5);
    const thicker = await cover();
    expect(solid.spawned()).toBe(3);
    expect(thicker.files['cover.stl']).not.toEqual(zip.files['cover.stl']);
    // Its key is the mold now on screen, which the ZIP's is not.
    expect(thicker.key).toBe(p.exportKeyFor('cover'));
    expect(zip.key).not.toBe(p.exportKeyFor('zip'));
    // Only the last export is kept, so back at 3 mm the cover is built again, the same as the ZIP's.
    await setT(3);
    expect(zip.key).toBe(p.exportKeyFor('zip'));
    expect((await cover()).files['cover.stl']).toEqual(zip.files['cover.stl']);
    expect(solid.spawned()).toBe(4);
    // A change and back again finds that export current, so it needs no worker.
    await setT(3.5);
    await setT(3);
    expect((await cover()).files['cover.stl']).toEqual(zip.files['cover.stl']);
    expect(solid.spawned()).toBe(4);
  }, 60_000);

  it('the fit test is a ZIP of its own, built with the user\'s taper clearance', async () => {
    const p = await loaded();
    p.setParams((params) => (params.joint.taperClearance = 0.2));
    const outputs = await p.exportParts(() => {}, undefined, { want: 'fit-test', fitTest: false });
    const names = Object.keys(unzipSync(outputs.zip)).sort();
    expect(names).toEqual([...fitVariants(p.params).flatMap((v) => [`fit_test/${v.id}_base.stl`, `fit_test/${v.id}_cover.stl`]), 'fit_test/README.txt'].sort());
    expect(names).toContain('fit_test/groove-0.35-taper-0.20_cover.stl');
  }, 60_000);

  it('Cancel ends the export at once with no file, its worker terminated, and the next export runs', async () => {
    const workers = counting();
    const p = await loaded(workers.spawn);
    p.armFault('export', { kind: 'delay', ms: 10_000 });
    const t0 = performance.now();
    const run = p.exportParts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([p.exporting, p.exportWorkerAlive]).toEqual([true, true]);
    // The gate's worker, and the export's, alive.
    expect(workers.terminated()).toEqual([false, false]);
    p.cancelExport();
    expect(workers.terminated()).toEqual([false, true]);
    await expect(run).rejects.toMatchObject({ name: 'Cancelled' });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect([p.exporting, p.exportWorkerAlive]).toEqual([false, false]);
    expect(p.currentExport()).toBeNull();
    expect(p.exportError()).toBeNull();
    const outputs = await p.exportParts();
    expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(3);

    // A cancel while it waits for the preview starts no worker at all.
    const solid = counting();
    const q = await loaded(solid.spawn);
    q.setParams((params) => (params.silicone.t = 3.5));
    const waiting = q.exportParts();
    q.cancelExport();
    await expect(waiting).rejects.toMatchObject({ name: 'Cancelled' });
    await q.idle();
    expect(solid.spawned()).toBe(1);
  }, 60_000);

  it('a new file while the export waits for the preview ends it, so nothing is made from one model under the name of another', async () => {
    const solid = counting();
    const p = await loaded(solid.spawn);
    p.setParams((params) => (params.silicone.t = 3.5));
    const waiting = p.exportParts();
    p.load(exampleBytes('barrel'), EXAMPLE_FILES.barrel);
    await expect(waiting).rejects.toMatchObject({ name: 'Replaced', message: expect.stringContaining(`the export of ${EXAMPLE_FILES.jersey} waited`) });
    expect(p.exporting).toBe(false);
    await p.idle();
    // Only the gate's worker: none was started for the export.
    expect(solid.spawned()).toBe(1);
    expect(p.exportError()).toBeNull();
    // A new file while the export itself runs does not end it: it goes on with the model it was given.
    p.armFault('export', { kind: 'delay', ms: 300 });
    const running = p.exportParts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    expect((await running).report!.model.file).toBe(EXAMPLE_FILES.barrel);
  }, 60_000);

  it('an export that waited for the preview checks the buttons\' rule again, as the rim\'s errors come with the field', async () => {
    const solid = counting();
    const p = await loaded(solid.spawn);
    // Both within the sliders' ranges, and only the field worker's rim finds that the ridge comes to nothing.
    p.setParams((params) => {
      params.joint.ridgeWidth = 0.8;
      params.joint.ridgeHeight = 4;
    });
    expect(exportBlocked(p)).toBeNull();
    await expect(p.exportParts()).rejects.toMatchObject({ name: 'Blocked', message: expect.stringContaining('Fix this first: The ridge comes to nothing') });
    expect(exportBlocked(p)).toContain('The ridge comes to nothing');
    expect(solid.spawned()).toBe(1);
    // Not a failure of the export: the error is the preview's, and shows as that.
    expect(p.exportError()).toBeNull();
  }, 60_000);

  it('an export worker that never says ready gets an inline error after 20 s, and its worker is terminated', async () => {
    // The 20 s of the bootstrap rule, run short once the model is in, so the gate's own workers keep theirs.
    let short = false;
    const timers = { set: (run: () => void, ms: number) => realTimers.set(run, short && ms === INIT_TIMEOUT_MS ? 50 : ms), clear: realTimers.clear };
    const silent = (): WorkerLike => ({ onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} });
    const solid = counting(() => (solid.spawned() === 0 ? inProcessSolid() : silent()));
    const p = await loaded(solid.spawn, () => {}, { timers });
    short = true;
    const steps: string[] = [];
    await expect(p.exportParts((s) => steps.push(s.step))).rejects.toMatchObject({ name: 'InitTimeout', message: expect.stringContaining('did not start within 20 s') });
    expect(steps).toEqual([]);
    // Not a crash, so no retry: one export worker, terminated.
    expect(solid.terminated()).toEqual([false, true]);
    expect([p.exporting, p.exportWorkerAlive]).toEqual([false, false]);
  }, 60_000);

  it('a request while the preview catches up waits for it, then exports what shows, and only Cancel ends an export', async () => {
    const p = await loaded();
    p.setParams((params) => (params.silicone.t = 3.5));
    const steps: ExportProgress[] = [];
    const run = p.exportParts((s) => steps.push(s));
    const outputs = await run;
    expect(steps[0].step).toBe('wait');
    expect(outputs.report!.params.silicone.t).toBe(3.5);
    expect(p.currentExport()).not.toBeNull();

    // A change while it runs leaves it to finish, and its clearance then no longer shows.
    p.armFault('export', { kind: 'delay', ms: 300 });
    const late = p.exportParts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    p.setParams((params) => (params.silicone.t = 3));
    const done = await late;
    expect(done.report!.params.silicone.t).toBe(3.5);
    await p.idle();
    expect(p.currentExport()).toBeNull();
    // Back on the geometry it measured, its clearance is current again.
    p.setParams((params) => (params.silicone.t = 3.5));
    await p.idle();
    expect(p.currentExport()?.clearance).toEqual(done.clearance);
  }, 60_000);

  it('a clearance measured under t raises the margin once and builds again: a warning, at least t, a larger box, and the README says so', async () => {
    // A margin of -0.6 mm, which the number box takes, leaves the first build about 0.47 mm short at jersey's thinnest point.
    const p = await loaded(inProcessSolid, (q) => q.setParams((params) => (params.silicone.printMargin = -0.6)));
    const steps: ExportProgress[] = [];
    const outputs = await p.exportParts((s) => steps.push(s));
    const { clearance, report } = outputs;
    // Raised by the shortfall plus 0.05, so the second build measures t + 0.05, give or take how the gap follows the margin.
    expect(clearance!.raisedBy).toBeCloseTo(0.515, 3);
    expect(clearance!.measured).toBeGreaterThanOrEqual(3);
    expect(Math.abs(clearance!.measured - 3.05)).toBeLessThan(0.01);
    expect(report!.clearance).toMatchObject({ measured: clearance!.measured, marginRaisedBy: clearance!.raisedBy });
    expect(outputs.diagnostics.filter((d) => d.code === 'margin-raised' || d.code === 'clearance-short')).toEqual([{ code: 'margin-raised', severity: 'warning', message: expect.stringContaining(`raised by ${clearance!.raisedBy.toFixed(2)} mm`) }]);
    // The rebuilt mold's box is larger than the one the preview shows, on every side.
    const shown = moldBox(p.field!.value.rim);
    [report!.box.x, report!.box.y, report!.box.z].forEach((size, k) => expect(size).toBeGreaterThan(shown[k] + 0.4));
    expect(outputs.rim!.Zt).toBe(report!.box.Zt);
    const readme = text(outputs.files['README.txt']).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain(`so the safety margin was raised by ${clearance!.raisedBy.toFixed(2)} mm and the mold was built again`);
    expect(readme).toContain(`Warning: ${outputs.diagnostics.find((d) => d.code === 'margin-raised')!.message}`);
    // The rebuild shows as one step where the clearance stands, so the stage bar never runs backwards.
    expect(steps.map((s) => s.step)).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'raise', 'clearance', 'files', 'zip']);
    steps.forEach((s, k) => expect(s.done, s.step).toBeGreaterThanOrEqual(k === 0 ? 0 : steps[k - 1].done));
    // A warning of the export's own, so it shows in the Export box and Diagnostics while current.
    expect(allDiagnostics(p).filter((d) => d.byExport).map((d) => [d.code, d.severity])).toEqual([['margin-raised', 'warning']]);
    expect(exportBlocked(p)).toBeNull();
  }, 60_000);

  it('an error only the export found shows in Diagnostics while its geometry is current, and does not block the buttons', async () => {
    // Silicone still under t after the raise is a case no example reaches, so the worker's reply says so here.
    const p = await loaded(editing((data) => {
      if (data.t !== 'exported') return;
      data.outputs.diagnostics.push({ code: 'clearance-short', severity: 'error', message: 'Even after a wider safety margin, the silicone is only 2.95 mm thick at its thinnest.' });
    }));
    await p.exportParts();
    expect(allDiagnostics(p).filter((d) => d.byExport).map((d) => d.code)).toEqual(['clearance-short']);
    // Exporting again is how to see such a result change, so it never turns the buttons off.
    expect(exportBlocked(p)).toBeNull();
    p.setParams((params) => (params.silicone.t = 3.2));
    await p.idle();
    expect(allDiagnostics(p).filter((d) => d.byExport)).toEqual([]);
  }, 60_000);

  it('an open mesh exports with its clearance unverified, said in words a maker can follow, and that holds while current', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(asciiStl(toSoup(withoutTriangles(box([0, 0, 0], [30, 20, 12]), [8]))), 'open box.stl');
    await p.idle();
    expect(p.diagnostics.map((d) => d.code)).toContain('soup-mode');
    const outputs = await p.exportParts();
    expect(outputs.clearance).toBeNull();
    expect(outputs.diagnostics.find((d) => d.code === 'clearance-unverified')).toEqual({ code: 'clearance-unverified', severity: 'warning', message: "The model's mesh has holes, so the silicone thickness could not be measured: the mold is planned to leave at least 3 mm, but that is not checked." });
    expect(outputs.report!.clearance).toMatchObject({ measured: null, minGap: null });
    expect(text(outputs.files['README.txt']).replace(/\r\n\s*/g, ' ')).toContain('The clearance could not be measured, as the model\'s mesh is not closed.');
    // What the status strip reads: an export is current, with no clearance measured.
    expect(p.currentExport()).not.toBeNull();
    expect(p.currentExport()!.clearance).toBeNull();
  }, 60_000);

  it('README and report.json carry what is true of the mold, not the preview\'s notes on itself or the card\'s marks', async () => {
    const p = await loaded();
    // A crash in the preview doubles its cell, which the card says, and which says nothing about the export.
    p.armFault('field', { kind: 'oob' });
    p.setParams((params) => (params.silicone.t = 3.2));
    await p.idle();
    expect(p.diagnostics.map((d) => d.code)).toContain('preview-coarser');
    const outputs = await p.exportParts();
    expect(outputs.report!.diagnostics.map((d) => d.code)).not.toContain('preview-coarser');
    expect(text(outputs.files['README.txt'])).not.toContain('the preview now runs');
    for (const d of outputs.report!.diagnostics) expect(Object.keys(d).sort()).toEqual(['code', 'message', 'severity']);
  }, 60_000);

  it('a failed export is shown in Diagnostics while its geometry is current, as it is, and not retried', async () => {
    let exports = 0;
    const p = await loaded(editing((data) => {
      exports++;
      return { t: 'error', id: 1, name: 'Error', message: 'The export field reaches past the rim at 3 nodes, so the cavity would lose clearance there.', inline: false, cached: {} };
    }));
    await expect(p.exportParts()).rejects.toThrow(/past the rim/);
    expect(exports).toBe(1);
    expect(allDiagnostics(p).find((d) => d.code === 'export-failed')).toMatchObject({ severity: 'error', byExport: true });
    expect(exportBlocked(p)).toBeNull();
    p.setParams((params) => (params.silicone.t = 3.2));
    await p.idle();
    expect(p.exportError()).toBeNull();
  }, 60_000);

  it('Mode B on a 2 x 3 grid: no model_oriented.stl, six tiles, README says Mode B and the copies, and the walls checked at the export cell', async () => {
    const p = await loaded(inProcessSolid, (q) =>
      q.setParams((params) => {
        params.base.mode = 'merged';
        params.grid.nx = 2;
        params.grid.ny = 3;
      }),
    { checkWalls: true });
    await vi.waitFor(() => expect(p.wallStatus().result).not.toBeNull(), { timeout: 30_000, interval: 50 });
    const outputs = await p.exportParts();
    // The wall check is main's, so it reaches the files as one of its notes, without the card's mark.
    const walls = outputs.report!.diagnostics.find((d) => d.code === 'tile-walls')!;
    expect(walls).toEqual({ code: 'tile-walls', severity: 'info', message: expect.stringContaining('The thinnest wall between models is') });
    expect(text(outputs.files['README.txt']).replace(/\r\n\s*/g, ' ')).toContain(walls.message);
    expect(Object.keys(outputs.files).sort()).toEqual(['README.txt', 'base.stl', 'cover.stl', 'funnel.stl', 'project.json', 'report.json']);
    expect(outputs.report!.tiles).toHaveLength(6);
    expect(outputs.report!.tiles).toEqual(p.field!.value.mold.offsets);
    expect(outputs.report!.openings.every((o) => o.copies === 6)).toBe(true);
    const readme = text(outputs.files['README.txt']).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('Mode B: the model is part of the base.');
    expect(readme).toContain('2 x 3 copies of the model, every');
    const pours = outputs.report!.openings.filter((o) => o.kind === 'pour').length * 6;
    expect(readme).toContain(`Print ${pours}, one for each pour opening.`);
  }, 120_000);
});
