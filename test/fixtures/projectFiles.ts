import { strToU8, zipSync } from 'fflate';
import { MODEL_ENTRY, PROJECT_ENTRY } from '../../src/app/projectArchive';

/**
 * A ZIP whose central directory says an entry unpacks to `size` bytes, whatever it holds: a ZIP bomb
 * as the reader sees it before inflating anything. `packed`, if given, is the compressed size it
 * declares too, which a crafted file raises to pass a check of one against the other.
 */
export function declaredSize(zip: Uint8Array, name: string, size: number, packed?: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let at = out.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const length = view.getUint16(at + 28, true);
    if (new TextDecoder().decode(out.subarray(at + 46, at + 46 + length)) !== name) continue;
    view.setUint32(at + 24, size, true);
    if (packed !== undefined) view.setUint32(at + 20, packed, true);
    return out;
  }
  throw new Error(`The ZIP has no entry ${name}.`);
}

/** Every entry's DOS date and time, from the local headers and the central directory, as [date, time] pairs. */
export function zipDates(zip: Uint8Array): { local: [number, number][]; central: [number, number][] } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const local: [number, number][] = [], central: [number, number][] = [];
  // Walked header by header, as data inside an entry can hold a signature's bytes by chance.
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    local.push([view.getUint16(at + 12, true), view.getUint16(at + 10, true)]);
    at += 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + view.getUint32(at + 18, true);
  }
  while (view.getUint32(at, true) === 0x02014b50) {
    central.push([view.getUint16(at + 14, true), view.getUint16(at + 12, true)]);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return { local, central };
}

/** A binary STL with every vertex raised by `dz`, so the model stands off the origin. */
export function raised(stl: Uint8Array, dz: number): Uint8Array {
  const out = stl.slice();
  const view = new DataView(out.buffer);
  const count = view.getUint32(80, true);
  if (out.length !== 84 + 50 * count) throw new Error('Not a binary STL.');
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const at = 84 + 50 * t + 12 + 12 * k + 8;
      view.setFloat32(at, view.getFloat32(at, true) + dz, true);
    }
  }
  return out;
}

/** A .moldproj made by hand, with whatever project.json text and STL it is given. */
export function handMade(json: string, stl: Uint8Array | null): Uint8Array {
  return zipSync(stl ? { [PROJECT_ENTRY]: strToU8(json), [MODEL_ENTRY]: stl } : { [PROJECT_ENTRY]: strToU8(json) });
}
