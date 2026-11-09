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
// - `define`: the trust root (public key of this build's signing key) and the build id are baked
//   into the bundle; the page never fetches a trust root.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const trustRootPath = resolve(root, 'public', 'fixture', 'trust-root.json');

if (!existsSync(trustRootPath)) {
  throw new Error(
    `${trustRootPath} is missing: run \`node demo/tools/make-fixture.mjs\` first (npm run demo:build does)`,
  );
}

const trustRoot = readFileSync(trustRootPath, 'utf8');
const build = process.env['GITHUB_SHA']?.slice(0, 12) ?? 'local';

export default defineConfig({
  root,
  base: './',
  publicDir: 'public',
  define: {
    __DEMO_TRUST_ROOT__: JSON.stringify(trustRoot),
    __DEMO_BUILD__: JSON.stringify(build),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'app',
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
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
