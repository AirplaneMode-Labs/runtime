// D1-11: the Pages workflow. The build job only reads the repository; only the deploy job may write
// Pages and request an id-token; no secrets; every action pinned by full SHA; the test model is fetched
// failing closed; the dist size is recorded and bounded.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

const yml = readFileSync(resolve(repoDir, '.github/workflows/pages.yml'), 'utf8');
const ci = readFileSync(resolve(repoDir, '.github/workflows/ci.yml'), 'utf8');

/** The text of one top-level job. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('pages.yml', () => {
  it('the build job has only contents: read; only the deploy job has pages: write and id-token: write', () => {
    const build = job(yml, 'build');
    const deploy = job(yml, 'deploy');
    expect(build).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(build).not.toMatch(/pages: write|id-token: write|contents: write/);
    expect(deploy).toContain('pages: write');
    expect(deploy).toContain('id-token: write');
    expect(deploy).toContain('environment:');
    expect(deploy).toContain('name: github-pages');
    expect(yml.match(/pages: write/g)).toHaveLength(1);
    expect(yml.match(/id-token: write/g)).toHaveLength(1);
    // the workflow-level default is read-only
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
  });

  it('uses no secret, no pull_request_target, persists no credentials and pins every action by full SHA', () => {
    for (const text of [yml, ci]) {
      expect(text).not.toMatch(/secrets\./);
      expect(text).not.toContain('pull_request_target');
      for (const m of text.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
    }
    const checkouts = yml.match(/actions\/checkout@/g) ?? [];
    expect(checkouts.length).toBeGreaterThan(0);
    expect((yml.match(/persist-credentials: false/g) ?? []).length).toBe(checkouts.length);
  });

  it('the pins are the ones every repository uses', () => {
    for (const pin of [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
      'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
      'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0',
      'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0',
      'actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1',
    ])
      expect(yml, pin).toContain(pin);
  });

  it('fetches only the two runtime-demo models (SmolLM2-135M and multilingual-e5-small), fails closed, builds with DEMO_MODELS=1 and records a bounded dist size', () => {
    expect(yml).toContain('node test/tools/fetch-model.mjs smollm2-135m-instruct');
    expect(yml).toContain('node test/tools/fetch-model.mjs multilingual-e5-small-wasm-q8');
    // no pilot model and no Qwen weights in the runtime demo: the 1.7B graph alone is over the 1 GB limit
    expect(yml).not.toMatch(/qwen3-1\.7b|smollm2-360m|mlc/i);
    expect(yml).toContain('DEMO_MODELS=1 npm run demo:build');
    // the per-model sizes are printed and the 1 GiB refusal stays (Pages limit)
    expect(yml).toContain('du -sk demo/dist/models/*');
    expect(yml).toContain('dist-size.txt');
    expect(yml).toMatch(/1073741824|1 GB|1 GiB/);
    expect(yml).toContain('upload-pages-artifact');
    expect(yml).toContain('dev.airplanemode.runtime-demo-models');
  });

  it('ci.yml keeps the model-wasm job WebAssembly-only and runs the worker, TT and DevTools proofs nowhere that needs a GPU', () => {
    const wasm = job(ci, 'model-wasm');
    expect(wasm).toContain('RUNTIME_MODEL_LEGS=wasm');
    expect(wasm).not.toContain('REQUIRE_WEBGPU');
    expect(ci).not.toMatch(/RUNTIME_DEVTOOLS_HEADED/);
  });
});
