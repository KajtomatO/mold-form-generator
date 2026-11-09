import { RISING_LEVEL_NOTE } from '../analysis/air';
import { demoldSteps, hintWords, placeWords, VERDICT_MEANING, VERDICT_WORDS, type GeometryReports } from '../analysis/reports';
import { GROUP_TITLES, PARAM_SCHEMA, type ParamDef, type Params } from '../params/schema';
import type { BoltLayout } from '../parts/bolts';
import { SEAL_SPACING_MM, type BoltAdvice, type ClampAdvice, type CoverLift } from './clamp';
import type { Diagnostic } from './diagnostics';
import type { PlasticEstimate } from './printability';
import { EOL, wrap } from './text';

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
  /** M10: the bolts and the tape they still need, or null with the bolts off. */
  bolts: { layout: BoltLayout; advice: BoltAdvice } | null;
  plastic: PlasticEstimate;
  /** Every diagnostic in force, the preview's and the export's. */
  diagnostics: Diagnostic[];
  /** The file's separate parts, voids aside, and the bodies they make once those that overlap or touch are one. */
  parts: { count: number; bodies: number };
}

function heading(title: string): string[] {
  return ['', title.toUpperCase(), '-'.repeat(title.length)];
}

const mm = (value: number, digits = 1): string => `${Number(value.toFixed(digits))} mm`;

const grams = (g: number): string => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(0)} g`);

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The sprue rule of README.txt, with a funnel seat. docs/WORKFLOW.md is held to its words. */
export const SPRUE_RULE = 'The sprue rule: if you pour without a funnel, silicone fills the cone-shaped seat at the top of each pour opening. Cut that sprue at the floor of the seat, where the cone meets the straight bore, and not flush with the top. A cone of silicone left in the seat is wider than the bore under it, so it would lock the mold in the cover.';

/** Said where air stays under an overhang: nobody has tried a vacuum on a printed mold yet. */
export const VACUUM_NOTE = 'A vacuum on the filled mold could also draw that air out, but it is untested on printed molds: air held in the infill may come through the walls into the silicone. Try it first on a fit-test pair filled with silicone, and look for bubbles at its walls.';

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
  const bolts = input.bolts;
  const overhang = bolts
    ? `It needs no supports: its only overhangs are the cone of each funnel seat, at ${params.seat.halfAngleDeg} degrees from vertical, and the ceiling of each nut slot in its corners, a ${mm(bolts.layout.slotWidth)} bridge your slicer prints straight across the slot, with one layer of plastic left across the end of the bolt hole so the bridge prints whole.`
    : `It needs no supports, as its only overhang is the cone of each funnel seat, at ${params.seat.halfAngleDeg} degrees from vertical.`;
  out.push(...wrap(`The cover: a box whose inside follows your model with ${mm(t)} of room for silicone, with the pour and vent openings in its flat top. Print it as it is saved: it is already turned flat top down on the bed. ${overhang}`, '  '));
  out.push('', 'base.stl');
  const holes = bolts ? ` A countersunk hole in each corner takes a bolt from below.` : '';
  out.push(...wrap(glue
    ? `The base plate, with a ridge that fits the groove in the cover and a shallow pocket that your model is glued into.${holes} Print it as it is saved, flat underside on the bed.`
    : `The base plate with your model built onto it, and a ridge that fits the groove in the cover.${holes} Print it as it is saved, flat underside on the bed. The model's own overhangs may need supports in your slicer.`, '  '));
  if (has('model_oriented.stl')) {
    out.push('', 'model_oriented.stl');
    const quantity = copies === 1 ? '' : ` Print ${copies} copies of it, one for each of the ${copies} pockets in the base.`;
    // The file's parts stay as they are: the mold took them as one, and a slicer does too.
    const { count, bodies } = input.parts;
    const parts = count > bodies ? ` It keeps the ${count} parts your file is made of, ${bodies === 1 ? 'which' : 'some of which'} overlap or touch, as the file has them: slicers print overlapping parts as one.` : '';
    out.push(...wrap(`Your model, turned so that its base face lies flat at the bottom, ready to glue into ${copies === 1 ? 'the pocket' : 'a pocket'} of the base.${quantity}${parts} Print it however suits it best, for example on a resin printer, and glue its flat face into the pocket.`, '  '));
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

  if (bolts) {
    const { layout } = bolts;
    const f = layout.fastener;
    out.push(...heading('Hardware'));
    out.push(...wrap('To buy, for the bolts that hold the base to the cover:'));
    // A length the warnings reject would be bought for nothing, as the holes are cut for the length set.
    const misfit = bolts.advice.lengthFits ? '' : ` Not yet: this length does not fit this mold (see Warnings below), so set Bolt length in the app to the length the warning gives and export again before you buy.`;
    item(`${layout.spots.length} x ${layout.size} x ${layout.length} mm countersunk screws with a 90 degree head, ${f.screw === 'ISO 10642' ? 'ISO 10642 (hex socket) or DIN 7991' : `${f.screw} (hexalobular socket) or ISO 7046`}. The length is measured over the head.${misfit}`);
    item(`${layout.spots.length} x ${layout.size} hex nuts, ISO 4032: ${mm(f.nutFlats)} across the flats, ${mm(f.nutHeight)} high.`);
    // The slot is the nut's flats wide and ends in a point, so the nut goes in turned with a corner leading.
    para(`Fit the nuts before you assemble the mold: push one into the slot in each corner of the cover, from the side wall, corner first, with two of its flats against the sides of the slot, until its leading corner stops at the end of the slot, over the hole. The bolts go in from under the base. The first time, each one pushes through a thin layer of plastic between its hole and the nut slot, under the nut, before it reaches the nut. That layer is meant: it lets the slot's ceiling print as a whole bridge.`);
  }

  out.push(...heading('Printing'));
  item('The parts are saved the way up they print best, so do not flip them over or lay them on another side in your slicer. Turning one about the vertical axis to fit your bed is fine.');
  item(`About ${Math.round(params.print.infill * 100)} percent infill is enough. Use at least 3 walls (perimeters) and 4 top and bottom layers, so the surfaces that touch silicone are solid and nothing seeps through.`);
  item(`Use the layer height of ${mm(params.print.layerHeight, 2)} this mold was made for: the base and its pocket are sized in whole layers of it.`);
  item(`Plastic: about ${grams(input.plastic.printed)} at that infill, or ${grams(input.plastic.solid)} printed solid. This is an estimate: slicers differ.`);

  // With the bolts, tape is needed only where they stand far apart or hold too little.
  const taped = !bolts || bolts.advice.strips > 0;
  const underside = input.reports?.air.underside.length ?? 0;
  out.push(...heading('Before the first pour'));
  const touches = [glue ? 'a dab of the glue you will use' : '', taped ? 'a strip of the tape' : '', 'a smear of the Vaseline'].filter(Boolean);
  const touching = touches.length === 1 ? touches[0] : `${touches.slice(0, -1).join(', ')} and ${touches[touches.length - 1]}`;
  const scraps = glue
    ? 'Print a small scrap in the material of your model, a resin if you print it on a resin printer, and one in the material of the base and the cover.'
    : 'Print a small scrap in the material of the base, which carries your model, and the cover.';
  step(1, `Cure-inhibition test: some resins, plastics, glues, tapes and sealants stop silicone from curing where they touch it, and platinum-cure silicone is the sensitive kind. ${scraps} Put ${touching} on them, pour a small test patch of your silicone over all of it, and let it cure fully. If it stays sticky or soft anywhere it touches, do not use that material as it is: seal it, for example with a clear coat, or choose another, and test again.`);
  step(2, `Leak test${glue ? ', before you glue the model in' : ''}: seal the mold as below, with the Vaseline in the groove and the ${bolts ? 'bolts' : 'tape'}, then fill it with water through the pour opening until water shows at the vents. Let it stand for several minutes: the joint should stay dry. Pour the water out, take the mold apart, and let the parts dry fully. Seal it the same way again for the pour: the test checks your print and your way of sealing it.`);

  out.push(...heading('Pouring'));
  let n = 0;
  if (glue) step(++n, copies === 1 ? 'Glue the model into the pocket of the base, flat face down, and let the glue cure.' : `Glue a model into each of the ${copies} pockets of the base, flat face down, and let the glue cure.`);
  // The coat goes on while the model can still be reached, before the mold is closed.
  if (underside > 0) step(++n, `Air would stay in ${underside === 1 ? 'a pocket' : `${underside} pockets`} under an overhang of the model, as AIR below says. Mix a small batch of silicone and brush a thin first coat onto the model there now, then close the mold and pour the rest within the time your silicone's data sheet gives for a second coat to bond.`);
  step(++n, 'Spread a thin film of Vaseline in the groove of the cover: it helps the joint seal.');
  step(++n, `Fit the base into the cover: the ridge on the base goes into the groove of the cover. Press until the base rests on the cover's shelf all round. It then stands ${mm(params.joint.baseProud, 2)} proud of the cover's bottom edge, which is meant: the ${bolts ? 'bolts pull' : 'tape pulls'} the base against the shelf.`);
  const { clamp, lift } = input.tape;
  const head = lift.level > input.box[2] - params.base.thickness ? 'up to the rim of a full funnel' : 'up to the flat top';
  if (bolts) {
    const { layout, advice } = bolts;
    const holds = !advice.lengthFits
      ? `which the ${layout.spots.length} bolts hold only at a length that fits this mold: see Warnings`
      : advice.boltsHoldN >= advice.holdN ? `which the ${layout.spots.length} bolts hold, at about ${advice.boltsHoldN} N together when snug, an estimate for printed plastic` : `more than the ${layout.spots.length} bolts hold, at about ${advice.boltsHoldN} N together when snug, so the tape below makes up the rest`;
    step(++n, `Put an ${layout.size} x ${layout.length} mm countersunk screw up through each corner hole of the base and turn it into its nut until it is snug and its head sits flush in the countersink. Tighten them in turn, a little at a time, and no more than snug: a printed plate bends if the screws are forced, and the seal then opens between the corners. Liquid silicone ${head} pushes the cover up with about ${lift.forceN.toFixed(1)} N, and the joint should hold twice that, and never less than 10 N: here ${advice.holdN.toFixed(1)} N, ${holds}.`);
    const middle = advice.middle;
    if (advice.strips > 0) {
      const where = [middle[0] > 0 ? `${middle[0]} from front to back` : '', middle[1] > 0 ? `${middle[1]} from left to right` : ''].filter(Boolean).join(' and ');
      const why = advice.liftStrips > advice.middle[0] + advice.middle[1]
        ? `the bolts hold about ${advice.boltsHoldN} N together, under the ${advice.holdN.toFixed(1)} N twice the lift asks for`
        : `the bolts stand ${advice.spans.map((v) => v.toFixed(0)).join(' and ')} mm apart, and a printed plate bends between bolts more than about ${SEAL_SPACING_MM} mm apart`;
      step(++n, `Tape the middle of the joint too, as ${why}: at least ${plural(advice.strips, 'strip')} of tape at ${figure(advice.stripN)} N each${where ? `, ${where}` : ''}, each from a side wall of the cover across the base to the opposite wall, spread evenly between the bolts.`);
    }
  } else {
    step(++n, `Tape the joint with at least ${plural(clamp.strips, 'strip')} of tape at ${figure(clamp.stripN)} N each, each running from a side wall of the cover across the base to the opposite wall: at least ${clamp.across[0]} from front to back and ${clamp.across[1]} from left to right, spread evenly, no more than about ${SEAL_SPACING_MM} mm apart along any wall, so the tape presses the seal all round. Liquid silicone ${head} pushes the cover up with about ${lift.forceN.toFixed(1)} N, and the tape should hold twice that, and never less than 10 N: here ${clamp.holdN.toFixed(1)} N, which ${clamp.liftStrips === 1 ? 'one strip holds' : `${clamp.liftStrips} of the strips hold`}.`);
  }
  const collide = input.diagnostics.some((d) => d.code === 'funnel-collision');
  const funnels = !has('funnel.stl')
    ? ''
    : collide
      ? ' The funnels would touch at this spacing, so either print them with the smaller top diameter the funnel warning below suggests, or pour through one funnel at a time, moving it from seat to seat.'
      : ' Push a funnel into the seat of each pour opening.';
  step(++n, `Stand the mold on its base on a level surface.${funnels}`);
  step(++n, `Mix the silicone, and degas it in the cup if you have a vacuum chamber. Pour it slowly, in a thin stream, into the pour opening${input.pours === 1 ? '' : 's'}, until silicone shows at every vent. This mold has ${plural(input.pours, 'pour opening')} and ${plural(input.vents, 'vent')}.`);
  step(++n, 'Let it cure for the full time the maker of your silicone gives.');
  if (params.seat.enabled) para(SPRUE_RULE);
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
    for (const p of air.underside) item(`Air stays in a pocket under an overhang of the model, ${placeWords([p.x, p.y, p.z], centre)}, about ${(p.volume / 1000).toFixed(2)} ml. No vent in the top reaches it: brush a first coat of silicone onto the model there before you close the mold, as POURING says, or tilt the mold as you pour.`);
    for (const d of air.sealed) item(d.inModel ? `${(d.volume / 1000).toFixed(2)} ml is a sealed hollow inside the model, which no silicone reaches.` : `${(d.volume / 1000).toFixed(2)} ml of space is closed off between the model and the base, so no silicone goes there. That is harmless.`);
    if (air.underside.length > 0) para(VACUUM_NOTE);
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
  const layer = params.silicone.baseLayer ?? t;
  const together = input.tiles > 1 ? ', which joins the copies into one mold' : '';
  const slope = params.silicone.baseLayerSlopeDeg > 0 ? `, rising towards the model by ${params.silicone.baseLayerSlopeDeg} degrees so air under it reaches the vents` : ', with a flat top';
  item(layer > 0 ? `Base layer: silicone at least ${mm(layer, 2)} thick over the whole base plate inside the joint${together}${slope}.` : 'Base layer: none, so the silicone is a jacket around the model only.');
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
