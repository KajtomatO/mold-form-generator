import { Pipeline, type PipelineOptions } from '../app/pipeline';
import { installTestHooks } from '../app/testHooks';
import { PreviewScene } from '../view/scene';
import type { WorkerLike } from '../workers/protocol';

// A bare harness for the worker pipeline: load a file, run it, draw the cover and base. M6 builds the app on the same parts.
const query = new URLSearchParams(location.search);
const test = query.get('test') === '1';
const options: PipelineOptions = {
  spawnField: () => new Worker(new URL('../workers/field.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  spawnSolid: () => new Worker(new URL('../workers/solid.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  frozen: test,
};
const pipeline = new Pipeline(options);
// draw=0 leaves out the 3D view altogether, so the pipeline also runs where there is no WebGL, as in
// Firefox headless on the server, and its timings are not those of a software renderer.
const draw = query.get('draw') !== '0';
const scene = draw ? new PreviewScene(document.querySelector('#view') as HTMLCanvasElement) : null;
const badge = document.querySelector('#badge') as HTMLElement;
const error = document.querySelector('#error') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const modelName = document.querySelector('#model') as HTMLElement;

let drawn: { cover: unknown; base: unknown } = { cover: null, base: null };
pipeline.subscribe(() => {
  if (scene && pipeline.cover !== drawn.cover) scene.setPart('cover', pipeline.cover?.value ?? null);
  if (scene && pipeline.base !== drawn.base) scene.setPart('base', pipeline.base?.value ?? null);
  drawn = { cover: pipeline.cover, base: pipeline.base };
  const s = pipeline.status();
  badge.classList.toggle('on', s.stale);
  error.textContent = s.error ?? '';
  modelName.textContent = pipeline.modelName ?? '';
  const last = (values: number[]): string => (values.length ? `${Math.round(values[values.length - 1])} ms` : '-');
  status.textContent = `T1 ${last(pipeline.timing.t1)} · T2 ${last(pipeline.timing.t2)} · T2b ${last(pipeline.timing.drag)} drag, ${last(pipeline.timing.cut)} cut${s.busy ? ' · working' : ''}`;
});
window.addEventListener('resize', () => scene?.resize());

async function fetchModel(name: string): Promise<Uint8Array> {
  const response = await fetch(`/examples/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Could not fetch ${name}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

(document.querySelector('#file') as HTMLInputElement).addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) pipeline.load(new Uint8Array(await file.arrayBuffer()), file.name);
});

const noView = (): never => {
  throw new Error('The page was opened with draw=0, so it has no 3D view.');
};
if (test) installTestHooks(pipeline, options, scene ?? { worldToScreen: noView, setCamera: noView }, fetchModel);
const model = query.get('model');
if (model) void fetchModel(model).then((bytes) => pipeline.load(bytes, model), (e: unknown) => (error.textContent = String(e)));
