import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * Memory of the browser a test drives, from /proc. Playwright starts the browser from the test's own worker
 * process, so every process below this one is the browser's: its main process, renderers, GPU process and
 * workers. The web servers belong to the runner, not this worker, so they are not counted. Every figure is
 * in MiB, 1024 x 1024 bytes, as /proc's kB are KiB: 3 GiB is 3,072 MiB, and 3 GB (3e9 bytes) 2,861 MiB.
 */
export interface TreeMemory {
  /** Resident memory summed over the tree, in MiB. Pages two processes share count twice, so this reads high. */
  rssMb: number;
  /** Proportional set size summed over the tree, in MiB: shared pages split between the processes sharing them. */
  pssMb: number;
  processes: number;
  /** Reads of a live process's memory that failed, which would make the sums read low. */
  failedReads: number;
  /** Each process's command name, RSS and PSS in MiB, largest RSS first. */
  each: [string, number, number][];
}

function children(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    // The command name sits in brackets and may hold spaces, so the fields are read after its end.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const list = map.get(ppid) ?? [];
    list.push(Number(name));
    map.set(ppid, list);
  }
  return map;
}

/** A field of a /proc file in kB, or null where it could not be read. */
function kb(path: string, field: string): number | null {
  try {
    const match = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(readFileSync(path, 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The browser's tree below `root` right now. */
export function treeMemory(root = process.pid): TreeMemory {
  const map = children();
  const tree: number[] = [];
  const walk = (pid: number): void => {
    for (const child of map.get(pid) ?? []) {
      tree.push(child);
      walk(child);
    }
  };
  walk(root);
  let rss = 0, pss = 0, failedReads = 0;
  const each: [string, number, number][] = [];
  for (const pid of tree) {
    const own = [kb(`/proc/${pid}/status`, 'VmRSS'), kb(`/proc/${pid}/smaps_rollup`, 'Pss')];
    // A process that ended between the listing and the read had no memory left to count; one still
    // there that could not be read is a failure, as it would leave its memory out of the sums.
    if (own.some((v) => v === null)) {
      if (existsSync(`/proc/${pid}`)) failedReads++;
      continue;
    }
    rss += own[0]!;
    pss += own[1]!;
    let name = '?';
    try {
      name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
      // Gone since: its figures stand without a name.
    }
    each.push([name, Math.round(own[0]! / 1024), Math.round(own[1]! / 1024)]);
  }
  each.sort((a, b) => b[1] - a[1]);
  return { rssMb: rss / 1024, pssMb: pss / 1024, processes: tree.length, failedReads, each };
}

/** Swap in use on this machine, in MiB. */
export function swapUsedMb(): number {
  const info = readFileSync('/proc/meminfo', 'utf8');
  const read = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)![1]) / 1024;
  return read('SwapTotal') - read('SwapFree');
}

export interface MemoryPeak {
  rssMb: number;
  pssMb: number;
  /** The phase the RSS peak fell in, as the test last named it. */
  phase: string;
  processes: number;
  /** The processes at the RSS peak: name, RSS and PSS in MiB. */
  each: [string, number, number][];
  /** The fewest processes any sample found, and the reads that failed over all samples. */
  fewestProcesses: number;
  failedReads: number;
  samples: number;
  /** Swap's growth over the run, in MiB. */
  swapGrowthMb: number;
  /** The RSS and PSS peaks of each phase, in MiB. */
  phases: Record<string, [number, number]>;
}

/**
 * Samples the tree every `everyMs` until stopped, keeping the peaks. `phase` names what the test is doing,
 * so the report says when the peak came. Sampling a few hundred /proc entries takes about a millisecond.
 */
export function sampleMemory(everyMs = 200, swapLimit?: { mb: number; then: () => void }): { phase(name: string): void; peak(): MemoryPeak; stop(): MemoryPeak } {
  const swap0 = swapUsedMb();
  let phase = 'start';
  let stopped = false;
  const peak: MemoryPeak = { rssMb: 0, pssMb: 0, phase, processes: 0, each: [], fewestProcesses: Infinity, failedReads: 0, samples: 0, swapGrowthMb: 0, phases: {} };
  const sample = (): void => {
    const now = treeMemory();
    peak.samples++;
    peak.failedReads += now.failedReads;
    peak.fewestProcesses = Math.min(peak.fewestProcesses, now.processes);
    const [rss, pss] = peak.phases[phase] ?? [0, 0];
    peak.phases[phase] = [Math.round(Math.max(rss, now.rssMb)), Math.round(Math.max(pss, now.pssMb))];
    if (now.rssMb > peak.rssMb) Object.assign(peak, { rssMb: now.rssMb, phase, processes: now.processes, each: now.each });
    peak.pssMb = Math.max(peak.pssMb, now.pssMb);
    peak.swapGrowthMb = Math.max(peak.swapGrowthMb, swapUsedMb() - swap0);
    // The server is shared: past the swap it can spare, the test ends its own browser at once.
    if (swapLimit && !stopped && peak.swapGrowthMb > swapLimit.mb) {
      stopped = true;
      swapLimit.then();
    }
  };
  sample();
  const timer = setInterval(sample, everyMs);
  return {
    phase: (name) => {
      sample();
      phase = name;
    },
    peak: () => ({ ...peak, phases: { ...peak.phases } }),
    stop: () => {
      clearInterval(timer);
      sample();
      return { ...peak, phases: { ...peak.phases } };
    },
  };
}
