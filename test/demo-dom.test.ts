import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the .mjs tool has no declaration file; the shape used here is checked at run time
import { buildModelManifest } from './tools/model-manifest.mjs';
import { repoDir } from './helpers';

const read = (rel: string) => readFileSync(resolve(repoDir, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const demoFiles = (ext: RegExp) => readdirSync(resolve(repoDir, 'demo')).filter((f) => ext.test(f));

/** The Content-Security-Policy of demo/index.html as shipped in Sprint 1 (must not change). */
const SPRINT1_INDEX_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MODELS_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const cspOf = (html: string): string => {
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  expect(m, 'a CSP meta tag').not.toBeNull();
  return m![1]!;
};

describe('the demo pages: markup and policy', () => {
  it('every demo TypeScript file renders with textContent only: no innerHTML, outerHTML or insertAdjacentHTML', () => {
    const files = demoFiles(/\.ts$/);
    expect(files).toContain('backend-panel.ts');
    expect(files).toContain('main.ts');
    for (const f of files)
      expect(read(`demo/${f}`), f).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      );
  });

  it('index.html keeps its Sprint 1 CSP byte for byte', () => {
    expect(cspOf(read('demo/index.html'))).toBe(SPRINT1_INDEX_CSP);
    // and, as a second guard, the committed Sprint 1 file's CSP when the history is available
    try {
      const prior = execFileSync('git', ['-C', repoDir, 'show', 'c2b6166:demo/index.html'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(cspOf(read('demo/index.html'))).toBe(cspOf(prior));
    } catch {
      // not a git checkout, or the Sprint 1 commit is not there: the constant above is the check
    }
  });

  it('models.html carries exactly the specified CSP: connect-src self, no https:, wasm-unsafe-eval for scripts only', () => {
    expect(cspOf(read('demo/models.html'))).toBe(MODELS_CSP);
  });

  it('models.html has no inline script or style, no external URL and loads backend-panel.ts as a module', () => {
    const html = read('demo/models.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).toContain('<script type="module" src="./backend-panel.ts"></script>');
  });

  it('index.html links to the backend page', () => {
    expect(read('demo/index.html')).toContain('href="./models.html"');
  });

  it('allowTestKeys: true appears only on the isLocal path of backend-panel.ts; the click handler hard-codes false', () => {
    const src = read('demo/backend-panel.ts');
    const trues = [...src.matchAll(/allowTestKeys:\s*true/g)];
    // the loopback hook's run() and diagnose() each build a manager for the RFC 8032 test manifest
    expect(trues.length).toBeGreaterThanOrEqual(1);
    const isLocalBlock = src.indexOf('if (isLocal) {');
    expect(isLocalBlock).toBeGreaterThan(0);
    for (const t of trues)
      expect(t.index!, 'allowTestKeys: true outside the isLocal block').toBeGreaterThan(
        isLocalBlock,
      );
    expect(src).toMatch(/allowedOrigins:\s*\[location\.origin\],\s*allowTestKeys:\s*false/);
    // the AssetManager of the click handler is created inside the handler, not at module load
    const click = src.slice(
      src.indexOf('async function onDownloadClick'),
      src.indexOf('async function onRunClick'),
    );
    expect(click).toContain('new AssetManager(');
    expect(src.slice(0, src.indexOf('async function onDownloadClick'))).not.toMatch(
      /new AssetManager\(/,
    );
  });

  it('models.html shows the done-when and model-card wording verbatim and lists every not-yet item', () => {
    const html = flat(read('demo/models.html').replace(/<[^>]+>/g, ' '));
    expect(html).toContain(
      'Same prompt answered on WebGPU and on WebAssembly with the test model SmolLM2-135M-Instruct (q4), in Chrome on an Apple-silicon Mac only. This is not the Hindi production model; Windows and the 8 GB no-GPU laptop are not measured.',
    );
    expect(html).toContain(
      'Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.',
    );
    expect(html).toContain('What this demo does not do yet');
    for (const item of [
      'Test model only',
      'not the Hindi production model'.slice(0, 0) +
        'the Hindi production model is not hosted or bundled here',
      'WebGPU is verified only on an Apple-silicon Mac',
      'WebLLM backend: Sprint 3',
      'No threads',
      'Chrome built-in model is used only if you tick the box',
      'No service worker',
      'signed by a key generated for this build only',
    ])
      expect(html, item).toContain(item);
    expect(html).toContain('Force WASM');
    expect(html).toContain('Allow Chrome built-in model');
    expect(html).toContain('Download test model and load');
  });

  it('the not-yet box of index.html no longer says there is no backend adapter and points at the backend page', () => {
    const html = flat(read('demo/index.html').replace(/<[^>]+>/g, ' '));
    expect(html).not.toContain('No backend adapter');
    expect(html).toContain('backend demo');
  });

  it('the build config has two pages and drops the stray ORT wasm Vite would emit', () => {
    const cfg = read('demo/vite.config.ts');
    expect(cfg).toContain("models: resolve(root, 'models.html')");
    expect(cfg).toContain('drop-emitted-wasm');
    // the engine's default endpoints (Hugging Face host, CDN wasm prefix, HF_TOKEN host list) are
    // rewritten in the bundle by the plugin of demo/engine-defaults.ts, registered by the config
    expect(cfg).toMatch(/plugins:\s*\[[^\]]*neutraliseEngineDefaults/);
    const plugin = read('demo/engine-defaults.ts');
    expect(plugin).toContain('neutralise-engine-defaults');
    expect(plugin).toContain('https://invalid.invalid/');
  });
});

describe('redistribution: notices, licences and provenance', () => {
  it('THIRD-PARTY-NOTICES.txt names onnxruntime-web (MIT) and every bundled library with its real licence', () => {
    const text = read('demo/THIRD-PARTY-NOTICES.txt');
    expect(text).toMatch(/onnxruntime-web 1\.31\.0-dev\.20260914-8d85527a0 \(MIT/);
    expect(text).toContain('SmolLM2-135M-Instruct');
    const lines: [string, string][] = [
      ['onnxruntime-web', 'MIT'],
      ['@huggingface/transformers', 'Apache-2.0'],
      ['@huggingface/tokenizers', 'Apache-2.0'],
      ['onnxruntime-common', 'MIT'],
      ['protobufjs', 'BSD-3-Clause'],
      ['long', 'Apache-2.0'],
      ['flatbuffers', 'Apache-2.0'],
      ['platform', 'MIT'],
      ['guid-typescript', 'ISC'],
    ];
    for (const [pkg, licence] of lines) {
      const manifest = JSON.parse(read(`node_modules/${pkg}/package.json`)) as { license: string };
      expect(manifest.license, pkg).toBe(licence);
      expect(text, pkg).toContain(pkg);
      expect(text, `${pkg} licence`).toContain(licence);
    }
    expect(
      JSON.parse(
        read('node_modules/@huggingface/transformers/node_modules/@huggingface/jinja/package.json'),
      ).license,
    ).toBe('MIT');
  });

  it('NOTICE mentions the bundled ONNX Runtime factory and its licence', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('onnxruntime-web');
    expect(notice).toContain('MIT');
    expect(notice).toContain('ort-wasm-simd-threaded.asyncify.mjs');
  });
});

describe('buildModelManifest: signs only files that equal models.json and the ORT pin', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

  function fixture(over: { configBytes?: string; ortBytes?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'build-model-manifest-'));
    dirs.push(dir);
    const config = '{"a":1}';
    const ort = 'ORT-WASM';
    mkdirSync(join(dir, 'tiny', 'onnx'), { recursive: true });
    mkdirSync(join(dir, 'ort'), { recursive: true });
    writeFileSync(join(dir, 'tiny', 'config.json'), over.configBytes ?? config);
    writeFileSync(join(dir, 'tiny', 'onnx', 'm.onnx'), 'WEIGHTS');
    writeFileSync(join(dir, 'ort', 'ort-wasm-x.wasm'), over.ortBytes ?? ort);
    const models = {
      schema: 1,
      models: {
        tiny: {
          repo: 'acme/tiny',
          revision: 'a'.repeat(40),
          licence: 'Apache-2.0',
          files: [
            { path: 'config.json', size: config.length, sha256: sha(config) },
            { path: 'onnx/m.onnx', size: 7, sha256: sha('WEIGHTS') },
          ],
        },
      },
    };
    const pins = {
      version: '1.0.0',
      wasmFile: 'ort-wasm-x.wasm',
      wasmSha256: sha(ort),
      factoryFile: 'ort-wasm-x.mjs',
      factorySha256: '0'.repeat(64),
    };
    return { dir, models, pins };
  }

  const spec = (f: ReturnType<typeof fixture>) => ({
    cacheDir: f.dir,
    modelKey: 'tiny',
    models: f.models,
    pins: f.pins,
    manifestId: 'dev.airplanemode.demo-models',
    manifestVersion: '0.1.0',
    outDir: join(f.dir, 'out'),
    descriptorEntryId: 'tiny.descriptor',
    descriptorFile: 'tiny.descriptor.json',
    descriptor: {
      id: 'tiny',
      engine: 'transformers-js',
      task: 'text-generation',
      devices: ['wasm'],
      dtype: 'q4',
      contextLength: 128,
    },
    entryIds: { 'config.json': 'tiny.config', 'onnx/m.onnx': 'tiny.onnx' },
    ortEntryId: 'ort.wasm',
    sign: () => ({
      alg: 'ed25519',
      keyId: '0'.repeat(64),
      sig: 'A'.repeat(86) + '==',
      signedAt: '2026-11-09T00:00:00Z',
    }),
  });

  it('builds a sorted manifest and a descriptor for files that match', () => {
    const f = fixture();
    const r = buildModelManifest(spec(f)) as {
      manifest: { entries: { id: string }[] };
      descriptor: { files: { path: string }[] };
    };
    expect(r.manifest.entries.map((e) => e.id)).toEqual([
      'ort.wasm',
      'tiny.config',
      'tiny.descriptor',
      'tiny.onnx',
    ]);
    expect(r.descriptor.files.map((x) => x.path)).toEqual([
      'config.json',
      'onnx/m.onnx',
      'runtime/ort-wasm-x.wasm',
    ]);
    expect(existsSync(join(f.dir, 'out', 'manifest.json'))).toBe(true);
  });

  it('fails the build when a signed file differs from models.json (same size, one byte changed)', () => {
    const f = fixture({ configBytes: '{"a":2}' });
    expect(() => buildModelManifest(spec(f))).toThrow(/differs from models\.json/);
    expect(existsSync(join(f.dir, 'out', 'manifest.json'))).toBe(false);
  });

  it('fails the build when the ORT wasm differs from ort-pins.ts', () => {
    const f = fixture({ ortBytes: 'ORT-WASX' });
    expect(() => buildModelManifest(spec(f))).toThrow(/differs from ort-pins\.ts/);
  });

  it('refuses to write outside the cache directory', () => {
    const f = fixture();
    expect(() => buildModelManifest({ ...spec(f), outDir: tmpdir() })).toThrow(
      /refusing to write outside/,
    );
    void copyFileSync;
  });
});

describe('the workflows', () => {
  const ci = () => read('.github/workflows/ci.yml');
  const pages = () => read('.github/workflows/pages.yml');
  const CACHE_PIN = 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0';

  it('every uses: is pinned to a 40-hex SHA and every checkout has persist-credentials: false', () => {
    for (const [name, text] of [
      ['ci.yml', ci()],
      ['pages.yml', pages()],
    ] as const) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${name}: ${u}`).toMatch(/@[0-9a-f]{40}$/);
      const checkouts = [
        ...text.matchAll(
          /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n(\s+with:\n(\s+[a-z-]+: [^\n]+\n)+)?/g,
        ),
      ];
      for (const c of checkouts) expect(c[0], name).toContain('persist-credentials: false');
      expect(text, name).not.toMatch(/pull_request_target/);
      expect(text, name).not.toMatch(/uses:\s*docker\//);
    }
  });

  it('the model job is separate from check (<os>), labelled not-yet-executed, and uses the pinned cache action', () => {
    const text = ci();
    expect(text).toContain('name: model-wasm (ubuntu-latest)');
    expect(text).toContain(CACHE_PIN);
    const checkJob = text.slice(text.indexOf('  check:'), text.indexOf('  model-wasm:'));
    expect(checkJob).not.toContain('test:model');
    expect(checkJob).not.toContain('fetch-model');
    expect(checkJob).not.toContain('actions/cache');
    const modelJob = text.slice(text.indexOf('  model-wasm:'));
    expect(modelJob).toContain("hashFiles('test/tools/models.json')");
    expect(modelJob).toContain('node test/tools/fetch-model.mjs smollm2-135m-instruct');
    expect(modelJob).toContain('RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model');
    expect(modelJob).toContain('runs-on: ubuntu-latest');
    expect(text).toContain('configured, not yet executed');
  });

  it('pages.yml restores the cache, fetches (re-hashing) and builds with DEMO_MODELS=1', () => {
    const text = pages();
    expect(text).toContain(CACHE_PIN);
    expect(text.indexOf('actions/cache@')).toBeLessThan(
      text.indexOf('run: node test/tools/fetch-model.mjs'),
    );
    expect(text.indexOf('run: node test/tools/fetch-model.mjs')).toBeLessThan(
      text.indexOf('run: DEMO_MODELS=1 npm run demo:build'),
    );
  });
});
