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
import { buildLabel, readGitInfo } from './build-id';
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
// 'Built from main at <sha12>' (CI), else 'Local build <sha12>[-dirty]' from git HEAD, else 'local' with the
// reason (S1-052, D1-FIX1-02)
const build = buildLabel({
  githubSha: process.env['GITHUB_SHA'],
  githubRef: process.env['GITHUB_REF'],
  git: readGitInfo(fileURLToPath(new URL('..', import.meta.url))),
});

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

// package.json `sideEffects` ("./dist/worker/*.js") describes the published output, so a bundler that
// reads it would treat src/worker/egress-install.ts as side-effect free and drop the import that
// installs the egress guard. The guard must run first in the worker, so it is marked as having side
// effects here (test/browser/guard-order.spec.ts proves the order in the built worker).
const keepEgressGuard = {
  name: 'keep-egress-guard',
  apply: 'build' as const,
  transform(
    _code: string,
    id: string,
  ): { code: string; map: null; moduleSideEffects: true } | null {
    if (!/[\\/]src[\\/]worker[\\/]egress-install\.ts$/.test(id)) return null;
    return { code: _code, map: null, moduleSideEffects: true };
  },
};

export default defineConfig({
  root,
  plugins: [dropEmittedWasm, neutraliseEngineDefaults, keepEgressGuard],
  // The engine worker (src/worker/engine-host.ts, imported with ?worker&url): an ES-module worker
  // with the same plugins, written to app/ beside the page chunks.
  worker: {
    format: 'es' as const,
    plugins: () => [dropEmittedWasm, neutraliseEngineDefaults, keepEgressGuard],
    rollupOptions: {
      output: {
        entryFileNames: 'app/[name]-[hash].js',
        chunkFileNames: 'app/[name]-[hash].js',
        assetFileNames: 'app/[name]-[hash][extname]',
      },
    },
  },
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
