import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it('no source, test or demo file cites a scratch path: they cite evidence/sprint-N/ paths (T3-S3-035)', () => {
    const skip = new Set(['docs.test.ts', 'package-meta.test.ts']); // these two assert the absence itself
    const walk = (dir: string): string[] =>
      readdirSync(resolve(repoDir, dir), { withFileTypes: true }).flatMap((d) =>
        d.name === 'node_modules' || d.name === 'dist' || d.name === 'public'
          ? []
          : d.isDirectory()
            ? walk(`${dir}/${d.name}`)
            : /\.(ts|mjs|html|css)$/.test(d.name) && !skip.has(d.name)
              ? [`${dir}/${d.name}`]
              : [],
      );
    const offenders = ['src', 'test', 'demo']
      .flatMap(walk)
      .filter((f) => readFileSync(resolve(repoDir, f), 'utf8').includes('/private/tmp'));
    expect(offenders).toEqual([]);
  });

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

  it('prose describing the 8 GB column quotes the full cell text (T3-R1-02)', () => {
    for (const f of ['README.md', 'docs/release.md']) {
      const text = read(f).replace(/\s+/g, ' ');
      const bad = text.match(/(?:reads?|read)\s+"not measured"/g);
      expect(bad, `${f} quotes the 8 GB column as "not measured"`).toBeNull();
    }
  });

  it('README.md: the IndexedDB quota Benchmarks row records the measured 6252 ms (T1R2-02)', () => {
    const row = read('README.md')
      .split('\n')
      .find((l) => l.includes('Quota eviction') && l.includes('IndexedDB'));
    expect(row).toBeDefined();
    expect(row).toContain('6252 ms');
    expect(row).toMatch(/\| not measured on 8 GB\s*\|\s*$/); // the 8 GB column only (T3-S5-15)
    expect(row!.replace(/\| not measured on 8 GB\s*\|\s*$/, '')).not.toContain('not measured');
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
        spec: string;
        sessionOptions?: unknown;
        devices: string[];
        dtype: string;
        files: { path: string }[];
        generation: { chatTemplateKwargs: { enable_thinking: boolean } };
        source: { repo: string; revision: string };
        licence: string;
      };
      const r = validateModelDescriptor(d);
      expect(r.errors, file).toEqual([]);
      // D1-03: both docs descriptors are 0.2; only the q4f16 one needs graphOptimizationLevel disabled
      expect(d.spec, file).toBe('airplanemode.model/0.2');
      expect(d.sessionOptions, file).toEqual(
        dtype === 'q4f16' ? { graphOptimizationLevel: 'disabled' } : undefined,
      );
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
  // Sprint 3: the worker host (default in the demo) removes both limitations; they remain true for the
  // main-thread adapter, which is what createDefaultAdapters() builds without a workerUrl.
  const POISON =
    'Main-thread adapter only: if the WebGPU engine fails after it has started creating a session (for example out of memory), WebAssembly cannot start in the same page until it is reloaded; the worker host (a workerUrl) starts a fresh engine per rung and has no such limit.';
  const MAIN_THREAD =
    'Main-thread adapter only: on WebAssembly, generation runs on the main thread: the tab does not repaint or run timers until generation ends, and an AbortSignal fired from a timer or a button is honoured only between engine steps that yield; abort from onToken works. The worker host (a workerUrl) keeps the page responsive and lands an abort within about 250 ms by terminating the worker.';

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

  it('model-choice.md and the README state the sessionOptions finding and its Sprint 3 resolution (model descriptor 0.2.0)', () => {
    for (const rel of ['README.md', 'docs/model-choice.md']) {
      const d = flat(read(rel));
      expect(d, rel).toContain("graphOptimizationLevel 'disabled'");
      expect(d, rel).toContain('std::bad_alloc');
      expect(d, rel).toContain('4 GB wasm32 heap');
      expect(d, rel).toContain(
        "the q4f16 descriptor carries sessionOptions { graphOptimizationLevel: 'disabled' }, so createDefaultAdapters() loads it without the application passing sessionOptions",
      );
      expect(d, rel).not.toContain('cannot load the production model unless');
      expect(d, rel).not.toContain('architect decision for Sprint 3');
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
    expect(d).toMatch(/\| Scenario[^\n]*\| 8 GB laptop \|/);
    expect(d).not.toContain('8 GB Windows no-GPU laptop (any of the above)');
  });

  it('README Limitations: the poisoned-engine line (T1-S2-01) and the main-thread line (T1-S2-02) stay until the worker host lands; the hash-failure line (T1-S2-07) is gone', () => {
    const readme = read('README.md');
    const limitations = readme.slice(
      readme.indexOf('## Limitations'),
      readme.indexOf('## Security'),
    );
    expect(limitations.length).toBeGreaterThan(100);
    for (const sentence of [POISON, MAIN_THREAD]) expect(flat(limitations)).toContain(sentence);
    // T1-S2-07 is closed in Sprint 3: the hash-failure limitation is gone and the fix is in the CHANGELOG
    expect(flat(limitations)).not.toContain('is reported as "could not be started"');
  });

  it('spec/backend-adapter.md rewrites the main-thread limitation for 0.3.0, and spec/CHANGELOG.md recorded it under 0.2.0 (T1-S2-02)', () => {
    const md = flat(read('spec/backend-adapter.md'));
    expect(md).toContain('Known limitation (0.3.0 draft)');
    expect(md).toContain('the main-thread engine adapter');
    const log = read('spec/CHANGELOG.md');
    const section = log.slice(log.indexOf('## [0.2.0]'));
    expect(flat(section)).toContain('T1-S2-02');
    expect(flat(section)).toContain('Known limitation');
  });

  it('models.html: the not-yet box no longer says the page freezes (the engine runs in a worker, D1-04) and the WASM path keeps maxTokens at 32 or less', () => {
    const html = flat(read('demo/models.html'));
    const box = html.slice(html.indexOf('What this demo does not do yet'));
    expect(box).not.toMatch(/freezes while WebAssembly generates/);
    // the line itself is written by the page when a backend.worker ready event arrives
    expect(read('demo/backend-panel.ts')).toContain('The engine runs in a worker');
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
      /preinstalled on ubuntu-latest.{0,200}first ran on GitHub on 9 Nov 2026/,
    );
    expect(flat(read('README.md'))).not.toContain('configured, not yet executed');
  });

  it('CHANGELOG.md has a bullet for each fix, ending with the id, and the S1-053 bullet names the Sprint 3 cacheOnly option', () => {
    const log = read('CHANGELOG.md');
    // since Sprint 3 the unreleased work lives under the 0.2.0-alpha.0 heading
    const from = log.indexOf('## [0.2.0-alpha.0]');
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

// ---- Sprint 6 Part A (T3-R2-06, TD-51): the README Status carries the done-when sentence ------------
describe('T3-R2-06: the README Status states the 8 GB done-when', () => {
  const DONE_WHEN =
    'build done on Apple M5 Pro 48 GB; 8 GB Windows done-when NOT met (owner runbook step 5)';
  // Status = the lines between a line "## Status" and the next line that starts with "## " (a "### "
  // sub-heading does not end it). CRLF is normalised so a Windows checkout reads the same text.
  const lf = (s: string) => s.replace(/\r\n?/g, '\n');
  const statusSection = (readme: string): string => {
    const text = lf(readme);
    const start = text.search(/^## Status[ \t]*$/m);
    if (start === -1) return '';
    const rest = text.slice(start + '## Status'.length);
    const next = rest.search(/^## /m);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const hasSentence = (readme: string) =>
    statusSection(readme).replace(/\s+/g, ' ').includes(DONE_WHEN);

  it('README.md: the Status section carries the TD-51 sentence verbatim', () => {
    expect(statusSection(read('README.md')).length).toBeGreaterThan(200);
    expect(hasSentence(read('README.md'))).toBe(true);
  });

  it('the check fails on a README copy with the sentence removed, or moved out of Status', () => {
    const readme = read('README.md');
    expect(hasSentence(readme.split(DONE_WHEN).join(''))).toBe(false);
    // present, but only after the next "## " heading: not in Status
    const moved = lf(readme)
      .replace(DONE_WHEN, '')
      .replace('\n## Install', `\n## Install\n\n${DONE_WHEN}`);
    expect(hasSentence(moved)).toBe(false);
  });

  it('is read through fs with CRLF normalised: a CRLF copy of the README gives the same verdict', () => {
    const crlf = lf(read('README.md')).replace(/\n/g, '\r\n');
    expect(hasSentence(crlf)).toBe(true);
    expect(hasSentence(crlf.split(DONE_WHEN).join(''))).toBe(false);
  });
});

describe('D1-03: docs describe the descriptor sessionOptions', () => {
  const flat = (x: string) => x.replace(/\s+/g, ' ');
  it('docs/examples/README.md and docs/model-choice.md say the 1.7B q4f16 descriptor carries graphOptimizationLevel disabled and that createDefaultAdapters needs no sessionOptions', () => {
    const examples = flat(read('docs/examples/README.md'));
    expect(examples).toContain('airplanemode.model/0.2');
    expect(examples).toContain("sessionOptions { graphOptimizationLevel: 'disabled' }");
    const choice = flat(read('docs/model-choice.md'));
    expect(choice).toContain("sessionOptions { graphOptimizationLevel: 'disabled' }");
    expect(choice).toContain('without the application passing sessionOptions');
    expect(choice).not.toContain('the application passes it');
  });
});

describe('Sprint 7 (D1-04, D1-06, D1-08): RELEASING.md, the live demo line, the issue forms and the write-up draft', () => {
  const lf = (s: string) => s.replace(/\r\n?/g, '\n');
  const flat = (s: string) => lf(s).replace(/\s+/g, ' ');
  const releasing = lf(read('docs/RELEASING.md'));
  const steps = [...releasing.matchAll(/^### (\d+)\. (.+)$/gm)].map(
    (m) => [Number(m[1]), m[2]!] as const,
  );

  it('README: the Live demo line is within the first 12 lines, exactly (TD-116)', () => {
    const head = lf(read('README.md')).split('\n').slice(0, 12);
    expect(head).toContain('Live demo: https://airplanemode-labs.github.io/runtime/');
  });

  it('RELEASING.md has fourteen steps, in order, and each one says why the team cannot do it', () => {
    expect(steps.map(([n]) => n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    const bodies = releasing.split(/^### \d+\. .+$/m).slice(1);
    expect(bodies).toHaveLength(14);
    for (const [i, b] of bodies.entries()) expect(b, `step ${i + 1}`).toMatch(/Why not the team:/);
  });

  it("public prose does not use a tester role as a subject: no 'T1 measured', 'T2 showed', 'T3's ... found' in README, CHANGELOG or docs/*.md (fix round 2 decision)", () => {
    // Ids such as BUG-T2-S7-02 and test names are fine; only a role as the subject of a sentence is not. docs/security (the
    // findings register) is out of scope, as in the rule's grep.
    const files = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md'].concat(
      readdirSync(resolve(docsDir, 'docs'))
        .filter((n) => n.endsWith('.md'))
        .map((n) => `docs/${n}`),
    );
    // on the whitespace-flattened text, so a role at the end of one line and its verb at the start of the next is caught too
    const role = /\bT[123](?:'s)? (?:showed|measured|found|confirmed)\b/g;
    const hits = files.flatMap((f) =>
      [...flat(read(f)).matchAll(role)].map((m) => `${f}: ...${m[0]}...`),
    );
    expect(hits).toEqual([]);
  });

  it('FINDINGS.md (BUG-T3-S7-23): the evidence-rsync.sh line numbers cited for S1-115 and S1-122 are the lines that hold the quoted text', () => {
    // The script is in the workspace's evidence/sprint-6/, not in this repository: a lone checkout has nothing to compare with.
    const script = resolve(workspace, 'evidence/sprint-6/architect/evidence-rsync.sh');
    if (!existsSync(script)) return;
    const src = lf(readFileSync(script, 'utf8')).split('\n');
    const at = (a: number, b = a): string => src.slice(a - 1, b).join('\n');
    const findings = flat(read('docs/security/FINDINGS.md'));
    // [the citation as FINDINGS.md writes it, the first and last line it names, text that must be on those lines]
    const cited: [string, number, number, string[]][] = [
      [
        '`evidence-rsync.sh` l.7 `ARGS=(',
        7,
        7,
        ['ARGS=(-a --no-links --one-file-system --max-size=5m --prune-empty-dirs'],
      ],
      [
        'l.10-11 S1-098 extras',
        10,
        11,
        [
          "'*-copy*/'",
          "'*-head/'",
          "'ws/'",
          "'ws-cp/'",
          "'red-base/'",
          "'fresh-*/'",
          "'dl-*'",
          "'*.tar.gz'",
        ],
      ],
      [
        'l.13-14 the S1-115 extras',
        13,
        14,
        ["'fix2-clean-*/tree/'", "'cli-root/'", "'Cargo.lock.before'"],
      ],
      [
        '`evidence-rsync.sh` l.16-17 add',
        16,
        17,
        [
          "'cs-mnt/'",
          "'cs-vol/'",
          "'parity-cpm/'",
          "'sdist-work/'",
          "'__pycache__/'",
          "'*.hex'",
          "'*keygrep*'",
          "'parity-1000.*'",
        ],
      ],
      [
        'and l.22 `*control-plane*.lock`',
        22,
        22,
        ["'*control-plane*.lock'", "'keys1000/'", "'km/'", "'*-km/'"],
      ],
      ['with `--one-file-system` on l.7', 7, 7, ['--one-file-system']],
    ];
    for (const [phrase, a, b, needles] of cited) {
      expect(findings, `FINDINGS.md cites "${phrase}"`).toContain(phrase);
      for (const n of needles)
        expect(at(a, b), `l.${a}-${b} of evidence-rsync.sh holds ${n}`).toContain(n);
    }
    // and no other line number is cited for this script
    const nums = [...findings.matchAll(/evidence-rsync\.sh` l\.(\d+(?:-\d+)?)/g)].map((m) => m[1]);
    expect(nums.sort()).toEqual(['16-17', '7']);
  });

  it('RELEASING.md step 3 (BUG-T3-S7-13): the documented base64 command turns a cp-sign key.pub into the TEST 1 publicKey of spec/vectors/release, and refuses a file without an ed25519-public line', () => {
    // cp-sign keygen writes key.pub as '# cp-sign Ed25519 public key.' then 'ed25519-public <64 hex>' (control-plane
    // crates/cp-sign/src/main.rs): the command must pick that line, not the first line of the file.
    const body = releasing.split(/^### \d+\. .+$/m)[3]!;
    const m = /^node -e '([^']*)' <KEYDIR>\/key\.pub$/m.exec(body);
    expect(m, 'step 3 holds one node -e command that ends in <KEYDIR>/key.pub').not.toBeNull();
    const js = m![1]!;
    const test1Hex = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const vector = JSON.parse(
      readFileSync(resolve(repoDir, 'spec/vectors/release/base/release-manifest.json'), 'utf8'),
    ) as { signatures: { publicKey: string }[] };
    const test1B64 = vector.signatures[0]!.publicKey;
    expect(test1B64.startsWith('11qYAYKx')).toBe(true);
    expect(Buffer.from(test1Hex, 'hex').toString('base64')).toBe(test1B64);

    const dir = mkdtempSync(join(tmpdir(), 'rt-pubkey-'));
    try {
      const run = (content: string) => {
        const file = join(dir, 'key.pub');
        writeFileSync(file, content);
        const r = spawnSync(process.execPath, ['-e', js, file], { encoding: 'utf8' });
        return { status: r.status, out: r.stdout, err: r.stderr, file };
      };
      const ok = run(`# cp-sign Ed25519 public key.\ned25519-public ${test1Hex}\n`);
      expect(ok.err).toBe('');
      expect(ok.status).toBe(0);
      expect(ok.out).toBe(`${test1B64}\n`);
      // the same file with CRLF line endings (a Windows checkout of the notes, an editor) gives the same answer
      const crlf = run(`# cp-sign Ed25519 public key.\r\ned25519-public ${test1Hex}\r\n`);
      expect([crlf.status, crlf.out]).toEqual([0, `${test1B64}\n`]);
      // no ed25519-public line (the comment line only, a secret-key file, an empty file): exit 1 and nothing on stdout
      for (const bad of [
        '# cp-sign Ed25519 public key.\n',
        `# cp-sign Ed25519 secret key.\ned25519-seed ${'9d'.repeat(32)}\n`,
        '',
        `ed25519-publicx ${test1Hex}\n`,
      ]) {
        const r = run(bad);
        expect([r.status, r.out], JSON.stringify(bad)).toEqual([1, '']);
        expect(r.err).toContain('not a cp-sign public key file');
      }
      // a public line that is not exactly 32 bytes (truncated, extra, not hex) is refused too
      for (const hex of [test1Hex.slice(0, 62), `${test1Hex}00`, 'zz'.repeat(32), '']) {
        const r = run(`# cp-sign Ed25519 public key.\ned25519-public ${hex}\n`);
        expect([r.status, r.out], hex).toEqual([1, '']);
      }
      // the command as documented, run by a shell with the placeholder replaced (POSIX only: Windows has no sh here)
      if (process.platform !== 'win32') {
        const file = join(dir, 'key.pub');
        writeFileSync(file, `# cp-sign Ed25519 public key.\ned25519-public ${test1Hex}\n`);
        const cmd = m![0]!.replace('<KEYDIR>/key.pub', `'${file.replace(/'/g, `'\\''`)}'`);
        expect(execFileSync('sh', ['-c', cmd], { encoding: 'utf8' })).toBe(`${test1B64}\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RELEASING.md names the steps in the specified order', () => {
    const titles = steps.map(([, t]) => t.toLowerCase());
    const order = [
      'reserve',
      'generate the release key offline',
      'commit the public key',
      'create the `release` environment',
      '8 gb runbook',
      'dated changelog',
      'dispatch the publish workflow',
      'check the candidate',
      'sign `release-manifest.json` offline',
      'tag exactly',
      'short-lived npm token',
      'approve the deployment',
      'revoke the token',
      'publish the write-up',
    ];
    for (const [i, needle] of order.entries()) expect(titles[i], `step ${i + 1}`).toContain(needle);
  });

  it('RELEASING.md carries the exact commands: environment, reviewer, branch policy, admins, variables, secret, candidate check, signing, verification, tag, token', () => {
    const f = releasing;
    for (const s of [
      'gh api -X PUT repos/AirplaneMode-Labs/runtime/environments/release',
      '"reviewers": [{ "type": "User", "id": $OWNER_ID }]',
      '"can_admins_bypass": false',
      '"custom_branch_policies": true',
      'gh api -X POST repos/AirplaneMode-Labs/runtime/environments/release/deployment-branch-policies -f name=main -f type=branch',
      'gh variable set RELEASE_PUBLISH_ARMED --env release',
      'gh variable set RELEASE_KEY_ID --env release',
      'gh secret set NPM_TOKEN --env release --repo AirplaneMode-Labs/runtime',
      'gh run view <run-id> --repo AirplaneMode-Labs/runtime --json event,headBranch,headSha,workflowName',
      'gh workflow run publish.yml',
      'cp-sign keygen --out <KEYDIR>',
      'cp-sign sign --no-expiry --key <KEYDIR>/key.secret',
      'cp-sign verify --pub <KEYDIR>/key.pub --expect-id runtime-release',
      'node spec/tools/release-tool.mjs verify --dir verify-copy --expect-id runtime-release --trust-file docs/release-keys.json',
      'git -C <runtime clone> tag -a v0.3.0-beta.2 <sha>',
      'gh release create v0.3.0-beta.2',
      'npm token revoke',
      'gh secret delete NPM_TOKEN --env release',
      'Granular Access Token',
      '7 days or less',
      'tag ruleset',
      'private vulnerability reporting',
      'CODEOWNERS',
      'TD-122',
    ])
      expect(f, s).toContain(s);
    // the token never appears on a command line
    expect(f).not.toMatch(/gh secret set NPM_TOKEN[^\n]*--body/);
    expect(f).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
  });

  it("RELEASING.md never tells anyone to use a test key: '--allow-test-key' appears only after 'never'", () => {
    for (const m of releasing.matchAll(/--allow-test-key/g)) {
      const before = releasing.slice(Math.max(0, m.index! - 14), m.index!);
      expect(before, `context of --allow-test-key at ${m.index}`).toMatch(/never pass `$/);
    }
    expect(releasing).not.toMatch(/--trust-test-key|allowTestKeys|rfc8032-1/);
  });

  it('RELEASING.md (TD-125): both variables are environment variables, set with --env release; arming is in step 12, just before the approval, and disarming follows the publish', () => {
    const f = flat(releasing);
    expect(f).toContain('Both variables are variables of the `release` environment');
    expect(f).toContain('no job-level `if:` reads them');
    expect(releasing).not.toMatch(/gh variable (set|delete) \w+ --repo/);
    expect(releasing).not.toMatch(/gh variable (set|delete) RELEASE_\w+(?![^\n]*--env release)/);
    const bodies = releasing.split(/^### \d+\. .+$/m).slice(1);
    // step 4 sets the key id only: the arming variable is not set early
    expect(bodies[3]).toContain('gh variable set RELEASE_KEY_ID --env release');
    expect(bodies[3]).not.toContain('gh variable set RELEASE_PUBLISH_ARMED');
    // step 12 arms, after dispatch, the candidate check, signing and the GitHub release (steps 7 to 10)
    expect(bodies[11]).toContain('gh variable set RELEASE_PUBLISH_ARMED --env release --body true');
    expect(bodies[11]!.indexOf('gh variable set RELEASE_PUBLISH_ARMED')).toBeLessThan(
      bodies[11]!.indexOf('approve the `release` environment'),
    );
    // step 13 disarms after the publish
    expect(bodies[12]).toContain('gh variable delete RELEASE_PUBLISH_ARMED --env release');
  });

  it('RELEASING.md (TD-121): signing uses cp-sign sign --no-expiry and the publish job refuses an expiresAt', () => {
    const f = flat(releasing);
    expect(f).toContain('cp-sign sign --no-expiry');
    expect(f).toContain('refuses a manifest that carries an `expiresAt`');
  });

  it('RELEASING.md does not list a step the team could have done: no step is a build, a test or a commit of team files', () => {
    for (const [, title] of steps)
      expect(title.toLowerCase(), title).not.toMatch(/^(write|build|implement|document|draft)\b/);
  });

  it('issue forms: bug_report.yml has the required no-real-documents checkbox and a redaction line (TD-117)', () => {
    const bug = lf(read('.github/ISSUE_TEMPLATE/bug_report.yml'));
    const label =
      'I have not attached any real, confidential or personal document (bank, legal, medical, identity). Any sample is synthetic or public.';
    expect(bug).toContain(label);
    expect(bug).toMatch(
      new RegExp(`- label: ${label.replace(/[()]/g, '\\$&')}\\n\\s+required: true`),
    );
    expect(flat(bug)).toMatch(/redact/i);
    expect(bug).toContain('type: checkboxes');
    const feature = lf(read('.github/ISSUE_TEMPLATE/feature_request.yml'));
    expect(feature).toContain(label);
    expect(feature).toMatch(/required: true/);
  });

  it('issue forms: config.yml disables blank issues and links SECURITY.md; SECURITY.md says to report privately', () => {
    const config = lf(read('.github/ISSUE_TEMPLATE/config.yml'));
    expect(config).toMatch(/^blank_issues_enabled: false$/m);
    expect(config).toContain('contact_links:');
    expect(config).toContain('/blob/main/SECURITY.md');
    const sec = flat(read('SECURITY.md'));
    expect(sec).toContain('never in a public issue');
    expect(sec).toContain('privately');
    expect(existsSync(resolve(docsDir, 'CONTRIBUTING.md'))).toBe(true);
    expect(flat(read('CONTRIBUTING.md'))).toContain('test/quickstart.test.ts');
  });

  it('the good-first-issue drafts for runtime (in the workspace, not in this repository) are 3 to 5 texts, none filed', () => {
    const p = resolve(workspace, 'drafts/good-first-issues/runtime.md');
    if (!existsSync(p)) return; // a lone checkout has no workspace: nothing to read
    const text = lf(readFileSync(p, 'utf8'));
    expect(text).toContain('nothing is filed');
    const count = (text.match(/^## \d+\. /gm) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(5);
    expect(text).not.toMatch(/--allow-test-key|--trust-test-key|allowTestKeys|rfc8032|\bcurl\b/i);
  });

  describe('the write-up draft (D1-08)', () => {
    const draft = lf(read('docs/writeup-0.3.0-beta.2-draft.md'));

    it('is marked draft, not published, and says what was tried, what held up and what did not', () => {
      expect(draft).toContain('**Draft, not published.**');
      for (const h of ['## What was tried', '## What held up', '## What did not'])
        expect(draft, h).toContain(h);
      expect(draft).toContain('## On the 8 GB Windows laptop without a GPU');
    });

    it('reads "not measured on 8 GB" for the laptop and every figure sits beside a file path', () => {
      expect(draft).toContain('not measured on 8 GB');
      const f = flat(draft);
      for (const fig of [
        '4060 ms',
        '2561 ms',
        '2592 ms',
        '10.9 tokens/s',
        '26 weak-key rows',
        '36 cases',
        '44-id',
      ])
        expect(f, fig).toContain(fig);
      // every figure line cites a committed file or a link
      for (const fig of ['4060 ms', '2592 ms', '36 cases']) {
        const para = draft.split('\n\n').find((p) => p.includes(fig))!;
        expect(para, fig).toMatch(/\]\(\.\.?\/|`[a-z][^`]*\.(md|json|ts|mjs|log)`/);
      }
    });

    it('makes no published, audited or compliant claim, and no gate-1 prediction', () => {
      expect(draft).not.toMatch(/\b(audited|compliant|certified|guarantee[sd]?)\b/i);
      for (const m of draft.matchAll(/published/gi)) {
        const ctx = draft.slice(Math.max(0, m.index! - 12), m.index! + 9).toLowerCase();
        expect(ctx, `"published" in "${ctx}"`).toMatch(
          /not published|unpublished|be published|publish/,
        );
      }
      expect(draft).not.toMatch(/\b(stars|pilots)\b[^.]*\bwill\b/i);
    });

    it('release.md closes the team rows and calls the write-up row a draft that waits on the 8 GB figure', () => {
      const rel = flat(read('docs/release.md'));
      expect(rel).toContain('draft exists; finishing it waits on the 8 GB figure (owner)');
      expect(rel).toContain('## What the team closed in Sprint 7');
      expect(rel).toContain('RELEASING.md');
    });
  });
});
