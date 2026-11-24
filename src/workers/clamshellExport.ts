import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { analyseIntervals, analysisCellProblem, type IntervalReport } from '../core/analysis/intervals';
import { boreSilicone, type OpeningPin } from '../core/analysis/placement';
import { geometryReports, onTheSeam, withoutDoubledVoids, type GeometryReports } from '../core/analysis/reports';
import type { Footprint } from '../core/base/footprint';
import { chooseFor, placeSeam, prepareClamshell, seamHold, clipHold, exactFootprint, type SeamStage } from '../core/field/clamshell';
import { sealedAirOf } from '../core/field/silicone';
import { topMap } from '../core/field/side';
import type { WeldedMesh } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import { buildGlueBase, buildMergedBase, layerDiagnostics, pocketOutline, triangleContour } from '../core/parts/base';
import { clamshellG4, type ClamshellG4 } from '../core/parts/clamshell';
import { clipPlate } from '../core/parts/clips';
import { coverBottom } from '../core/parts/cover';
import { buildFunnel, funnelPose } from '../core/parts/funnel';
import type { CutOpening } from '../core/parts/openings';
import { basePose, halfPose, modelOrientedStl, poseToStl } from '../core/parts/poses';
import type { ClamRim } from '../core/parts/rim';
import { lugBedGrowth } from '../core/parts/seamBolts';
import { halvesTape, seamBelts, type ClipAdvice, type SeamBoltAdvice } from '../core/report/clamp';
import { clamshellReadme, halfFiles } from '../core/report/clamshellReadme';
import type { Diagnostic } from '../core/report/diagnostics';
import { plasticDiagnostic, plasticEstimate, type PartAmount } from '../core/report/printability';
import { crossParameterErrors } from '../core/params/rules';
import type { OrientedModel } from '../core/base/orient';
import type { Arena } from '../core/solid/arena';
import type { Clearance, ExportInputs, ExportJob, ExportMeta, ExportOutputs, ExportReport } from './exportJob';

/**
 * MP5: T3 for the two-part cover (G13.13): G13.3's split from coarse fields at the export's settings, S7c's openings on
 * P at the export cell with the preview's openings pinned where they stood, G13.4's G4 for each half with its one
 * rebuild at the same split (clamshellG4), the base with its ridge bars, each part in its print pose, report.json and
 * README.txt. runExport hands over what it read of the model; this builds from there.
 */

/** What runExport has worked out before the mold, as the one-piece cover's build starts from the same. */
export interface ClamExportContext {
  api: ManifoldToplevel;
  arena: Arena;
  job: ExportJob;
  /** The settings at the export's cell, a crash's retry's coarser one included. */
  scaled: Params;
  inputs: ExportInputs;
  meta: ExportMeta;
  mesh: WeldedMesh;
  /** The oriented model's solid, or null for an open mesh, and what minGap measures for it, with its proved error. */
  model: Manifold | null;
  probe: () => { solid: Manifold; error: number } | null;
  footprint: Footprint;
  pocketDepth: number;
  resolved: Record<string, number>;
  /** What the model's parts share above the plane, which the silicone takes off. */
  shared: number;
  modelVolume: number | null;
  /** model_oriented.stl as the one-piece's export reads it: the maker's file, or the trimmed model, or null for the mesh. */
  modelStl: () => Uint8Array | null;
  parts: { count: number; bodies: number };
  diagnostics: Diagnostic[];
  timed: <T>(step: string, build: () => T) => T;
  holding: unknown[];
  fitTest: () => Record<string, Uint8Array>;
  zip: (files: Record<string, Uint8Array>) => Uint8Array;
  started: number;
  now: () => number;
  timings: Record<string, number>;
  report: (silicone: ExportReport['silicone'], extra: Pick<ExportReport, 'openings' | 'tiles' | 'box' | 'plastic' | 'parts' | 'diagnostics' | 'reports' | 'reportsError' | 'clearance'>) => ExportReport;
  app: { name: string; version: string; moldType: string };
  readmeCredit: Parameters<typeof clamshellReadme>[0]['credit'];
  project: (modelSha256: string | null) => Uint8Array;
}

const triangles = (stl: Uint8Array): number => (stl.length - 84) / 50;

/** Each diagnostic once, by its code and message, in the order first given. */
function unique(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.code}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** report.json's `clamshell`: G13.13's split, bed, halves and hold, as the export built them. */
export interface ExportClamshell {
  axis: 'x' | 'y';
  xs: number;
  ceilingDeg: number;
  bed: { width: number; length: number; depth: number; fits: boolean; fitted: boolean; fitsAtBeta: number | null };
  halves: { file: string; side: 'neg' | 'pos'; volumeMm3: number; siliconeMm3: number; sideN: number; liftN: number }[];
  holdN: number;
  filmN: number;
  dGrew: boolean;
  wallRaised: { from: number; to: number } | null;
  /** G13.10.9's belts with Seam fasteners None, else null. */
  belts: { count: number; holdN: number } | null;
}

/** report.json's `seamBolts` (G13.10.14), null with clips or None. */
export interface ExportSeamBolts {
  size: string;
  length: number;
  count: number;
  perEnd: number;
  spots: { end: string; z: number; b: number }[];
  e: number;
  p: number;
  c: number;
  hL: number;
  relief: number;
  Tn: number;
  Tp: number;
  f: number;
  s: number;
  slotHeight: number;
  sinkDepth: number;
  holdN_seam: number;
  boltsHoldN: number;
  wedgeN: number;
  bottomHoldN: number;
  topSpan: number;
  topClamp: boolean;
  lugZone: [number, number];
  bedGrowth: number;
  lengthFits: boolean;
}

/** report.json's `clips` (G13.10.19), null unless Seam fasteners Clips. */
export interface ExportClips {
  rows: number;
  count: number;
  spares: number;
  rowsZ: number[];
  earLength: number;
  earDepth: number;
  relief: number;
  clearance: number;
  socket: { neckTip: number; neckBottom: number; depth: number; flareDeg: number; taperDeg: number; length: number };
  key: { length: number; home: number; travelIn: number; travelOut: number; perMmPerSide: number };
  clipHoldN: number;
  clipsHoldN: number;
  holdN_seam: number;
  bottomHoldN: number;
  wedgeN: ClipAdvice['wedgeN'];
  topSpan: number;
  topClamp: boolean;
  bedGrowth: number;
}

export function runClamExport(c: ClamExportContext): ExportOutputs {
  const { api, arena, job, scaled, inputs, meta, mesh, model, timed, diagnostics } = c;
  const { want } = job;
  // G13.3 from coarse fields, which no cell changes: the split the preview showed.
  const split = timed('field', () => {
    const prep = prepareClamshell(mesh, scaled, { overlapVolume: c.shared });
    return chooseFor(prep, scaled.clamshell.ceilingDeg);
  });
  diagnostics.push(...split.diagnostics);
  // The preview's openings, pinned where they stood, so the export cuts what the screen showed; S7c places what the
  // export cell's seam has besides, as a pin keeps its place along P.
  const pins: OpeningPin[] = inputs.openings.map(({ id, kind, x, y }) => ({ id, kind, x, y }));
  let stage: SeamStage | null = null;
  const probe = model ? c.probe() : null;
  // An open mesh has no solid to measure: a speck far under the mold stands in, which every half clears by more than the
  // search, so no rebuild is made, and the clearance is left unverified below, as the one-piece cover's is.
  const speck = (): Manifold => arena.track(arena.track(arena.api.Manifold.cube([0.01, 0.01, 0.01])).translate([0, 0, -1e4]));
  const built: ClamshellG4 = timed('cover', () => clamshellG4(arena, mesh, scaled, { axis: split.axis, xs: split.xs }, probe?.solid ?? speck(), {
    error: probe?.error ?? 0,
    inputs: { overlapVolume: c.shared },
    openingsFor: (prep, fine) => {
      stage = placeSeam(prep, fine, { pins, removed: meta.project.removed });
      return { openings: stage.openings, pinsKept: stage.placement.pinsKept };
    },
  }));
  c.holding.push(built);
  const seam = stage as SeamStage | null;
  if (!seam) throw new Error('The openings on the seam were not placed.');
  const { prep, fine, build } = built;
  const rim = build.rim as ClamRim;
  diagnostics.push(...built.diagnostics, ...build.diagnostics, ...seam.placement.diagnostics);
  const clearance: Clearance | null = probe ? { measured: Math.min(...built.gaps), error: probe.error, raisedBy: built.raisedBy } : null;
  if (!probe) diagnostics.push({ code: 'clearance-unverified', severity: 'warning', message: `The model's mesh has holes, so the silicone thickness could not be measured: the mold is planned to leave at least ${scaled.silicone.t} mm, but that is not checked.` });

  const files: Record<string, Uint8Array> = {};
  const names = halfFiles(fine.axis);
  const base = want === 'cover' ? null : timed('base', () => {
    diagnostics.push(...layerDiagnostics(scaled.base.thickness, c.pocketDepth, scaled.print.layerHeight));
    if (scaled.base.mode === 'merged') {
      const merged = buildMergedBase(arena, build.base, model, c.footprint, { planeTol: inputs.planeTol, offsets: [[0, 0]] });
      if (!merged.base) throw new Error(merged.diagnostics[0].message);
      diagnostics.push(...merged.diagnostics);
      return merged.base;
    }
    const section = model ? arena.track(model.slice(c.pocketDepth)) : triangleContour(arena, mesh, c.pocketDepth);
    const glue = buildGlueBase(arena, build.base, pocketOutline(arena, c.footprint, section, scaled.base.pocketEnlarge), c.pocketDepth, [[0, 0]]);
    diagnostics.push(...glue.diagnostics);
    return glue.base;
  });
  const funnel = want === 'zip' && scaled.funnel.generate && !crossParameterErrors(scaled).some((d) => d.code.startsWith('funnel-')) ? buildFunnel(arena, scaled) : null;
  const clipSet = scaled.clamshell.fastener === 'clips' && build.clips && build.clips.count > 0 ? build.clips : null;
  timed('files', () => {
    if (want !== 'base') {
      files[names.neg] = poseToStl(api, build.halves[0], halfPose(rim, fine.axis, -1));
      files[names.pos] = poseToStl(api, build.halves[1], halfPose(rim, fine.axis, 1));
    }
    if (base) files['base.stl'] = poseToStl(api, base, basePose(rim));
    if (funnel) files['funnel.stl'] = poseToStl(api, funnel, funnelPose(scaled));
    if (want === 'zip' && clipSet) files['clips.stl'] = poseToStl(api, clipPlate(arena, clipSet), { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
    if (want === 'zip' && scaled.base.mode === 'glue') files['model_oriented.stl'] = c.modelStl() ?? modelOrientedStl({ mesh, needsTrim: inputs.needsTrim } as OrientedModel, model);
  });
  c.holding.push(files);
  const outputs = (zip: Uint8Array, report: ExportReport | null): ExportOutputs => ({ want, files, zip, clearance, rim, diagnostics, report, modelSha256: meta.modelSha256 });
  if (want !== 'zip') return outputs(want === 'cover' ? c.zip(files) : new Uint8Array(), null);
  if (job.fitTest) Object.assign(files, timed('fit-test', c.fitTest));

  return timed('zip', () => {
    const r0 = c.now();
    const top = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs);
    let s8: IntervalReport | null = null;
    let reports: GeometryReports | null = null;
    let reportsError: string | null = analysisCellProblem(scaled.quality.analysisCell);
    if (reportsError === null) {
      try {
        s8 = analyseIntervals(mesh, scaled.quality.analysisCell);
        if (s8.shells.length === 0 && mesh.indices.length > 0) throw new Error('the analysis found no solid in the model');
        // As the Diagnostics card has them: the pockets a vent on the seam lets out left out, the verdict for halves.
        reports = onTheSeam(geometryReports(scaled, { s8, field: top, raise: scaled.quality.tinTolFinal, rim, tiles: 1, ceiling: { uncovered: seam.placement.uncovered, leaves: seam.placement.ceilingLeaves } }), seam.placement.openings, seam.placement.diagnostics);
      } catch (error) {
        s8 = null;
        reportsError = error instanceof Error ? error.message : String(error);
      }
    }
    if (reportsError !== null) diagnostics.push({ code: 'reports-failed', severity: 'warning', message: `The demold and air reports could not be worked out for this export, so README.txt has no demold estimate and the silicone figure keeps any sealed air: ${reportsError}` });
    const sealed = s8 ? sealedAirOf(mesh, { analysisCell: scaled.quality.analysisCell, minVolumeMl: scaled.reports.minVolumeMl }, s8).sealedAir : 0;
    const cuts: CutOpening[] = build.openings;
    const boresMl = boreSilicone(cuts.filter((o) => !('hidden' in o && o.hidden)), top, rim.Zt) / 1000;
    const ml = fine.siliconeMl - sealed / 1000 + boresMl;
    c.timings.reports = c.now() - r0;
    const pours = cuts.filter((o) => o.kind === 'pour').length;
    const amount = (solid: Manifold, count: number): PartAmount => ({ volume: solid.volume(), area: solid.surfaceArea(), count });
    const parts = [amount(build.halves[0], 1), amount(build.halves[1], 1), amount(base!, 1), ...(funnel && pours > 0 ? [amount(funnel, pours)] : [])];
    const plastic = plasticEstimate(parts, scaled);
    const hold = scaled.clamshell.fastener === 'bolts' ? seamHold(prep, fine) : null;
    const clipHolding = scaled.clamshell.fastener === 'clips' ? clipHold(prep, fine) : null;
    const box: [number, number] = [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0];
    const tape = halvesTape([fine.forces[0].liftN, fine.forces[1].liftN], scaled.print.tapeStrip, box, fine.axis);
    const belts = scaled.clamshell.fastener === 'none' ? seamBelts(fine.holdN, scaled.print.tapeStrip, coverBottom(rim), rim.Zt) : null;
    const inForce = unique(withoutDoubledVoids([...diagnostics, ...(reports?.diagnostics ?? []), ...(hold?.advice.diagnostics ?? []), ...(clipHolding?.advice.diagnostics ?? []), plasticDiagnostic(plastic, scaled), ...meta.notes], reports));
    const fp = exactFootprint(prep, fine);
    const hidden = seam.placement.openings.filter((o) => o.hidden).length;
    const volumes: Record<string, number | null> = { [names.neg]: build.halves[0].volume(), [names.pos]: build.halves[1].volume(), 'base.stl': base!.volume(), 'funnel.stl': funnel ? funnel.volume() : null, 'model_oriented.stl': c.modelVolume, ...(clipSet ? { 'clips.stl': null } : {}) };
    const found = reports ? (({ diagnostics: _shown, ...rest }) => rest)(reports) : null;
    const report = c.report(
      { ml, grams: ml * scaled.silicone.density, density: scaled.silicone.density, boresMl, sealedAirMl: sealed / 1000 },
      {
        tiles: [[0, 0]],
        box: { x: box[0], y: box[1], z: rim.Zt + rim.Tb, Zt: rim.Zt, Tb: rim.Tb },
        // Pinned as the user pinned them: the export pins every opening of the preview only to cut it where it showed.
        openings: seam.placement.openings.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, pinned: inputs.openings.find((given) => given.id === o.id)?.pinned ?? false, zb: o.zb, boreLength: o.boreLength, copies: 1, ...(o.hidden ? { hidden: true as const } : {}) })),
        plastic,
        parts: Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.stl')).map(([name, bytes]) => [name, { triangles: triangles(bytes), volumeMm3: volumes[name] ?? null }])),
        diagnostics: inForce,
        reports: found,
        reportsError,
        clearance: { asked: scaled.silicone.t, measured: clearance?.measured ?? null, minGap: clearance ? clearance.measured + clearance.error : null, decimationError: clearance?.error ?? null, marginRaisedBy: clearance?.raisedBy ?? 0, searchMm: probe ? Math.max(8, scaled.silicone.t + 0.7) : null },
      },
    );
    report.clamshell = {
      axis: fine.axis,
      xs: fine.xs,
      ceilingDeg: scaled.clamshell.ceilingDeg,
      bed: { width: fp.width, length: fp.length, depth: fp.depth, fits: fp.fits, fitted: split.fitted, fitsAtBeta: split.fitsAtBeta },
      halves: (['neg', 'pos'] as const).map((side, k) => ({ file: k === 0 ? names.neg : names.pos, side, volumeMm3: build.halves[k].volume(), siliconeMm3: fine.forces[k].volume, sideN: fine.forces[k].sideN, liftN: fine.forces[k].liftN })),
      holdN: fine.holdN,
      filmN: fine.filmN,
      dGrew: rim.dGrew,
      wallRaised: rim.wallRaised,
      belts: belts ? { count: belts.count, holdN: belts.holdN } : null,
    };
    report.seamBolts = hold && build.bolts ? exportSeamBolts(hold.advice, build.bolts) : null;
    report.clips = clipHolding && build.clips ? exportClips(clipHolding.advice, build.clips) : null;
    const readme = clamshellReadme({
      app: c.app.name,
      version: c.app.version,
      model: meta.model,
      moldType: c.app.moldType,
      params: scaled,
      resolved: c.resolved,
      files: Object.keys(files),
      pours,
      vents: cuts.length - pours,
      box: [report.box.x, report.box.y, report.box.z],
      clearance,
      silicone: { ml, grams: ml * scaled.silicone.density },
      reports,
      reportsError,
      plastic,
      diagnostics: inForce,
      parts: c.parts,
      ...(c.readmeCredit ? { credit: c.readmeCredit } : {}),
      axis: fine.axis,
      files2: names,
      bolts: hold && build.bolts ? { layout: build.bolts, advice: hold.advice } : null,
      clips: clipHolding && build.clips ? { layout: build.clips, advice: clipHolding.advice } : null,
      belts,
      tape,
      bed: { width: fp.width, length: fp.length, depth: fp.depth, bedX: scaled.print.bedX, bedY: scaled.print.bedY },
      topClamp: (hold?.advice.topClamp ?? clipHolding?.advice.topClamp) ?? false,
      hiddenVents: hidden,
    });
    const text = new TextEncoder();
    files['README.txt'] = text.encode(readme);
    files['report.json'] = text.encode(`${JSON.stringify(report, null, 2)}\n`);
    files['project.json'] = c.project(meta.modelSha256);
    return outputs(c.zip(files), report);
  });
}

function exportSeamBolts(advice: SeamBoltAdvice, layout: NonNullable<ClamshellG4['build']['bolts']>): ExportSeamBolts {
  return {
    size: layout.size,
    length: layout.length,
    count: layout.count,
    perEnd: layout.perEnd,
    spots: layout.spots.map((s) => ({ end: s.end, z: s.z, b: s.b })),
    e: layout.e,
    p: layout.p,
    c: layout.c,
    hL: layout.height,
    relief: layout.relief,
    Tn: layout.tn,
    Tp: layout.tp,
    f: layout.f,
    s: layout.slotWidth,
    slotHeight: layout.slotHeight,
    sinkDepth: layout.sinkDepth,
    holdN_seam: advice.holdN,
    boltsHoldN: advice.boltsHoldN,
    wedgeN: advice.wedgeN,
    bottomHoldN: advice.bottomHoldN,
    topSpan: advice.topSpan,
    topClamp: advice.topClamp,
    lugZone: layout.lugZone,
    bedGrowth: lugBedGrowth(layout),
    lengthFits: layout.lengthFits,
  };
}

function exportClips(advice: ClipAdvice, layout: NonNullable<ClamshellG4['build']['clips']>): ExportClips {
  const k = layout.key;
  return {
    rows: advice.rows,
    count: layout.count,
    spares: advice.spares,
    rowsZ: layout.zs,
    earLength: layout.earLength,
    earDepth: layout.earDepth,
    relief: layout.relief,
    clearance: layout.clearance,
    socket: { neckTip: layout.neckTip, neckBottom: layout.neckBottom, depth: layout.depth, flareDeg: layout.flareDeg, taperDeg: layout.taperDeg, length: layout.socketLength },
    key: { length: k.length, home: k.home, travelIn: k.travelIn, travelOut: k.travelOut, perMmPerSide: k.perMmPerSide },
    clipHoldN: advice.clipHoldN,
    clipsHoldN: advice.clipsHoldN,
    holdN_seam: advice.holdN,
    bottomHoldN: advice.bottomHoldN,
    wedgeN: advice.wedgeN,
    topSpan: advice.topSpan,
    topClamp: advice.topClamp,
    bedGrowth: 2 * layout.earLength,
  };
}
