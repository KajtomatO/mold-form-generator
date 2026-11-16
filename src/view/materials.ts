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

/**
 * OL: the dashed circle where a funnel's flange will rest round each pour: the funnel's slate two steps
 * darker, the same in both themes, neither a ring's blue nor its violet, as it is not something to drag.
 * Straight down, the backdrop is the mold's pale top in both themes, where the funnel's own #94a3b8 would be
 * about 1.3:1 and this is about 2.8:1 on Benchy. At an angle in the dark theme the backdrop is the dark
 * scene seen through the cover, about rgb(95, 102, 108), where this alone is about 1.1:1; so each dash lies
 * on a light band, FLANGE_CASING_COLOUR, a little wider and longer, 6.2:1 against the dashes, which brings
 * the line to about 2.5:1 there (docs/PLAN.md, VF).
 */
export const FLANGE_OUTLINE_COLOUR = 0x475569;
/** The light band under each of the flange circle's dashes (slate 200). */
export const FLANGE_CASING_COLOUR = 0xe2e8f0;

/** Drawn after the solid parts, outermost last, so each see-through layer blends over what it encloses. */
export const LAYER_ORDER: Record<LayerName, number> = { model: 0, base: 0, funnel: 0, silicone: 1, cover: 2 };

/**
 * U2: a part that rests against another part's face draws a hair behind it, so where the two lie in one
 * plane the other part wins every pixel, and the plane does not flicker as the view turns. The base's
 * top lies at z = 0 under the cover's shelf over both lands round the groove, and in Mode B the base
 * holds the model's copies, which coincide with the model drawn on its own (the real mesh: above 300,000
 * triangles the view draws a simplified copy, which crosses the base's copy and is not ordered by this);
 * the funnel's flange rests on the cover's flat top. A positive offset only pushes a part's depth back, so whatever lies in front of
 * it or level with it, see-through or not, draws over it. Its 2 units are far under 0.001 mm in world
 * terms with the fitted planes of depthPlanes.ts; its factor moves a face back by about one depth step per
 * pixel of the face's own depth slope, so on screen it shifts where the face meets another by about a
 * pixel at the most, at grazing angles, and never reverses a real gap.
 */
export const DEPTH_BIAS: Partial<Record<LayerName, { factor: number; units: number }>> = { base: { factor: 1, units: 2 }, funnel: { factor: 1, units: 2 } };

export function partMaterial(name: LayerName, style: LayerStyle, wireframe: boolean): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: LAYER_COLOURS[name], roughness: 0.7, metalness: 0, side: THREE.DoubleSide, flatShading: true });
  const bias = DEPTH_BIAS[name];
  if (bias) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = bias.factor;
    material.polygonOffsetUnits = bias.units;
  }
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
