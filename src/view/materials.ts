import * as THREE from 'three';
import type { LayerName, LayerStyle } from './layers';

export { DEFAULT_LAYERS, type LayerName, type LayerStyle } from './layers';

/** The plan's part colours. Orange and yellow are kept for selection, so no part uses them. */
export const LAYER_COLOURS: Record<LayerName, number> = {
  model: 0xb9b4a7,
  silicone: 0x2dd4bf,
  cover: 0xc7ccd3,
  base: 0x6b7280,
  funnel: 0x94a3b8,
};

/** Selection colours: yellow for what the pointer is over, orange for what is chosen or shown. */
export const HOVER_COLOUR = 0xfacc15;
export const SELECTED_COLOUR = 0xf97316;

export const MARKER_COLOURS = { pour: 0x3ea6ff, vent: 0xa78bfa, invalid: 0xf43f5e } as const;

/** Drawn after the solid parts, outermost last, so each see-through layer blends over what it encloses. */
export const LAYER_ORDER: Record<LayerName, number> = { model: 0, base: 0, funnel: 0, silicone: 1, cover: 2 };

export function partMaterial(name: LayerName, style: LayerStyle, wireframe: boolean): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: LAYER_COLOURS[name], roughness: 0.7, metalness: 0, side: THREE.DoubleSide, flatShading: true });
  applyStyle(material, style, wireframe);
  return material;
}

/** Opacity below 1 makes a layer blend and stop hiding what is behind it in the depth buffer. */
export function applyStyle(material: THREE.Material & { wireframe?: boolean }, style: LayerStyle, wireframe: boolean): void {
  const see = style.opacity < 1;
  if (material.transparent !== see) material.needsUpdate = true;
  material.transparent = see;
  material.opacity = style.opacity;
  material.depthWrite = !see;
  material.visible = style.visible && style.opacity > 0;
  if ('wireframe' in material) material.wireframe = wireframe;
}
