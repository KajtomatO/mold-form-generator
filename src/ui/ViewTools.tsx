import { moldExtent } from '../app/derived';
import { explodeDistance, explodeMax, sectionPlane, sectionRange, type SectionAxis } from '../app/store';
import { useStore } from './context';

const AXES: SectionAxis[] = ['x', 'y', 'z'];

/**
 * The section's controls, under the parts while Section is on: the axis it cuts across, Flip, and where
 * along the axis, which the handle in the view also drags. All of it is the view's alone (T0).
 */
export function SectionTools() {
  const store = useStore();
  const section = store.section.value;
  const rim = store.pipeline.field?.value.rim;
  if (!section.on) return null;
  const box = rim ? moldExtent(rim) : null;
  const plane = box ? sectionPlane(section, box) : null;
  const range = box ? sectionRange(section.axis, box) : null;
  // The model and the silicone round it need a closed model mesh for a filled cut.
  const open = store.pipeline.modelClosed() === false;
  const shown = store.layers.value;
  return (
    <div class="view-tool" data-testid="section-tools">
      <h2>Section</h2>
      <div class="tool-row">
        <div class="segmented" role="group" aria-label="Cut across">
          {AXES.map((axis) => (
            <button key={axis} type="button" data-cut={axis} aria-pressed={axis === section.axis} title={`Cut across ${axis.toUpperCase()}, through the middle of the mold`} onClick={() => store.setSection({ axis, at: null })}>
              {axis.toUpperCase()}
            </button>
          ))}
        </div>
        <button type="button" class="btn small" data-testid="section-flip" aria-pressed={section.flip} title="Keep the other side of the cut" onClick={() => store.setSection({ flip: !section.flip })}>
          Flip
        </button>
      </div>
      {plane && range ? (
        <label class="tool-slider">
          <input
            type="range"
            data-testid="section-at"
            aria-label={`Section position along ${section.axis.toUpperCase()}`}
            min={range[0]}
            max={range[1]}
            step={0.1}
            value={plane.at}
            onInput={(event) => store.setSection({ at: Number(event.currentTarget.value) })}
            onDblClick={() => store.setSection({ at: null })}
          />
          <span class="value">{plane.at.toFixed(1)} mm</span>
        </label>
      ) : null}
      {open && (shown.model.visible || shown.silicone.visible) ? (
        <p class="note" data-testid="section-open-note">
          The model's mesh has holes, so the cut through it and the silicone round it is left unfilled: only a closed part has an inside to fill.
        </p>
      ) : null}
    </div>
  );
}

/** The exploded view's distance, under the parts while Explode is on. Double-click goes back to a quarter of the box. */
export function ExplodeTools() {
  const store = useStore();
  const explode = store.explode.value;
  const rim = store.pipeline.field?.value.rim ?? null;
  if (!explode.on) return null;
  const max = explodeMax(rim);
  const distance = explodeDistance(explode, rim);
  return (
    <div class="view-tool" data-testid="explode-tools">
      <h2>Explode</h2>
      <label class="tool-slider">
        <input
          type="range"
          data-testid="explode-distance"
          aria-label="Explode distance"
          title="Double-click to go back to a quarter of the box's height"
          min={0}
          max={max}
          step={0.5}
          value={distance}
          onInput={(event) => store.setExplode({ distance: Number(event.currentTarget.value) })}
          onDblClick={() => store.setExplode({ distance: null })}
        />
        <span class="value">{distance.toFixed(1)} mm</span>
      </label>
    </div>
  );
}
