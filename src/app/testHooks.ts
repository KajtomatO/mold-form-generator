import type { DropResult } from '../core/analysis/validate';
import type { Params } from '../core/params/schema';
import type { CameraView } from '../view/scene';
import type { Fault, WorkerLike } from '../workers/protocol';
import type { BudgetSettings } from './budgets';
import { hashBytes, hashMesh } from './hash';
import type { LogEntry } from './jobGate';
import { Pipeline, type PipelineEvent, type PipelineOptions, type PipelineStatus } from './pipeline';
import { parseStl } from '../core/stl/parse';
import { weld } from '../core/mesh/weld';
import { setParamValue as setPath, type ParamPath } from './stages';
import type { Project, WallStatus } from './pipeline';
import type { ExportReport, ExportRequest } from '../workers/exportJob';
import type { GeometryReports } from '../core/analysis/reports';

export interface ExportSummary {
  files: Record<string, { bytes: number; hash: string; meshHash: string }>;
  /** report.json as parsed, less its timings, which are the one part that differs from run to run. */
  report: Omit<ExportReport, 'timings'> | null;
  zipBytes: number;
  clearance: { measured: number; error: number; raisedBy: number } | null;
  diagnostics: string[];
  progress: string[];
  ms: number;
}

/** What tests drive the pipeline with, on `window.__pipeline` when the page has ?test=1. */
export interface TestHooks {
  /** Fetches an example by file name and loads it. */
  load(name: string): Promise<void>;
  idle(): Promise<void>;
  jobLog(): LogEntry[];
  events(): PipelineEvent[];
  status(): PipelineStatus;
  geometryHash(): ReturnType<Pipeline['geometryHash']>;
  /** The same state built from nothing by a second pipeline with workers of its own. */
  freshHash(): Promise<ReturnType<Pipeline['geometryHash']>>;
  worldToScreen(point: [number, number, number]): { x: number; y: number; visible: boolean };
  setCamera(view: CameraView): void;
  freezeBudgets(settings?: Partial<BudgetSettings>): void;
  budgets(): ReturnType<Pipeline['budgets']['snapshot']>;
  params(): Params;
  setParam(path: ParamPath, value: unknown): void;
  /** Sets each value in turn, `gapMs` apart, without waiting for anything else. */
  burst(path: ParamPath, values: unknown[], gapMs: number): Promise<void>;
  openings(): { id: string; kind: string; x: number; y: number; pinned: boolean }[];
  drag(id: string, x: number, y: number): void;
  drop(id: string, x: number, y: number): DropResult | null;
  /** A fault on the next job of a worker, or on the next export, which a delay `at` a step holds there. */
  armFault(gate: 'field' | 'solid' | 'export' | 'reports', fault: Fault): void;
  recycleSolid(): void;
  solidCached(): Record<string, string>;
  heap(): Promise<{ capacity: number | null; used: number | null; held: number }>;
  timing(): Pipeline['timing'];
  /** The factor on the preview cell in use: above 1 after a crash, or on a slow machine. */
  cellScale(): number;
  /** The cover on screen: the request it answered, and whether it is a drag's. */
  shownCover(): { rev: number; provisional: boolean } | null;
  /** Called after every change the pipeline makes, after the page itself has drawn it. */
  subscribe(listener: () => void): () => void;
  diagnostics(): { code: string; severity: string; exportCell: boolean }[];
  /** The export field's wall check, and how long each one took. */
  walls(): WallStatus;
  wallTimes(): number[];
  project(): Project;
  /** The box around a part on screen, in mold coordinates. */
  partBounds(part: 'cover' | 'base'): { min: [number, number, number]; max: [number, number, number] } | null;
  exportParts(request?: ExportRequest): Promise<ExportSummary>;
  /** Whether an export runs, and whether the pipeline holds its worker. */
  exporting(): { active: boolean; worker: boolean };
  /** Every solid worker the page spawned, in order: whether it was terminated, and what it said after. */
  solidWorkers(): WorkerRecord[];
  /** S9 on screen, with whether it is for the state on screen, and how long S8 and S9 took. */
  reports(): { current: boolean; value: GeometryReports } | null;
  reportTimes(): Pipeline['reportTimes'];
}

/** One worker as a test sees it from outside the pipeline, which only a real terminate() can end. */
export interface WorkerRecord {
  terminated: boolean;
  /** Messages it sent in all, and after terminate() was called. A terminated worker sends none. */
  messages: number;
  afterTerminate: number;
}

/**
 * Wraps a spawn so a test can see each worker's end for itself, and not only the pipeline's word for
 * it: Cancel must really terminate the export's worker, so that it stops building a mold nobody wants.
 */
export function recordWorkers(spawn: () => WorkerLike): { spawn: () => WorkerLike; records: WorkerRecord[] } {
  const records: WorkerRecord[] = [];
  return {
    records,
    spawn: () => {
      const worker = spawn();
      const record: WorkerRecord = { terminated: false, messages: 0, afterTerminate: 0 };
      records.push(record);
      // A listener of its own, beside the pipeline's onmessage, so it hears the worker whatever the pipeline does.
      (worker as unknown as EventTarget).addEventListener?.('message', () => {
        record.messages++;
        if (record.terminated) record.afterTerminate++;
      });
      const end = worker.terminate.bind(worker);
      worker.terminate = () => {
        record.terminated = true;
        end();
      };
      return worker;
    },
  };
}

export function installTestHooks(pipeline: Pipeline, options: PipelineOptions, view: { worldToScreen: TestHooks['worldToScreen']; setCamera: TestHooks['setCamera'] }, fetchModel: (name: string) => Promise<Uint8Array>, solidWorkers: WorkerRecord[] = []): TestHooks {
  const hooks: TestHooks = {
    async load(name) {
      pipeline.load(await fetchModel(name), name);
    },
    idle: () => pipeline.idle(),
    jobLog: () => pipeline.log,
    events: () => pipeline.events,
    status: () => pipeline.status(),
    geometryHash: () => pipeline.geometryHash(),
    async freshHash() {
      const snapshot = pipeline.snapshot();
      if (!snapshot) throw new Error('Nothing is loaded.');
      const fresh = new Pipeline({ ...options, frozen: true, checkWalls: false, reports: false });
      try {
        fresh.restore(snapshot);
        await fresh.idle();
        return fresh.geometryHash();
      } finally {
        fresh.dispose();
      }
    },
    worldToScreen: (point) => view.worldToScreen(point),
    setCamera: (camera) => view.setCamera(camera),
    freezeBudgets: (settings) => pipeline.budgets.freeze(settings),
    budgets: () => pipeline.budgets.snapshot(),
    params: () => pipeline.params,
    setParam: (path, value) => pipeline.setParams((p) => setPath(p, path, value)),
    async burst(path, values, gapMs) {
      for (const value of values) {
        pipeline.setParams((p) => setPath(p, path, value));
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    },
    openings: () => (pipeline.placement?.value.placement.openings ?? []).map(({ id, kind, x, y, pinned }) => ({ id, kind, x, y, pinned })),
    drag: (id, x, y) => pipeline.dragOpening(id, x, y),
    drop: (id, x, y) => pipeline.dropOpening(id, x, y),
    armFault: (gate, fault) => pipeline.armFault(gate, fault),
    recycleSolid: () => pipeline.recycleSolid(),
    solidCached: () => pipeline.solidCached() as Record<string, string>,
    heap: () => pipeline.readSolidHeap(),
    timing: () => pipeline.timing,
    cellScale: () => pipeline.cellScale(),
    shownCover: () => (pipeline.cover ? { rev: pipeline.cover.rev, provisional: pipeline.cover.value.provisional } : null),
    subscribe: (listener) => pipeline.subscribe(listener),
    diagnostics: () => pipeline.diagnostics.map(({ code, severity, exportCell }) => ({ code, severity, exportCell: exportCell === true })),
    walls: () => pipeline.wallStatus(),
    wallTimes: () => pipeline.wallTimes,
    project: () => pipeline.project(),
    partBounds(part) {
      const shown = part === 'cover' ? pipeline.cover : pipeline.base;
      if (!shown) return null;
      const { positions } = shown.value;
      const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3], positions[i]);
        max[i % 3] = Math.max(max[i % 3], positions[i]);
      }
      return { min, max };
    },
    async exportParts(request) {
      const progress: string[] = [];
      const t0 = performance.now();
      const outputs = await pipeline.exportParts((p) => progress.push(p.step), undefined, request);
      const ms = performance.now() - t0;
      const files: ExportSummary['files'] = {};
      for (const [name, bytes] of Object.entries(outputs.files)) {
        const mesh = name.endsWith('.stl') ? weld(parseStl(bytes).positions) : null;
        files[name] = { bytes: bytes.length, hash: hashBytes(bytes), meshHash: mesh ? hashMesh(mesh.positions, mesh.indices) : '' };
      }
      const report = outputs.report ? (({ timings: _timings, ...rest }) => rest)(outputs.report) : null;
      return { files, report, zipBytes: outputs.zip.length, clearance: outputs.clearance, diagnostics: outputs.diagnostics.map((d) => d.code), progress, ms };
    },
    exporting: () => ({ active: pipeline.exporting, worker: pipeline.exportWorkerAlive }),
    solidWorkers: () => solidWorkers.map((record) => ({ ...record })),
    reports: () => (pipeline.reports ? { current: pipeline.reports.key === pipeline.keys().S9, value: pipeline.reports.value } : null),
    reportTimes: () => pipeline.reportTimes,
  };
  (window as unknown as { __pipeline: TestHooks }).__pipeline = hooks;
  return hooks;
}
