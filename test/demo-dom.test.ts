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
import { ORT_FACTORY_SHA256, ORT_WASM_SHA256, ORT_WEB_VERSION } from '../src/backends/ort-pins';

const read = (rel: string) => readFileSync(resolve(repoDir, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const demoFiles = (ext: RegExp) => readdirSync(resolve(repoDir, 'demo')).filter((f) => ext.test(f));

/** The Content-Security-Policy of demo/index.html as shipped in Sprint 1. */
const SPRINT1_INDEX_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
/** Sprint 5 (TD-47, S1-039 re-opened and closed): the only change is connect-src 'self' without https:. */
const INDEX_CSP = SPRINT1_INDEX_CSP.replace("connect-src 'self' https:", "connect-src 'self'");
const MODELS_CSP =
  // Sprint 3: the engine runs in a module worker started from a blob: bootstrap (worker-src gains blob:),
  // and Trusted Types are required for scripts with exactly one policy, airplanemode-worker (D1-09)
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types airplanemode-worker";

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

  it("index.html carries the Sprint 1 CSP with one change: connect-src 'self', no https: (TD-47)", () => {
    expect(cspOf(read('demo/index.html'))).toBe(INDEX_CSP);
    expect(INDEX_CSP).toContain("connect-src 'self';");
    expect(INDEX_CSP).not.toContain('https:');
    // and, as a second guard, the committed Sprint 1 file's CSP when the history is available
    try {
      const prior = execFileSync('git', ['-C', repoDir, 'show', 'c2b6166:demo/index.html'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(cspOf(prior)).toBe(SPRINT1_INDEX_CSP);
    } catch {
      // not a git checkout, or the Sprint 1 commit is not there: the constant above is the check
    }
  });

  it('models.html carries exactly the specified CSP: connect-src self, no https:, wasm-unsafe-eval for scripts only', () => {
    expect(cspOf(read('demo/models.html'))).toBe(MODELS_CSP);
  });

  it('models.html requires Trusted Types for scripts with exactly one named policy, no allow-duplicates and no default policy (D1-09)', () => {
    const csp = cspOf(read('demo/models.html'));
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp.match(/trusted-types ([^;]*)/)![1]).toBe('airplanemode-worker');
    expect(csp).not.toContain('allow-duplicates');
    expect(csp).not.toMatch(/trusted-types[^;]*\bdefault\b/);
    // no script sink in the page code: no eval, Function, setTimeout(string), createElement('script')
    const panel = read('demo/backend-panel.ts');
    expect(panel).not.toMatch(
      /\beval\s*\(|new Function|createElement\(['"]script['"]\)|\.srcdoc|document\.write/,
    );
    // the one policy lives in the library, created once per page
    expect(read('src/backends/worker-bootstrap.ts')).toContain(
      "export const WORKER_POLICY_NAME = 'airplanemode-worker'",
    );
    expect(read('src/backends/worker-bootstrap.ts').match(/\btt\.createPolicy\(/g)).toHaveLength(1);
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
      'neither the pilot model (Qwen3-1.7B, whose graph alone is over the 1 GB Pages limit) nor any Hindi model is hosted here',
      'Not measured on 8 GB',
      'WebGPU is verified only on an Apple-silicon Mac',
      // Sprint 3: D1-05 (WebLLM) did not land, so the box says so instead of claiming it
      'WebLLM rung: not yet',
      'Memory figures are shown only where Chrome exposes them',
      'No threads',
      'Chrome built-in model is used only if you tick the box',
      'No service worker',
      'signed by a key generated for this build only',
    ])
      expect(html, item).toContain(item);
    expect(html).toContain('Transformers.js WebAssembly');
    expect(html).toContain('Allow Chrome built-in model');
    expect(html).toContain('Download test model and load');
    // D1-04 proved the worker host: the two Sprint 2 limitations are gone from the box
    const box = html.slice(html.indexOf('What this demo does not do yet'));
    expect(box).not.toMatch(/freezes while WebAssembly generates/);
    expect(box).not.toMatch(/reload the page and tick/i);
    expect(box).not.toContain('WebLLM backend: Sprint 3');
    // conditional claims: nothing about WebLLM as a working rung
    expect(html).not.toContain('WebLLM (WebGPU)');
  });

  it('models.html has the engine picker with only the choices that landed, the worker line and the load timing and memory read-out (D1-11)', () => {
    const raw = read('demo/models.html');
    const select = /<select id="sel-engine"[^>]*>([\s\S]*?)<\/select>/.exec(raw);
    expect(select, 'the engine picker').not.toBeNull();
    const options = [...select![1]!.matchAll(/<option value="([a-z]+)">([^<]*)<\/option>/g)].map(
      (m) => m[1],
    );
    expect(options).toEqual(['auto', 'webgpu', 'wasm']);
    expect(select![1]).not.toMatch(/webllm/i);
    expect(raw).toMatch(/id="worker-line"[^>]*class="[^"]*hidden/);
    expect(raw).toContain('id="readout"');
    expect(flat(raw.replace(/<[^>]+>/g, ' '))).toContain('Load timing and memory');
    expect(raw).toContain('devtools/README.md');
    const panel = read('demo/backend-panel.ts');
    expect(panel).toContain("from '../devtools/src/render.ts'");
    expect(panel).toContain('exposeDevtoolsHook');
    expect(panel).toContain("'sel-engine'");
    expect(panel).toContain('backend.worker');
  });

  it('the picker choices map to the chain: auto starts at WebGPU, webgpu offers only the WebGPU adapter, wasm forces the wasm rung', () => {
    const panel = read('demo/backend-panel.ts');
    expect(panel).toMatch(/forceRung: 'wasm'/);
    expect(panel).toMatch(/engine === 'webgpu'/);
  });

  it('the not-yet box of index.html no longer says there is no backend adapter and points at the backend page', () => {
    const html = flat(read('demo/index.html').replace(/<[^>]+>/g, ' '));
    expect(html).not.toContain('No backend adapter');
    expect(html).toContain('backend demo');
  });

  it('D1-FIX1-02: both pages take the whole build label (convention form) from the build, not a hard-coded "main"', () => {
    for (const page of ['demo/index.html', 'demo/models.html']) {
      const html = read(page);
      expect(html, page).toMatch(/<code id="build-id">\?<\/code>/);
      expect(html, page).not.toMatch(/Built from\s*<code>main<\/code>/);
    }
    for (const ts of ['demo/main.ts', 'demo/backend-panel.ts']) {
      expect(read(ts), ts).toContain("$('build-id').textContent = __DEMO_BUILD__");
    }
    const cfg = read('demo/vite.config.ts');
    expect(cfg).toMatch(/__DEMO_BUILD__: JSON\.stringify\(build\)/);
    expect(cfg).toMatch(/buildLabel\(/);
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

describe('the Tamper lab (D1-03): markup and isolation', () => {
  const CASE_IDS = [
    'tamper-01',
    'tamper-02',
    'tamper-03',
    'tamper-04',
    'tamper-05',
    'tamper-06',
    'tamper-07',
    'tamper-08',
    'tamper-10',
    'tamper-15',
    'asset-flip',
    'asset-truncated',
    'valid',
    'other-product',
    'weak-key',
  ];

  it('index.html has the lab section with one run button per case, in order, and the demo-only label', () => {
    const html = read('demo/index.html');
    const section = html.slice(html.indexOf('id="tamper-lab"'));
    expect(html).toContain('id="tamper-lab"');
    const ids = [...section.matchAll(/data-case="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect([...new Set(ids)]).toEqual(CASE_IDS);
    for (const id of CASE_IDS) {
      expect(section, id).toMatch(
        new RegExp(`data-case="${id}"[\\s\\S]*?<button[^>]*data-action="run"`),
      );
    }
    expect(flat(html.replace(/<[^>]+>/g, ' '))).toContain(
      'RFC 8032 public test keys: demo only; allowTestKeys is false by default in the library',
    );
    expect(html).not.toContain('btn-tamper');
    expect(read('demo/main.ts')).not.toMatch(/btn-tamper/);
  });

  it('main.ts loads the lab module; the lab has its own trust set, its own memory state store and fresh memory stores', () => {
    expect(read('demo/main.ts')).toMatch(/from '\.\/tamper-lab\.ts'/);
    const lab = read('demo/tamper-lab.ts');
    expect(lab).toContain('InMemoryManifestState');
    expect(lab).toContain("store: 'memory'");
    expect(lab).toContain('RFC8032_TEST_PUBLIC_KEYS_HEX');
    expect(lab).toContain('PerformanceObserver');
    expect(lab).toContain('Requests after refusal:');
    // never the page's own trust set, pasted roots, persistent stores or downgrade state
    expect(lab).not.toMatch(
      /OpfsAssetStore|IndexedDbAssetStore|store:\s*'opfs'|store:\s*'indexeddb'/,
    );
    expect(lab).not.toMatch(/trustSet\(|parseTrustRoots|taRoots|trustRoot\b/);
    // allowTestKeys is a literal true in the lab only, set by code, never by input
    expect((lab.match(/allowTestKeys:\s*true/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(lab).not.toMatch(/allowTestKeys:\s*(?!true\b)[^,}\s]/);
  });

  it('allowTestKeys is not driven by the URL, storage or any input anywhere in the demo', () => {
    for (const f of demoFiles(/\.ts$/)) {
      const src = read(`demo/${f}`);
      for (const m of src.matchAll(/allowTestKeys[^\n]*/g)) {
        const line = m[0];
        expect(line, `${f}: ${line}`).not.toMatch(
          /params\.get|location\.search|localStorage|sessionStorage/,
        );
      }
    }
    const main = read('demo/main.ts');
    expect(main).not.toMatch(/allowTestKeys:\s*true/);
  });

  it('the not-yet box says WebLLM was cut and names the other open items, without the items Sprint 5 landed', () => {
    const idx = flat(read('demo/index.html').replace(/<[^>]+>/g, ' '));
    const box = idx.slice(idx.indexOf('What this demo does not do yet'));
    for (const item of [
      'WebLLM (cut; revisit after the 8 GB measurement)',
      'Windows and 8 GB no-GPU measurements (not measured on 8 GB)',
      'revocation of a signing key',
      'a real signing key',
      "connect-src 'self'",
    ])
      expect(box, item).toContain(item);
    // landed in Sprint 5: embeddings through the worker host and the expected-id check
    expect(box).not.toContain('embeddings through the worker host');
    expect(box).not.toContain('an expected-id check');
    const models = flat(read('demo/models.html').replace(/<[^>]+>/g, ' '));
    expect(models).toContain('WebLLM rung: not yet (cut from Sprint 4');
  });

  it('the page shows its status line, equal to site/data/demos.json when the workspace has it', () => {
    const html = read('demo/index.html');
    const m = /<p id="status-line"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    expect(m, 'a status line').not.toBeNull();
    const line = flat(m![1]!.replace(/<[^>]+>/g, ' '));
    expect(line.startsWith('Sprint 6 (19 Nov 2026): Working:')).toBe(true);
    expect(line).toContain('runtime beta 0.3.0-beta.1');
    expect(line).toContain('not measured on 8 GB');
    expect(line).toContain('Not yet:');
    const demos = resolve(repoDir, '../site/data/demos.json');
    if (!existsSync(demos)) return; // a standalone clone has no site folder
    const entry = (
      JSON.parse(readFileSync(demos, 'utf8')) as { repo: string; status: string }[]
    ).find((d) => d.repo === 'runtime');
    // until D5 copies this lane's status-line.txt into site/data/demos.json the file carries the Sprint 5 line
    if (entry?.status.startsWith('Sprint 6')) expect(line).toBe(flat(entry.status));
  });
});

describe('redistribution: notices, licences and provenance', () => {
  it('THIRD-PARTY-NOTICES.txt names onnxruntime-web (MIT) and every bundled library with its real licence', () => {
    const text = read('demo/THIRD-PARTY-NOTICES.txt');
    expect(text).toMatch(/onnxruntime-web 1\.31\.1 \(MIT/);
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

  it('THIRD-PARTY-NOTICES.txt quotes exactly the ort-pins.ts digests for the pinned onnxruntime-web (S1-083)', () => {
    const text = read('demo/THIRD-PARTY-NOTICES.txt');
    expect(text).toContain(`onnxruntime-web ${ORT_WEB_VERSION} (MIT`);
    const digests = [...text.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]);
    // the two onnxruntime-web digests come first; any later digest belongs to another component
    expect(digests.slice(0, 2)).toEqual([ORT_FACTORY_SHA256, ORT_WASM_SHA256]);
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

  it('the model job is separate from check (<os>), records its first GitHub run, and uses the pinned cache action', () => {
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
    expect(text).toContain('First ran on GitHub on 9 Nov 2026');
    expect(text).not.toContain('configured, not yet executed');
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

describe('the status line of both runtime demo pages (D1-10)', () => {
  const lineOf = (file: string, id: string): string => {
    const m = new RegExp(`<p id="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(read(file));
    expect(m, `${file} #${id}`).not.toBeNull();
    return flat(m![1]!.replace(/<[^>]+>/g, ' '));
  };
  it('index.html #status-line and models.html #sprint-status carry the same Sprint 6 line, rendered as text', () => {
    const a = lineOf('demo/index.html', 'status-line');
    const b = lineOf('demo/models.html', 'sprint-status');
    expect(a).toBe(b);
    expect(a.startsWith('Sprint 6 (19 Nov 2026): Working:')).toBe(true);
    expect(a).toContain('Not yet:');
    expect(a).toContain('not measured on 8 GB');
    expect(a).not.toMatch(/free RAM/i);
    expect(a).toContain('weak_key_refused');
    expect(a).toContain('Tamper lab now has fifteen cases');
    for (const item of [
      'WebLLM (cut)',
      'key revocation',
      'a real signing key',
      'a transparency log',
    ])
      expect(a, item).toContain(item);
    expect(read('demo/models.html')).toMatch(/id="sprint-status"/);
  });
});
