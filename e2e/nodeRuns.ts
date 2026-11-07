import { Pipeline, type PipelineOptions } from '../src/app/pipeline';
import { exampleBytes, EXAMPLE_FILES, type ExampleId } from '../test/fixtures/loadExamples';
import { inProcessField, inProcessSolid } from '../test/fixtures/inProcessWorker';

/**
 * The same state built in Node by the same stage code, in workers of its own. With checkWalls, as the
 * app has it, a grid also waits for the wall check, whose findings an export's files carry.
 */
export async function inNode<R>(id: ExampleId, change: (p: Pipeline) => void, read: (p: Pipeline) => R | Promise<R>, options: Partial<PipelineOptions> = {}): Promise<R> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, ...options });
  try {
    p.load(exampleBytes(id), EXAMPLE_FILES[id]);
    await p.idle();
    change(p);
    await p.idle();
    const grid = p.params.grid.nx * p.params.grid.ny > 1;
    while (options.checkWalls && grid && p.wallStatus().result === null) await new Promise((resolve) => setTimeout(resolve, 50));
    return await read(p);
  } finally {
    p.dispose();
  }
}

export const nodeHash = (id: ExampleId, change: (p: Pipeline) => void = () => {}): Promise<ReturnType<Pipeline['geometryHash']>> => inNode(id, change, (p) => p.geometryHash());
