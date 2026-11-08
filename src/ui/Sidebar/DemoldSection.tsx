import { RISING_LEVEL_NOTE } from '../../core/analysis/air';
import { demoldSteps, hintWords, placeWords, VERDICT_MEANING, VERDICT_WORDS } from '../../core/analysis/reports';
import { useStore } from '../context';
import { Section } from './Section';

/** The Show toggle's key for a cut hint, beside the diagnostics' own keys in store.shown. */
export function hintKey(id: string): string {
  return `hint|${id}`;
}

/** Hints shown as rows. README.txt lists every one. */
const HINT_ROWS = 6;

const ml = (mm3: number): string => `${(mm3 / 1000).toFixed(mm3 < 1000 ? 2 : 1)} ml`;

/**
 * Plan D2: whether pulling the model out inside the cover is plausible, and where cuts are likely, per
 * model, on one tile. Every verdict is an estimate from the shape, and the steps follow the verdict.
 */
export function DemoldSection() {
  const store = useStore();
  const { pipeline } = store;
  const reports = pipeline.reports?.value ?? null;
  const shown = store.shown.value;
  const failed = pipeline.reportsError();
  const current = reports !== null && pipeline.reports!.key === pipeline.keys().S9;

  let body;
  if (!pipeline.modelName) body = <p class="figure">Load a model to see how it comes out of the silicone.</p>;
  else if (failed) body = <p class="note warning">The reports could not be worked out: {failed}</p>;
  else if (!reports) body = <p class="figure" data-testid="demold-pending">Working out how the model comes out of the silicone…</p>;
  else {
    const { demold, air, tiles, centre } = reports;
    const cuts = demold.hints.filter((h) => h.cuts).length;
    const bodies = demold.bodies.length;
    const alike = demold.bodies.filter((b) => b.verdict === demold.verdict).length;
    body = (
      <>
        <div class={`verdict ${demold.verdict}`} data-testid="demold-verdict" data-verdict={demold.verdict} aria-busy={!current}>
          <strong>{VERDICT_WORDS[demold.verdict]}</strong>
          <span class="estimate">estimate</span>
        </div>
        <p class="figure">
          {VERDICT_MEANING[demold.verdict]}
          {bodies > 1 ? ` ${alike === bodies ? `All ${bodies} bodies` : `${alike} of ${bodies} bodies`} read the same way.` : ''}
          {tiles > 1 ? ` Each of the ${tiles} copies is the same.` : ''}
        </p>
        {demold.hints.length > 0 ? (
          <>
            <h3>Where it holds</h3>
            <ul class="hints" data-testid="demold-hints">
              {demold.hints.slice(0, HINT_ROWS).map((hint) => {
                const key = hintKey(hint.id);
                return (
                  <li key={hint.id} class="cut-hint" data-hint={hint.id} data-reason={hint.reason} data-cuts={hint.cuts}>
                    <span>
                      {hint.cuts ? <strong class="tag cut" title="The silicone holds the model in a loop here, which is why it needs cutting">Cut</strong> : null}
                      {hintWords(hint, centre, demold.verdict)}
                    </span>
                    <button type="button" class="btn small" aria-pressed={shown.includes(key)} title="Mark this place and the line of the cut in the view" onClick={() => store.toggleShown(key)}>
                      Show
                    </button>
                  </li>
                );
              })}
            </ul>
            {demold.hints.length > HINT_ROWS ? <p class="figure">And {demold.hints.length - HINT_ROWS} smaller ones{cuts > HINT_ROWS ? `, ${cuts - HINT_ROWS} of them to cut,` : ''} listed in README.txt.</p> : null}
          </>
        ) : null}
        <h3>Air</h3>
        <ul class="air" data-testid="air-traps">
          <li>
            {air.uncovered.length === 0
              ? air.ceilingLeaves === 1
                ? 'The one peak of the cover’s ceiling has an opening.'
                : `All ${air.ceilingLeaves} peaks of the cover’s ceiling have an opening.`
              : `${air.uncovered.length} of ${air.ceilingLeaves} peaks of the cover’s ceiling have no opening, so air stays there.`}
          </li>
          {air.underside.length === 0 ? <li>No pocket under the model traps air.</li> : null}
          {air.underside.map((p, k) => (
            <li key={`u${k}`} class="trap" data-trap="underside">
              {`Under an overhang of the model, ${placeWords([p.x, p.y, p.z], centre)}, about ${ml(p.volume)}: no top vent reaches it, so brush a first coat there, tilt the mold as you pour, or use a vacuum.`}
            </li>
          ))}
          {air.sealed.map((d, k) => (
            <li key={`s${k}`} data-trap="sealed">
              {`${ml(d.volume)} ${d.inModel ? 'sealed inside the model' : 'closed off under the model'}: no silicone goes there, which is harmless.`}
            </li>
          ))}
        </ul>
        <p class="figure">{RISING_LEVEL_NOTE}</p>
      </>
    );
  }
  return (
    <Section id="demold" title="Demold report">
      {body}
      <h3>How to demold</h3>
      <ol class="steps" data-testid="demold-steps">
        {demoldSteps(reports && !failed ? reports.demold.verdict : null, pipeline.params).map((step, k) => (
          <li key={k}>{step}</li>
        ))}
      </ol>
    </Section>
  );
}
