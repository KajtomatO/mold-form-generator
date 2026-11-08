/** How numbers read in the sidebar and status strip. Shared with the browser tests, which compare against Node. */

/** Up to `digits` decimals, without trailing zeros: 3, 0.2, 0.125. */
export function formatNumber(value: number, digits = 3): string {
  return String(Number(value.toFixed(digits)));
}

/** Units as they read on screen: core's messages and the schema write mm2, mm3 and cm3 in plain text. */
export function units(text: string): string {
  return text.replace(/\bmm2\b/g, 'mm²').replace(/\bmm3\b/g, 'mm³').replace(/\bcm3\b/g, 'cm³');
}

/** Fixed decimals, with no "-0.00" for a value that rounds to zero, such as a float's residue off an axis. */
export function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

export function formatMm(value: number, digits = 1): string {
  return `${value.toFixed(digits)} mm`;
}

/** Three sizes as the status strip shows them: 60.0 × 31.0 × 48.0 mm. */
export function formatSize(size: readonly number[]): string {
  return `${size.map((v) => v.toFixed(1)).join(' × ')} mm`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** A plane's outward normal as an axis, such as −Z, or as its tilt from the nearest one. */
export function formatNormal(normal: readonly number[]): string {
  const axis = normal.reduce((best, value, k) => (Math.abs(value) > Math.abs(normal[best]) ? k : best), 0);
  const name = `${normal[axis] < 0 ? '−' : '+'}${'XYZ'[axis]}`;
  const tilt = (Math.acos(Math.min(1, Math.abs(normal[axis]))) * 180) / Math.PI;
  return tilt < 0.05 ? name : `${name} ${tilt.toFixed(1)}°`;
}
