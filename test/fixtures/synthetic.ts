import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { withArena } from '../../src/core/solid/arena';
import type { WeldedMesh } from '../../src/core/mesh/weld';

type V3 = [number, number, number];

/** A closed box with outward winding: 8 vertices and 12 triangles. */
export function box(min: V3, max: V3): WeldedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, // bottom
      4, 5, 6, 4, 6, 7, // top
      0, 1, 5, 0, 5, 4, // front
      2, 3, 7, 2, 7, 6, // back
      1, 2, 6, 1, 6, 5, // right
      3, 0, 4, 3, 4, 7, // left
    ]),
  };
}

/** Indices of the box's top and bottom triangles, for cutting holes. */
export const BOX_TOP = [2, 3];
export const BOX_BOTTOM = [0, 1];
export const BOX_BOTTOM_FIRST = 0;

export function join(...meshes: WeldedMesh[]): WeldedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...Array.from(mesh.indices, (v) => v + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

export function withoutTriangles(mesh: WeldedMesh, triangles: number[]): WeldedMesh {
  const drop = new Set(triangles);
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    if (!drop.has(t)) indices.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(indices) };
}

export function inverted(mesh: WeldedMesh): WeldedMesh {
  const indices = mesh.indices.slice();
  for (let i = 0; i < indices.length; i += 3) {
    indices[i + 1] = mesh.indices[i + 2];
    indices[i + 2] = mesh.indices[i + 1];
  }
  return { positions: mesh.positions, indices };
}

/** Reverses the winding of a few triangles only, as a badly built file might. */
export function flipTriangles(mesh: WeldedMesh, triangles: number[]): WeldedMesh {
  const indices = mesh.indices.slice();
  for (const t of triangles) {
    indices[t * 3 + 1] = mesh.indices[t * 3 + 2];
    indices[t * 3 + 2] = mesh.indices[t * 3 + 1];
  }
  return { positions: mesh.positions, indices };
}

/**
 * Cuts a closed mesh in two along mid-x: triangles past the middle get their own copies of the
 * shared vertices, moved by `gap`. This is what an exporter rounding each patch separately writes.
 */
export function cracked(mesh: WeldedMesh, gap: number): WeldedMesh {
  const { positions: p, indices } = mesh;
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    low = Math.min(low, p[i]);
    high = Math.max(high, p[i]);
  }
  const middle = (low + high) / 2;
  const isRight = (t: number): boolean => (p[indices[t * 3] * 3] + p[indices[t * 3 + 1] * 3] + p[indices[t * 3 + 2] * 3]) / 3 > middle;
  const count = p.length / 3;
  const onLeft = new Uint8Array(count);
  const onRight = new Uint8Array(count);
  for (let t = 0; t < indices.length / 3; t++) {
    const side = isRight(t) ? onRight : onLeft;
    for (let c = 0; c < 3; c++) side[indices[t * 3 + c]] = 1;
  }
  const positions = Array.from(p);
  const copyOf = new Int32Array(count).fill(-1);
  for (let v = 0; v < count; v++) {
    if (!onLeft[v] || !onRight[v]) continue;
    copyOf[v] = positions.length / 3;
    positions.push(p[v * 3] + gap, p[v * 3 + 1], p[v * 3 + 2]);
  }
  const out = indices.slice();
  for (let t = 0; t < indices.length / 3; t++) {
    if (!isRight(t)) continue;
    for (let c = 0; c < 3; c++) {
      const copy = copyOf[indices[t * 3 + c]];
      if (copy >= 0) out[t * 3 + c] = copy;
    }
  }
  return { positions: Float32Array.from(positions), indices: out };
}

/**
 * A 10 mm cube whose far top corner is two vertices `ulps` float steps apart, the smallest open
 * seam. Vertex 6 is that corner, and the top face's two uses of it go to the copy.
 */
export function seamBox(ulps = 1): WeldedMesh {
  const mesh = box([0, 0, 0], [10, 10, 10]);
  const positions = Float32Array.from([...mesh.positions, nextFloat(10, ulps), nextFloat(10, ulps), nextFloat(10, ulps)]);
  const indices = mesh.indices.slice();
  indices[8] = indices[10] = 8;
  return { positions, indices };
}

/** Four coplanar vertices closed into a tetrahedron: a closed mesh Manifold takes, with no volume. */
export function flatTetrahedron(): WeldedMesh {
  return { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 3, 3, 0]), indices: Uint32Array.from([0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0]) };
}

/** A 20 mm cube with a right triangle of the given leg cut out of its top face. */
export function boxWithTopHole(leg: number): WeldedMesh {
  const mesh = box([0, 0, 0], [20, 20, 20]);
  const positions = Float32Array.from([...mesh.positions, 10, 10, 20, 10 + leg, 10, 20, 10, 10 + leg, 20]);
  const top = [4, 5, 9, 5, 6, 9, 6, 10, 9, 6, 7, 10, 7, 4, 8, 7, 8, 10, 4, 9, 8];
  return { positions, indices: Uint32Array.from([...withoutTriangles(mesh, BOX_TOP).indices, ...top]) };
}

/** The inverse of weld: 9 floats per triangle, in triangle order. */
export function toSoup(mesh: WeldedMesh): Float32Array {
  const soup = new Float32Array(mesh.indices.length * 3);
  mesh.indices.forEach((v, i) => {
    soup[i * 3] = mesh.positions[v * 3];
    soup[i * 3 + 1] = mesh.positions[v * 3 + 1];
    soup[i * 3 + 2] = mesh.positions[v * 3 + 2];
  });
  return soup;
}

/** An ASCII STL with shortest round-trip numbers, so parsing it back gives the same floats. */
export function asciiStl(soup: ArrayLike<number>, name = 'fixture'): Uint8Array {
  const lines: string[] = [`solid ${name}`];
  for (let t = 0; t < soup.length / 9; t++) {
    const i = t * 9;
    lines.push(
      ' facet normal 0 0 1',
      '  outer loop',
      `   vertex ${soup[i]} ${soup[i + 1]} ${soup[i + 2]}`,
      `   vertex ${soup[i + 3]} ${soup[i + 4]} ${soup[i + 5]}`,
      `   vertex ${soup[i + 6]} ${soup[i + 7]} ${soup[i + 8]}`,
      '  endloop',
      ' endfacet',
    );
  }
  lines.push(`endsolid ${name}`, '');
  return new TextEncoder().encode(lines.join('\n'));
}

export function signedVolume(mesh: WeldedMesh): number {
  const { positions: p, indices } = mesh;
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

/** Runs a Manifold expression and returns its mesh, freeing every handle passed through keep. */
function meshOf(build: (keep: <T extends Manifold>(m: T) => T) => Manifold): WeldedMesh {
  const handles: Manifold[] = [];
  const result = build((m) => {
    handles.push(m);
    return m;
  });
  const mesh = result.getMesh();
  handles.forEach((h) => h.delete());
  return { positions: mesh.vertProperties, indices: mesh.triVerts };
}

function cuboid(api: ManifoldToplevel, keep: <T extends Manifold>(m: T) => T, min: V3, max: V3): Manifold {
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return keep(keep(api.Manifold.cube(size)).translate(min));
}

/** A person's two legs: two feet on z=0, joined above, so one shell has two footprints. */
export function arch(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => {
    const left = cuboid(api, keep, [0, 0, 0], [10, 10, 20]);
    const right = cuboid(api, keep, [30, 0, 0], [40, 10, 20]);
    const top = cuboid(api, keep, [0, 0, 20], [40, 10, 30]);
    return keep(api.Manifold.union([left, right, top]));
  });
}

export const CABIN = { deck: [40, 30, 5] as V3, roofZ: 25, roof: 3, overhang: 3, post: 4, inset: 5 } as const;

/**
 * A deck 40 x 30 x 5 with a roof 3 mm thick over it at 25 mm, overhanging the deck by 3 mm all round, on
 * posts 4 mm square: four inset 5 mm from the deck's corners, as a cabin's, or one in the middle, as a
 * table's. Silicone fills the room between deck and roof and opens all round under the overhang.
 */
export function cabin(api: ManifoldToplevel, posts: 'corners' | 'middle'): WeldedMesh {
  const { deck, roofZ, roof, overhang, post, inset } = CABIN;
  return meshOf((keep) => {
    const parts = [cuboid(api, keep, [0, 0, 0], deck), cuboid(api, keep, [-overhang, -overhang, roofZ], [deck[0] + overhang, deck[1] + overhang, roofZ + roof])];
    const at: [number, number][] = posts === 'corners' ? [[inset, inset], [deck[0] - inset - post, inset], [inset, deck[1] - inset - post], [deck[0] - inset - post, deck[1] - inset - post]] : [[(deck[0] - post) / 2, (deck[1] - post) / 2]];
    for (const [x, y] of at) parts.push(cuboid(api, keep, [x, y, deck[2] - 1], [x + post, y + post, roofZ + 1]));
    return keep(api.Manifold.union(parts));
  });
}

/**
 * A block 30 x 20 x 10 whose underside has a square ring engraved 0.5 mm deep, 10 mm across, round an
 * island 4 mm square that still stands on the plane, as the inside of a letter does. With `channel` a
 * groove 1 mm wide runs from the ring out through the block's side, so silicone reaches the ring.
 */
export function engravedBlock(api: ManifoldToplevel, channel: boolean): WeldedMesh {
  return meshOf((keep) => {
    let block = keep(cuboid(api, keep, [0, 0, 0], [30, 20, 10]).subtract(cuboid(api, keep, [10, 5, -1], [20, 15, 0.5])));
    if (channel) block = keep(block.subtract(cuboid(api, keep, [-1, 9.5, -1], [11, 10.5, 0.5])));
    return keep(block.add(cuboid(api, keep, [13, 8, 0], [17, 12, 1])));
  });
}

/** A block 40 x 40 x 10 standing on a pad `padHeight` tall and `padSize` square: the VIS-35 case. */
export function twoLevelBlock(api: ManifoldToplevel, padHeight: number, padSize = 10): WeldedMesh {
  return meshOf((keep) => {
    const body = cuboid(api, keep, [0, 0, padHeight], [40, 40, padHeight + 10]);
    const c = 20 - padSize / 2;
    const pad = cuboid(api, keep, [c, c, 0], [c + padSize, c + padSize, padHeight + 1]);
    return keep(body.add(pad));
  });
}

/** A 20 x 20 x 10 block on z=0 with a cone reaching `depth` below it: by default a stray vertex. */
export function spikedBlock(api: ManifoldToplevel, depth: number, radius = 0.5): WeldedMesh {
  return meshOf((keep) => {
    const block = cuboid(api, keep, [0, 0, 0], [20, 20, 10]);
    // A cone from a point at z=-depth widening to its radius just inside the block.
    const cone = keep(api.Manifold.cylinder(depth + 1, 0, radius, 16));
    const moved = keep(cone.translate([10, 10, -depth]));
    return keep(block.add(moved));
  });
}

/** A 40 x 40 x 10 block with a 10 x 10 recess cut `depth` into its underside: a closed-off level. */
export function recessedBlock(api: ManifoldToplevel, depth: number): WeldedMesh {
  return meshOf((keep) => keep(cuboid(api, keep, [0, 0, 0], [40, 40, 10]).subtract(cuboid(api, keep, [15, 15, -1], [25, 25, depth]))));
}

/** A 100 x 100 plate with a 20 x 20 recess in its underside and a 2 x 2 knob on its top. */
export function knobbedPlate(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => {
    const plate = keep(cuboid(api, keep, [0, 0, 0], [100, 100, 5]).subtract(cuboid(api, keep, [40, 40, -1], [60, 60, 0.5])));
    return keep(plate.add(cuboid(api, keep, [49, 49, 4], [51, 51, 20])));
  });
}

/** The same cut running out through one side, so the level stands open to the cavity. */
export function notchedBlock(api: ManifoldToplevel, depth: number): WeldedMesh {
  return meshOf((keep) => keep(cuboid(api, keep, [0, 0, 0], [40, 40, 10]).subtract(cuboid(api, keep, [15, -1, -1], [25, 25, depth]))));
}

/** A 40 x 40 x 5 plate on four square legs, standing on nothing but `foot` x `foot` feet. */
export function plateOnLegs(foot: number): WeldedMesh {
  const corners = [[0, 0], [40 - foot, 0], [0, 40 - foot], [40 - foot, 40 - foot]];
  return join(box([0, 0, 2], [40, 40, 7]), ...corners.map(([x, y]) => box([x, y, 0], [x + foot, y + foot, 2.5])));
}

/** A 20 x 10 block on two feet 2 mm tall, each `foot` wide: at the default size, under the island limit. */
export function blockOnFeet(api: ManifoldToplevel, foot: [number, number] = [2, 1.5]): WeldedMesh {
  return meshOf((keep) => {
    const block = cuboid(api, keep, [0, 0, 2], [20, 10, 10]);
    const left = cuboid(api, keep, [2, 4, 0], [2 + foot[0], 4 + foot[1], 3]);
    const right = cuboid(api, keep, [16, 4, 0], [16 + foot[0], 4 + foot[1], 3]);
    return keep(keep(block.add(left)).add(right));
  });
}

/** A sphere with an 8 x 8 pad under it: one real base among many almost flat directions. */
export function sphereOnPad(api: ManifoldToplevel, radius: number, segments: number): WeldedMesh {
  return meshOf((keep) => keep(keep(api.Manifold.sphere(radius, segments)).add(cuboid(api, keep, [-4, -4, -radius - 1], [4, 4, -radius + 1]))));
}

export function sphere(api: ManifoldToplevel, radius: number, segments: number): WeldedMesh {
  return meshOf((keep) => keep(api.Manifold.sphere(radius, segments)));
}

/**
 * A convex block whose underside is two flat faces meeting at a ridge along y, each tilted by half
 * of `apart` degrees, so both are support planes.
 */
export function ridgedBlock(api: ManifoldToplevel, apart: number): WeldedMesh {
  const rise = 40 * Math.tan(((apart / 2) * Math.PI) / 180);
  const points: V3[] = [
    [-40, 0, rise], [0, 0, 0], [40, 0, rise], [-40, 40, rise], [0, 40, 0], [40, 40, rise],
    [-40, 0, 20], [40, 0, 20], [-40, 40, 20], [40, 40, 20],
  ];
  return meshOf((keep) => keep(api.Manifold.hull(points)));
}

/** A plate with a round hole straight through, so its footprint has a real hole. */
export function ring(api: ManifoldToplevel, outer: number, hole: number, height: number): WeldedMesh {
  return meshOf((keep) => {
    const plate = cuboid(api, keep, [0, 0, 0], [outer, outer, height]);
    const drill = keep(keep(api.Manifold.cylinder(height + 2, hole / 2, hole / 2, 64)).translate([outer / 2, outer / 2, -1]));
    return keep(plate.subtract(drill));
  });
}

/**
 * A plinth with a tall tower at one end and a low one at the other, far enough apart that the ceiling
 * between them is the plinth's. So the low tower's persistence is known exactly: its height over the
 * plinth, as the same radius lifts both.
 */
export const TOWERS = { length: 120, width: 30, plinth: 10, tall: 40, side: 12, tallX: 6, lowX: 102 } as const;

export function towers(api: ManifoldToplevel, persistence: number): WeldedMesh {
  const { length, width, plinth, tall, side, tallX, lowX } = TOWERS;
  return meshOf((keep) => {
    const base = cuboid(api, keep, [0, 0, 0], [length, width, plinth]);
    const y0 = (width - side) / 2;
    const high = cuboid(api, keep, [tallX, y0, 0], [tallX + side, y0 + side, tall]);
    const low = cuboid(api, keep, [lowX, y0, 0], [lowX + side, y0 + side, plinth + persistence]);
    return keep(api.Manifold.union([base, high, low]));
  });
}

/**
 * A 40 x 40 x 10 plinth with two 1 mm square spikes on it: one 20 tall at its middle, (20, 20), and a
 * lower one 16 tall `apart` mm along x. Dilated, each is a cap of r_eff over its own little flat, so with
 * the plinth's ceiling between them the low one is a leaf of 6 mm persistence.
 */
export const SPIKES = { plinth: 10, high: 20, low: 16, centre: 20 } as const;

export function spikes(api: ManifoldToplevel, apart: number): WeldedMesh {
  const { plinth, high, low, centre } = SPIKES;
  return meshOf((keep) => {
    const base = cuboid(api, keep, [0, 0, 0], [40, 40, plinth]);
    const tall = cuboid(api, keep, [centre - 0.5, centre - 0.5, 0], [centre + 0.5, centre + 0.5, high]);
    const short = cuboid(api, keep, [centre + apart - 0.5, centre - 0.5, 0], [centre + apart + 0.5, centre + 0.5, low]);
    return keep(api.Manifold.union([base, tall, short]));
  });
}

/** L profile: a 40 x 20 lower step of height 5 with a 10 x 20 tower of height 30 on one end. */
export function stepped(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => {
    const step = cuboid(api, keep, [0, 0, 0], [40, 20, 5]);
    const tower = cuboid(api, keep, [0, 0, 0], [10, 20, 30]);
    return keep(step.add(tower));
  });
}

/** A 40 x 40 plate whose underside is a triangle grid at the given heights, under a low pyramid. */
export function plateWithUnderside(cells: number, height: (x: number, y: number) => number): WeldedMesh {
  const n = cells + 1;
  const step = 40 / cells;
  const positions: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) positions.push(i * step, j * step, height(i * step, j * step));
  const indices: number[] = [];
  const at = (i: number, j: number): number => i + j * n;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) indices.push(at(i, j), at(i + 1, j + 1), at(i + 1, j), at(i, j), at(i, j + 1), at(i + 1, j + 1));
  }
  // Close it with a flat top, walking the grid border as one fan around a centre vertex.
  const centre = positions.length / 3;
  positions.push(20, 20, 8);
  const border: number[] = [];
  for (let i = 0; i < cells; i++) border.push(at(i, 0));
  for (let j = 0; j < cells; j++) border.push(at(cells, j));
  for (let i = cells; i > 0; i--) border.push(at(i, cells));
  for (let j = cells; j > 0; j--) border.push(at(0, j));
  border.forEach((v, i) => indices.push(v, border[(i + 1) % border.length], centre));
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * A plate whose underside has its corners jittered in z by up to `jitter`, like a scan of a flat
 * face. Facet normals vary while the face stays flat within tolerance.
 */
export function noisyPlate(cells: number, jitter: number): WeldedMesh {
  // A fixed sequence, not Math.random, so a failure reproduces.
  let seed = 12345;
  return plateWithUnderside(cells, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 2 * jitter;
  });
}

/**
 * A flat 60 x 40 face beside a face `slope` mm wide rising at `degrees`. By default both land in
 * one histogram bin, so the bin's mean normal is tilted off the flat face and misses it.
 */
export function flatBesideSlope(api: ManifoldToplevel, degrees = 0.6, slope = 40): WeldedMesh {
  const rise = slope * Math.tan((degrees * Math.PI) / 180);
  const end = 60 + slope;
  const points: V3[] = [
    [0, 0, 0], [60, 0, 0], [end, 0, rise], [end, 40, rise], [60, 40, 0], [0, 40, 0],
    [0, 0, 20], [end, 0, 20], [end, 40, 20], [0, 40, 20],
  ];
  return meshOf((keep) => keep(api.Manifold.hull(points)));
}

/**
 * Stacked squares joined by straight walls, each given as [half width, z], lowest first.
 * Caps close both ends. A thin first step makes a chamfer narrower than the plane tolerance.
 */
export function squareStack(rings: [number, number][]): WeldedMesh {
  const positions: number[] = [];
  for (const [h, z] of rings) positions.push(-h, -h, z, h, -h, z, h, h, z, -h, h, z);
  const indices: number[] = [0, 2, 1, 0, 3, 2];
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let c = 0; c < 4; c++) {
      const a = r * 4 + c, b = r * 4 + ((c + 1) % 4);
      indices.push(a, b, b + 4, a, b + 4, a + 4);
    }
  }
  const t = (rings.length - 1) * 4;
  indices.push(t, t + 1, t + 2, t, t + 2, t + 3);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** The cup every field oracle uses, open end up: outer R30, inner r27, height 60, floor 3. */
export const CUP = { R: 30, r: 27, height: 60, floor: 3 };

/** Facets this fine change the volumes by about 0.01%, far below the 2% these shapes are checked to. */
const ROUND = 256;

function cupSolid(api: ManifoldToplevel, keep: <T extends Manifold>(m: T) => T): Manifold {
  const { R, r, height, floor } = CUP;
  const outer = keep(api.Manifold.cylinder(height, R, R, ROUND));
  const hollow = keep(keep(api.Manifold.cylinder(height, r, r, ROUND)).translate([0, 0, floor]));
  return keep(outer.subtract(hollow));
}

export function cup(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => cupSolid(api, keep));
}

/** The same cup with its open end on the plane: a half-turn about x, so still no reflection. */
export function invertedCup(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => keep(keep(cupSolid(api, keep).rotate([180, 0, 0])).translate([0, 0, CUP.height])));
}

/** The inverted cup with a `diameter` hole through its wall at mid height, so its air is no longer sealed. */
export function ventedInvertedCup(api: ManifoldToplevel, diameter: number): WeldedMesh {
  return meshOf((keep) => {
    const moved = keep(keep(cupSolid(api, keep).rotate([180, 0, 0])).translate([0, 0, CUP.height]));
    const drill = keep(keep(keep(api.Manifold.cylinder(10, diameter / 2, diameter / 2, 64)).rotate([0, 90, 0])).translate([24, 0, CUP.height / 2]));
    return keep(moved.subtract(drill));
  });
}

/** A hollow cone standing on its open base, its wall `thickness` thick measured upward. */
export function hollowCone(api: ManifoldToplevel, height: number, radius: number, thickness: number): WeldedMesh {
  return meshOf((keep) => {
    const outer = keep(api.Manifold.cylinder(height, radius, 0, ROUND));
    const inner = keep(api.Manifold.cylinder(height - thickness, radius * (1 - thickness / height), 0, ROUND));
    return keep(outer.subtract(inner));
  });
}

export const MUSHROOM = { stemRadius: 6, stemHeight: 35, capRadius: 22 };

/** A stem under a hemisphere dome, with the flat of the dome facing down. */
export function mushroom(api: ManifoldToplevel): WeldedMesh {
  const { stemRadius, stemHeight, capRadius } = MUSHROOM;
  return meshOf((keep) => {
    // The stem runs on into the dome so the two do not meet in a coplanar face.
    const stem = keep(api.Manifold.cylinder(stemHeight + 1, stemRadius, stemRadius, ROUND));
    const dome = keep(keep(keep(api.Manifold.sphere(capRadius, ROUND)).trimByPlane([0, 0, 1], 0)).translate([0, 0, stemHeight]));
    return keep(stem.add(dome));
  });
}

export const HOLED_BLOCK = { side: 40, height: 60, holeRadius: 10 };

/** A block on z=0 with a round hole straight through it along y, at mid height. */
export function holedBlock(api: ManifoldToplevel): WeldedMesh {
  const { side, height, holeRadius } = HOLED_BLOCK;
  return meshOf((keep) => {
    const block = cuboid(api, keep, [-side / 2, -side / 2, 0], [side / 2, side / 2, height]);
    const drill = keep(keep(keep(api.Manifold.cylinder(side + 2, holeRadius, holeRadius, ROUND, true)).rotate([90, 0, 0])).translate([0, 0, height / 2]));
    return keep(block.subtract(drill));
  });
}

/** The same block with the hole drilled in from its back face only, to the middle: a pocket with one mouth. */
export function blindHoledBlock(api: ManifoldToplevel): WeldedMesh {
  const { side, height, holeRadius } = HOLED_BLOCK;
  return meshOf((keep) => {
    const block = cuboid(api, keep, [-side / 2, -side / 2, 0], [side / 2, side / 2, height]);
    const drill = keep(keep(keep(api.Manifold.cylinder(side / 2 + 1, holeRadius, holeRadius, ROUND)).rotate([90, 0, 0])).translate([0, side / 2 + 1, height / 2]));
    return keep(block.subtract(drill));
  });
}

export const STANDING_RING = { outer: 20, inner: 10, depth: 10, flat: 3 };

/**
 * A ring standing on its edge, its axis along y, cut flat `flat` mm up its outside so it stands on a
 * face. The hole runs through it sideways, so the silicone in it holds the ring in a loop.
 */
export function standingRing(api: ManifoldToplevel): WeldedMesh {
  const { outer, inner, depth, flat } = STANDING_RING;
  return meshOf((keep) => {
    const disc = keep(api.Manifold.cylinder(depth, outer, outer, ROUND, true));
    const hole = keep(api.Manifold.cylinder(depth + 2, inner, inner, ROUND, true));
    const upright = keep(keep(keep(disc.subtract(hole)).rotate([90, 0, 0])).translate([0, 0, outer - flat]));
    return keep(upright.trimByPlane([0, 0, 1], 0));
  });
}

/** A square pyramid standing on the plane with its tip at (x, y, height), and a base far narrower than a cell. */
export function needle(x: number, y: number, height: number, baseHalf: number): WeldedMesh {
  return {
    positions: Float32Array.from([x - baseHalf, y - baseHalf, 0, x + baseHalf, y - baseHalf, 0, x + baseHalf, y + baseHalf, 0, x - baseHalf, y + baseHalf, 0, x, y, height]),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
  };
}

/** Rotates a mesh by a rotation matrix, with no rounding beyond float32. */
export function rotated(mesh: WeldedMesh, r: readonly number[]): WeldedMesh {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < out.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z;
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z;
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z;
  }
  return { positions: out, indices: mesh.indices };
}

/** Rotation about a unit axis, for tilting fixtures to an arbitrary pose. */
export function axisRotation(axis: V3, degrees: number): number[] {
  const [x, y, z] = axis;
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  const k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** The float32 `ulps` steps above a positive value: too close for an exact weld to merge. */
export function nextFloat(value: number, ulps = 1): number {
  const f = new Float32Array([value]);
  new Uint32Array(f.buffer)[0] += ulps;
  return f[0];
}

/**
 * M11's soup-mode fixture: the L below, refined so its faces are a few mm across, with every face of the tall
 * arm's outer side within 3 mm of a point half way up it taken out, as a scan's hole. Its underside is whole:
 * 700 mm2 inside 160 mm of outline.
 */
export function patchedL(api: ManifoldToplevel): WeldedMesh {
  const l = lShape(api);
  const fine = withArena(api, (arena) => {
    const mesh = arena.track(arena.manifold(new api.Mesh({ numProp: 3, vertProperties: l.positions, triVerts: l.indices })).refine(20)).getMesh();
    return { positions: mesh.vertProperties, indices: mesh.triVerts };
  });
  const patch: number[] = [];
  for (let t = 0; t < fine.indices.length / 3; t++) {
    const c = [0, 1, 2].map((axis) => [0, 1, 2].reduce((sum, k) => sum + fine.positions[fine.indices[t * 3 + k] * 3 + axis], 0) / 3);
    if (Math.abs(c[0] + 20) < 1e-4 && Math.hypot(c[1] - 5, c[2] - 12) < 3) patch.push(t);
  }
  return withoutTriangles(fine, patch);
}

/** The pocket the L's underside needs, offset by e with round corners, d deep: Steiner's area for its 5 convex corners, less e2 at its reflex one. */
export const L_POCKET = (e: number, d: number): number => (700 + 160 * e + ((5 * Math.PI) / 4 - 1) * e * e) * d;

/**
 * An L seen from above, with its bounding box centred on the origin: a tall arm down the -x side and
 * a low arm along the -y side. No mirror of it lands on itself, so a mirrored cavity cannot pass.
 */
export function lShape(api: ManifoldToplevel): WeldedMesh {
  return meshOf((keep) => {
    const low = cuboid(api, keep, [-20, -20, 0], [20, -10, 15]);
    const tall = cuboid(api, keep, [-20, -20, 0], [-10, 20, 25]);
    return keep(low.add(tall));
  });
}
