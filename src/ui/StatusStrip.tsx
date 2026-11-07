import { modelSize, moldBox, previewSilicone } from '../app/derived';
import { useStore } from './context';
import { formatCount, formatSize } from './format';

/**
 * File, triangles, size, box, silicone, clearance and rebuild time, then the view toggles and how the
 * mouse moves the view. Section and Explode join the toggles in M8.
 */
export function StatusStrip() {
  const store = useStore();
  const { pipeline } = store;
  const parsed = pipeline.parsed?.value;
  const oriented = pipeline.oriented?.value;
  const rim = pipeline.field?.value.rim;
  const silicone = previewSilicone(pipeline);
  const t = store.project.value.params.silicone.t;
  const timing = pipeline.timing;
  const rebuild = pipeline.lastRebuild;
  return (
    <footer class="status" data-testid="status">
      {pipeline.modelName ? (
        <>
          <span class="item" data-testid="status-file">
            <b>{pipeline.modelName}</b>
          </span>
          {parsed ? <span class="item" data-testid="status-triangles">{formatCount(parsed.triangles)} triangles</span> : null}
          {oriented ? <span class="item" data-testid="status-size">{formatSize(modelSize(oriented.bounds))}</span> : null}
          {rim ? <span class="item" data-testid="status-box">box {formatSize(moldBox(rim))}</span> : null}
          {silicone ? <span class="item" data-testid="status-silicone">{silicone.ml.toFixed(1)} ml silicone</span> : null}
          {rim ? (
            <span class="item" data-testid="status-clearance" title="The mold is built to leave at least this much silicone everywhere. Exporting measures it.">
              clearance ≥ {t.toFixed(2)} mm, planned
            </span>
          ) : null}
          {rebuild ? (
            <span class="item" data-testid="status-rebuild" title={`The last rebuild of the solids${rebuild.kind === 't2' ? '' : ', which only cut the openings'}. The quick preview before it took ${Math.round(timing.t1.at(-1) ?? 0)} ms.`}>
              rebuild {Math.round(rebuild.ms)} ms
            </span>
          ) : null}
        </>
      ) : (
        <span class="item">No model loaded</span>
      )}
      <span class="toggles">
        <label>
          <input type="checkbox" data-testid="wireframe" checked={store.wireframe.value} onChange={(event) => (store.wireframe.value = event.currentTarget.checked)} />
          Wireframe
        </label>
        <label>
          <input type="checkbox" data-testid="perspective" checked={store.perspective.value} onChange={(event) => (store.perspective.value = event.currentTarget.checked)} />
          Perspective
        </label>
      </span>
      <span class="hint">Drag: turn · Right-drag: move · Wheel: zoom</span>
    </footer>
  );
}
