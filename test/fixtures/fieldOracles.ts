import { CUP, HOLED_BLOCK, MUSHROOM } from './synthetic';

/**
 * Closed forms for the height-field fixtures, in ml, so the tests do not depend on any grid. All
 * are at no margin: the integral of H minus the model, plus sealed air for the inverted cup.
 *
 * The integrals over a rim come from integral(0..t) sqrt(t^2 - u^2) du = pi t^2 / 4 and
 * integral(0..t) u sqrt(t^2 - u^2) du = t^3 / 3.
 */
const { PI } = Math;

/** The dome beyond an outer circle of radius R, or inside an inner one when the sign is -1. */
function ringDome(radius: number, t: number, sign: 1 | -1): number {
  return 2 * PI * ((radius * PI * t * t) / 4 + (sign * t * t * t) / 3);
}

const cupVolume = (): number => PI * CUP.R ** 2 * CUP.height - PI * CUP.r ** 2 * (CUP.height - CUP.floor);

/** Open end up: a plastic core reaches down inside, stopping t above the floor and t from the wall. */
export function cupSilicone(t: number): number {
  const { R, r, height, floor } = CUP;
  const core = PI * (r - t) ** 2 * (floor + t);
  const innerRim = PI * (r * r - (r - t) ** 2) * height + ringDome(r, t, -1);
  const lip = PI * (R * R - r * r) * (height + t);
  const outerRim = PI * ((R + t) ** 2 - R * R) * height + ringDome(R, t, 1);
  return (core + innerRim + lip + outerRim - cupVolume()) / 1000;
}

export function cupAir(): number {
  return (PI * CUP.r ** 2 * (CUP.height - CUP.floor)) / 1000;
}

/** Open end on the plane: the field never sees the inside, so that volume is sealed air. */
export function invertedCupSilicone(t: number): number {
  const { R, height } = CUP;
  const integral = PI * R * R * (height + t) + PI * ((R + t) ** 2 - R * R) * height + ringDome(R, t, 1);
  return (integral - cupVolume()) / 1000 - cupAir();
}

export function mushroomSilicone(t: number): number {
  const { stemRadius: s, stemHeight: h, capRadius: c } = MUSHROOM;
  const dome = (radius: number): number => (2 / 3) * PI * radius ** 3;
  const integral = PI * (c + t) ** 2 * h + dome(c + t);
  const model = PI * s * s * h + dome(c);
  return (integral - model) / 1000;
}

/** The field cannot see the hole, so it fills with silicone. */
export function holedBlockSilicone(t: number): number {
  const { side: s, height: h, holeRadius: r } = HOLED_BLOCK;
  const integral = h * (s * s + 4 * s * t + PI * t * t) + s * s * t + PI * t * t * s + (2 / 3) * PI * t ** 3;
  const model = s * s * h - PI * r * r * s;
  return (integral - model) / 1000;
}

type Inside = (x: number, y: number, z: number) => boolean;

const radial = (x: number, y: number): number => Math.hypot(x, y);

export const ANALYTIC_SHAPES: Record<'cup' | 'invertedCup' | 'mushroom' | 'holedBlock', Inside> = {
  cup: (x, y, z) => z > 0 && z < CUP.height && radial(x, y) < CUP.R && !(radial(x, y) < CUP.r && z > CUP.floor),
  invertedCup: (x, y, z) => z > 0 && z < CUP.height && radial(x, y) < CUP.R && !(radial(x, y) < CUP.r && z < CUP.height - CUP.floor),
  mushroom: (x, y, z) => (z > 0 && z <= MUSHROOM.stemHeight && radial(x, y) < MUSHROOM.stemRadius) || (z > MUSHROOM.stemHeight && Math.hypot(radial(x, y), z - MUSHROOM.stemHeight) < MUSHROOM.capRadius),
  holedBlock: (x, y, z) => Math.abs(x) < HOLED_BLOCK.side / 2 && Math.abs(y) < HOLED_BLOCK.side / 2 && z > 0 && z < HOLED_BLOCK.height && Math.hypot(x, z - HOLED_BLOCK.height / 2) >= HOLED_BLOCK.holeRadius,
};

/**
 * What a voxel grid reports for the same shape. The docs do not say how the plan's oracle figures
 * were measured or what shapes they used. This replay was written in M2 as a guess at both, and it
 * lands within 0.5% of the figures at 0.5 mm, which is all the evidence there is for it. Voxels are
 * model if their centre is inside, each column's top voxel centre is dilated by t, and voxels under
 * that surface and outside the model are silicone. `sealedAir` leaves out the voxels in the inverted
 * cup's interior, by the same centre test.
 */
export function voxelSilicone(inside: Inside, voxel: number, t: number, sealedAir: Inside | null = null): { silicone: number; air: number } {
  const half = 36;
  const n = Math.round((2 * half) / voxel);
  const nz = Math.round(70 / voxel);
  const at = (k: number): number => -half + (k + 0.5) * voxel;
  const top = new Float64Array(n * n).fill(-1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      for (let k = nz - 1; k >= 0; k--) {
        if (!inside(at(i), at(j), (k + 0.5) * voxel)) continue;
        top[i + j * n] = (k + 0.5) * voxel;
        break;
      }
    }
  }
  const reach = Math.ceil(t / voxel);
  const kernel: number[] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const d2 = (dx * dx + dy * dy) * voxel * voxel;
      if (d2 <= t * t) kernel.push(dx, dy, Math.sqrt(t * t - d2));
    }
  }
  const H = new Float64Array(n * n);
  for (let j = reach; j < n - reach; j++) {
    for (let i = reach; i < n - reach; i++) {
      const h = top[i + j * n];
      if (h < 0) continue;
      for (let q = 0; q < kernel.length; q += 3) {
        const target = i + kernel[q] + (j + kernel[q + 1]) * n;
        if (h + kernel[q + 2] > H[target]) H[target] = h + kernel[q + 2];
      }
    }
  }
  let silicone = 0, air = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < nz; k++) {
        const z = (k + 0.5) * voxel;
        if (z > H[i + j * n]) break;
        if (inside(at(i), at(j), z)) continue;
        if (sealedAir?.(at(i), at(j), z)) air++;
        else silicone++;
      }
    }
  }
  const unit = voxel ** 3 / 1000;
  return { silicone: silicone * unit, air: air * unit };
}

/** The inside of the inverted cup, for voxelSilicone. */
export const invertedCupInterior: Inside = (x, y, z) => radial(x, y) < CUP.r && z > 0 && z < CUP.height - CUP.floor;
