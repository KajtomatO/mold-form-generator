import type { Params } from '../core/params/schema';
import type { LayerName } from '../view/layers';
import { useStore } from './context';
import { Eye } from './icons';
import { ExplodeTools, SectionTools } from './ViewTools';

const PARTS: { name: LayerName; label: string; colour: string }[] = [
  { name: 'model', label: 'Model', colour: '#b9b4a7' },
  { name: 'silicone', label: 'Silicone', colour: '#2dd4bf' },
  { name: 'cover', label: 'Cover', colour: '#c7ccd3' },
  { name: 'base', label: 'Base', colour: '#6b7280' },
  { name: 'funnel', label: 'Funnel', colour: '#94a3b8' },
  { name: 'clips', label: 'Clips', colour: '#4b5563' },
];

/** MP5: the parts the mold type on screen makes: the seam clips only on the Two-part cover with Seam fasteners Clips. */
function partsOf(params: Params): typeof PARTS {
  const clips = params.mold.type === 'clamshell' && params.clamshell.fastener === 'clips';
  return PARTS.filter((part) => part.name !== 'clips' || clips);
}

/** One row per part: whether it shows, and how see-through it is; then the explode and section controls while those are on. */
export function PartsList() {
  const store = useStore();
  const layers = store.layers.value;
  const parts = partsOf(store.project.value.params);
  return (
    <div class="card parts-card" data-testid="parts">
      <h2>Parts</h2>
      {parts.map(({ name, label, colour }) => (
        <div class="part" key={name} data-part={name}>
          <button
            type="button"
            class="eye"
            aria-pressed={layers[name].visible}
            aria-label={`${layers[name].visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
            title={`${layers[name].visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
            onClick={() => store.setLayer(name, { visible: !layers[name].visible })}
          >
            <Eye open={layers[name].visible} />
          </button>
          <span class="swatch" style={{ background: colour }} />
          <span>{label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={layers[name].opacity}
            aria-label={`${label} opacity`}
            title={`${label} opacity ${Math.round(layers[name].opacity * 100)}%`}
            onInput={(event) => store.setLayer(name, { opacity: Number(event.currentTarget.value) })}
          />
        </div>
      ))}
      <ExplodeTools />
      <SectionTools />
    </div>
  );
}
