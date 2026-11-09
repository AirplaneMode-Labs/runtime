// Vite build for the runtime demo page (demo/ -> demo/dist). The range test server serves
// demo/dist as static files on the same origin as /manifest.json and /assets/*.
//
// `assetsDir` is "app", not Vite's default "assets": the range server reserves /assets/* for the
// synthetic streams, and the browser specs' egress check allows exactly /, /app/*, /manifest.json
// and /assets/*.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/',
  publicDir: false,
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
