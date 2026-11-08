import type { ProjectFile } from './project';
import { ProjectError } from './projectFile';
import type { Opened, ProjectJob, ProjectReply } from '../workers/projectJob';
import type { WorkerLike } from '../workers/protocol';

/**
 * Saving and opening project files off the main thread: each job gets a worker of its own, which is
 * terminated when it answers, so a large STL never holds the page. Main pays only for copying the STL
 * into the job and for the Blob of the result.
 */
export class ProjectFiles {
  private jobs = 0;

  constructor(private readonly spawn: () => WorkerLike) {}

  private run(job: ProjectJob, transfer: Transferable[]): Promise<ProjectReply> {
    return new Promise((resolve, reject) => {
      const worker = this.spawn();
      worker.onmessage = ({ data }) => {
        if (!('id' in data) || data.id !== job.id) return;
        worker.terminate();
        resolve(data as ProjectReply);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        worker.terminate();
        // No ProjectError: the file may be fine, and the caller says so in its own words.
        reject(new Error(`The project worker failed: ${event.message ?? 'no reason given'}.`));
      };
      worker.postMessage(job, transfer);
    });
  }

  /** The .moldproj's bytes and the STL's hash. The STL is copied into the job, so the pipeline keeps its own. */
  async pack(file: ProjectFile, stl: Uint8Array): Promise<{ zip: Uint8Array; sha256: string }> {
    const copy = stl.slice().buffer;
    const reply = await this.run({ t: 'pack', id: ++this.jobs, file, stl: copy }, [copy]);
    if (reply.t === 'project-error') throw new ProjectError(reply.message, reply.details);
    if (reply.t !== 'packed') throw new Error(`The project worker answered a save with ${reply.t}.`);
    return { zip: reply.zip, sha256: reply.sha256 };
  }

  /**
   * An STL, read in a worker before it replaces the model on screen. Its bytes are handed over and come
   * back with the answer; a reason it cannot be read is a ProjectError. `loaded` says a model is on screen.
   */
  async check(bytes: Uint8Array, name: string, loaded: boolean): Promise<{ bytes: Uint8Array; sha256: string | null; triangles: number; warnings: string[] }> {
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
    const reply = await this.run({ t: 'check', id: ++this.jobs, bytes: own, name, loaded }, [own]);
    if (reply.t === 'project-error') throw new ProjectError(reply.message, reply.details);
    if (reply.t !== 'checked') throw new Error(`The project worker answered a check with ${reply.t}.`);
    return { bytes: new Uint8Array(reply.bytes), sha256: reply.sha256, triangles: reply.triangles, warnings: reply.warnings };
  }

  /** A chosen or dropped project file, which is handed over whole; `loaded` is copied, as the pipeline keeps it. */
  async open(bytes: Uint8Array, name: string, kind: 'zip' | 'json', loaded: Uint8Array | null): Promise<Opened> {
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
    const model = loaded ? loaded.slice().buffer : null;
    const reply = await this.run({ t: 'open', id: ++this.jobs, bytes: own, name, kind, loaded: model }, model ? [own, model] : [own]);
    if (reply.t === 'project-error') throw new ProjectError(reply.message, reply.details);
    if (reply.t !== 'opened') throw new Error(`The project worker answered an open with ${reply.t}.`);
    return reply.opened;
  }
}
