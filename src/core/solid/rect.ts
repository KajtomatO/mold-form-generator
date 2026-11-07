/** An axis-aligned rectangle in the base plane. Rim and box sides differ per side, so no half widths. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function outset(rect: Rect, by: number): Rect {
  return { x0: rect.x0 - by, y0: rect.y0 - by, x1: rect.x1 + by, y1: rect.y1 + by };
}

/** True if `inner` lies inside `outer`, edges included. */
export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}
