import { useStore } from '../context';
import { FileButton } from '../files';
import { formatCount, formatNormal, formatNumber, units } from '../format';
import { ParamRow } from '../ParamRow';
import { Section } from './Section';

/**
 * Load, then confirm the base (G2.4): the ranked planes with the top one chosen, a face picked on the
 * model instead, the plane tolerance, and G2.6's offer to stand on the upper level.
 */
export function ModelSection() {
  const store = useStore();
  const { pipeline } = store;
  const parsed = pipeline.parsed?.value;
  const oriented = pipeline.oriented?.value;
  const plane = store.project.value.plane;
  const keys = pipeline.modelName ? pipeline.keys() : null;
  // Only a report for the plane on screen may offer a move, or a second click would move it twice.
  const footprint = keys && pipeline.footprint?.key === keys.S2 && pipeline.oriented?.key === keys.S2 ? pipeline.footprint.value : null;
  const upper = footprint?.levels.useUpper ?? null;
  const offset = oriented?.chosen.offset ?? 0;
  // S2 stands on the named level only if it still finds it; otherwise a warning says so.
  const standing = oriented !== undefined && plane.upper !== false && Math.abs(offset - plane.upper) <= oriented.planeTol;
  const error = store.pipeline.status().error;

  return (
    <Section id="model" title="Model">
      <div class="file-row">
        <FileButton store={store} label="Open STL…" primary={!pipeline.modelName} />
        <span class="name" data-testid="file-name">
          {pipeline.modelName ? `${pipeline.modelName}${parsed ? `, ${formatCount(parsed.triangles)} triangles` : ''}` : 'Or drop an STL on the view.'}
        </span>
      </div>
      {/* A file that is no STL, or has no face to stand on, says why right here, next to Open STL. */}
      {!oriented && error ? (
        <p class="note error" data-testid="model-error">
          {units(error)}
        </p>
      ) : null}
      {oriented ? (
        <>
          <h3>Base face</h3>
          <p class="lead">The flat face the model stands on. The best guess is chosen; check it, or pick another.</p>
          <ul class="candidates" role="listbox" aria-label="Base face candidates" onMouseLeave={() => (store.hoverCandidate.value = null)}>
            {oriented.candidates.map((candidate, rank) => {
              const selected = 'rank' in plane && plane.rank === rank;
              return (
                <li key={rank}>
                  <button
                    type="button"
                    class="candidate"
                    role="option"
                    aria-selected={selected}
                    data-rank={rank}
                    title={`Outward normal (${candidate.normal.map((v) => v.toFixed(3)).join(', ')}), ${candidate.members.length} triangles`}
                    onMouseEnter={() => (store.hoverCandidate.value = rank)}
                    onFocus={() => (store.hoverCandidate.value = rank)}
                    onBlur={() => (store.hoverCandidate.value = null)}
                    // The chosen row again is no change: it would drop the pins and removed vents, and an upper level.
                    onClick={() => (selected ? undefined : store.setPlane({ rank, upper: false }))}
                  >
                    <span class="dot" />
                    <span class="rank">{rank + 1}</span>
                    <span>
                      {formatNormal(candidate.normal)}
                      {candidate.source === 'hole' ? ', open hole' : ''}
                      {candidate.offset > 0 ? `, ${formatNumber(candidate.offset, 2)} mm in` : ''}
                    </span>
                    <span class="area">{formatCount(Math.round(candidate.area))} mm²</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div class="pick-row">
            <button type="button" class="btn" aria-pressed={store.pickMode.value} data-testid="pick-face" onClick={() => (store.pickMode.value = !store.pickMode.value)}>
              Pick a face on the model
            </button>
            {'pick' in plane ? <span class="lead">Using a picked face.</span> : null}
          </div>
          {store.pickMode.value ? <p class="lead">Click the face the model stands on. Esc cancels.</p> : null}
          <ParamRow path="base.planeTol" />
          {upper ? (
            <div class="note warning" data-testid="upper-level">
              {units(footprint!.levels.diagnostics.find((d) => d.code === 'upper-level')?.message ?? '')}
              <div>
                {/* The very level the warning names: the report knows which one silicone can reach. */}
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(upper.offset)}>
                  Use upper level
                </button>
              </div>
            </div>
          ) : null}
          {standing ? (
            <div class="note" data-testid="on-upper-level">
              The model stands on the level {formatNumber(offset, 2)} mm up, and what lies below it is trimmed off.
              <div>
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(false)}>
                  Use the lower level
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
