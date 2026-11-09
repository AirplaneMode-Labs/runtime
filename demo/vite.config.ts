// Vite build for the runtime demo page (demo/ -> demo/dist), deployed to GitHub Pages at
// https://airplanemode-labs.github.io/runtime/ and served locally by the range test server.
//
// - `base: './'`: every URL in the output is relative to the document, so the same dist works at
//   `/` (range server, browser specs) and at `/runtime/` (Pages).
// - `publicDir: 'public'`: demo/public/fixture/ (written by demo/tools/make-fixture.mjs at build
//   time, git-ignored) is copied to dist/fixture/.
// - `assetsDir` is "app", not Vite's default "assets": the range server reserves /assets/* for the
//   synthetic streams, and the browser specs' egress check allows exactly /, /app/*, /fixture/*,
//   /manifest.json and /assets/*.
// - `define`: the trust root (public key of this build's signing key), the build id and, when
//   `DEMO_MODELS=1` bundled the test model, its trust root and size (__DEMO_MODELS__) are baked into
//   the bundle; no page fetches a trust root.
// - two pages: index.html (asset manager demo, Sprint 1 CSP unchanged) and models.html (backend demo,
//   its own CSP with 'wasm-unsafe-eval' and connect-src 'self').

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { buildId } from './build-id';
import { neutraliseEngineDefaults } from './engine-defaults';

const root = fileURLToPath(new URL('.', import.meta.url));
const trustRootPath = resolve(root, 'public', 'fixture', 'trust-root.json');

if (!existsSync(trustRootPath)) {
  throw new Error(
    `${trustRootPath} is missing: run \`node demo/tools/make-fixture.mjs\` first (npm run demo:build does)`,
  );
}

const trustRoot = readFileSync(trustRootPath, 'utf8');
// Written by demo/tools/make-fixture.mjs only when DEMO_MODELS=1 (and removed otherwise).
const modelsMetaPath = resolve(root, 'public', 'models', 'trust-root.json');
const modelsMeta = existsSync(modelsMetaPath)
  ? readFileSync(modelsMetaPath, 'utf8')
  : JSON.stringify({ bundled: false });
// first 12 characters of GITHUB_SHA when it is 40 lowercase hex, else 'local' (S1-052)
const build = buildId(process.env['GITHUB_SHA']);

// onnxruntime-web's JS references its own wasm with `new URL('...wasm', import.meta.url)`, which Vite
// would copy into the output (a second 26 MB copy of the binary that is never fetched: the adapter
// hands the engine the pinned, verified binary as wasmBinary). Drop it so the only wasm in a build is
// the one a signed manifest lists (models/ort/ in a DEMO_MODELS=1 build).
const dropEmittedWasm = {
  name: 'drop-emitted-wasm',
  apply: 'build' as const,
  generateBundle(_options: unknown, bundle: Record<string, { type: string }>) {
    for (const name of Object.keys(bundle)) {
      if (bundle[name]?.type === 'asset' && name.endsWith('.wasm')) delete bundle[name];
    }
  },
};

// The engine's endpoint defaults are rewritten in the bundle: see ./engine-defaults.ts (T1-S2-08).

export default defineConfig({
  root,
  plugins: [dropEmittedWasm, neutraliseEngineDefaults],
  base: './',
  publicDir: 'public',
  define: {
    __DEMO_TRUST_ROOT__: JSON.stringify(trustRoot),
    __DEMO_BUILD__: JSON.stringify(build),
    __DEMO_MODELS__: JSON.stringify(modelsMeta),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'app',
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        models: resolve(root, 'models.html'),
      },
      output: {
        entryFileNames: 'app/[name]-[hash].js',
        chunkFileNames: 'app/[name]-[hash].js',
        assetFileNames: 'app/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
