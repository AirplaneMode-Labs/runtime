/**
 * Entry of the engine worker (built to dist/worker/engine-worker.js and, in the demo, by Vite as a
 * module worker). The FIRST import is the egress guard: ES module evaluation runs it before anything
 * else, in particular before any engine module. The engine itself is only loaded by tjs-engine on
 * `init`, by a dynamic import that the guard has long since covered.
 */

import './egress-install';
import { TjsEngine } from './tjs-engine';

const scope = globalThis as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
};

const engine = new TjsEngine({
  post: (m) => scope.postMessage(m),
  selfOrigin: new URL(import.meta.url).origin,
  scope: globalThis,
});

scope.onmessage = (e) => {
  void engine.handle(e.data);
};
