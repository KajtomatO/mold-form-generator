import type { Rect } from '../solid/rect';
import { applyClosing } from './closing';
import type { Field, FieldSettings } from './grid';

/**
 * The silicone base layer: silicone spread over the whole base plate inside the joint, so every copy and
 * every body sits in one piece of silicone instead of a jacket of its own. Its top is the cover's
 * underside, so it is a ceiling the rising silicone meets, and it slopes up towards the models by
 * `slopeDeg`: air under it then moves to the models and out through their vents, even with the box a
 * little off level. Far from any model it is `depth` thick.
 */
export interface BaseLayer {
  depth: number;
  slopeDeg: number;
  /** The wall draft, which its outer edge keeps as the rest of the cavity does. */
  draftDeg: number;
  /** Closing runs again over the field with the layer, so no thin plastic is left where the two meet. */
  closeWidth: number;
  /** D of G8: how far the cavity may reach at z = 0, which keeps the layer off the joint. */
  rect: Rect;
}

/** The layer the settings ask for inside `rect`, or null with a depth of 0. */
export function baseLayerOf(settings: Pick<FieldSettings, 'baseLayer' | 'baseLayerSlopeDeg' | 'draftDeg' | 'closeWidth'>, rect: Rect): BaseLayer | null {
  const depth = settings.baseLayer ?? 0;
  if (!(depth > 0)) return null;
  return { depth, slopeDeg: settings.baseLayerSlopeDeg ?? 0, draftDeg: settings.draftDeg, closeWidth: settings.closeWidth, rect };
}

/** Rounding of a node's position against D. */
const EPS = 1e-6;

/**
 * Nodes the layer may fill, as whole node ranges: those the tool keeps (src/core/solid/tool.ts), whose
 * surface comes down to z = 0 within one cell inside D. So the export's own field never reaches the joint.
 */
export function layerNodes(field: Field, rect: Rect): { i0: number; i1: number; j0: number; j1: number } {
  const { nx, ny, cell, x0, y0 } = field;
  const i0 = Math.max(0, Math.ceil((rect.x0 + cell - x0) / cell - EPS));
  const i1 = Math.min(nx - 1, Math.floor((rect.x1 - cell - x0) / cell + EPS));
  const j0 = Math.max(0, Math.ceil((rect.y0 + cell - y0) / cell - EPS));
  const j1 = Math.min(ny - 1, Math.floor((rect.y1 - cell - y0) / cell + EPS));
  return { i0, i1, j0, j1 };
}

/** Two-pass chamfer distance in mm to the nodes where `values` is above 0, Infinity with none. */
function distanceToCavity(field: Field): Float32Array {
  const { nx, ny, cell, values } = field;
  const dist = new Float32Array(values.length);
  for (let n = 0; n < values.length; n++) dist[n] = values[n] > 0 ? 0 : Infinity;
  const straight = cell, diagonal = cell * Math.SQRT2;
  for (let y = 0; y < ny; y++) {
    for (let x = 0, n = y * nx; x < nx; x++, n++) {
      let d = dist[n];
      if (x > 0 && dist[n - 1] + straight < d) d = dist[n - 1] + straight;
      if (y > 0) {
        if (dist[n - nx] + straight < d) d = dist[n - nx] + straight;
        if (x > 0 && dist[n - nx - 1] + diagonal < d) d = dist[n - nx - 1] + diagonal;
        if (x < nx - 1 && dist[n - nx + 1] + diagonal < d) d = dist[n - nx + 1] + diagonal;
      }
      dist[n] = d;
    }
  }
  for (let y = ny - 1; y >= 0; y--) {
    for (let x = nx - 1, n = x + y * nx; x >= 0; x--, n--) {
      let d = dist[n];
      if (x < nx - 1 && dist[n + 1] + straight < d) d = dist[n + 1] + straight;
      if (y < ny - 1) {
        if (dist[n + nx] + straight < d) d = dist[n + nx] + straight;
        if (x < nx - 1 && dist[n + nx + 1] + diagonal < d) d = dist[n + nx + 1] + diagonal;
        if (x > 0 && dist[n + nx - 1] + diagonal < d) d = dist[n + nx - 1] + diagonal;
      }
      dist[n] = d;
    }
  }
  return dist;
}

/**
 * The roof in place of `buffer`: max over cavity nodes u of (min(H(u), cap) - k |x - u|), a cone of slope k
 * from the cavity cut off at `cap`, by the same two-pass chamfer as the draft. Cut off, it rises to the
 * level `cap` and stays there, so it never fills the cavity up to a model's top; from under that level it
 * climbs all the way to the jacket, with no flat ring at the jacket's foot. -Infinity where no cavity is.
 */
function roof(field: Field, buffer: Float32Array, cap: number, k: number): void {
  const { nx, ny, cell, values } = field;
  for (let n = 0; n < values.length; n++) buffer[n] = values[n] > 0 ? Math.min(values[n], cap) : -Infinity;
  const straight = cell * k, diagonal = straight * Math.SQRT2;
  for (let y = 0; y < ny; y++) {
    for (let x = 0, n = y * nx; x < nx; x++, n++) {
      let v = buffer[n];
      if (x > 0 && buffer[n - 1] - straight > v) v = buffer[n - 1] - straight;
      if (y > 0) {
        if (buffer[n - nx] - straight > v) v = buffer[n - nx] - straight;
        if (x > 0 && buffer[n - nx - 1] - diagonal > v) v = buffer[n - nx - 1] - diagonal;
        if (x < nx - 1 && buffer[n - nx + 1] - diagonal > v) v = buffer[n - nx + 1] - diagonal;
      }
      buffer[n] = v;
    }
  }
  for (let y = ny - 1; y >= 0; y--) {
    for (let x = nx - 1, n = x + y * nx; x >= 0; x--, n--) {
      let v = buffer[n];
      if (x < nx - 1 && buffer[n + 1] - straight > v) v = buffer[n + 1] - straight;
      if (y < ny - 1) {
        if (buffer[n + nx] - straight > v) v = buffer[n + nx] - straight;
        if (x < nx - 1 && buffer[n + nx + 1] - diagonal > v) v = buffer[n + nx + 1] - diagonal;
        if (x > 0 && buffer[n + nx - 1] - diagonal > v) v = buffer[n + nx - 1] - diagonal;
      }
      buffer[n] = v;
    }
  }
}

/**
 * Adds the base layer to a conditioned field, in place. It only raises H, so the clearance and the
 * nesting of G4 and D1 hold as they did. The roof rises by k over the farthest reach R of the layer from
 * the cavity, so the layer's farthest corner is `depth` thick and the rest is thicker towards the models.
 * Its outer edge keeps the wall draft: a node may stand no higher than its distance to the edge allows.
 * Closing runs again, so the meeting of the layer and a jacket leaves no fin thinner than the element.
 */
export function applyBaseLayer(field: Field, layer: BaseLayer): void {
  const { nx, cell, values } = field;
  const { i0, i1, j0, j1 } = layerNodes(field, layer.rect);
  if (i1 < i0 || j1 < j0) return;
  const k = Math.tan((Math.max(0, layer.slopeDeg) * Math.PI) / 180);
  const tanDraft = Math.tan((Math.max(0, layer.draftDeg) * Math.PI) / 180);

  let buffer: Float32Array | null = null;
  let cap = layer.depth;
  if (k > 0) {
    buffer = distanceToCavity(field);
    let reach = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0, n = i0 + j * nx; i <= i1; i++, n++) if (buffer[n] > reach && buffer[n] < Infinity) reach = buffer[n];
    }
    // No cavity at all leaves nothing to slope towards, so the layer is flat.
    if (reach > 0) {
      cap = layer.depth + k * reach;
      roof(field, buffer, cap, k);
    } else buffer = null;
  }

  for (let j = j0; j <= j1; j++) {
    const fromEdgeJ = Math.min(j - j0, j1 - j) + 1;
    for (let i = i0, n = i0 + j * nx; i <= i1; i++, n++) {
      let h = buffer ? Math.max(layer.depth, buffer[n]) : layer.depth;
      if (tanDraft > 0) {
        const edge = Math.min(fromEdgeJ, Math.min(i - i0, i1 - i) + 1) * cell;
        h = Math.min(h, edge / tanDraft);
      }
      if (h > values[n]) values[n] = h;
    }
  }
  applyClosing(field, layer.closeWidth);
}

/** A copy of `field` with the layer added, leaving `field` as it was. */
export function withBaseLayer(field: Field, layer: BaseLayer): Field {
  const copy: Field = { ...field, values: field.values.slice() };
  applyBaseLayer(copy, layer);
  return copy;
}
