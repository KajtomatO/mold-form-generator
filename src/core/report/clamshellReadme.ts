import { RISING_LEVEL_NOTE } from '../analysis/air';
import { hintWords, placeWords, VERDICT_WORDS } from '../analysis/reports';
import type { SeamAxis } from '../field/side';
import { moldTypeOf, type MoldTypeId } from '../mold/types';
import { defaultOf } from '../params/defaults';
import { GROUP_TITLES, PARAM_SCHEMA, type ParamDef } from '../params/schema';
import type { ParamPath } from '../../app/stages';
import type { ClipLayout } from '../parts/clips';
import type { SeamBoltLayout } from '../parts/seamBolts';
import type { Belts, ClampAdvice, ClipAdvice, SeamBoltAdvice } from './clamp';
import { grams, heading, mm, plural, settingText, SPRUE_RULE, type ReadmeInput } from './readme';
import { EOL, wrap } from './text';

/**
 * MP5: README.txt of the two-part cover's export (G13.10.11, G13.10.14, G13.10.19, G13.11, G13.13): the type at the
 * top, the halves and what holds them, the hardware or that there is nothing to buy, the print notes, G13.11's
 * assembly with the leak test, the Vaseline bead and ring, the demold, and the measured figures and warnings as the
 * one-piece cover's README.txt gives them. Plain ASCII. The one-piece cover's README.txt is src/core/report/readme.ts's.
 */

/** What README.txt says of the two-part cover besides what the one-piece cover's says. */
export interface ClamReadmeInput extends Omit<ReadmeInput, 'bolts' | 'tape' | 'tiles' | 'pitch'> {
  axis: SeamAxis;
  /** The halves' files: neg's (a < xs, the screws' heads) and pos's (the nuts). */
  files2: { neg: string; pos: string };
  /** G13.10's hold: the seam bolts, the seam clips with their bed footprint, or the clamps and belts. */
  bolts: { layout: SeamBoltLayout; advice: SeamBoltAdvice } | null;
  clips: { layout: ClipLayout; advice: ClipAdvice } | null;
  belts: Belts | null;
  /** The base tape at the halves' summed lift, at least one strip per half each way. */
  tape: ClampAdvice;
  /** Each half's pose on the bed, the fastener's growth included, and the bed it was checked against. */
  bed: { width: number; length: number; depth: number; bedX: number; bedY: number };
  /** The seam's top span past SEAL_SPACING_MM: the one clamp across the top middle (G13.10.7). */
  topClamp: boolean;
  /** Vents that rise from a hidden leaf of the seam through more of the cavity above it (G13.5). */
  hiddenVents: number;
}

/** Under this much room on the bed either way, mouse ears at the corners rather than a full brim (G13.10.19). */
const BRIM_SPARE_MM = 5;

/** README.txt of the two-part cover's export ZIP. */
export function clamshellReadme(input: ClamReadmeInput): string {
  const { params, files, clearance } = input;
  const glue = params.base.mode === 'glue';
  const t = params.silicone.t;
  const has = (name: string): boolean => files.includes(name);
  const flanged = params.funnel.flangeWidth > 0 && params.seat.enabled;
  const { neg, pos } = input.files2;
  const bolts = input.bolts, clips = input.clips;
  const out: string[] = [];
  const para = (text: string): void => {
    out.push('', ...wrap(text));
  };
  const item = (text: string): void => {
    out.push(...wrap(text, '- ', '  '));
  };
  const step = (n: string | number, text: string): void => {
    out.push(...wrap(text, `${n}. `, ' '.repeat(String(n).length + 2)));
  };

  const title = wrap(`${input.model.replace(/\.stl$/i, '')}: silicone casting mold`);
  out.push(...title, '='.repeat(Math.max(...title.map((line) => line.length))));
  para(`Mold type: ${input.moldType}.`);
  const across = input.axis === 'x' ? 'left and right' : 'front and back';
  para(`Made by ${input.app} ${input.version} from ${input.model}. This ZIP holds a plastic mold box in three parts: a base and a cover split down the middle into two halves, ${across}. You print them, slide the halves onto the base round your model, join them, and pour silicone into the space between your model and the cover. The cured silicone is your casting mold, and the halves slide off it sideways, so it comes off the model with less silicone than a one-piece cover needs.`);
  const credit = input.credit;
  if (credit) para(`The model is ${credit.title} by ${credit.author} (${credit.authorUrl}), from ${credit.source} (${credit.url}), under the ${credit.licence} licence (${credit.deed}). It is not ${input.app}'s: credit its author when you share it or what you cast from it.`);

  out.push(...heading('The files'));
  const overhangs = bolts
    ? `Its undersides slope at 45 degrees or less from vertical, the countersinks of the seam bolts open downwards, and the only bridges are the ceilings of the nut slots, ${mm(bolts.layout.slotWidth)} across, with one layer of plastic left across the end of each bolt hole so the bridge prints whole.`
    : clips
      ? 'The clip ears on its ends print without supports: their undersides slope at 45 degrees.'
      : 'Its undersides slope at 45 degrees or less from vertical.';
  for (const [name, role] of [[neg, bolts ? 'the screws\' heads go in this half\'s lugs' : 'its seam face carries the tongue and the pins'], [pos, bolts ? 'the nuts go in this half\'s slots' : 'its seam face carries the groove and the pin holes']] as const) {
    out.push('', name);
    out.push(...wrap(`A half of the cover: ${role}. Print it as it is saved, on its back, seam face up. It needs no supports. ${overhangs}`, '  '));
  }
  out.push('', 'base.stl');
  out.push(...wrap(glue
    ? 'The base plate, with two ridge bars that guide the halves as they slide on, and a shallow pocket that your model is glued into. Print it as it is saved, flat underside on the bed.'
    : 'The base plate with your model built onto it, and two ridge bars that guide the halves as they slide on. Print it as it is saved, flat underside on the bed. The model\'s own overhangs may need supports in your slicer.', '  '));
  if (has('model_oriented.stl')) {
    out.push('', 'model_oriented.stl');
    out.push(...wrap('Your model, turned so that its base face lies flat at the bottom, ready to glue into the pocket of the base. Print it however suits it best, and glue its flat face into the pocket.', '  '));
  }
  if (has('funnel.stl')) {
    out.push('', 'funnel.stl');
    const sits = flanged ? `Its spigot drops into the cone-shaped seat at the top of a pour opening, on the seam, and its flange, ${mm(params.funnel.flangeWidth)} wide, rests flat across the seam on the top of both halves.` : 'Its spigot sits in the cone-shaped seat at the top of a pour opening, on the seam.';
    out.push(...wrap(`The pour funnel. Print ${input.pours === 1 ? 'one' : `${input.pours}, one for each pour opening`}. Print it as it is saved, wide rim down. ${sits}`, '  '));
  }
  if (clips) {
    out.push('', 'clips.stl');
    out.push(...wrap(`${clips.layout.count} clips and ${clips.advice.spares} spares. Nothing to buy: the clips hold the two halves together. Each clip is a printed wedge that slides into the sockets of a pair of ears, one ear on each half, and draws the halves together.`, '  '));
  }
  if (files.some((name) => name.startsWith('fit_test/'))) {
    out.push('', 'fit_test/');
    out.push(...wrap('Small test pieces of the joint between base and cover, and of what holds the halves together, to find the clearances that suit your printer before you print the real mold. fit_test/README.txt says how to read them.', '  '));
  }
  out.push('', 'report.json and project.json');
  out.push(...wrap(`Every number of this export, and the settings it was made with. To make the same mold again, open ${input.model} in the app, then open this ZIP or its project.json there: the settings, the base face and the openings come back as they were.`, '  '));

  out.push(...heading('Hardware'));
  if (bolts) {
    const { layout, advice } = bolts;
    const misfit = advice.lengthFits ? '' : ' Not yet: this length does not fit these halves (see Warnings below), so set Bolt length in the app to the length the warning gives and export again before you buy.';
    out.push(...wrap('To buy, for the seam bolts that hold the halves together:'));
    item(`${layout.count} x ${layout.size} x ${layout.length} mm countersunk screws (${layout.fastener.screw === 'ISO 10642' ? 'ISO 10642 or DIN 7991' : `${layout.fastener.screw} or ISO 7046`}), ${layout.count} ${layout.size} hex nuts (ISO 4032), a ${layout.hexKey} mm hex key.${misfit}`);
    para(`They go ${layout.perEnd} on each end of the seam, through printed lugs: together they hold about ${advice.boltsHoldN} N, an estimate for printed plastic, against the ${advice.holdN.toFixed(0)} N the seam needs.`);
  } else if (clips) {
    out.push(...wrap(`Nothing to buy: the ${clips.layout.count} printed clips in clips.stl hold the halves together, ${clips.layout.zs.length} on each end of the seam, about ${clips.advice.clipsHoldN} N together (40 N each, an estimate for printed plastic), against the ${clips.advice.holdN.toFixed(0)} N the seam needs.`));
  } else {
    const belts = input.belts;
    out.push(...wrap(`Nothing to buy but two clamps and tape: Seam fasteners is set to None, so two clamps across the two back faces hold the halves together, each pressing through a flat board or ruler on each face so the thin printed skin is not crushed, the lower one over the bottom edge and the other 10 mm under the top.${belts ? ` Without clamps, ${plural(belts.count, 'belt')} of strong tape round all four walls, pulled tight and each overlapping itself by at least 50 mm, the lowest at the cover's bottom edge and none more than 100 mm from the next, hold about the ${belts.holdN.toFixed(0)} N the seam needs.` : ''}`));
  }

  out.push(...heading('Printing'));
  item('The parts are saved the way up they print best, so do not flip them over or lay them on another side in your slicer. Turning one about the vertical axis to fit your bed is fine.');
  item(`About ${Math.round(params.print.infill * 100)} percent infill is enough, as the printed parts carry little load. Use at least 3 walls (perimeters) and 4 bottom layers, and at least 1.2 mm of top layers (6 at 0.2 mm): each half's seam face is its last, top layer, and it must be flat and closed to seal.`);
  item(`Use the layer height of ${mm(params.print.layerHeight, 2)} this mold was made for: the base, the halves' depths and the ${bolts ? 'nut slots' : clips ? 'clip sockets' : 'seam'} are sized in whole layers of it.`);
  const spare = Math.min(input.bed.bedX - input.bed.width, input.bed.bedY - input.bed.length, input.bed.bedY - input.bed.width, input.bed.bedX - input.bed.length);
  item(`Each half${clips ? ' with its clip ears' : bolts ? ' with its lugs' : ''} needs ${input.bed.width.toFixed(1)} x ${input.bed.length.toFixed(1)} mm on the bed and stands up to ${input.bed.depth.toFixed(1)} mm tall. Use a brim on large halves${spare < BRIM_SPARE_MM ? ', or with this little room to spare on your bed, use mouse ears at the corners rather than a full brim' : ''}, so their corners do not lift.`);
  item('Before you use the halves, lay each seam face on a flat surface, such as a glass plate, and check that it sits flat with no gap: a warped face does not seal.');
  if (bolts) item(`Check in your slicer's preview that the lugs print filled: every part of a lug lies within about two lines of a cut, so it prints as walls, not infill.`);
  if (clips) {
    item('Print the clips at 100 percent infill, standing on their heads as clips.stl lays them out, in PLA or PETG: each clip is pulled along its layers, never across them.');
  }
  item(`Plastic: about ${grams(input.plastic.printed)} at that infill, or ${grams(input.plastic.solid)} printed solid. This is an estimate: slicers differ.`);

  out.push(...heading('Before the first pour'));
  step(1, 'Cure-inhibition test: some resins, plastics, glues, tapes and sealants stop silicone from curing where they touch it, and platinum-cure silicone is the sensitive kind. Put a smear of each material you will use on a printed scrap, pour a small test patch of your silicone over it, and let it cure fully. If it stays sticky or soft anywhere it touches, seal that material or use another.');
  step(2, `Fit test: the fit_test pieces check the joint${bolts ? ' and the seam bolts' : clips ? ' and the clips' : ''} on your printer before you print the halves.`);

  out.push(...heading('Assembly and pouring'));
  para('The mold never leaves the table while you assemble it.');
  // G13.11's steps, with the seam's own (G13.10.11, G13.10.18, G13.10.9).
  const fasten = bolts ? 'the seam bolts' : clips ? 'the clips' : 'the clamps or belts';
  step(1, `Leak test, sealed exactly as for the pour: Vaseline in the base groove and in the seam groove of ${pos}, a thin film on the seam faces, and a bead of Vaseline along both halves' bottom seam edges and the base's edge under the seam; ${fasten} and the base tape as below. Fill the mold with water to the top of the vents and wait 10 minutes. Watch the two bottom corners of the seam and the top under the funnel: they are where a leak shows first. Then empty it, take it apart, dry it and seal it again.`);
  step(2, 'Coat both halves\' cavities and the top of the base with a mold release made for silicone, then put on the Vaseline as in step 1.');
  step(3, `Lay the base tape strips sticky side up on the table where the base goes, their free ends turned back on themselves beyond the box: ${plural(input.tape.strips, 'strip')} at ${input.tape.stripN} N each, ${input.tape.across[0]} front to back and ${input.tape.across[1]} left to right.${bolts ? ` Strips across the seam keep clear of the lugs: more than ${(bolts.layout.lugZone[0]).toFixed(0)} mm in front of the seam and ${(bolts.layout.lugZone[1]).toFixed(0)} mm behind it.` : ''}`);
  step(4, glue ? 'Glue the model into the pocket of the base, flat face down, and let the glue cure. Stand the base on the strips.' : 'Stand the base, with the model on it, on the strips.');
  step(5, `Slide each half onto the base's shelf from its own side, towards the seam: its groove runs over the ridge bars, which guide it. Press the tongue of ${neg} into the groove of ${pos}${params.clamshell.pins ? ' and fit the pins into their holes' : ''}, until the seam faces close.`);
  if (bolts) {
    step('6a', `Drop a nut into each slot on the top of the lugs of ${pos}, flats against the slot's sides, bottom lug first.`);
    step('6b', `Put a screw through each lug of ${neg} from its outer side, through the hole and the thin layer of plastic in it, and turn it into the nut with the ${bolts.layout.hexKey} mm key: the bottom pair first and working up, alternating ends. Stop at snug: when the seam is closed, give it at most a quarter turn more. Harder can crack a lug.`);
  } else if (clips) {
    step('6a', 'Keep Vaseline off the clips and their sockets: a greased clip still locks, but less firmly.');
    step('6b', 'Push a clip into the sockets of each pair of ears, narrow end first and head out, by hand until it stops, the bottom row first and working up, alternating ends. Then give its head two light taps with a screwdriver handle: its double line should end level with the tip of the ears, within one mark, or where the clip coupon told you.');
  } else {
    step('6a', 'Put one clamp across the two back faces over the bottom edge and another 10 mm under the top, each pressing through a flat board or ruler on each face; or tape the belts round all four walls as HARDWARE says.');
  }
  if (input.topClamp && (bolts || clips)) step('6t', 'These halves are wide: put one clamp across the two back faces at the middle of the seam, 10 mm under the top, with a flat board or ruler under each jaw.');
  step('6c', 'Open the base tape strips\' ends and press them up the walls, then check that the seam is closed at the bottom edge. If it is not, the taper clearance is too small for this mold.');
  if (bolts) para('After the leak test, snug every screw again just before the pour: the plastic settles a little under them.');
  if (clips) para('After the leak test, just before the pour, tap each clip once more and read its line again.');
  const funnel = has('funnel.stl')
    ? `Seat the funnel only after ${bolts ? 'the screws' : clips ? 'the clips' : 'the clamps'} are in: smear a ring of Vaseline on the underside of its flange, across the seam line, and press it into the seat by its weight and a light press only, as its split seat is a wedge that would push the halves apart.`
    : 'Pour into the seat on the seam.';
  step(7, `${funnel}${flanged ? ' Keep the Vaseline out of the seats and the vents.' : ''}`);
  step(8, `Mix the silicone, and degas it in the cup if you have a vacuum chamber. Pour it slowly, in a thin stream, into the pour opening${input.pours === 1 ? '' : 's'}, until silicone shows at every vent. This mold has ${plural(input.pours, 'pour opening')} and ${plural(input.vents, 'vent')}.`);
  step(9, 'Let it cure for the full time the maker of your silicone gives.');
  if (params.seat.enabled) para(SPRUE_RULE);

  out.push(...heading('Demolding'));
  const reports = input.reports;
  if (reports) {
    const { demold, centre } = reports;
    out.push(...wrap(`Estimate: ${VERDICT_WORDS[demold.verdict].toLowerCase()}. Once the halves are off, nothing of the plastic holds the silicone, so only the model is left to free from it. This is worked out from the model's shape alone, so treat it as a guide.`));
    const cut = demold.hints.filter((h) => h.cuts);
    if (cut.length > 0) {
      out.push('', ...wrap(`Cut the silicone at ${cut.length === 1 ? 'this place' : 'these places'}, where it holds the model in a loop, measured from the middle of the model, with the front being the side you face in the app's first view:`));
      for (const hint of cut) item(hintWords(hint, centre, demold.verdict));
    }
  }
  out.push('');
  const rods = input.hiddenVents > 0 ? ` and cut ${input.hiddenVents === 1 ? 'the vent rod' : `the ${input.hiddenVents} vent rods`} that ${input.hiddenVents === 1 ? 'rises' : 'rise'} from a high point inside the mold through the silicone above it: cut these vent rods at demold, as they tie two parts of the silicone together` : '';
  step(1, `Cut the sprues: take out the funnels, cut each pour sprue at the floor of its seat and the silicone in each vent flush with the top${rods}.`);
  step(2, bolts
    ? `Fold the base tape down, then unscrew the seam bolts. The nuts drop out when ${pos} is turned over, so keep them.`
    : clips
      ? 'Fold the base tape down, then lever each clip out with a flat screwdriver between its head and the ears.'
      : 'Fold the base tape down, then take the clamps or belts off.');
  step(3, 'Pry at the V pockets at the top of the seam, on the two end faces, and slide the halves apart, each along its own side, the base staying on the table.');
  step(4, `Trim the thin fin of silicone along the seam flush with the mold, then free the model${reports && reports.demold.hints.some((h) => h.cuts) ? ' by the cuts above' : ''}.${glue ? '' : ' The silicone comes off the printed model on the base.'}`);
  para('To cast, check that the seam closes with no silicone in it, close the halves round the silicone again, fasten them as for the pour, turn the mold over and cast through the silicone\'s open foot.');

  out.push(...heading('Air'));
  if (reports) {
    const { air, centre } = reports;
    if (air.uncovered.length === 0) item(air.ceilingLeaves === 1 ? 'The one high point of the cavity on the seam has an opening, so its air gets out.' : `All ${air.ceilingLeaves} high points of the cavity on the seam have an opening, so their air gets out.`);
    else item(`${air.uncovered.length} of the ${air.ceilingLeaves} high points of the cavity on the seam have no opening, so air stays there: see the warnings.`);
    item(`Each half's ceilings slope down to the seam at ${params.clamshell.ceilingDeg} degrees or more, so air runs along them to the openings on the seam.`);
    for (const p of air.underside) item(`Air stays in a pocket under an overhang of the model, ${placeWords([p.x, p.y, p.z], centre)}, about ${(p.volume / 1000).toFixed(2)} ml: brush a first coat of silicone onto the model there before you close the mold.`);
  } else {
    item('The air report could not be worked out for this export.');
  }
  para(RISING_LEVEL_NOTE);

  out.push(...heading('This mold'));
  item(`Silicone thickness asked for: ${mm(t, 2)}.`);
  if (clearance) {
    const decimated = clearance.error > 0 ? `, measured on a simplified copy of the model with its error of ${clearance.error.toFixed(3)} mm taken off` : '';
    item(`Measured clearance: ${clearance.measured.toFixed(2)} mm at the thinnest point between the model and either half${decimated}.`);
    if (clearance.raisedBy > 0) item(`The first build measured less than ${mm(t, 2)}, so the safety margin was raised by ${clearance.raisedBy.toFixed(2)} mm and the mold was built again at the same split. The cavity and the box are a little larger than the preview showed.`);
  } else {
    item(`The clearance could not be measured, as the model's mesh is not closed. The mold is planned to leave at least ${mm(t, 2)}, but that is not verified.`);
  }
  item(`Split: along ${input.axis.toUpperCase()}, into ${neg} and ${pos}, with the ceilings sloping at ${params.clamshell.ceilingDeg} degrees.`);
  item(`Silicone: about ${input.silicone.ml.toFixed(0)} ml, ${input.silicone.grams.toFixed(0)} g at ${params.silicone.density} g/cm3. Mix a little more, for what stays in the cup.`);
  item(`Mold box: ${input.box.map((v) => v.toFixed(1)).join(' x ')} mm, with a base ${mm(params.base.thickness)} thick.`);
  item(glue ? 'Mode A: the model is printed on its own and glued into the base.' : 'Mode B: the model is part of the base.');

  const problems = input.diagnostics.filter((d) => d.severity !== 'info');
  const notes = input.diagnostics.filter((d) => d.severity === 'info');
  out.push(...heading('Warnings'));
  if (problems.length === 0) out.push('None.');
  for (const d of problems) item(`${d.severity === 'error' ? 'Error' : 'Warning'}: ${d.message}`);
  if (clips) item('With PLA, do not warm the mold above 40 C to speed the cure: PLA softens from about 55 C and creeps well below it.');
  if (notes.length > 0) {
    out.push(...heading('Notes'));
    for (const d of notes) item(d.message);
  }

  out.push(...heading('Estimates'));
  const asDefault = t === defaultOf('silicone.t', moldTypeOf(params).id as MoldTypeId) ? ', the default' : '';
  out.push(...wrap(`The ${mm(t, 2)} silicone thickness${asDefault}, the ceiling slope of ${params.clamshell.ceilingDeg} degrees and the holding forces are estimates: only a test pour shows what your silicone, printer and model need.`));

  out.push(...heading('Settings'));
  const type = moldTypeOf(params);
  const held = (path: string): boolean => type.locked.some((lock) => lock.path === path);
  out.push(...wrap('Every setting this mold was made with, by the names the app gives them. project.json holds the same, but for the settings marked "held by the mold type": the mold type sets those, and project.json keeps the values you set, for when you switch to another type.'));
  for (const [group, defs] of Object.entries(PARAM_SCHEMA) as [string, Record<string, ParamDef>][]) {
    const used = Object.keys(defs).filter((key) => group !== 'mold' && type.applies(`${group}.${key}` as ParamPath));
    if (used.length === 0) continue;
    out.push('', GROUP_TITLES[group]);
    for (const [key, def] of Object.entries(defs).filter(([key]) => used.includes(key))) {
      const path = `${group}.${key}`;
      item(`${def.label}: ${settingText(path, def, (params as unknown as Record<string, Record<string, unknown>>)[group][key], input.resolved[path])}${held(path) ? ', held by the mold type' : ''}`);
    }
  }
  out.push('');
  return out.join(EOL);
}

/** G13.13's names of the halves' files: left and right with an x seam, front and back with a y seam, neg first. */
export function halfFiles(axis: SeamAxis): { neg: string; pos: string } {
  return axis === 'x' ? { neg: 'cover_left.stl', pos: 'cover_right.stl' } : { neg: 'cover_front.stl', pos: 'cover_back.stl' };
}

