import type { Field } from '../field/grid';
import type { IntervalReport, SiliconeBody } from './intervals';

/**
 * The plan's demold report, per body on one tile: can the model be pulled out of the silicone while the
 * silicone is still in the cover, must the silicone come out of the cover first so it can stretch, or
 * will it need cutting. All of it is an estimate from the model's shape, for the D2 workflow.
 */
export type Verdict = 'plausible' | 'jacket-out' | 'cut-required';

/** Plan: either class at this much silicone or more makes pulling inside the cover implausible. */
export const PLAUSIBLE_LIMIT_MM3 = 1000;

const RANK: Record<Verdict, number> = { plausible: 0, 'jacket-out': 1, 'cut-required': 2 };

export type Vec3 = [number, number, number];

export interface CutHint {
  /** Stable while the model and its plane stay the same, so a Show toggle survives a change of t. */
  id: string;
  /** A base loop lock, or silicone under the model or sandwiched in it. */
  reason: 'loop-lock' | 'under-plug' | 'sandwiched';
  /** Index into DemoldReport.bodies. */
  body: number;
  /** The silicone at this place, in mm3. */
  volume: number;
  /** Where sandwiched silicone opens into the rest. 0 for the other kinds. */
  mouths: number;
  /** Where the model closes sandwiched silicone off at the side, such as each post it runs round. 0 for the other kinds. */
  walls: number;
  /** For a loop lock, the separate places the body stands on. 0 for the other kinds. */
  footprints: number;
  /**
   * The silicone holds the model in a loop here, so it must be cut: a loop lock, or sandwiched silicone
   * with two mouths or two walls. Elsewhere it holds but can stretch off.
   */
  cuts: boolean;
  /** A point in the silicone that holds, nearest the middle of it. */
  at: Vec3;
  /** Where to cut: from the outside of the silicone straight in to `at`, at its height. */
  seam: [Vec3, Vec3];
}

export interface BodyDemold {
  verdict: Verdict;
  /** In mm3, the shell's own. */
  volume: number;
  /** Footprint patches at or above the smallest island. Two or more lock the silicone in a loop. */
  footprints: number;
  loopLock: boolean;
  /** Totals of the two classes, in mm3, over the bodies above the smallest reported volume. */
  underPlug: number;
  sandwiched: number;
}

export interface DemoldReport {
  /** The worst of the bodies'. */
  verdict: Verdict;
  bodies: BodyDemold[];
  /** The places that must be cut first, loop locks before the rest, then by volume. */
  hints: CutHint[];
}

export interface DemoldOptions {
  /** reports.minVolumeMl in mm3: smaller silicone is noise from the cell. */
  minVolume: number;
  /** base.minIsland in mm2: smaller footprint patches are crumbs the footprint drops too. */
  minIsland: number;
  /** Where the silicone's outside is nearest to a point, or null if nowhere. */
  outside: (x: number, y: number) => [number, number] | null;
}

/**
 * The outside of the silicone nearest to each point: the edge of the cavity, where H falls to 0. Its
 * edge nodes are gathered once, so each question costs one pass over them.
 */
export function cavityEdge(field: Field): (x: number, y: number) => [number, number] | null {
  const { nx, ny, cell, x0, y0, values } = field;
  const edge: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const n = i + j * nx;
      if (values[n] > 0) continue;
      if ((i > 0 && values[n - 1] > 0) || (i + 1 < nx && values[n + 1] > 0) || (j > 0 && values[n - nx] > 0) || (j + 1 < ny && values[n + nx] > 0)) edge.push(x0 + i * cell, y0 + j * cell);
    }
  }
  return (x, y) => {
    let best = Infinity, bx = 0, by = 0;
    for (let k = 0; k < edge.length; k += 2) {
      const d = (edge[k] - x) ** 2 + (edge[k + 1] - y) ** 2;
      if (d < best) {
        best = d;
        bx = edge[k];
        by = edge[k + 1];
      }
    }
    return best === Infinity ? null : [bx, by];
  };
}

/**
 * Sandwiched silicone that holds the model in a loop: it runs through the model and out again (two
 * mouths), or round a part that joins the model to itself on both sides of it (two walls), as through the
 * windows of a cabin round its posts.
 */
export function holdsInLoop(s: Pick<SiliconeBody, 'kind' | 'mouths' | 'walls'>): boolean {
  return s.kind === 'sandwiched' && (s.mouths >= 2 || s.walls >= 2);
}

/**
 * Plan: `plausible` means no lock and both classes under 1 ml; `cut-required` means a lock, or sandwiched
 * silicone touching 2 or more mouths, which takes in silicone the model is joined round on 2 sides or
 * more; otherwise `jacket-out`. A hint comes from every body of silicone of either class past the
 * smallest reported volume, and from each loop lock, so a verdict other than plausible always has one.
 */
export function demoldReport(s8: IntervalReport, options: DemoldOptions): DemoldReport {
  const { minVolume, minIsland, outside } = options;
  // A crumb of the model is no body to demold. If every shell is one, they all count.
  let shells = s8.shells.map((shell, index) => ({ shell, index })).filter(({ shell }) => shell.volume >= minVolume);
  if (shells.length === 0) shells = s8.shells.map((shell, index) => ({ shell, index }));
  const bodyOfShell = new Map(shells.map(({ index }, body) => [index, body]));
  // Silicone over no shell the analysis kept, as an open mesh can leave, goes with the largest body.
  const largest = shells.reduce((best, { shell }, body) => (shell.volume > shells[best].shell.volume ? body : best), 0);
  const ownerOf = (silicone: SiliconeBody): number => bodyOfShell.get(silicone.shell) ?? largest;

  const kept = s8.silicone.filter((s) => s.volume >= minVolume);
  const seamTo = (at: Vec3): [Vec3, Vec3] => {
    const edge = outside(at[0], at[1]);
    return [edge ? [edge[0], edge[1], at[2]] : at, at];
  };
  const hints: CutHint[] = [];
  const used = new Set<SiliconeBody>();

  const bodies = shells.map(({ shell }, body): BodyDemold => {
    const footprints = shell.footprints.filter((f) => s8.footprints[f].area >= minIsland);
    const loopLock = footprints.length >= 2;
    const mine = kept.filter((s) => ownerOf(s) === body);
    const total = (kind: SiliconeBody['kind']): number => mine.filter((s) => s.kind === kind).reduce((sum, s) => sum + s.volume, 0);
    const underPlug = total('under-plug'), sandwiched = total('sandwiched');
    const looped = mine.some(holdsInLoop);
    const verdict: Verdict = loopLock || looped ? 'cut-required' : underPlug < PLAUSIBLE_LIMIT_MM3 && sandwiched < PLAUSIBLE_LIMIT_MM3 ? 'plausible' : 'jacket-out';

    if (loopLock) {
      // The silicone under the shell, between its feet, is what closes the loop around it.
      const under = s8.silicone.filter((s) => s.kind === 'under-plug' && ownerOf(s) === body).sort((a, b) => b.volume - a.volume)[0];
      let at: Vec3;
      if (under) {
        at = under.at;
        used.add(under);
      } else {
        const [a, b] = footprints.map((f) => s8.footprints[f]).sort((p, q) => q.area - p.area);
        at = [(a.centroid[0] + b.centroid[0]) / 2, (a.centroid[1] + b.centroid[1]) / 2, 0];
      }
      hints.push({ id: `lock-${body}`, reason: 'loop-lock', body, volume: under?.volume ?? 0, mouths: 0, walls: 0, footprints: footprints.length, cuts: true, at, seam: seamTo(at) });
    }
    return { verdict, volume: shell.volume, footprints: footprints.length, loopLock, underPlug, sandwiched };
  });

  // The ids keep the rank by volume alone, so a Show toggle stays on its place whatever comes first.
  let rank = 0;
  const rest: CutHint[] = [];
  for (const s of [...kept].sort((a, b) => b.volume - a.volume)) {
    if (used.has(s)) continue;
    const sandwiched = s.kind === 'sandwiched';
    rest.push({ id: `${s.kind}-${rank++}`, reason: s.kind, body: ownerOf(s), volume: s.volume, mouths: sandwiched ? s.mouths : 0, walls: sandwiched ? s.walls : 0, footprints: 0, cuts: holdsInLoop(s), at: s.at, seam: seamTo(s.at) });
  }
  // What forces the cut comes first, so the rows the Demold report shows start with it.
  hints.push(...rest.filter((h) => h.cuts), ...rest.filter((h) => !h.cuts));
  const verdict = bodies.reduce<Verdict>((worst, b) => (RANK[b.verdict] > RANK[worst] ? b.verdict : worst), 'plausible');
  return { verdict, bodies, hints };
}
