import type { SolidReport } from '../mesh/shells';
import type { WeldedMesh } from '../mesh/weld';
import type { Field, FieldPlan, FieldSettings } from './grid';
import { clipToPlane } from './raster';
import { exteriorMesh, sealedDomains, type SealedDomain } from './sealed';

export interface SiliconeInputs {
  /** Enclosed by the model's outer surface above the plane, voids included, so a void is never silicone. */
  exteriorVolume: number;
  /** Copies of the model in this field. */
  tiles: number;
  /** Sealed air per tile, from sealedDomains. Not silicone either. */
  sealedAir: number;
  /** The tool builder's vertical raise on nodes above 0, so this figure matches the built cover. */
  raise: number;
}

export interface SiliconeVolume {
  /** Volume under H, in mm3. */
  integral: number;
  /** Footprint of the cavity at z = 0, in mm2. */
  area: number;
  /** In ml, without the bores: see boreSilicone, which needs the placed openings. */
  ml: number;
}

/**
 * The plan's silicone volume: integral of H dA, minus exterior model volume times tiles, minus
 * sealed air. The sum over nodes is the exact volume under the surface interpolated between them.
 */
export function siliconeVolume(field: Field, inputs: SiliconeInputs): SiliconeVolume {
  const { values, cell } = field;
  let sum = 0, nodes = 0;
  for (let n = 0; n < values.length; n++) {
    const v = values[n];
    if (v > 0) {
      sum += v;
      nodes++;
    }
  }
  const cellArea = cell * cell;
  const integral = (sum + inputs.raise * nodes) * cellArea;
  const model = (inputs.exteriorVolume + inputs.sealedAir) * inputs.tiles;
  return { integral, area: nodes * cellArea, ml: (integral - model) / 1000 };
}

/**
 * Volume of a mesh above z = 0, as the integral of z over its surface projected on the plane. The
 * cut at z = 0 needs no cap, as z is 0 all over it, and for the same reason an open mesh that only
 * lacks its flat base still gets its true volume. Overlapping shells count twice, as in M1.
 */
export function volumeAbovePlane(mesh: WeldedMesh): number {
  const { positions: p, indices } = mesh;
  const triangle = new Float64Array(9);
  const clipped = new Float64Array(12);
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const v = indices[t + c] * 3;
      triangle[c * 3] = p[v];
      triangle[c * 3 + 1] = p[v + 1];
      triangle[c * 3 + 2] = p[v + 2];
    }
    const corners = clipToPlane(triangle, 3, 2, 0, true, clipped);
    for (let k = 2; k < corners; k++) {
      const a = 0, b = (k - 1) * 3, d = k * 3;
      const doubled = (clipped[b] - clipped[a]) * (clipped[d + 1] - clipped[a + 1]) - (clipped[b + 1] - clipped[a + 1]) * (clipped[d] - clipped[a]);
      sum += (doubled * (clipped[a + 2] + clipped[b + 2] + clipped[d + 2])) / 6;
    }
  }
  return sum;
}

export interface MoldSilicone extends SiliconeVolume {
  /** The model above the plane per tile in mm3, with overlaps counted once and voids included. */
  modelVolume: number;
  /** Sealed air per tile in mm3. */
  sealedAir: number;
  domains: SealedDomain[];
}

/**
 * The silicone of a built field, as the plan defines it. Everything that makes it up is chosen here,
 * so the tests and the pipeline measure the same thing: the exterior mesh, so a void is not air, the
 * model above the plane only, because the raster clips the rest, and the sealed air above the filter.
 * M1's overlap is for the whole model, so bodies overlapping below the plane would take off too much.
 */
export function moldSilicone(mesh: WeldedMesh, plan: FieldPlan, field: Field, report: Pick<SolidReport, 'overlapVolume'>, settings: Pick<FieldSettings, 'analysisCell' | 'minVolumeMl'>): MoldSilicone {
  const exterior = exteriorMesh(mesh);
  const modelVolume = volumeAbovePlane(exterior) - report.overlapVolume;
  const domains = sealedDomains(exterior, settings.analysisCell, settings.minVolumeMl * 1000);
  const sealedAir = domains.reduce((sum, domain) => sum + domain.volume, 0);
  const volume = siliconeVolume(field, { exteriorVolume: modelVolume, tiles: plan.nx * plan.ny, sealedAir, raise: plan.raise });
  return { ...volume, modelVolume, sealedAir, domains };
}
