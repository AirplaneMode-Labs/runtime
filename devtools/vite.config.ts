// Builds the DevTools extension into devtools/dist: devtools.html and panel.html with their scripts
// and styles bundled, plus manifest.json copied unchanged. Nothing is inlined and nothing is loaded
// from a CDN: the extension CSP allows only 'self'.
//
//   npm run devtools:build

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

function copyManifest(): Plugin {
  return {
    name: 'airplanemode-copy-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(`${root}manifest.json`, 'utf8'),
      });
    },
  };
}

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  plugins: [copyManifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      input: { devtools: `${root}devtools.html`, panel: `${root}panel.html` },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
