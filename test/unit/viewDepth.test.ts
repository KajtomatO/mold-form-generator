import { describe, expect, it } from 'vitest';
import { moldExtent } from '../../src/app/derived';
import { fieldSettings } from '../../src/core/field/grid';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import { deriveRim, moldBounds } from '../../src/core/parts/rim';
import { boxCorners, depthPlanes, depthStep, MIN_NEAR, orthoPlanes } from '../../src/view/depthPlanes';
import { DEFAULT_LAYERS, partMaterial, type LayerName } from '../../src/view/materials';
import { LIFT, OUTLINE_LIFT } from '../../src/view/overlays';
import { box } from '../fixtures/synthetic';

type V = [number, number, number];
const DEG = Math.PI / 180;

/** The mold's box at defaults round a cube of `size` mm standing on the plane, as moldExtent gives it to the view. */
function moldOf(size: number): { min: V; max: V } {
  const params = defaultParams();
  const mesh = box([0, 0, 0], [size, size, size]);
  const bounds = meshBounds(mesh.positions);
  return moldExtent(deriveRim(moldBounds(mesh, bounds, fieldSettings(params, bounds)), params));
}

const sub = (a: readonly number[], b: readonly number[]): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: V): V => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const depthOf = (p: readonly number[], eye: V, forward: V): number => (p[0] - eye[0]) * forward[0] + (p[1] - eye[1]) * forward[1] + (p[2] - eye[2]) * forward[2];

interface View {
  eye: V;
  target: V;
  inside: boolean;
}

/** frameBox's camera: from the front right, above, 1.77 box diagonals from the centre. */
function framed(box: { min: V; max: V }, k = 1): View {
  const centre = box.min.map((v, i) => (v + box.max[i]) / 2) as V;
  const size = Math.hypot(...sub(box.max, box.min));
  return { eye: [centre[0] + 0.6 * size * k, centre[1] - 1.4 * size * k, centre[2] + 0.9 * size * k], target: centre, inside: false };
}

/** Every view the test takes of a box: the framed one zoomed out, orbits all round, Top view, and two inside it. */
function views(box: { min: V; max: V }): View[] {
  const list: View[] = [1, 2, 5, 20].map((k) => framed(box, k));
  const { target } = framed(box);
  const distance = Math.hypot(...sub(framed(box).eye, target));
  for (let azimuth = 0; azimuth < 360; azimuth += 30) {
    for (const elevation of [-30, 0, 30, 60, 85]) {
      const a = azimuth * DEG, e = elevation * DEG;
      list.push({ eye: [target[0] + distance * Math.cos(e) * Math.cos(a), target[1] + distance * Math.cos(e) * Math.sin(a), target[2] + distance * Math.sin(e)], target, inside: false });
    }
  }
  // topView: the top filling the view's height at 35 degrees with 12% to spare (a square box, a wide view).
  const half = ((box.max[1] - box.min[1]) / 2) * 1.12;
  const up = half / Math.tan(17.5 * DEG);
  const top: V = [target[0], target[1], box.max[2]];
  list.push({ eye: [top[0], top[1] - up * 1e-3, top[2] + up], target: top, inside: false });
  for (const k of [0.05, 0.2]) list.push({ ...framed(box, k), inside: true });
  return list;
}

/**
 * What is wrong with these planes for this view of the box, by the test's rules; empty if nothing. From in
 * front of the box every corner lies between the planes; from any view, inside the box too, what the camera
 * orbits does, and inside the box the near plane stands no further than 5% of the way to it, so what lies
 * close round the target is kept as well; the step at the farthest corner is under the bar; and near is
 * never under 0.1.0's.
 */
function problems(planes: { near: number; far: number }, corners: V[], view: View, bars = { outside: 0.001, inside: 0.01 }): string[] {
  const forward = unit(sub(view.target, view.eye));
  const depths = corners.map((c) => depthOf(c, view.eye, forward));
  const nearest = Math.min(...depths), farthest = Math.max(...depths);
  const toTarget = depthOf(view.target, view.eye, forward);
  const found: string[] = [];
  if (nearest > 0 && depths.some((d) => d < planes.near || d > planes.far)) found.push(`a corner outside ${planes.near.toFixed(2)}..${planes.far.toFixed(1)}`);
  if (toTarget < planes.near || toTarget > planes.far) found.push(`the target at ${toTarget.toFixed(2)} outside ${planes.near.toFixed(2)}..${planes.far.toFixed(1)}`);
  if (nearest <= 0 && planes.near > 0.05 * toTarget) found.push(`near ${planes.near.toFixed(2)} past 5% of the ${toTarget.toFixed(1)} mm to the target`);
  const step = depthStep(planes.near, planes.far, farthest);
  const bar = view.inside ? bars.inside : bars.outside;
  if (step > bar) found.push(`a step of ${step.toExponential(2)} mm at ${farthest.toFixed(0)} mm`);
  if (planes.near < MIN_NEAR) found.push(`near ${planes.near}`);
  return found;
}

describe('the 3D view\'s depth buffer (U2)', () => {
  it('U2: the fixed planes of 0.1.0 give a depth step of 0.065 and 0.47 mm at the framed view of a 60 and a 200 mm mold', () => {
    const steps = [60, 200].map((size) => {
      const mold = moldOf(size);
      const view = framed(mold);
      const forward = unit(sub(view.target, view.eye));
      const farthest = Math.max(...boxCorners(mold.min, mold.max).map((c) => depthOf(c, view.eye, forward)));
      return depthStep(0.1, 5000, farthest);
    });
    // The cause, measured: more than a ring's 0.05 mm lift and the rebate's 0.097 mm gap, so they fought.
    expect(steps[0]).toBeGreaterThan(0.055);
    expect(steps[0]).toBeLessThan(0.067);
    expect(steps[1]).toBeGreaterThan(0.4);
    expect(steps[1]).toBeLessThan(0.48);
    // Each is also over this file's bar, so the test below would fail on the planes of 0.1.0.
    for (const step of steps) expect(step).toBeGreaterThan(0.05);
  });

  it('depthPlanes: every corner between the planes, and a depth step under 0.001 mm from every view outside the box, under 0.01 mm inside', () => {
    const params = defaultParams();
    const { joint, funnel } = params;
    // The smallest gaps the view draws between two surfaces: an opening ring over the flat top, a flange's
    // dashed circle under a ring and over the top, the plate's sides behind the rebate, the ridge in its
    // groove, and a funnel's spigot in its seat. 0.001 mm is 20 steps of the smallest.
    const gaps = [LIFT, OUTLINE_LIFT, LIFT - OUTLINE_LIFT, joint.taperClearance * Math.cos(joint.taperDeg * DEG), joint.grooveClearance * Math.cos(joint.ridgeDraftDeg * DEG), joint.grooveExtraDepth, funnel.seatClearance];
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.02 - 1e-12);
    const worst = { outside: 0, inside: 0 };
    let count = 0;
    for (const size of [20, 60, 200]) {
      const mold = moldOf(size);
      const corners = boxCorners(mold.min, mold.max);
      for (const view of views(mold)) {
        const forward = unit(sub(view.target, view.eye));
        const planes = depthPlanes(corners, view.eye, forward, Math.hypot(...sub(view.target, view.eye)));
        expect(problems(planes, corners, view), `${size} mm from ${view.eye.map((v) => v.toFixed(0))}`).toEqual([]);
        const farthest = Math.max(...corners.map((c) => depthOf(c, view.eye, forward)));
        const nearest = Math.min(...corners.map((c) => depthOf(c, view.eye, forward)));
        expect(nearest > 0, `${size} mm: the view from ${view.eye.map((v) => v.toFixed(0))} is ${view.inside ? 'inside' : 'outside'} the box`).toBe(!view.inside);
        const step = depthStep(planes.near, planes.far, farthest);
        const side = view.inside ? 'inside' : 'outside';
        worst[side] = Math.max(worst[side], step);
        count++;
      }
      // As measured at the framed view: about 2e-5 mm at 60 mm and 5e-5 mm at 200 mm, where 0.1.0 had 0.065 and 0.47.
      const view = framed(mold);
      const forward = unit(sub(view.target, view.eye));
      const planes = depthPlanes(corners, view.eye, forward, Math.hypot(...sub(view.target, view.eye)));
      const step = depthStep(planes.near, planes.far, Math.max(...corners.map((c) => depthOf(c, view.eye, forward))));
      if (size === 60) expect(step).toBeLessThan(3e-5);
      if (size === 200) expect(step).toBeLessThan(7e-5);
    }
    expect(count).toBe(3 * (4 + 60 + 1 + 2));
    expect(worst.outside).toBeLessThan(0.001);
    expect(worst.inside).toBeLessThan(0.01);
    // With nothing drawn yet, 0.1.0's planes.
    expect(depthPlanes(null, [0, 0, 100], [0, 0, -1], 100)).toEqual({ near: 0.1, far: 5000 });
  });

  it('negative controls: a near plane past the nearest corner, and the fixed planes of 0.1.0, each fail the rules above', () => {
    const mold = moldOf(60);
    const corners = boxCorners(mold.min, mold.max);
    const view = framed(mold);
    const forward = unit(sub(view.target, view.eye));
    const nearest = Math.min(...corners.map((c) => depthOf(c, view.eye, forward)));
    const fitted = depthPlanes(corners, view.eye, forward, Math.hypot(...sub(view.target, view.eye)));
    expect(problems(fitted, corners, view)).toEqual([]);
    // A near plane at 1.1 times the nearest corner's depth would clip that corner.
    expect(problems({ near: 1.1 * nearest, far: fitted.far }, corners, view)).toEqual([expect.stringMatching(/^a corner outside/)]);
    // 0.1.0's planes keep every corner but resolve only 0.06 mm there.
    expect(problems({ near: 0.1, far: 5000 }, corners, view)).toEqual([expect.stringMatching(/^a step of 6\.\d+e-2 mm/)]);
    // Inside the box, a near plane beyond what the camera orbits would clip it, and one at a fifth of the
    // way would clip what lies close round it, though either only shrinks the step.
    const inside = framed(mold, 0.2);
    const toTarget = Math.hypot(...sub(inside.target, inside.eye));
    const insideForward = unit(sub(inside.target, inside.eye));
    expect(problems(depthPlanes(corners, inside.eye, insideForward, toTarget), corners, { ...inside, inside: true })).toEqual([]);
    expect(problems({ near: 2 * toTarget, far: fitted.far }, corners, { ...inside, inside: true })).toEqual([expect.stringMatching(/^the target at .* outside/), expect.stringMatching(/^near .* past 5% of the/)]);
    expect(problems({ near: 0.2 * toTarget, far: fitted.far }, corners, { ...inside, inside: true })).toEqual([expect.stringMatching(/^near .* past 5% of the/)]);
  });

  it('orthoPlanes: the orthographic view keeps the mold between its planes from any distance, where 0.1.0\'s, fixed at the camera, lost it past 5 m', () => {
    const lost: number[] = [];
    for (const size of [20, 60, 200]) {
      const mold = moldOf(size);
      const corners = boxCorners(mold.min, mold.max);
      for (const k of [1, 2, 5, 20, 50]) {
        const view = framed(mold, k);
        const forward = unit(sub(view.target, view.eye));
        const toTarget = Math.hypot(...sub(view.target, view.eye));
        const depths = corners.map((c) => depthOf(c, view.eye, forward));
        const planes = orthoPlanes(toTarget);
        expect(depths.every((d) => d > planes.near && d < planes.far), `${size} mm, ${k} times out`).toBe(true);
        // Linear: the same 0.0006 mm step at every distance.
        expect((planes.far - planes.near) / 2 ** 24).toBeLessThan(0.001);
        // Negative control: -5000 and 5000 from the camera, as 0.1.0 had them.
        if (!depths.every((d) => d > -5000 && d < 5000)) lost.push(toTarget);
      }
    }
    expect(lost.length).toBeGreaterThan(0);
    expect(Math.min(...lost)).toBeGreaterThan(4500);
  });

  it('the base and the funnel draw a hair behind by a polygon offset, and no other part does', () => {
    const biased = (Object.keys(DEFAULT_LAYERS) as LayerName[]).filter((name) => {
      const material = partMaterial(name, DEFAULT_LAYERS[name], false);
      const on = material.polygonOffset;
      if (on) {
        expect(material.polygonOffsetFactor, name).toBeGreaterThanOrEqual(1);
        expect(material.polygonOffsetUnits, name).toBeGreaterThanOrEqual(1);
      }
      material.dispose();
      return on;
    });
    expect(biased.sort()).toEqual(['base', 'funnel']);
    // Seen through, as a user may set it, the base keeps its offset.
    expect(partMaterial('base', { visible: true, opacity: 0.5 }, true).polygonOffset).toBe(true);
  });
});
