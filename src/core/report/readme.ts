import { RISING_LEVEL_NOTE } from '../analysis/air';
import { demoldSteps, hintWords, placeWords, VERDICT_MEANING, VERDICT_WORDS, type GeometryReports } from '../analysis/reports';
import { GROUP_TITLES, PARAM_SCHEMA, type ParamDef, type Params } from '../params/schema';
import { SEAL_SPACING_MM, type ClampAdvice, type CoverLift } from './clamp';
import type { Diagnostic } from './diagnostics';
import type { PlasticEstimate } from './printability';

/** Everything the README of an export ZIP says, as measured or chosen. */
export interface ReadmeInput {
  app: string;
  version: string;
  /** The STL the mold was made from, which may be any name at all. */
  model: string;
  params: Params;
  /** What each auto setting left to its rule came to in this export, by its path, such as base.pocketDepth. */
  resolved: Record<string, number>;
  /** The files in the ZIP besides this one, by path. */
  files: string[];
  /** Pour openings across the whole mold, which is how many funnels to print. */
  pours: number;
  vents: number;
  tiles: number;
  /** From one copy to the next, in mm, when there is more than one. */
  pitch: [number, number] | null;
  /** The assembled mold: the cover's outside, and from the base's underside to the flat top. */
  box: [number, number, number];
  /** Null for an open mesh, which has no solid to measure. */
  clearance: { measured: number; error: number; raisedBy: number } | null;
  silicone: { ml: number; grams: number };
  /** S9: the demold estimate and the air, or null when the export could not work them out. */
  reports: GeometryReports | null;
  /** Why the reports could not be worked out, when they could not. */
  reportsError: string | null;
  /** The cover's lift and the tape that holds it, which need no S8. */
  tape: { lift: CoverLift; clamp: ClampAdvice };
  plastic: PlasticEstimate;
  /** Every diagnostic in force, the preview's and the export's. */
  diagnostics: Diagnostic[];
}

/** Lines are kept short for any editor, and end in CRLF, so Windows Notepad shows them as they are. */
const WIDTH = 76;
const EOL = '\r\n';

/** Letters that keep no plain form when their accents come off: l and L with a stroke, o slash, d bar, sharp s, ae, oe. */
const PLAIN_LETTERS: Record<string, string> = {
  'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D',
  'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
};

/**
 * Text as plain ASCII: a model's file name can hold any letter, as Polish ones do. Accents come off,
 * and what still has no ASCII form becomes '?'.
 */
export function ascii(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, (c) => PLAIN_LETTERS[c] ?? (/\s/.test(c) ? ' ' : '?'));
}

/**
 * Words to lines of at most WIDTH, the first after `first`, the rest after `rest`, in plain ASCII. A word
 * longer than a whole line, such as a long file name, is broken where the line ends.
 */
function wrap(text: string, first = '', rest = first): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  const next = (): void => {
    lines.push(line);
    line = rest;
    empty = true;
  };
  for (const word of ascii(text).split(/\s+/).filter(Boolean)) {
    let left = word;
    while (left.length > 0) {
      const room = WIDTH - line.length - (empty ? 0 : 1);
      if (left.length <= room) {
        line += (empty ? '' : ' ') + left;
        empty = false;
        break;
      }
      if (!empty && (left.length <= WIDTH - rest.length || room <= 0)) {
        next();
        continue;
      }
      line += (empty ? '' : ' ') + left.slice(0, room);
      left = left.slice(room);
      next();
    }
  }
  lines.push(line);
  return lines;
}

function heading(title: string): string[] {
  return ['', title.toUpperCase(), '-'.repeat(title.length)];
}

const mm = (value: number, digits = 1): string => `${Number(value.toFixed(digits))} mm`;

const grams = (g: number): string => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(0)} g`);

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * README.txt of the export ZIP, for the maker who prints and pours the mold: what each file is and
 * how to print it, the pour and the D2 demold workflow, the sprue rule, the checks to make before the
 * first pour, what was measured, and every warning in force. Plain ASCII.
 */
export function exportReadme(input: ReadmeInput): string {
  const { params, files, clearance } = input;
  const glue = params.base.mode === 'glue';
  const t = params.silicone.t;
  const has = (name: string): boolean => files.includes(name);
  const out: string[] = [];
  const para = (text: string): void => {
    out.push('', ...wrap(text));
  };
  const item = (text: string): void => {
    out.push(...wrap(text, '- ', '  '));
  };
  const step = (n: number, text: string): void => {
    out.push(...wrap(text, `${n}. `, '   '));
  };

  const title = wrap(`${input.model.replace(/\.stl$/i, '')}: silicone casting mold`);
  out.push(...title, '='.repeat(Math.max(...title.map((line) => line.length))));
  const copies = input.tiles;
  para(`Made by ${input.app} ${input.version} from ${input.model}. This ZIP holds a two-part plastic mold box, a base and a cover. You print both, join them, and pour silicone into the space between your model and the cover. The cured silicone is your casting mold.`);

  out.push(...heading('The files'));
  out.push('', 'cover.stl');
  out.push(...wrap(`The cover: a box whose inside follows your model with ${mm(t)} of room for silicone, with the pour and vent openings in its flat top. Print it as it is saved: it is already turned flat top down on the bed. It needs no supports, as its only overhang is the cone of each funnel seat, at ${params.seat.halfAngleDeg} degrees from vertical.`, '  '));
  out.push('', 'base.stl');
  out.push(...wrap(glue
    ? `The base plate, with a ridge that fits the groove in the cover and a shallow pocket that your model is glued into. Print it as it is saved, flat underside on the bed.`
    : `The base plate with your model built onto it, and a ridge that fits the groove in the cover. Print it as it is saved, flat underside on the bed. The model's own overhangs may need supports in your slicer.`, '  '));
  if (has('model_oriented.stl')) {
    out.push('', 'model_oriented.stl');
    const quantity = copies === 1 ? '' : ` Print ${copies} copies of it, one for each of the ${copies} pockets in the base.`;
    out.push(...wrap(`Your model, turned so that its base face lies flat at the bottom, ready to glue into ${copies === 1 ? 'the pocket' : 'a pocket'} of the base.${quantity} Print it however suits it best, for example on a resin printer, and glue its flat face into the pocket.`, '  '));
  }
  if (has('funnel.stl')) {
    out.push('', 'funnel.stl');
    out.push(...wrap(`The pour funnel. Print ${input.pours === 1 ? 'one' : `${input.pours}, one for each pour opening`}. Print it as it is saved, wide rim down. Its spigot sits in the cone-shaped seat at the top of a pour opening.`, '  '));
  }
  if (files.some((name) => name.startsWith('fit_test/'))) {
    out.push('', 'fit_test/');
    out.push(...wrap('Small test pieces of the joint between base and cover, to find the clearances that suit your printer before you print the real mold. fit_test/README.txt says how to read them.', '  '));
  }
  out.push('', 'report.json and project.json');
  out.push(...wrap(`Every number of this export, and the settings it was made with. To make the same mold again, open ${input.model} in the app, then open this ZIP or its project.json there: the settings, the base face and the openings come back as they were. project.json records the STL's SHA-256, so the app can tell whether the model is the same.`, '  '));

  out.push(...heading('Printing'));
  item('The parts are saved the way up they print best, so do not flip them over or lay them on another side in your slicer. Turning one about the vertical axis to fit your bed is fine.');
  item(`About ${Math.round(params.print.infill * 100)} percent infill is enough. Use at least 3 walls (perimeters) and 4 top and bottom layers, so the surfaces that touch silicone are solid and nothing seeps through.`);
  item(`Use the layer height of ${mm(params.print.layerHeight, 2)} this mold was made for: the base and its pocket are sized in whole layers of it.`);
  item(`Plastic: about ${grams(input.plastic.printed)} at that infill, or ${grams(input.plastic.solid)} printed solid. This is an estimate: slicers differ.`);

  out.push(...heading('Before the first pour'));
  step(1, 'Cure-inhibition test: some resins, glues, paints and plastics stop silicone from curing where they touch it, and platinum-cure silicone is the sensitive kind. Pour a small test patch of your silicone onto a scrap printed in the same resin, with the same glue you will use, and let it cure fully. If it stays sticky where it touches, seal the model first, for example with a clear coat, and test again.');
  step(2, 'Leak test: assemble and tape the mold as below, and fill it with water through the pour opening until water shows at the vents. Let it stand for several minutes: the joint should stay dry. Pour the water out and let the mold dry fully before you use silicone.');

  out.push(...heading('Pouring'));
  let n = 0;
  if (glue) step(++n, copies === 1 ? 'Glue the model into the pocket of the base, flat face down, and let the glue cure.' : `Glue a model into each of the ${copies} pockets of the base, flat face down, and let the glue cure.`);
  step(++n, `Fit the base into the cover: the ridge on the base goes into the groove of the cover. Press until the base rests on the cover's shelf all round. It then stands ${mm(params.joint.baseProud, 2)} proud of the cover's bottom edge, which is meant: the tape pulls the base against the shelf.`);
  const { clamp, lift } = input.tape;
  const head = lift.level > input.box[2] - params.base.thickness ? 'up to the rim of a full funnel' : 'up to the flat top';
  step(++n, `Tape the joint with at least ${plural(clamp.strips, 'strip')} of tape at ${figure(clamp.stripN)} N each, each running from a side wall of the cover across the base to the opposite wall: at least ${clamp.across[0]} from front to back and ${clamp.across[1]} from left to right, spread evenly, no more than about ${SEAL_SPACING_MM} mm apart along any wall, so the tape presses the seal all round. Liquid silicone ${head} pushes the cover up with about ${lift.forceN.toFixed(1)} N, and the tape should hold twice that, and never less than 10 N: here ${clamp.holdN.toFixed(1)} N, which ${clamp.liftStrips === 1 ? 'one strip holds' : `${clamp.liftStrips} of the strips hold`}. A thin film of Vaseline in the groove, before you fit the base, makes the seal better.`);
  const collide = input.diagnostics.some((d) => d.code === 'funnel-collision');
  const funnels = !has('funnel.stl')
    ? ''
    : collide
      ? ' The funnels would touch at this spacing, so either print them with the smaller top diameter the funnel warning below suggests, or pour through one funnel at a time, moving it from seat to seat.'
      : ' Push a funnel into the seat of each pour opening.';
  step(++n, `Stand the mold on its base on a level surface.${funnels}`);
  step(++n, `Mix and degas the silicone. Pour it slowly, in a thin stream, into the pour opening${input.pours === 1 ? '' : 's'}, until silicone shows at every vent. This mold has ${plural(input.pours, 'pour opening')} and ${plural(input.vents, 'vent')}.`);
  step(++n, 'Let it cure for the full time the maker of your silicone gives.');
  if (params.seat.enabled) para("The sprue rule: if you pour without a funnel, silicone fills the cone-shaped seat at the top of each pour opening. Cut that sprue at the floor of the seat, where the cone meets the straight bore, and not flush with the top. A cone of silicone left in the seat is wider than the bore under it, so it would lock the mold in the cover.");
  else para('The pour openings have no funnel seat, so cut the silicone in each of them flush with the top.');

  out.push(...heading('Demolding'));
  const reports = input.reports;
  if (reports) {
    const { demold, centre, tiles } = reports;
    out.push(...wrap(`Estimate: ${VERDICT_WORDS[demold.verdict].toLowerCase()}. ${VERDICT_MEANING[demold.verdict]} This is worked out from the model's shape alone${tiles > 1 ? `, and holds for each of the ${tiles} copies alike` : ''}, so treat it as a guide.`));
    const measured = `measured from the middle of the model${tiles > 1 ? ' in the first copy' : ''}, with the front being the side you face in the app's first view`;
    const cut = demold.hints.filter((h) => h.cuts), held = demold.hints.filter((h) => !h.cuts);
    if (cut.length > 0) {
      out.push('', ...wrap(`Cut the silicone at ${cut.length === 1 ? 'this place' : 'these places'}, where it holds the model in a loop, ${measured}:`));
      for (const hint of cut) item(hintWords(hint, centre, demold.verdict));
    }
    if (held.length > 0) {
      out.push('', ...wrap(`${cut.length > 0 ? 'It also holds the model here' : 'Where the silicone holds the model'}, ${cut.length > 0 ? 'but can stretch off' : measured}:`));
      for (const hint of held) item(hintWords(hint, centre, demold.verdict));
    }
  } else {
    out.push(...wrap(`The demold estimate could not be worked out for this export (${input.reportsError ?? 'no reason given'}), so look over the model for overhangs and holes yourself before you demold.`));
  }
  out.push('');
  demoldSteps(reports?.demold.verdict ?? null, params).forEach((text, k) => step(k + 1, text));
  para("The cover's flat top is now the bottom of your mold: turn it over, and cast into the opening.");

  out.push(...heading('Air'));
  if (reports) {
    const { air, centre } = reports;
    if (air.uncovered.length === 0) item(air.ceilingLeaves === 1 ? 'The one peak of the cover\'s ceiling has an opening, so its air gets out.' : `All ${air.ceilingLeaves} peaks of the cover's ceiling have an opening, so their air gets out.`);
    else item(`${air.uncovered.length} of the ${air.ceilingLeaves} peaks of the cover's ceiling have no opening, so air stays there: see the warnings.`);
    if (air.underside.length === 0) item('No pocket under the model traps air.');
    for (const p of air.underside) item(`Air stays in a pocket under an overhang of the model, ${placeWords([p.x, p.y, p.z], centre)}, about ${(p.volume / 1000).toFixed(2)} ml. No vent in the top reaches it: brush a first coat of silicone onto the model there, tilt the mold as you pour, or degas the poured mold in a vacuum.`);
    for (const d of air.sealed) item(d.inModel ? `${(d.volume / 1000).toFixed(2)} ml is a sealed hollow inside the model, which no silicone reaches.` : `${(d.volume / 1000).toFixed(2)} ml of space is closed off between the model and the base, so no silicone goes there. That is harmless.`);
  } else {
    item('The air report could not be worked out for this export.');
  }
  para(RISING_LEVEL_NOTE);

  out.push(...heading('This mold'));
  item(`Silicone thickness asked for: ${mm(t, 2)}.`);
  if (clearance) {
    const simplified = clearance.error > 0 ? `, measured on a simplified copy of the model with its error of ${clearance.error.toFixed(3)} mm taken off` : '';
    item(`Measured clearance: ${clearance.measured.toFixed(2)} mm at the thinnest point between the model and the cover${simplified}.`);
    if (clearance.raisedBy > 0) item(`The first build measured less than ${mm(t, 2)}, so the safety margin was raised by ${clearance.raisedBy.toFixed(2)} mm and the mold was built again. The cavity and the box are a little larger than the preview showed.`);
  } else {
    item(`The clearance could not be measured, as the model's mesh is not closed. The mold is planned to leave at least ${mm(t, 2)}, but that is not verified.`);
  }
  item(`Silicone: about ${input.silicone.ml.toFixed(0)} ml, ${input.silicone.grams.toFixed(0)} g at ${params.silicone.density} g/cm3. Mix a little more, for what stays in the cup.`);
  item(`Mold box: ${input.box.map((v) => v.toFixed(1)).join(' x ')} mm, with a base ${mm(params.base.thickness)} thick.`);
  if (input.tiles > 1 && input.pitch) item(`${params.grid.nx} x ${params.grid.ny} copies of the model, every ${input.pitch[0].toFixed(2)} x ${input.pitch[1].toFixed(2)} mm.`);
  item(glue ? 'Mode A: the model is printed on its own and glued into the base.' : 'Mode B: the model is part of the base.');

  const problems = input.diagnostics.filter((d) => d.severity !== 'info');
  const notes = input.diagnostics.filter((d) => d.severity === 'info');
  out.push(...heading('Warnings'));
  if (problems.length === 0) out.push('None.');
  for (const d of problems) item(`${d.severity === 'error' ? 'Error' : 'Warning'}: ${d.message}`);
  if (notes.length > 0) {
    out.push(...heading('Notes'));
    for (const d of notes) item(d.message);
  }

  out.push(...heading('Estimates'));
  out.push(...wrap(`The ${mm(t, 2)} silicone thickness${t === 3 ? ', which is the default,' : ''} and the way the silicone fills the mold from the top are estimates. No published source shows that 3 mm holds up in use, and only a test pour shows how your silicone flows and where air stays. Make a test pour before you rely on this mold.`));

  out.push(...heading('Settings'));
  out.push(...wrap('Every setting this mold was made with, by the names the app gives them. project.json holds the same.'));
  for (const [group, defs] of Object.entries(PARAM_SCHEMA) as [string, Record<string, ParamDef>][]) {
    out.push('', GROUP_TITLES[group]);
    for (const [key, def] of Object.entries(defs)) {
      const path = `${group}.${key}`;
      item(`${def.label}: ${settingText(path, def, (params as unknown as Record<string, Record<string, unknown>>)[group][key], input.resolved[path])}`);
    }
  }
  out.push('');
  return out.join(EOL);
}

const figure = (value: number): string => String(Number(value.toFixed(4)));

/** One setting as README.txt lists it: its value and unit, or what an auto setting came to. */
function settingText(path: string, def: ParamDef, value: unknown, resolved: number | undefined): string {
  if (def.kind === 'flag') return value ? 'on' : 'off';
  if (def.kind === 'choice') return value === 'glue' ? 'glue (Mode A)' : value === 'merged' ? 'merged (Mode B)' : String(value);
  const unit = def.unit ? ` ${def.unit}` : '';
  if (path === 'print.infill') return `${figure(value as number)} (${Math.round((value as number) * 100)} percent)`;
  if (value !== null) return `${figure(value as number)}${unit}`;
  return resolved === undefined ? 'auto, for the preview only' : `auto, ${figure(resolved)}${unit}`;
}
