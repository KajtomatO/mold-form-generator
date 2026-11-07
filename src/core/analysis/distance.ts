/**
 * Exact distance from each cell of a grid to the nearest cell with mask 0, in cells, by the two-pass
 * lower envelope of parabolas (Felzenszwalb and Huttenlocher). Cost per cell is the same however wide
 * the distance gets, and a chamfer would put a pole of inaccessibility up to 8% off.
 */
export function distanceToOutside(mask: Uint8Array, w: number, h: number): Float32Array {
  const squared = new Float32Array(w * h);
  const longest = Math.max(w, h);
  const line = new Float64Array(longest);
  const result = new Float64Array(longest);
  const sites = new Int32Array(longest);
  const starts = new Float64Array(longest + 1);
  const FAR = (w + h) ** 2;

  const envelope = (n: number): void => {
    let top = -1;
    for (let q = 0; q < n; q++) {
      if (line[q] >= FAR) continue;
      // Pop parabolas this one beats everywhere they were lowest.
      let start = -Infinity;
      while (top >= 0) {
        const p = sites[top];
        start = (line[q] - line[p] + q * q - p * p) / (2 * (q - p));
        if (start > starts[top]) break;
        top--;
      }
      top++;
      sites[top] = q;
      starts[top] = top === 0 ? -Infinity : start;
    }
    if (top < 0) {
      result.fill(FAR, 0, n);
      return;
    }
    let k = 0;
    for (let q = 0; q < n; q++) {
      while (k < top && starts[k + 1] < q) k++;
      const p = sites[k];
      result[q] = line[p] + (q - p) * (q - p);
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0, at = x; y < h; y++, at += w) line[y] = mask[at] ? FAR : 0;
    envelope(h);
    for (let y = 0, at = x; y < h; y++, at += w) squared[at] = result[y];
  }
  for (let y = 0, row = 0; y < h; y++, row += w) {
    for (let x = 0; x < w; x++) line[x] = squared[row + x];
    envelope(w);
    for (let x = 0; x < w; x++) squared[row + x] = Math.sqrt(result[x]);
  }
  return squared;
}
