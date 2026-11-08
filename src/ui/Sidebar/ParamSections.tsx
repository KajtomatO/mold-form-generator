import { boltFigure, clampFigure, exportPitch, previewSilicone } from '../../app/derived';
import { PARAM_SCHEMA } from '../../core/params/schema';
import { SEAL_SPACING_MM } from '../../core/report/clamp';
import { useContext } from 'preact/hooks';
import { ProblemsContext, useStore } from '../context';
import { formatNumber } from '../format';
import { Chevron } from '../icons';
import { GROUP_NOTES, GROUP_TITLES, SECTION_PARAMS, type SectionId } from '../layout';
import { ParamRow } from '../ParamRow';
import { Section } from './Section';

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
    <Section id="base" title="Base">
      <Rows section="base" />
    </Section>
  );
}

export function SiliconeSection() {
  const store = useStore();
  const silicone = previewSilicone(store.pipeline);
  return (
    <Section id="silicone" title="Silicone">
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

/** Plan: tape that holds max(2 x lift, 10 N), in strips of Tape strip holds each, and enough of them to press the seal all round. */
export function CoverSection() {
  const store = useStore();
  const clamp = clampFigure(store.pipeline);
  const n = figure;
  const on = store.project.value.params.bolts.enabled;
  const joint = SECTION_PARAMS.cover.filter((path) => !path.startsWith('bolts.'));
  // Only the toggle while the bolts are off: the rest has nothing to say then.
  const bolts = SECTION_PARAMS.cover.filter((path) => path.startsWith('bolts.') && (on || path === 'bolts.enabled'));
  return (
    <Section id="cover" title="Cover & joint">
      {joint.map((path) => (
        <ParamRow key={path} path={path} />
      ))}
      <h3 data-testid="bolts-group">Bolts</h3>
      {bolts.map((path) => (
        <ParamRow key={path} path={path} />
      ))}
      {store.pipeline.modelName && on ? <BoltAdviceFigure /> : null}
      {store.pipeline.modelName && !on ? (
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
  const bounds = pipeline.oriented?.value.bounds;
  const params = store.project.value.params;
  const grid = params.grid.nx * params.grid.ny > 1;
  const pitch = bounds && grid ? exportPitch(params, bounds) : null;
  const walls = pipeline.wallStatus();
  return (
    <Section id="grid" title="Grid">
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
  const groups = Object.keys(PARAM_SCHEMA).filter((group) => SECTION_PARAMS.advanced.some((path) => path.startsWith(`${group}.`)));
  // Advanced is closed by default, so its summary says when a row inside has something to say.
  const problems = useContext(ProblemsContext);
  const inside = SECTION_PARAMS.advanced.flatMap((path) => problems.get(path) ?? []);
  const worst = inside.some((d) => d.severity === 'error') ? 'error' : inside.some((d) => d.severity === 'warning') ? 'warning' : 'info';
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
      </summary>
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
    </details>
  );
}
