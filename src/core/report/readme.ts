import { GROUP_TITLES, PARAM_SCHEMA, type ParamDef, type Params } from '../params/schema';
import type { Diagnostic } from './diagnostics';

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
  out.push(...wrap('Every number of this export, and the settings it was made with, so the same mold can be made again.', '  '));

  out.push(...heading('Printing'));
  item('The parts are already turned to how they print best, so do not rotate them in your slicer.');
  item(`About ${Math.round(params.print.infill * 100)} percent infill is enough. Use at least 3 walls (perimeters) and 4 top and bottom layers, so the surfaces that touch silicone are solid and nothing seeps through.`);
  item(`Use the layer height of ${mm(params.print.layerHeight, 2)} this mold was made for: the base and its pocket are sized in whole layers of it.`);

  out.push(...heading('Before the first pour'));
  step(1, 'Cure-inhibition test: some resins, glues, paints and plastics stop silicone from curing where they touch it, and platinum-cure silicone is the sensitive kind. Pour a small test patch of your silicone onto a scrap printed in the same resin, with the same glue you will use, and let it cure fully. If it stays sticky where it touches, seal the model first, for example with a clear coat, and test again.');
  step(2, 'Leak test: assemble and tape the mold as below, and fill it with water through the pour opening until water shows at the vents. Let it stand for several minutes: the joint should stay dry. Pour the water out and let the mold dry fully before you use silicone.');

  out.push(...heading('Pouring'));
  let n = 0;
  if (glue) step(++n, copies === 1 ? 'Glue the model into the pocket of the base, flat face down, and let the glue cure.' : `Glue a model into each of the ${copies} pockets of the base, flat face down, and let the glue cure.`);
  step(++n, `Fit the base into the cover: the ridge on the base goes into the groove of the cover. Press until the base rests on the cover's shelf all round. It then stands ${mm(params.joint.baseProud, 2)} proud of the cover's bottom edge, which is meant: the tape pulls the base against the shelf.`);
  step(++n, 'Tape the joint all round, running each strip from the side walls of the cover across the base. A thin film of Vaseline in the groove, before you fit the base, makes the seal better.');
  step(++n, `Stand the mold on its base on a level surface.${has('funnel.stl') ? ' Push a funnel into the seat of each pour opening.' : ''}`);
  step(++n, `Mix and degas the silicone. Pour it slowly, in a thin stream, into the pour opening${input.pours === 1 ? '' : 's'}, until silicone shows at every vent. This mold has ${plural(input.pours, 'pour opening')} and ${plural(input.vents, 'vent')}.`);
  step(++n, 'Let it cure for the full time the maker of your silicone gives.');
  para("The sprue rule: if you pour without a funnel, silicone fills the cone-shaped seat at the top of each pour opening. Cut that sprue at the floor of the seat, where the cone meets the straight bore, and not flush with the top. A cone of silicone left in the seat is wider than the bore under it, so it would lock the mold in the cover.");

  out.push(...heading('Demolding'));
  step(1, `Cut the sprues: take out the funnels${has('funnel.stl') ? '' : ' if you used any'}, cut each pour sprue at the floor of its seat by the sprue rule, and cut the silicone in each vent flush with the top.`);
  step(2, `Take off the tape. Lever the base out${params.joint.pryNotches ? ' at the pry notches on the bottom edge of the cover' : ''}, and slide the silicone out of the cover with the model still inside it. The cover widens towards the base, so the silicone can slide out that way.`);
  step(3, 'Flex the silicone to free the model, or cut it with a sharp blade where it holds the model, in a wavy line so the cut faces line up again.');
  step(4, 'Take out the model.');
  step(5, "Put the silicone back into the cover, the way it came out. The cover holds it in shape. The cover's flat top is now the bottom of your mold: turn it over, and cast into the opening.");

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
