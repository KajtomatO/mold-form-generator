import { boltFigure, clampFigure, exportPitch, previewSilicone, seamHoldLine } from '../../app/derived';
import { changedPaths } from '../../app/stages';
import { effectiveParams, moldTypeOf } from '../../core/mold/types';
import { PARAM_SCHEMA } from '../../core/params/schema';
import { SEAL_SPACING_MM } from '../../core/report/clamp';
import { useContext } from 'preact/hooks';
import { ProblemsContext, useStore } from '../context';
import { formatNumber } from '../format';
import { Chevron } from '../icons';
import { GROUP_NOTES, GROUP_TITLES, SECTION_PARAMS, type SectionId } from '../layout';
import { ParamRow } from '../ParamRow';
import { Section, SectionReset } from './Section';

function Rows({ section }: { section: SectionId }) {
  return (
    <>
      {SECTION_PARAMS[section].map((path) => (
        <ParamRow key={path} path={path} />
      ))}
    </>
  );
}

export function BaseSection() {
  return (
    <Section id="base" title="Base" reset={SECTION_PARAMS.base}>
      <Rows section="base" />
    </Section>
  );
}

export function SiliconeSection() {
  const store = useStore();
  const silicone = previewSilicone(store.pipeline);
  return (
    <Section id="silicone" title="Silicone" reset={SECTION_PARAMS.silicone}>
      <Rows section="silicone" />
      <p class="figure" data-testid="silicone-figure" title="From the preview field, less the model and any air it seals off, with the silicone in the bores.">
        {silicone ? (
          <>
            About <strong>{silicone.ml.toFixed(1)} ml</strong>, {silicone.grams.toFixed(0)} g, from the preview
          </>
        ) : (
          'Load a model to see how much silicone it takes.'
        )}
      </p>
    </Section>
  );
}

const figure = (value: number): string => value.toFixed(value < 10 ? 1 : 0);

/** M10: with bolts on, what holds the cover is the bolt list, and tape only where the bolts leave the seal unpressed or the lift needs more. */
function BoltAdviceFigure() {
  const store = useStore();
  const advice = boltFigure(store.pipeline);
  const bolts = store.pipeline.field?.value.rim.bolts;
  if (!advice || !bolts) return <p class="figure" data-testid="bolt-advice">Working out what holds the cover down…</p>;
  const middle = advice.middle[0] + advice.middle[1];
  const spans = advice.spans.map((v) => v.toFixed(0)).join(' × ');
  const where = [advice.middle[0] > 0 ? `${advice.middle[0]} front to back` : '', advice.middle[1] > 0 ? `${advice.middle[1]} left to right` : ''].filter(Boolean).join(', ');
  return (
    <p
      class="figure"
      data-testid="bolt-advice"
      data-enough={advice.enough}
      title={`The joint should hold twice the silicone's lift, and never less than 10 N: here ${figure(advice.holdN)} N. Each snug bolt is counted at ${advice.boltsHoldN / advice.count} N, an estimate for printed plastic. Bolts at the corners press the seal where they stand, so between bolts more than 100 mm apart the plate bends and tape presses the middle.`}
    >
      Bolts: <strong>{advice.count} × {advice.size} × {advice.length} mm</strong> countersunk screws and <strong>{advice.count} × {advice.size}</strong> hex nuts, {spans} mm apart.{' '}
      {!advice.lengthFits
        ? `But ${advice.length} mm screws do not fit this mold, so they hold nothing to count on: see the warning under Bolt length for the length to use.`
        : advice.enough
          ? `Four bolts are enough for this box: together they hold about ${advice.boltsHoldN} N, over the ${figure(advice.holdN)} N it needs.`
          : advice.liftStrips > middle
            ? `They hold about ${advice.boltsHoldN} N, under the ${figure(advice.holdN)} N this box needs, so also tape ${advice.strips} ${advice.strips === 1 ? 'strip' : 'strips'} at ${advice.stripN} N across the base.`
            : `They hold the lift, but the bolts stand over 100 mm apart and a printed plate bends between them, so also tape ${advice.strips} ${advice.strips === 1 ? 'strip' : 'strips'} across the middle: ${where}.`}
    </p>
  );
}

/** MP5 (G13.10.14, G13.10.19, G13.10.9): what holds the two-part cover's halves, against what the seam needs. */
function SeamHoldFigure() {
  const store = useStore();
  const line = seamHoldLine(store.pipeline.field?.value.clam ?? null);
  // A failed preview has no fine pair to read, which Diagnostics says why.
  const failed = store.pipeline.status().error !== null;
  return (
    <p class="figure" data-testid="seam-hold" title="What the seam needs is twice the larger of the silicone's push on either half and the push of a film of it over the seam's face, and never less than 10 N.">
      {line ?? (failed ? 'What holds the halves together is not worked out: see Diagnostics.' : 'Working out what holds the halves together…')}
    </p>
  );
}

/** Plan: tape that holds max(2 x lift, 10 N), in strips of Tape strip holds each, and enough of them to press the seal all round. */
export function CoverSection() {
  const store = useStore();
  const clamp = clampFigure(store.pipeline);
  const n = figure;
  const params = store.project.value.params;
  // MT: as the type holds it: the two-part cover locks the corner bolts off.
  const on = effectiveParams(params).bolts.enabled;
  const joint = SECTION_PARAMS.cover.filter((path) => !path.startsWith('bolts.') && !path.startsWith('clamshell.') && !path.startsWith('clips.'));
  // Only the toggle while the bolts are off: the rest has nothing to say then.
  const bolts = SECTION_PARAMS.cover.filter((path) => path.startsWith('bolts.') && (on || path === 'bolts.enabled'));
  // MT: the two-part cover's own block, only in that type, with the clips' rows only with Seam fasteners Clips (G13.14).
  const type = moldTypeOf(params);
  // Headed by their schema groups' titles, the names the switch window and README.txt give them too.
  const twoPart = SECTION_PARAMS.cover.filter((path) => path.startsWith('clamshell.') && type.applies(path));
  const clips = SECTION_PARAMS.cover.filter((path) => path.startsWith('clips.') && params.clamshell.fastener === 'clips' && type.applies(path));
  // MP5 (G13.10.13): with Seam fasteners Bolts the shared bolt rows show under "Seam bolts", with no toggle, as the
  // type holds the corner bolts off; fit_test/README.txt names them "under Two-part cover, Seam bolts".
  const twoPartType = type.id === 'clamshell';
  const seamBolts = twoPartType && params.clamshell.fastener === 'bolts' ? SECTION_PARAMS.cover.filter((path) => path.startsWith('bolts.') && path !== 'bolts.enabled') : [];
  const shownBolts = twoPartType ? bolts.filter((path) => path === 'bolts.enabled') : bolts;
  return (
    <Section id="cover" title="Cover & joint" reset={SECTION_PARAMS.cover}>
      {joint.map((path) => (
        <ParamRow key={path} path={path} />
      ))}
      <h3 data-testid="bolts-group">Bolts</h3>
      {shownBolts.map((path) => (
        <ParamRow key={path} path={path} />
      ))}
      {twoPart.length > 0 ? (
        <>
          <h3 data-testid="two-part-group">{GROUP_TITLES.clamshell}</h3>
          {twoPart.map((path) => (
            <ParamRow key={path} path={path} />
          ))}
        </>
      ) : null}
      {seamBolts.length > 0 ? (
        <>
          <h4 data-testid="seam-bolts-group">Seam bolts</h4>
          {seamBolts.map((path) => (
            <ParamRow key={path} path={path} />
          ))}
        </>
      ) : null}
      {clips.length > 0 ? (
        <>
          <h4 data-testid="clips-group">{GROUP_TITLES.clips}</h4>
          {clips.map((path) => (
            <ParamRow key={path} path={path} />
          ))}
        </>
      ) : null}
      {store.pipeline.modelName && twoPartType ? <SeamHoldFigure /> : null}
      {store.pipeline.modelName && on ? <BoltAdviceFigure /> : null}
      {store.pipeline.modelName && !on && !twoPartType ? (
        <p
          class="figure"
          data-testid="clamp-advice"
          title={clamp ? `With the silicone up to ${clamp.level.toFixed(0)} mm, ${clamp.level > (store.pipeline.field?.value.rim.Zt ?? Infinity) ? 'the rim of a full funnel' : 'the flat top'}, it pushes the cover up with about ${n(clamp.liftN)} N. The tape holds twice that, and never less than 10 N, which ${clamp.liftStrips} ${clamp.liftStrips === 1 ? 'strip does' : 'strips do'}; the strips go no more than ${SEAL_SPACING_MM} mm apart along any wall, so they press the seal all round.` : undefined}
        >
          {clamp ? (
            <>
              Tape: hold <strong>{n(clamp.holdN)} N</strong> with at least <strong>{clamp.strips} {clamp.strips === 1 ? 'strip' : 'strips'}</strong> at {clamp.stripN} N each, {clamp.across[0]} front to back and {clamp.across[1]} left to right, spread round the joint.
              {' '}The silicone lifts the cover with {n(clamp.liftN)} N{clamp.coverWeightN !== null ? `, and the cover weighs about ${n(clamp.coverWeightN)} N` : ''}.
            </>
          ) : (
            'Working out how much tape holds the cover down…'
          )}
        </p>
      ) : null}
    </Section>
  );
}

export function GridSection() {
  const store = useStore();
  const { pipeline } = store;
  // RM: the plan's box, which a rebuilt model's left-out parts widen in glue mode.
  const bounds = pipeline.planBounds();
  // MT: the grid as the type holds it: the two-part cover makes one model.
  const params = effectiveParams(store.project.value.params);
  const grid = params.grid.nx * params.grid.ny > 1;
  const pitch = bounds && grid ? exportPitch(params, bounds, store.pipeline.modelErrorMm()) : null;
  const walls = pipeline.wallStatus();
  return (
    <Section id="grid" title="Grid" reset={SECTION_PARAMS.grid}>
      <Rows section="grid" />
      {pitch ? (
        <p class="figure" data-testid="pitch" title="From one copy to the next, at full export detail, which is where the parts are placed.">
          Copies every <strong>{formatNumber(pitch[0], 3)} × {formatNumber(pitch[1], 3)} mm</strong>
        </p>
      ) : null}
      {grid && pipeline.modelName ? (
        <p class="figure" data-testid="wall-check">
          {walls.result
            ? walls.result.minWall === null
              ? 'No wall stands between the models, checked at full export detail.'
              : `Thinnest wall between models ${walls.result.minWall.toFixed(2)} mm, checked at full export detail.`
            : walls.running
              ? 'Checking the walls between models at full export detail…'
              : 'The walls between models are checked at full export detail once the preview is done.'}
        </p>
      ) : null}
    </Section>
  );
}

export function AdvancedSection() {
  const store = useStore();
  const groups = Object.keys(PARAM_SCHEMA).filter((group) => SECTION_PARAMS.advanced.some((path) => path.startsWith(`${group}.`)));
  // Advanced is closed by default, so its summary says when a row inside has something to say.
  const problems = useContext(ProblemsContext);
  const inside = SECTION_PARAMS.advanced.flatMap((path) => problems.get(path) ?? []);
  const worst = inside.some((d) => d.severity === 'error') ? 'error' : inside.some((d) => d.severity === 'warning') ? 'warning' : 'info';
  // CS: and how many of its settings are changed, as its marks are out of sight while it is closed. Text only:
  // a button in a summary would be a control inside a control, so its Reset is the first line inside.
  const changed = changedPaths(store.project.value.params, SECTION_PARAMS.advanced).length;
  return (
    <details class="section advanced" data-section="advanced">
      <summary>
        <Chevron />
        Advanced
        {inside.length > 0 ? (
          <span class={`badge ${worst}`} data-testid="advanced-notes" title={`${inside.length === 1 ? 'A setting in here has a note' : `${inside.length} settings in here have notes`}: open to see.`}>
            {inside.length}
          </span>
        ) : null}
        {changed > 0 ? (
          <span class="changed-count" data-testid="advanced-changed" title={`${changed === 1 ? 'A setting in here is' : `${changed} settings in here are`} changed from ${changed === 1 ? 'its default' : 'their defaults'}: open to see.`}>
            {changed} changed
          </span>
        ) : null}
      </summary>
      {changed > 0 ? (
        <p class="lead advanced-reset">
          {changed === 1 ? 'One setting changed in here.' : `${changed} settings changed in here.`}
          <SectionReset paths={SECTION_PARAMS.advanced} title="Advanced" inline />
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group}>
          <h3>{GROUP_TITLES[group]}</h3>
          {GROUP_NOTES[group] ? (
            <p class="note" data-testid={`group-note-${group}`}>
              {GROUP_NOTES[group]}
            </p>
          ) : null}
          {SECTION_PARAMS.advanced
            .filter((path) => path.startsWith(`${group}.`))
            .map((path) => (
              <ParamRow key={path} path={path} />
            ))}
        </div>
      ))}
      {/* Developer pages, each in a tab of its own, so following one never loses the model loaded here. */}
      <div class="links" title="Pages for checking this browser and the app itself. Each opens in a new tab.">
        <span>Developer pages:</span>
        <a href="./diag.html" target="_blank" rel="noopener">Browser check</a>
        <a href="./bench.html" target="_blank" rel="noopener">Benchmark</a>
        <a href="./pipeline.html" target="_blank" rel="noopener">Pipeline test page</a>
      </div>
      {/* The minified build drops the libraries' own licence comments, so their notices ship as a file of their own. */}
      <div class="links">
        <a href="./third-party-notices.txt" target="_blank" rel="noopener" data-testid="notices-link" title="The licences of the open-source libraries this app is built with. Opens in a new tab.">
          Third-party licences
        </a>
      </div>
    </details>
  );
}
