/** Everything the view draws as a part, each with its own eye and opacity. No three here, so the store can import it. */
export type LayerName = 'model' | 'silicone' | 'cover' | 'base' | 'funnel';

export interface LayerStyle {
  visible: boolean;
  opacity: number;
}

/**
 * The cover is see-through so the cavity shows, and the silicone so the model inside it does. The funnel
 * is a print of its own and starts hidden: seated on every pour it hides the mold, as on x8 3 x 3, where
 * 72 funnels overlap. Its eye still shows one on each pour.
 */
export const DEFAULT_LAYERS: Record<LayerName, LayerStyle> = {
  model: { visible: true, opacity: 1 },
  silicone: { visible: true, opacity: 0.5 },
  cover: { visible: true, opacity: 0.35 },
  base: { visible: true, opacity: 1 },
  funnel: { visible: false, opacity: 1 },
};
