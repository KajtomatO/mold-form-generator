import { runProjectJob } from './projectJob';

// Pure JS, so there is nothing to wait for: each job is answered as it comes, and main ends the worker then.
self.onmessage = (event: MessageEvent) => {
  const { reply, transfer } = runProjectJob(event.data);
  self.postMessage(reply, { transfer });
};
