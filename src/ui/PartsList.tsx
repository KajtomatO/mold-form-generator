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
];

/** One row per part: whether it shows, and how see-through it is; then the explode and section controls while those are on. */
export function PartsList() {
  const store = useStore();
  const layers = store.layers.value;
  return (
    <div class="card parts-card" data-testid="parts">
      <h2>Parts</h2>
      {PARTS.map(({ name, label, colour }) => (
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
