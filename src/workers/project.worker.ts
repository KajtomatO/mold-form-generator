import { runProjectJob } from './projectJob';

/** A dedicated worker's synchronous reader, which TypeScript's DOM library leaves out. */
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

// MM2: a simplified model's own file, read here for its .moldproj, so main never holds its bytes.
const readBlob = (blob: Blob): Uint8Array => new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob));

// Pure JS, so there is nothing to wait for: each job is answered as it comes, and main ends the worker then.
self.onmessage = (event: MessageEvent) => {
  const { reply, transfer } = runProjectJob(event.data, readBlob);
  self.postMessage(reply, { transfer });
};
