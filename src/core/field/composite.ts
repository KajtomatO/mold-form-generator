import { emptyField, type Field, type FieldPlan } from './grid';

/** In the owner map: no tile has a cavity at this node, as closing or draft raised it. */
export const NO_OWNER = 0xffff;

export interface Composite {
  /** Is the tile itself for a 1 x 1 mold, so the common case makes no copy. Do not write to it. */
  field: Field;
  /** Which tile is highest at each node, only for a real grid: it tells tile walls from model fins. */
  owners: Uint16Array | null;
}

/**
 * G6: max of the tile at whole-cell offsets, which is exact. Overlapping tiles merge into one
 * cavity without any special handling. A plain max keeps later steps the same with one tile or many.
 */
export function compositeTiles(tile: Field, plan: FieldPlan): Composite {
  const { nx, ny } = plan;
  if (nx === 1 && ny === 1) return { field: tile, owners: null };
  const field = emptyField(plan.composite);
  const owners = new Uint16Array(field.values.length).fill(NO_OWNER);
  const { values } = field;
  const { values: source } = tile;
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const id = tx + ty * nx;
      const shift = tx * plan.pitchX + ty * plan.pitchY * field.nx;
      for (let y = 0; y < tile.ny; y++) {
        const from = y * tile.nx;
        for (let x = 0; x < tile.nx; x++) {
          const v = source[from + x];
          if (v <= 0) continue;
          const at = y * field.nx + x + shift;
          if (v > values[at]) {
            values[at] = v;
            owners[at] = id;
          }
        }
      }
    }
  }
  return { field, owners };
}
