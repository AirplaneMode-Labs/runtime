import { defineConfig } from 'tsup';

// The published package has no runtime dependencies. Engines are optional peers imported lazily from
// the backends entry (and, in the worker, from tjs-engine), so the bundler of the application resolves
// them: they stay external here.
const engines = [
  '@huggingface/transformers',
  'onnxruntime-web',
  'onnxruntime-common',
  '@mlc-ai/web-llm',
];

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'spec/index': 'spec/index.ts',
      'backends/index': 'src/backends/index.ts',
    },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: true,
    sourcemap: false,
    // the worker entry below builds into dist/worker: do not delete it
    clean: ['dist/**', '!dist/worker/**'],
    splitting: true,
    treeshake: true,
    outDir: 'dist',
    external: engines,
  },
  {
    // The engine worker: ONE self-contained file (no shared chunks), so the egress guard is the first
    // thing it evaluates and package.json `sideEffects` ("./dist/worker/*.js") covers all of it.
    entry: { 'worker/engine-worker': 'src/worker/engine-host.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: ['dist/worker/**'],
    splitting: false,
    treeshake: false,
    outDir: 'dist',
    external: engines,
    // package.json `sideEffects` ("./dist/worker/*.js") describes the OUTPUT for the application's
    // bundler. While building the worker from src/, esbuild would apply it to src/worker/egress-install.ts
    // and drop the import that installs the guard, so it is ignored here and the guard stays first.
    esbuildOptions(options) {
      options.ignoreAnnotations = true;
    },
  },
]);
