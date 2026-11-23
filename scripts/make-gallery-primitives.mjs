// Makes the gallery's primitive models: a cube, a sphere, a cylinder and a cone,
// each 40 mm tall, standing on a flat face at z = 0, centred on the z axis.
// The sphere is cut flat at the bottom, as the app needs a flat face to stand on.
//
//   node scripts/make-gallery-primitives.mjs [output dir]
//
// The folder defaults to public/gallery/, where the site serves them from. The output is deterministic: the
// same script gives the same bytes, which test/unit/gallery.test.ts checks against the committed files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Module from 'manifold-3d';

const H = 40; // height of every primitive, mm
const SEGMENTS = 128; // segments round a circle: about 0.01 mm chord error at r = 20
// The sphere's: a sagitta of about 0.025 mm at r = 21, under the 0.125 mm cell, and about 100 KB where 128 give 397 KB.
const SPHERE_SEGMENTS = 64;

const out = process.argv[2] ?? resolve(import.meta.dirname, '..', 'public', 'gallery');

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
Manifold.setCircularSegments?.(SEGMENTS);

const SPHERE_R = 21; // cut 2 mm off the bottom: a flat disc about 17.9 mm across
const models = {
  cube: () => Manifold.cube([H, H, H], true).translate([0, 0, H / 2]),
  sphere: () =>
    Manifold.sphere(SPHERE_R, SPHERE_SEGMENTS)
      .translate([0, 0, H - SPHERE_R])
      .trimByPlane([0, 0, 1], 0),
  cylinder: () => Manifold.cylinder(H, 15, 15, SEGMENTS),
  cone: () => Manifold.cylinder(H, 20, 0, SEGMENTS),
};

function binaryStl(mesh, name) {
  const { vertProperties: p, triVerts: t, numProp } = mesh;
  const n = t.length / 3;
  const buf = new Uint8Array(84 + 50 * n);
  const dv = new DataView(buf.buffer);
  const header = `binary STL, mold-form-generator gallery ${name}`;
  for (let i = 0; i < header.length && i < 80; i++) buf[i] = header.charCodeAt(i);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let k = 0; k < n; k++) {
    const v = [0, 1, 2].map((c) => {
      const i = t[k * 3 + c] * numProp;
      return [p[i], p[i + 1], p[i + 2]];
    });
    const u = v[1].map((x, i) => x - v[0][i]);
    const w = v[2].map((x, i) => x - v[0][i]);
    const nx = u[1] * w[2] - u[2] * w[1];
    const ny = u[2] * w[0] - u[0] * w[2];
    const nz = u[0] * w[1] - u[1] * w[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const x of [nx / len, ny / len, nz / len, ...v.flat()]) {
      dv.setFloat32(o, x, true);
      o += 4;
    }
    o += 2;
  }
  return buf;
}

mkdirSync(out, { recursive: true });
for (const [name, make] of Object.entries(models)) {
  const m = make();
  const bb = m.boundingBox();
  const stl = binaryStl(m.getMesh(), name);
  writeFileSync(join(out, `${name}.stl`), stl);
  const size = bb.max.map((x, i) => (x - bb.min[i]).toFixed(2)).join(' x ');
  console.log(`${name}.stl  ${m.numTri()} triangles, ${size} mm, ${(m.volume() / 1000).toFixed(1)} cm3, genus ${m.genus()}`);
  m.delete();
}
