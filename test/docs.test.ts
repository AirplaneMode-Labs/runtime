import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maxTokensFor } from '../demo/limits';
import { validateModelDescriptor } from '../src/schema';
import { repoDir } from './helpers';

// Documentation hygiene: READMEs never cite a scratch path, every cited evidence file exists in the
// workspace, and the quota wording matches the manager (usage = max(estimate, accounted bytes)).
// RUNTIME_DOCS_DIR points the checks at another copy of the documents (used to prove the test red
// against the pre-change files).
const docsDir = process.env['RUNTIME_DOCS_DIR'] ?? repoDir;
const read = (rel: string) => readFileSync(resolve(docsDir, rel), 'utf8');
const workspace = resolve(repoDir, '..');

describe('documentation hygiene', () => {
  const readmes = ['README.md', 'test/browser/README.md', 'spec/README.md'];

  for (const rel of readmes) {
    it(`${rel} cites no /private/tmp path`, () => {
      expect(read(rel)).not.toContain('/private/tmp');
    });
  }

  it('README.md: every evidence/sprint-N/... path it cites exists in the workspace', () => {
    const hasWorkspace = existsSync(resolve(workspace, 'evidence'));
    const cited = new Set(read('README.md').match(/evidence\/sprint-\d+\/[A-Za-z0-9_./-]+/g) ?? []);
    expect(cited.size).toBeGreaterThan(0);
    if (!hasWorkspace) return; // standalone clone (CI): the workspace evidence folder is not there
    for (const rel of cited) {
      // a trailing sentence dot is not part of the path
      const path = rel.replace(/\.$/, '');
      // Sprint 2 evidence is copied into the workspace by the architect at wrap-up: until its
      // folder exists the citation cannot be checked, from then on it must resolve.
      const sprintDir = path.split('/').slice(0, 2).join('/');
      if (!existsSync(resolve(workspace, sprintDir))) continue;
      expect(existsSync(resolve(workspace, path)), path).toBe(true);
    }
  });

  it('README.md: the IndexedDB quota Benchmarks row records the measured 6252 ms (T1R2-02)', () => {
    const row = read('README.md')
      .split('\n')
      .find((l) => l.includes('Quota eviction') && l.includes('IndexedDB'));
    expect(row).toBeDefined();
    expect(row).toContain('6252 ms');
    expect(row).not.toContain('not measured');
    expect(row).toContain('placeholder');
  });

  it('browser test docs describe usage as max(estimate().usage, accounted bytes) with usageSource (T1R2-01)', () => {
    const readme = read('test/browser/README.md');
    expect(readme).toContain('usageSource');
    expect(readme).toContain('accounted bytes');
    const stale =
      /manager runs on navigator\.storage\.estimate\(\) alone|estimate\(\)-based headroom|estimate\(\)-only manager never sees|`estimate\(\)` alone,/;
    for (const rel of [
      'test/browser/README.md',
      'test/browser/helpers.ts',
      'test/browser/big.spec.ts',
    ])
      expect(read(rel), rel).not.toMatch(stale);
  });

  describe('docs/model-choice.md', () => {
    // Prettier may re-wrap prose: compare with whitespace collapsed
    const doc = () => read('docs/model-choice.md').replace(/\s+/g, ' ');
    const models = () =>
      JSON.parse(readFileSync(resolve(repoDir, 'test/tools/models.json'), 'utf8')) as {
        models: Record<string, { files: { path: string; size: number }[] }>;
        reference: {
          candidates: Record<string, { totalBytes: number; files: { size: number }[] }>;
        };
      };
    const fmt = (n: number) => n.toLocaleString('en-US');

    it('names the three candidates, the stricter rule and the honest licence wording', () => {
      const d = doc();
      for (const s of ['Qwen3-1.7B', 'Llama-3.2-1B-Instruct', 'Gemma-3-1B-it'])
        expect(d, s).toContain(s);
      expect(d).toContain('Llama 3.2 and Gemma do allow commercial use and redistribution');
      for (const s of [
        'Built with Llama',
        'Acceptable Use Policy',
        '700 million',
        'Prohibited Use Policy',
        'reserves the right to restrict',
        'stricter rule',
        'no custom licence and no use-policy pass-through',
      ])
        expect(d, s).toContain(s);
      expect(d).toContain('not a claim');
    });

    it('every size in the tables equals models.json byte for byte', () => {
      const d = doc();
      const m = models();
      for (const [k, c] of Object.entries(m.reference.candidates)) {
        expect(d, `${k} total`).toContain(fmt(c.totalBytes));
        for (const f of c.files) expect(d, `${k} file`).toContain(fmt(f.size));
      }
      for (const name of ['smollm2-135m-instruct', 'qwen3-1.7b-webgpu-q4f16']) {
        const big = m.models[name]!.files.find((f) => f.path.endsWith('.onnx'))!;
        expect(d, name).toContain(fmt(big.size));
      }
    });

    it('states the planned and provisional decision wording, the contingency and the D1-09 outcome', () => {
      const d = doc();
      expect(d).toContain(
        'Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.',
      );
      expect(d).toContain('Qwen3-0.6B');
      expect(d).toContain('enable_thinking');
      expect(d).toContain('no independent evaluation by the lab exists');
      expect(d).toMatch(/provisional: not yet loaded in a browser|hindi-smoke\.json/);
      expect(d).not.toContain('PLACEHOLDER');
    });

    it('gives every candidate a Hindi evidence cell with a source or "none found"', () => {
      const d = doc();
      expect(d).toContain('arXiv 2505.09388');
      expect(d).toContain('MODEL_CARD.md');
      expect(d).toContain('model_card_3');
      expect(d).toContain('arXiv 2503.19786');
    });
  });

  it('the planned Qwen3-1.7B descriptors in docs/examples validate and match the planned shape', () => {
    for (const [file, devices, dtype, onnx] of [
      ['qwen3-1.7b.tjs-webgpu-q4f16.descriptor.json', ['webgpu'], 'q4f16', 'onnx/model_q4f16.onnx'],
      ['qwen3-1.7b.tjs-wasm-q8.descriptor.json', ['wasm'], 'q8', 'onnx/model_quantized.onnx'],
    ] as const) {
      const d = JSON.parse(read(`docs/examples/${file}`)) as {
        devices: string[];
        dtype: string;
        files: { path: string }[];
        generation: { chatTemplateKwargs: { enable_thinking: boolean } };
        source: { repo: string; revision: string };
        licence: string;
      };
      const r = validateModelDescriptor(d);
      expect(r.errors, file).toEqual([]);
      expect(d.devices).toEqual(devices);
      expect(d.dtype).toBe(dtype);
      expect(d.files.map((f) => f.path)).toContain(onnx);
      expect(d.generation.chatTemplateKwargs).toEqual({ enable_thinking: false });
      expect(d.source).toEqual({
        repo: 'onnx-community/Qwen3-1.7B-ONNX',
        revision: '3231b522c6e703b2f9b3cd8ea27426a1289a02f2',
      });
      expect(d.licence).toBe('Apache-2.0');
    }
  });
});

// ---- fix round 1 (T1-S2-01, -02, -04, -06, -07, -08, S1-052 to S1-058): one wording everywhere --------

describe('fix round 1: honest wording', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const MODEL_CARD =
    'Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.';
  const LOADED_ONCE =
    'Loaded once in a browser: a local, unscored WebGPU smoke run of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation turned off (evidence/sprint-2/D1/hindi-smoke.json).';
  const HASH_FAIL =
    'A model file that fails its hash check is reported as "could not be started", and the next rung downloads it again; a distinct integrity reason is planned with the Sprint 3 event minor.';
  const POISON =
    'If the WebGPU engine fails after it has started creating a session (for example out of memory), WebAssembly cannot start in the same page until it is reloaded; per-rung engine isolation is planned for Sprint 3.';
  const MAIN_THREAD =
    'On WebAssembly, generation runs on the main thread: the tab does not repaint or run timers until generation ends, and an AbortSignal fired from a timer or a button is honoured only between engine steps that yield; abort from onToken works. Moving the engine off the main thread is planned for Sprint 3.';

  it('README.md, demo/models.html and docs/model-choice.md carry the model-card sentence verbatim on one line, then the loaded-once sentence', () => {
    for (const rel of ['README.md', 'demo/models.html', 'docs/model-choice.md']) {
      const raw = read(rel);
      expect(raw, `${rel}: model card on one line`).toContain(MODEL_CARD);
      expect(raw, `${rel}: loaded-once sentence on one line`).toContain(LOADED_ONCE);
      expect(flat(raw), rel).toContain(`${MODEL_CARD} ${LOADED_ONCE}`);
      // the old, weaker wording is gone
      expect(flat(raw), rel).not.toContain('It was loaded once, in a local smoke run');
      expect(raw, rel).not.toContain('not yet loaded in a browser');
    }
  });

  it('model-choice.md and the README state the sessionOptions finding and the Sprint 3 decision', () => {
    for (const rel of ['README.md', 'docs/model-choice.md']) {
      const d = flat(read(rel));
      expect(d, rel).toContain("graphOptimizationLevel 'disabled'");
      expect(d, rel).toContain('std::bad_alloc');
      expect(d, rel).toContain('4 GB wasm32 heap');
      expect(d, rel).toContain(
        'createDefaultAdapters() cannot load the production model unless the application passes the sessionOptions option',
      );
      expect(d, rel).toContain('architect decision for Sprint 3');
      expect(d, rel).toContain('The sessionOptions allow-list stays at that one key.');
    }
  });

  it('README Benchmarks: the JS heap caveat and the renderer RSS proxy row with T1 evidence (T1-S2-06)', () => {
    const d = flat(read('README.md'));
    expect(d).toContain('excludes WebAssembly linear memory, Blob backing stores and GPU memory');
    expect(d).toContain('Chrome exposes no GPU-memory figure');
    const row = read('README.md')
      .split('\n')
      .find((l) => l.includes('renderer process RSS peak (proxy, placeholder)'));
    expect(row).toBeDefined();
    for (const s of ['1.9 GiB', '1.6 GiB', '0.35-0.42 GiB', 'Apple-silicon'])
      expect(row, s).toContain(s);
    expect(d).toContain('node /…/T1/runtime-legs.mjs webgpu wasm');
    for (const s of [
      'evidence/sprint-2/T1/runtime-legs.mjs',
      'evidence/sprint-2/T1/legs/rep1-webgpu.json',
      'rep3-webgpu.json',
      'evidence/sprint-2/T1/legs/rep1-wasm.json',
    ])
      expect(d, s).toContain(s);
    expect(d).toContain('8 GB Windows no-GPU laptop (any of the above) | not measured');
  });

  it('README Limitations: the hash-failure line (T1-S2-07), the poisoned-engine line (T1-S2-01) and the main-thread line (T1-S2-02)', () => {
    const readme = read('README.md');
    const limitations = readme.slice(
      readme.indexOf('## Limitations'),
      readme.indexOf('## Security'),
    );
    expect(limitations.length).toBeGreaterThan(100);
    for (const sentence of [HASH_FAIL, POISON, MAIN_THREAD])
      expect(flat(limitations)).toContain(sentence);
  });

  it('spec/backend-adapter.md carries the main-thread limitation as an informative paragraph, and spec/CHANGELOG.md records it under 0.2.0 (T1-S2-02)', () => {
    const md = flat(read('spec/backend-adapter.md'));
    expect(md).toContain('Known limitation (0.2.0 draft)');
    expect(md).toContain(MAIN_THREAD);
    const log = read('spec/CHANGELOG.md');
    const section = log.slice(log.indexOf('## [0.2.0]'));
    expect(flat(section)).toContain('T1-S2-02');
    expect(flat(section)).toContain('Known limitation');
  });

  it('models.html: the not-yet box says the page freezes while WebAssembly generates, and the WASM path keeps maxTokens at 32 or less (T1-S2-02)', () => {
    const html = flat(read('demo/models.html'));
    const box = html.slice(html.indexOf('What this demo does not do yet'));
    expect(box).toMatch(/freezes while WebAssembly generates/);
    expect(maxTokensFor('wasm')).toBeLessThanOrEqual(32);
    expect(maxTokensFor('wasm')).toBeGreaterThan(0);
    expect(maxTokensFor('webgpu')).toBeGreaterThanOrEqual(maxTokensFor('wasm'));
    expect(read('demo/backend-panel.ts')).toContain('maxTokensFor(');
  });

  it('README Install and Security name onnxruntime-node and protobufjs as the install-script packages, describe sharp as prebuilt @img/* code (S1-067), recommend ignoring scripts and link checklist row 8 (S1-056)', () => {
    const readme = read('README.md');
    const install = flat(
      readme.slice(readme.indexOf('## Install'), readme.indexOf('## Quick start')),
    );
    const security = flat(
      readme.slice(readme.indexOf('## Security and privacy'), readme.indexOf('## Develop')),
    );
    for (const [name, text] of [
      ['Install', install],
      ['Security and privacy', security],
    ] as const) {
      expect(text, name).toContain('onnxruntime-node');
      expect(text, name).toContain('protobufjs');
      expect(text, name).toContain('install scripts');
      expect(text, name).toContain('@img/*');
      expect(text, name).not.toMatch(/onnxruntime-node and `?sharp`?,? which have install scripts/);
      expect(text, name).toContain('npm install --ignore-scripts');
      expect(text, name).toContain('ignore-scripts=true');
      expect(text, name).toContain('docs/security/PRE-PILOT-CHECKLIST.md');
      expect(text, name).toMatch(/row 8/);
    }
  });

  it('ci.yml installs no Chrome: it uses the preinstalled one, logs its version, and every checkout and pin is intact (S1-058)', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/playwright install/);
    expect((ci.match(/google-chrome --version/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ci).toMatch(/channel/); // the comment explaining Playwright channel "chrome"
    const checkouts = ci.match(/actions\/checkout@/g) ?? [];
    const persist = ci.match(/persist-credentials: false/g) ?? [];
    expect(persist.length).toBe(checkouts.length);
    for (const m of ci.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(flat(read('README.md'))).not.toContain('npx playwright install --with-deps chrome');
    expect(flat(read('README.md'))).toMatch(
      /preinstalled on ubuntu-latest.{0,200}configured, not yet executed/,
    );
  });

  it('CHANGELOG.md has a bullet for each fix, ending with the id, and the S1-053 bullet names the Sprint 3 cacheOnly option', () => {
    const log = read('CHANGELOG.md');
    const from = log.indexOf('## [Unreleased]');
    const next = log.indexOf('\n## [', from + 5);
    const unreleased = log.slice(from, next === -1 ? undefined : next);
    // a bullet is a "- " line plus its continuation lines; it must end with "(... <id> ...)."
    const bullets = unreleased
      .split(/\n(?=- |#{1,6} )/)
      .filter((b) => b.startsWith('- '))
      .map((b) => flat(b).trim());
    for (const id of [
      'T1-S2-01',
      'T1-S2-02',
      'T1-S2-04',
      'T1-S2-06',
      'T1-S2-07',
      'T1-S2-08',
      'S1-052',
      'S1-053',
      'S1-054',
      'S1-056',
      'S1-058',
    ])
      expect(
        bullets.some((b) => new RegExp(`\\([^()]*\\b${id}\\b[^()]*\\)\\.?$`).test(b)),
        `a bullet ending with ${id}`,
      ).toBe(true);
    const s053 = bullets.find((b) => /\(S1-053\)|S1-053\)\.?$/.test(b) && b.includes('cacheOnly'));
    expect(s053, 'the S1-053 bullet names AcquireOptions.cacheOnly').toBeDefined();
    expect(s053).toContain('AcquireOptions.cacheOnly');
    expect(s053).toContain('Sprint 3');
  });
});
