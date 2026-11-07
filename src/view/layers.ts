/** Everything the view draws as a part, each with its own eye and opacity. No three here, so the store can import it. */
export type LayerName = 'model' | 'silicone' | 'cover' | 'base' | 'funnel';

export interface LayerStyle {
  visible: boolean;
  opacity: number;
}

/** The cover is see-through so the cavity shows, and the silicone so the model inside it does. */
export const DEFAULT_LAYERS: Record<LayerName, LayerStyle> = {
  model: { visible: true, opacity: 1 },
  silicone: { visible: true, opacity: 0.5 },
  cover: { visible: true, opacity: 0.35 },
  base: { visible: true, opacity: 1 },
  funnel: { visible: true, opacity: 1 },
};
