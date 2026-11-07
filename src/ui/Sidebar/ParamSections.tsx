import { exportPitch, previewSilicone } from '../../app/derived';
import { PARAM_SCHEMA } from '../../core/params/schema';
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
      <p class="figure" data-testid="silicone-figure" title="From the preview field; sealed air under the model is taken off with the reports of the next milestone.">
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

export function CoverSection() {
  return (
    <Section id="cover" title="Cover & joint">
      <Rows section="cover" />
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
