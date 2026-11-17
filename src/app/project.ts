import type { OpeningPin } from '../core/analysis/placement';
import type { StoredPlane } from '../core/base/storedPlane';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import type { PlaneChoice } from '../workers/fieldStages';
import { BUILD } from './buildInfo';
import type { SimplifiedEntry } from './simplified';

export type { StoredPlane } from '../core/base/storedPlane';

/** What the user has chosen, in one plain object, which undo and project files can keep as it is. */
export interface Project {
  params: Params;
  plane: PlaneChoice;
  pins: OpeningPin[];
  /** Automatic vents the user deleted. */
  removed: string[];
}

/**
 * project.json, as a .moldproj and the export ZIP hold it. Version 2 added the STL's hash and the base
 * plane itself, and 4 says its pins number bodies as joined parts; src/app/projectFile.ts migrates older
 * files and checks every field on the way in. `appVersion` is the build's version string (buildInfo.ts).
 */
export interface ProjectFile extends Project {
  schemaVersion: number;
  appVersion: string;
  /** The STL the mold was made from, by name. A .moldproj carries its bytes as model.stl. */
  model: string;
  /** SHA-256 of the STL's bytes, as sha256sum gives it, or null where it was not known, as in a version 1 file. */
  modelSha256: string | null;
  /** The plane `plane` chose, for a later version that ranks or welds differently; null if none was found. */
  basePlane: StoredPlane | null;
  /**
   * MM2: the mold was made from a simplified copy of `model` (R42), which a .moldproj holds as simplified.stl
   * beside the file itself; `plane`, `pins` and `removed` are the copy's. Only for a simplified model, so the
   * project.json of any other keeps its bytes, and the format stays 6.
   */
  simplified?: SimplifiedEntry;
}

/** The fields in the order project.json lists them, so the file reads from what it is about to what it holds. */
export function projectFile(project: Project, model: string, identity: { modelSha256: string | null; basePlane: StoredPlane | null; simplified?: SimplifiedEntry }): ProjectFile {
  return { schemaVersion: SCHEMA_VERSION, appVersion: BUILD.version, model, modelSha256: identity.modelSha256, basePlane: identity.basePlane, ...(identity.simplified ? { simplified: identity.simplified } : {}), ...project };
}

/** project.json's text, as both a .moldproj and the export ZIP write it. */
export function projectJson(file: ProjectFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
