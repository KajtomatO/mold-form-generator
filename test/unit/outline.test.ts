import { describe, expect, it } from 'vitest';
import { flangeOutlines, flangeTip, type FlangeSpot, type OpeningRing } from '../../src/app/derived';
import { checkOpening, FLANGE_GAP, flangeReach, openingSizes, placementSpace, topRadius, type OpeningSizes, type OpeningSpot, type PlacementSpace } from '../../src/core/analysis/validate';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import type { Rect } from '../../src/core/solid/rect';
import * as THREE from 'three';
import { WebGLRenderLists } from 'three/src/renderers/webgl/WebGLRenderLists.js';
import { CASING_WIDTH, dashCasing, dashCount, dashedRing, DASH_SHARE, OUTLINE_WIDTH } from '../../src/view/dashes';
import { DEFAULT_LAYERS, LAYER_ORDER, partMaterial } from '../../src/view/materials';
import { DiagnosticMarkers, FlangeOutlines, OpeningMarkers, RING_WIDTH } from '../../src/view/overlays';
import { SectionHandle } from '../../src/view/section';
import { fieldOf } from '../fixtures/fieldShapes';

/**
 * OL's tests take FL's 4 mm flange, as built: where it reaches, the flange's term decides the top's edge at a
 * 3 mm wall, which VN's default of 2 mm (D21) does not.
 */
function fl4(): Params {
  const params = defaultParams();
  params.funnel.flangeWidth = 4;
  return params;
}
const sizes: OpeningSizes = openingSizes(fl4());
/** FL's flange at 4 mm, by hand: the seat's radius at the top, 5 + 3 tan 30, plus the 4 mm flange width. */
const FLANGE = 5 + 3 * Math.tan(Math.PI / 6) + 4;
const SEAT = 5 + 3 * Math.tan(Math.PI / 6);
const MOUTH = topRadius(sizes, 'vent');
/** Where a vent's centre may come no nearer a pour's: the flange, the mouth and the 0.5 mm gap, by hand. */
const REACH = FLANGE + MOUTH + 0.5;

/** A cavity under all of the box, so only the land, flange and edge rules can refuse. */
const cavity = fieldOf(200, 200, 0.5, () => 20);
const O: Rect = { x0: -100, y0: -100, x1: 300, y1: 300 };

function sizesWith(change: (p: Params) => void): OpeningSizes {
  const params = fl4();
  change(params);
  return openingSizes(params);
}

/** Every copy of each spot on the lattice of `offsets`, as the view lists rings: opening by opening, a copy per tile. */
function ringsOf(spots: OpeningSpot[], offsets: [number, number][], ghosts: OpeningSpot[] = []): OpeningRing[] {
  const ring = (spot: OpeningSpot, [ox, oy]: [number, number], ghost?: boolean): OpeningRing => ({ x: spot.x + ox, y: spot.y + oy, kind: spot.kind, valid: true, radius: topRadius(sizes, spot.kind), ...(ghost ? { ghost } : {}) });
  return [...spots.flatMap((spot) => offsets.map((offset) => ring(spot, offset))), ...ghosts.flatMap((spot) => offsets.map((offset) => ring(spot, offset, true)))];
}

/** A lattice of nx by ny tiles at a pitch of 32 by 28 mm, near enough that a vent can come under the next tile's flange. */
function lattice(nx: number, ny: number): [number, number][] {
  const offsets: [number, number][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) offsets.push([i * 32, j * 28]);
  return offsets;
}

/** A seeded stream in [0, 1), so the random spots are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether the point lies in one of the triangles, z ignored. */
function covers(positions: ArrayLike<number>, indices: ArrayLike<number>, [px, py]: [number, number]): boolean {
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((v) => [positions[v * 3], positions[v * 3 + 1]]);
    const side = (p: number[], q: number[]): number => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
    const s1 = side(a, b), s2 = side(b, c), s3 = side(c, a);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  }
  return false;
}

describe('OL: the flange outline round each pour', () => {
  it('one outline per copy of each pour, at the flange\'s radius worked out by hand, and none at a vent, a landing spot, or with no funnel, no seat or no flange', () => {
    const offsets = lattice(2, 1);
    const spots: OpeningSpot[] = [{ kind: 'pour', x: 10, y: 10 }, { kind: 'vent', x: 10, y: 25 }, { kind: 'pour', x: 10, y: 60 }, { kind: 'vent', x: 10, y: 75 }];
    const rings = ringsOf(spots, offsets, [{ kind: 'pour', x: 40, y: 40 }]);
    const outlines = flangeOutlines(sizes, O, rings);
    expect(outlines.map(({ x, y }) => [x, y])).toEqual([[10, 10], [42, 10], [10, 60], [42, 60]]);
    for (const outline of outlines) {
      expect(outline.radius).toBeCloseTo(FLANGE, 9);
      expect(outline.refused).toBe(false);
    }
    // Not the seat's radius, nor the reach a vent's centre keeps: the flange's own edge.
    expect(Math.abs(outlines[0].radius - SEAT)).toBeGreaterThan(3.9);
    expect(Math.abs(outlines[0].radius - REACH)).toBeGreaterThan(2);
    expect(flangeOutlines(sizesWith((p) => (p.funnel.flangeWidth = 6)), O, rings)[0].radius).toBeCloseTo(SEAT + 6, 9);
    // No funnel, no seat or no flange: nothing rests on the top, so nothing is drawn.
    for (const change of [(p: Params) => (p.funnel.generate = false), (p: Params) => (p.seat.enabled = false), (p: Params) => (p.funnel.flangeWidth = 0)]) {
      expect(flangeOutlines(sizesWith(change), O, rings)).toEqual([]);
    }
  });

  it('an outline is refused exactly where the hard rule refuses a vent or a pour for the flange, copy by copy, on 1 x 1, 2 x 1 and 3 x 3', () => {
    const reach = flangeReach(sizes);
    expect(reach).toBeCloseTo(REACH, 9);
    let refusedSeen = 0, clearSeen = 0, crossTile = 0;
    for (const [nx, ny] of [[1, 1], [2, 1], [3, 3]]) {
      const offsets = lattice(nx, ny);
      const space: PlacementSpace = placementSpace(cavity, { O, Zt: 40, wall: 3 }, offsets, sizes);
      const random = seeded(nx * 10 + ny);
      const pour: OpeningSpot = { kind: 'pour', x: 40, y: 40 };
      for (let k = 0; k < 400; k++) {
        const angle = random() * 2 * Math.PI, distance = random() * 20;
        const vent: OpeningSpot = { kind: 'vent', x: pour.x + distance * Math.cos(angle), y: pour.y + distance * Math.sin(angle) };
        const outlines = flangeOutlines(sizes, O, ringsOf([pour, vent], offsets));
        expect(outlines).toHaveLength(offsets.length);
        // By hand, copy by copy: any copy of the vent nearer this copy of the pour than the reach.
        const pairs = offsets.map(([px, py]) => Math.min(...offsets.map(([vx, vy]) => Math.hypot(vent.x + vx - pour.x - px, vent.y + vy - pour.y - py))));
        if (pairs.some((d) => Math.abs(d - reach) < 1e-6)) continue;
        expect(outlines.map((o) => o.refused), `vent at ${vent.x.toFixed(3)}, ${vent.y.toFixed(3)} on ${nx} x ${ny}`).toEqual(pairs.map((d) => d < reach));
        const anyRefused = outlines.some((o) => o.refused);
        expect(anyRefused).toBe(checkOpening(space, vent, [pour]).problems.includes('flange'));
        expect(anyRefused).toBe(checkOpening(space, pour, [vent]).problems.includes('flange'));
        if (anyRefused) refusedSeen++;
        else clearSeen++;
        if (Math.hypot(vent.x - pour.x, vent.y - pour.y) >= reach && anyRefused) crossTile++;
      }
    }
    // Both answers came up often, and on the grids a vent clear of its own pour came under the next tile's flange.
    expect(refusedSeen).toBeGreaterThan(300);
    expect(clearSeen).toBeGreaterThan(300);
    expect(crossTile).toBeGreaterThan(20);
  });

  it('negative control: a vent outside the circle but within its reach is refused, so a rule of "inside the circle" would miss it', () => {
    const pour: OpeningSpot = { kind: 'pour', x: 40, y: 40 };
    const at = (distance: number): FlangeSpot => flangeOutlines(sizes, O, ringsOf([pour, { kind: 'vent', x: 40 + distance, y: 40 }], [[0, 0]]))[0];
    // Outside the circle (10.73 mm), within the reach (12.78 mm): the mouth would sit under or within 0.5 mm of the flange.
    expect(at(11.5).refused).toBe(true);
    expect(at(12.77).refused).toBe(true);
    expect(at(12.79).refused).toBe(false);
    expect(11.5).toBeGreaterThan(at(11.5).radius);
    // Beside it, where placement puts a vent, it is clear.
    expect(at(REACH + 0.01).refused).toBe(false);
  });

  it('an outline whose flange runs past the top\'s chamfer is refused, as the top-edge rule refuses the pour', () => {
    const edge = FLANGE + sizes.topChamfer;
    const space = placementSpace(cavity, { O, Zt: 40, wall: 3 }, [[0, 0]], sizes);
    for (const side of [0, 1, 2, 3]) {
      for (const by of [-0.01, 0.01]) {
        // by < 0 is past the edge: the flange's term (11.13 mm) is the larger at a 3 mm wall (9.73 mm).
        const along = by + edge;
        const spot: OpeningSpot = side === 0 ? { kind: 'pour', x: O.x0 + along, y: 100 } : side === 1 ? { kind: 'pour', x: 100, y: O.y0 + along } : side === 2 ? { kind: 'pour', x: O.x1 - along, y: 100 } : { kind: 'pour', x: 100, y: O.y1 - along };
        const outline = flangeOutlines(sizes, O, ringsOf([spot], [[0, 0]]))[0];
        expect(outline.refused, `side ${side}, ${by}`).toBe(by < 0);
        expect(checkOpening(space, spot, []).problems.includes('top-edge'), `side ${side}, ${by}`).toBe(by < 0);
      }
    }
    // With a wall wide enough that the seat's term decides (6 + 6.73 > 11.13), a pour there is refused for the
    // seat, which its ring shows, and the flange's outline stays as it is.
    const wide = placementSpace(cavity, { O, Zt: 40, wall: 6 }, [[0, 0]], sizes);
    const spot: OpeningSpot = { kind: 'pour', x: O.x0 + edge + 0.5, y: 100 };
    expect(checkOpening(wide, spot, []).problems).toContain('top-edge');
    expect(flangeOutlines(sizes, O, ringsOf([spot], [[0, 0]]))[0].refused).toBe(false);
  });

  it('the dashed circle lies at the radius, 0.4 mm across, a dash centred on +x and a gap after it, all round', () => {
    const radius = FLANGE;
    const n = dashCount(radius);
    expect(n).toBe(24);
    expect(dashCount(2)).toBe(12);
    const { positions, indices } = dashedRing(radius);
    expect(OUTLINE_WIDTH).toBe(0.4);
    for (let v = 0; v < positions.length; v += 3) {
      const r = Math.hypot(positions[v], positions[v + 1]);
      expect(Math.abs(Math.abs(r - radius) - OUTLINE_WIDTH / 2)).toBeLessThan(1e-5);
      expect(positions[v + 2]).toBe(0);
    }
    // The share of the circle the dashes cover, from their area against the whole band's.
    let area = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((v) => [positions[v * 3], positions[v * 3 + 1]]);
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    const band = Math.PI * ((radius + 0.2) ** 2 - (radius - 0.2) ** 2);
    expect(area / band).toBeGreaterThan(DASH_SHARE - 0.01);
    expect(area / band).toBeLessThan(DASH_SHARE + 0.01);
    // A dash on +x, a gap half a period round, and so on all round.
    const at = (angle: number): [number, number] => [radius * Math.cos(angle), radius * Math.sin(angle)];
    for (let k = 0; k < n; k++) {
      expect(covers(positions, indices, at((2 * Math.PI * k) / n)), `dash ${k}`).toBe(true);
      expect(covers(positions, indices, at((2 * Math.PI * (k + 0.5)) / n)), `gap ${k}`).toBe(false);
    }
    // Negative control: the gap probe finds a solid band, the plain ring this outline must not look like.
    const stops = 96;
    const ring = { positions: new Float32Array(stops * 2 * 3), indices: new Uint32Array(stops * 6) };
    for (let s = 0; s < stops; s++) {
      const angle = (2 * Math.PI * s) / stops;
      ring.positions.set([(radius - 0.2) * Math.cos(angle), (radius - 0.2) * Math.sin(angle), 0, (radius + 0.2) * Math.cos(angle), (radius + 0.2) * Math.sin(angle), 0], s * 6);
      const a = 2 * s, b = (2 * s + 2) % (2 * stops);
      ring.indices.set([a, a + 1, b + 1, a, b + 1, b], s * 6);
    }
    expect(covers(ring.positions, ring.indices, at(Math.PI / n))).toBe(true);
  });

  it('each dash lies on a light band 0.2 mm wider on each side and 0.2 mm longer at each end, and every gap stays open', () => {
    const radius = FLANGE;
    const n = dashCount(radius);
    const spare = (CASING_WIDTH - OUTLINE_WIDTH) / 2;
    expect(spare).toBeCloseTo(0.2, 12);
    const casing = dashCasing(radius);
    for (let v = 0; v < casing.positions.length; v += 3) {
      expect(Math.abs(Math.abs(Math.hypot(casing.positions[v], casing.positions[v + 1]) - radius) - CASING_WIDTH / 2)).toBeLessThan(1e-5);
    }
    const at = (r: number, angle: number): [number, number] => [r * Math.cos(angle), r * Math.sin(angle)];
    // The dash's half length along the circle, as an angle, and the band's 0.2 mm past it.
    const half = (Math.PI * DASH_SHARE) / n, past = spare / radius;
    for (let k = 0; k < n; k++) {
      const centre = (2 * Math.PI * k) / n;
      // Round the dark dash, 0.19 mm out from each of its edges and ends: on the band.
      for (const point of [at(radius + OUTLINE_WIDTH / 2 + 0.19, centre), at(radius - OUTLINE_WIDTH / 2 - 0.19, centre), at(radius, centre + half + 0.19 / radius), at(radius, centre - half - 0.19 / radius)]) {
        expect(covers(casing.positions, casing.indices, point), `round dash ${k}`).toBe(true);
      }
      // 0.21 mm past each, and in the middle of the gap: off it.
      for (const point of [at(radius + OUTLINE_WIDTH / 2 + 0.21, centre), at(radius - OUTLINE_WIDTH / 2 - 0.21, centre), at(radius, centre + half + past + 0.01 / radius), at(radius, centre + Math.PI / n)]) {
        expect(covers(casing.positions, casing.indices, point), `past dash ${k}`).toBe(false);
      }
    }
    // On a circle so small that 0.2 mm would close a gap, the band runs on by a quarter of the gap at most.
    const small = 2, m = dashCount(small);
    const tight = dashCasing(small);
    expect(covers(tight.positions, tight.indices, at(small, Math.PI / m))).toBe(false);
  });

  it('a vent\'s ring touches the dashes exactly where the flange rule starts to refuse the vent, so "keep the ring wholly outside the circle" is the rule', () => {
    // Half a ring and half the dark line are the rule's gap: the ring is drawn 0.3 mm each side of the mouth's
    // edge and the line 0.2 mm each side of the flange's, so their edges meet where the mouth is 0.5 mm clear.
    expect(RING_WIDTH / 2 + OUTLINE_WIDTH / 2).toBeCloseTo(FLANGE_GAP, 12);
    const space = placementSpace(cavity, { O, Zt: 40, wall: 3 }, [[0, 0]], sizes);
    const pour: OpeningSpot = { kind: 'pour', x: 40, y: 40 };
    let refused = 0, clear = 0;
    for (let d = 0.5; d <= 20; d += 0.01) {
      if (Math.abs(d - REACH) < 1e-6) continue;
      // The ring's edge nearest the pour, against the dark line's outer edge: on it or inside the circle.
      const touches = d - MOUTH - RING_WIDTH / 2 < FLANGE + OUTLINE_WIDTH / 2;
      const problems = checkOpening(space, { kind: 'vent', x: pour.x + d, y: pour.y }, [pour]).problems;
      expect(touches, `vent ${d.toFixed(2)} mm out`).toBe(problems.includes('flange'));
      if (touches) refused++;
      else clear++;
    }
    expect(refused).toBeGreaterThan(1000);
    expect(clear).toBeGreaterThan(600);
  });

  it('VN: the drag tip says what keeps a vent\'s mouth clear of the flange, by the gap these settings need: the ring wholly outside the circle at defaults, and that much further out past them', () => {
    expect(sizes.flangeGap).toBe(FLANGE_GAP);
    expect(flangeTip('vent', sizes.flangeGap)).toBe("The red dashed circle is that funnel's flange: keep the vent's ring wholly outside it, which leaves the vent's mouth 0.5 mm clear of the flange.");
    expect(flangeTip('pour', sizes.flangeGap)).toBe("The red dashed circle is this pour's flange: keep every vent's ring wholly outside it, which leaves each mouth 0.5 mm clear of the flange.");
    // At a seat clearance of 0.5 in a 45 degree seat the gap is 0.5 / cos 45 + 0.2 = 0.907 mm, so the ring must stand 0.41 mm off the dashes.
    const loose = sizesWith((p) => ((p.funnel.seatClearance = 0.5), (p.seat.halfAngleDeg = 45)));
    expect(loose.flangeGap).toBeCloseTo(0.5 / Math.SQRT1_2 + 0.2, 12);
    expect(flangeTip('vent', loose.flangeGap)).toBe("The red dashed circle is that funnel's flange: keep the vent's ring 0.41 mm or more outside it, which leaves the vent's mouth 0.91 mm clear of the flange, as the funnel's play in its seat and half a printed line need.");
    expect(flangeTip('pour', loose.flangeGap)).toBe("The red dashed circle is this pour's flange: keep every vent's ring 0.41 mm or more outside it, which leaves each mouth 0.91 mm clear of the flange, as the funnel's play in its seat and half a printed line need.");
    // And it is so: there a vent is refused until its ring stands that far off the dashes, and the outline turns red with it.
    const space = placementSpace(cavity, { O, Zt: 40, wall: 3 }, [[0, 0]], loose);
    const pour: OpeningSpot = { kind: 'pour', x: 40, y: 40 };
    const touching = loose.flangeRadius + OUTLINE_WIDTH / 2 + RING_WIDTH / 2 + topRadius(loose, 'vent');
    for (const [off, refused] of [[0.01, true], [0.4, true], [0.42, false]] as [number, boolean][]) {
      const vent: OpeningSpot = { kind: 'vent', x: pour.x + touching + off, y: pour.y };
      expect(checkOpening(space, vent, [pour]).problems.includes('flange'), `${off} mm off`).toBe(refused);
      expect(flangeOutlines(loose, O, ringsOf([pour, vent], [[0, 0]]))[0].refused, `${off} mm off`).toBe(refused);
    }
  });

  it('the dashes draw after the see-through cover, over their light band, and before every overlay meant to stay on top, as three sorts them', () => {
    // As the scene holds them: the cover and the rings and outlines under the cover's root, a plain Object3D;
    // the diagnostic pins and the section's handle in groups of their own.
    const scene = new THREE.Scene();
    const coverRoot = new THREE.Object3D();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), partMaterial('cover', DEFAULT_LAYERS.cover, false));
    cover.renderOrder = LAYER_ORDER.cover;
    cover.name = 'cover';
    const flanges = new FlangeOutlines();
    flanges.set([{ x: 0, y: 0, radius: FLANGE, refused: false }], 0);
    for (const mesh of flanges.group.children as THREE.Mesh[]) mesh.name = mesh.material === flanges.materials.casing ? 'band' : 'dashes';
    const rings = new OpeningMarkers();
    rings.set([{ x: 0, y: 0, radius: SEAT, kind: 'pour', valid: true }, { x: 30, y: 0, radius: SEAT, kind: 'pour', valid: true, ghost: true }], 0);
    rings.group.children[1].name = 'ghost ring';
    coverRoot.add(cover, rings.group, flanges.group);
    const pins = new DiagnosticMarkers();
    pins.set([{ at: [0, 0, 0] }], 1);
    pins.group.traverse((object) => (object.name ||= 'pin'));
    const handle = new SectionHandle();
    handle.group.visible = true;
    handle.group.traverse((object) => (object.name ||= 'handle'));
    scene.add(coverRoot, pins.group, handle.group);
    scene.updateMatrixWorld();
    // three's own render list and sort; its projectObject's rule that a Group sets the group order of all under it.
    const list = (new (WebGLRenderLists as unknown as new () => { get(scene: THREE.Scene, depth: number): RenderList })()).get(scene, 0);
    list.init();
    const camera = new THREE.PerspectiveCamera();
    const project = (object: THREE.Object3D, groupOrder: number): void => {
      if (!object.visible) return;
      if ((object as THREE.Group).isGroup) groupOrder = object.renderOrder;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.Material).visible) list.push(mesh, mesh.geometry, mesh.material as THREE.Material, groupOrder, 0, null, camera);
      for (const child of object.children) project(child, groupOrder);
    };
    project(scene, 0);
    list.finish();
    list.sort(undefined, undefined);
    const order = list.transparent.map((item) => item.object.name);
    const first = (name: string): number => order.indexOf(name);
    const last = (name: string): number => order.lastIndexOf(name);
    for (const name of ['cover', 'band', 'dashes', 'pin', 'handle', 'ghost ring']) expect(order, name).toContain(name);
    expect(last('cover')).toBeLessThan(first('band'));
    expect(last('band')).toBeLessThan(first('dashes'));
    // The pins and the handle test no depth and must stay on top, and the ghosts come last.
    expect(last('dashes')).toBeLessThan(first('pin'));
    expect(last('dashes')).toBeLessThan(first('handle'));
    expect(last('dashes')).toBeLessThan(first('ghost ring'));
    // The solid rings are opaque: drawn before all of it, and the dashes test their depth (Less), so a ring wins where they cross.
    expect(list.opaque.map((item) => item.object.name)).not.toContain('dashes');
    expect((flanges.materials.plain as THREE.Material).depthFunc).toBe(THREE.LessDepth);
    flanges.dispose();
    rings.dispose();
  });
});

/** What the test reads of three's render list. */
interface RenderList {
  init(): void;
  push(object: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, groupOrder: number, z: number, group: null, camera: THREE.Camera): void;
  finish(): void;
  sort(opaque: undefined, transparent: undefined): void;
  opaque: { object: THREE.Object3D }[];
  transparent: { object: THREE.Object3D }[];
}
