import { render } from 'preact';
import { saveBytes } from '../app/download';
import { Pipeline, type PipelineOptions } from '../app/pipeline';
import { ProjectFiles } from '../app/projectFiles';
import { Store } from '../app/store';
import { installTestHooks, recordWorkers } from '../app/testHooks';
import { PreviewScene } from '../view/scene';
import type { WorkerLike } from '../workers/protocol';
import { App } from './App';
import './style.css';

const query = new URLSearchParams(location.search);
const test = query.get('test') === '1';
const spawnSolid = (): WorkerLike => new Worker(new URL('../workers/solid.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
// With the test hooks, every solid worker is recorded, so a test can see for itself that Cancel ends one.
const solidWorkers = recordWorkers(spawnSolid);
const options: PipelineOptions = {
  spawnField: () => new Worker(new URL('../workers/field.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  spawnSolid: test ? solidWorkers.spawn : spawnSolid,
  frozen: test,
  checkWalls: true,
  // ?reports=0 leaves them out, so a measurement can tell what they cost T1 and T2.
  reports: query.get('reports') !== '0',
};
const pipeline = new Pipeline(options);
const files = new ProjectFiles(() => new Worker(new URL('../workers/project.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
const store = new Store(pipeline, undefined, files);
document.documentElement.dataset.theme = store.theme.value;

// The view is made before the UI, so it exists for the test hooks. Without WebGL 2 the rest still runs.
const canvas = document.createElement('canvas');
let scene: PreviewScene | null = null;
try {
  scene = new PreviewScene(canvas, { interactive: true, cpuHeights: query.get('heights') === 'cpu' });
} catch {
  scene = null;
}
render(<App store={store} scene={scene} canvas={scene ? canvas : null} />, document.getElementById('app')!);

if (test) {
  const noView = (): never => {
    throw new Error('This browser has no 3D view.');
  };
  const fetchModel = async (name: string): Promise<Uint8Array> => {
    const response = await fetch(`/examples/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Could not fetch ${name}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  installTestHooks(pipeline, options, scene ?? { worldToScreen: noView, setCamera: noView }, fetchModel, solidWorkers.records);
  // saveBytes too, so a test can time the very download Save project makes on a file too large to load.
  (window as unknown as { __app: unknown }).__app = { store, scene, saveBytes };
}
