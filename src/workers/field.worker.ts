import { fieldHost } from './fieldHost';

// Pure JS with nothing to load, so it is ready at once. The handler is attached before anything else
// runs all the same, as a module worker starts delivering messages right after its first run.
const handle = fieldHost((message, transfer) => self.postMessage(message, { transfer: transfer ?? [] }), () => performance.now());
self.onmessage = (event: MessageEvent) => handle(event.data);
self.postMessage({ t: 'ready', bootMs: 0, cached: {}, heapBytes: null });
