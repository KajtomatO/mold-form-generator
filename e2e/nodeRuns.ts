import { Pipeline } from '../src/app/pipeline';
import { exampleBytes, EXAMPLE_FILES, type ExampleId } from '../test/fixtures/loadExamples';
import { inProcessField, inProcessSolid } from '../test/fixtures/inProcessWorker';

/** The same state built in Node by the same stage code, in workers of its own. */
export async function inNode<R>(id: ExampleId, change: (p: Pipeline) => void, read: (p: Pipeline) => R | Promise<R>): Promise<R> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  try {
    p.load(exampleBytes(id), EXAMPLE_FILES[id]);
    await p.idle();
    change(p);
    await p.idle();
    return await read(p);
  } finally {
    p.dispose();
  }
}

export const nodeHash = (id: ExampleId, change: (p: Pipeline) => void = () => {}): Promise<ReturnType<Pipeline['geometryHash']>> => inNode(id, change, (p) => p.geometryHash());
