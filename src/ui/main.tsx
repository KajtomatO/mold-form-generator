import { render } from 'preact';
import { Pipeline, type PipelineOptions } from '../app/pipeline';
import { Store } from '../app/store';
import { installTestHooks } from '../app/testHooks';
import { PreviewScene } from '../view/scene';
import type { WorkerLike } from '../workers/protocol';
import { App } from './App';
import './style.css';

const query = new URLSearchParams(location.search);
const test = query.get('test') === '1';
const options: PipelineOptions = {
  spawnField: () => new Worker(new URL('../workers/field.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  spawnSolid: () => new Worker(new URL('../workers/solid.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  frozen: test,
  checkWalls: true,
};
const pipeline = new Pipeline(options);
const store = new Store(pipeline);
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
  installTestHooks(pipeline, options, scene ?? { worldToScreen: noView, setCamera: noView }, fetchModel);
  (window as unknown as { __app: unknown }).__app = { store, scene };
}
