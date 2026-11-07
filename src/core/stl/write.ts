/** Binary STL writer. The header never starts with "solid", so readers cannot mistake it for ASCII. */
export function writeBinaryStl(positions: ArrayLike<number>, indices?: ArrayLike<number>): Uint8Array {
  const triCount = (indices ? indices.length : positions.length / 3) / 3;
  const out = new Uint8Array(84 + 50 * triCount);
  const view = new DataView(out.buffer);
  const header = 'binary STL, casting-form-generator';
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  view.setUint32(80, triCount, true);

  const vertex = (t: number, c: number): number => (indices ? indices[t * 3 + c] : t * 3 + c);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = vertex(t, 0) * 3;
    const b = vertex(t, 1) * 3;
    const c = vertex(t, 2) * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(o, nx / len, true);
    view.setFloat32(o + 4, ny / len, true);
    view.setFloat32(o + 8, nz / len, true);
    view.setFloat32(o + 12, ax, true);
    view.setFloat32(o + 16, ay, true);
    view.setFloat32(o + 20, az, true);
    view.setFloat32(o + 24, bx, true);
    view.setFloat32(o + 28, by, true);
    view.setFloat32(o + 32, bz, true);
    view.setFloat32(o + 36, cx, true);
    view.setFloat32(o + 40, cy, true);
    view.setFloat32(o + 44, cz, true);
    o += 50;
  }
  return out;
}
