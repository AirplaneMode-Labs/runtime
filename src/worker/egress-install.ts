/**
 * Side-effect module: installs the egress guard on the worker's own global scope when it is evaluated.
 * The engine host imports it FIRST, before anything that could load an engine, so ES module evaluation
 * order puts the guard ahead of every engine module (package.json `sideEffects` covers dist/worker/*.js
 * so a bundler keeps this import).
 */

import { installEgressGuard } from './egress-guard';

installEgressGuard(globalThis, {
  post: (message) => {
    (globalThis as unknown as { postMessage(m: unknown): void }).postMessage({ v: 1, ...message });
  },
});
