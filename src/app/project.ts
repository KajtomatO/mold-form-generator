import type { OpeningPin } from '../core/analysis/placement';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import type { PlaneChoice } from '../workers/fieldStages';
import { APP_VERSION } from './version';

/** What the user has chosen, in one plain object, which undo and project files can keep as it is. */
export interface Project {
  params: Params;
  plane: PlaneChoice;
  pins: OpeningPin[];
  /** Automatic vents the user deleted. */
  removed: string[];
}

/**
 * project.json, as the export ZIP holds it and M9's project files will read it back. The schema
 * version is the parameter schema's, which is what a later version must migrate from.
 */
export interface ProjectFile extends Project {
  schemaVersion: number;
  appVersion: string;
  /** The STL the mold was made from, by name. M9's project file carries its bytes beside this. */
  model: string;
}

export function projectFile(project: Project, model: string): ProjectFile {
  return { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, model, ...project };
}
