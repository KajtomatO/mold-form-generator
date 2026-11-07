import type { ManifoldToplevel } from 'manifold-3d';
import { withArena } from '../solid/arena';

/**
 * Fixed benchmark run in both Node and a browser worker, so the ratio between them
 * can correct server timings. It covers the two kinds of work the app does: typed-array
 * loops in plain JS and booleans in WASM.
 */
export interface BenchResult {
  name: string;
  ms: number;
}

/** Hemisphere splat of a synthetic height map, the app's core loop in unoptimised form. */
export function splatKernel(size: number, radius: number): number {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5;
      const dy = y / size - 0.5;
      h[x + y * size] = Math.max(0, 40 - 120 * Math.hypot(dx, dy)) + Math.sin(x * 0.3) * Math.cos(y * 0.3);
    }
  }
  const off: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= radius * radius) off.push(dx, dy, Math.sqrt(radius * radius - d2));
    }
  }
  const kernel = Float32Array.from(off);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = h[x + y * size];
      if (v <= 0) continue;
      for (let k = 0; k < kernel.length; k += 3) {
        const X = x + kernel[k];
        const Y = y + kernel[k + 1];
        if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
        const i = X + Y * size;
        const z = v + kernel[k + 2];
        if (z > out[i]) out[i] = z;
      }
    }
  }
  return out[(size * size + size) >> 1];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

export function runBench(api: ManifoldToplevel, now: () => number, repeats = 3): BenchResult[] {
  const results: BenchResult[] = [];
  const measure = (name: string, fn: () => void): void => {
    const times: number[] = [];
    for (let i = 0; i < repeats; i++) {
      const t0 = now();
      fn();
      times.push(now() - t0);
    }
    results.push({ name, ms: Math.round(median(times) * 10) / 10 });
  };

  measure('js: splat 512x512 r=14', () => {
    splatKernel(512, 14);
  });
  for (const segments of [128, 256, 512]) {
    measure(`wasm: sphere minus sphere, ${segments} segments`, () => {
      withArena(api, ({ track }) => {
        const a = track(api.Manifold.sphere(30, segments));
        const b = track(track(api.Manifold.sphere(30, segments)).translate(20, 5, 3));
        track(a.subtract(b)).numTri();
      });
    });
  }
  return results;
}
