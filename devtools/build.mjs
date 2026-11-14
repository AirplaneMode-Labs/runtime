#!/usr/bin/env node
// Builds the DevTools extension: runtime/devtools/dist, loadable with Load unpacked.
//   npm run devtools:build
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
await build({ configFile: `${here}vite.config.ts` });
console.log(`built ${here}dist (Load unpacked in chrome://extensions)`);
