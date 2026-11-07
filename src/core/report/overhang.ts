export interface OverhangOptions {
  /** Faces steeper than this from vertical need support. */
  limitDeg?: number;
  /** Slack for a face meant to be exactly at the limit, such as a 45 degree chamfer. */
  toleranceDeg?: number;
  /** A face resting on the bed at this z needs no support. Defaults to the lowest point of the mesh. */
  bedZ?: number;
  /** Only faces whose centre passes this count, so a merged model can be reported apart from its plate. */
  only?: (x: number, y: number, z: number) => boolean;
}

export interface OverhangAudit {
  /** Faces steeper than the limit. */
  steepCount: number;
  steepArea: number;
  /** Steepest counted face from vertical, in degrees: 0 is a wall, 90 a flat ceiling. */
  worstDeg: number;
  /** Faces too small or thin to have a normal worth reading. Reported so that a real face cannot hide here. */
  ignoredArea: number;
}

/**
 * float32 rounding moves a corner by about 1e-5 mm at these sizes, so a face this small or this thin
 * has a normal that can point anywhere: a sliver 117 mm long and 4e-6 mm wide on Goddess's flat plate
 * top comes back wound upside down. A boolean leaves many such crumbs along its cuts.
 */
const CRUMB_AREA = 1e-4;
const CRUMB_WIDTH = 1e-3;
/** Within this of the bed, a face is lying on it. */
const ON_BED = 1e-3;

/**
 * Faces that would print over air, in the mesh's print pose. Used by the checks on the printed parts
 * and for the model's own overhang in Mode B, which is reported rather than treated as a fault.
 */
export function auditOverhang(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }, options: OverhangOptions = {}): OverhangAudit {
  const { positions: p, indices } = mesh;
  const { limitDeg = 45, toleranceDeg = 0.1, only } = options;
  let bedZ = options.bedZ;
  if (bedZ === undefined) {
    bedZ = Infinity;
    for (let i = 2; i < p.length; i += 3) if (p[i] < bedZ) bedZ = p[i];
  }
  const limit = Math.sin(((limitDeg + toleranceDeg) * Math.PI) / 180);

  let steepCount = 0, steepArea = 0, worst = 0, ignoredArea = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz >= 0) continue;
    const doubled = Math.hypot(nx, ny, nz);
    const area = doubled / 2;
    const down = -nz / doubled;
    const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (cz - bedZ <= ON_BED) continue;
    if (only && !only((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz)) continue;
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (ux - vx) ** 2 + (uy - vy) ** 2 + (uz - vz) ** 2));
    if (area < CRUMB_AREA || doubled / longest < CRUMB_WIDTH) {
      ignoredArea += area;
      continue;
    }
    worst = Math.max(worst, (Math.asin(Math.min(1, down)) * 180) / Math.PI);
    if (down > limit) {
      steepCount++;
      steepArea += area;
    }
  }
  return { steepCount, steepArea, worstDeg: worst, ignoredArea };
}
