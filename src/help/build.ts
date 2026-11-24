import type { Pipeline } from '../app/pipeline';
import type { MoldTypeId } from '../core/mold/types';
import { defaultParams } from '../core/params/defaults';
import type { Params } from '../core/params/schema';
import { helpParts, type HelpParts } from './media';

/**
 * HB: HELP_MODEL's parts for one mold type, as the help's animations show them: the pipeline's own run at that type's
 * defaults and the preview cell, with its budgets frozen (`frozen`), so the parts do not hang on the machine's speed.
 * The media page runs it on the real workers and test/unit/help.test.ts on the same workers in process.
 */
export async function buildHelpParts(pipeline: Pipeline, stl: Uint8Array, file: string, type: MoldTypeId): Promise<HelpParts> {
  const params = defaultParams(type);
  pipeline.setParams((p) => {
    for (const group of Object.keys(params) as (keyof Params)[]) (p as Record<string, unknown>)[group] = structuredClone(params[group]);
  });
  pipeline.load(stl, file);
  await pipeline.idle();
  const error = pipeline.status().error;
  if (error) throw new Error(`${file} as the ${type} mold: ${error}`);
  const { cover, base, field } = pipeline;
  // A solid stands for the rim it was cut on, as the view shows it (src/ui/viewSync.ts).
  if (!cover || !base || !field || cover.mold !== field.mold || base.mold !== field.mold || cover.value.provisional) throw new Error(`${file} as the ${type} mold: the parts were not built.`);
  return helpParts({ cover: cover.value, base: base.value, field: field.value });
}
