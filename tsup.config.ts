import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'spec/index': 'spec/index.ts',
    'backends/index': 'src/backends/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  outDir: 'dist',
});
