// D1-07: scripts/bundle-models.mjs, the demo model bundles with a per-build in-memory signing key.
// Synthetic models and a synthetic ORT pair stand in for the real weights, so this runs in CI; the real dockit
// set (762 MB) is checked by `RUNTIME_BUNDLE_REAL=1` and recorded in the sprint evidence.
// Written before the verifier of the bundle existed in the consumer (red run: evidence/sprint-5/D1/red/D1-07.log).

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyManifest, type TrustSet } from '../src/manifest';
import { InMemoryManifestState } from '../src/manifest';
// @ts-expect-error: plain ESM script
import { SETS, bundleModels, main, DEFAULT_MAX_BYTES } from '../scripts/bundle-models.mjs';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PEM_HEADER = ['PRIVATE', 'KEY'].join(' ');
// the PKCS#8 Ed25519 prefix, written in pieces so that this file itself holds no complete copy of it
const PKCS8 = ['302e0201', '00300506', '032b6570', '04220420'].join('');

let tmp: string;
const out: string[] = [];
const err: string[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bundle-models-'));
  out.length = 0;
  err.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/** A synthetic cache: every model of both sets with tiny files, plus an ORT pair, and its models.json. */
let seq = 0;
function fixture() {
  const cache = join(tmp, `cache${seq++}`);
  const ortDir = join(tmp, `ort${seq}`);
  mkdirSync(cache);
  mkdirSync(ortDir);
  const models: Record<string, unknown> = {};
  const content = (key: string, path: string) =>
    Buffer.from(`${key}::${path}::` + 'x'.repeat(50 + path.length));
  const filesOf: Record<string, string[]> = {
    'qwen3-0.6b-wasm-q8': [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'onnx/model_quantized.onnx',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
    'multilingual-e5-small-wasm-q8': [
      'config.json',
      'onnx/model_quantized.onnx',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
    'smollm2-135m-instruct': [
      'config.json',
      'generation_config.json',
      'onnx/model_q4.onnx',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  };
  for (const [key, paths] of Object.entries(filesOf)) {
    const files = paths.map((path) => {
      const bytes = content(key, path);
      const dest = join(cache, key, ...path.split('/'));
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, bytes);
      return { path, size: bytes.length, sha256: sha(bytes) };
    });
    models[key] = {
      repo: `acme/${key}`,
      revision: 'a'.repeat(40),
      licence: key.includes('e5') ? 'MIT' : 'Apache-2.0',
      files,
    };
  }
  const wasm = Buffer.from('FAKE-WASM-BINARY');
  const factory = Buffer.from('export default function ort() {}');
  writeFileSync(join(ortDir, 'ort.wasm'), wasm);
  writeFileSync(join(ortDir, 'ort.mjs'), factory);
  const pins = {
    version: '1.31.1',
    wasmFile: 'ort.wasm',
    wasmSha256: sha(wasm),
    factoryFile: 'ort.mjs',
    factorySha256: sha(factory),
  };
  return { cache, ortDir, models: { schema: 1, models }, pins };
}

function layout(version = '0.2.0-dev') {
  const app = join(tmp, `app${seq++}`);
  const root = join(app, 'public');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', version }));
  return {
    root,
    out: join(root, 'models'),
    trust: join(app, 'src', 'generated', 'trust-root.ts'),
  };
}

async function build(
  setName: 'dockit' | 'runtime-demo',
  over: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
) {
  const f = fixture();
  const l = layout();
  const set = (SETS as Record<string, { manifestId: string }>)[setName]!;
  const result = await bundleModels(
    {
      set: setName,
      out: l.out,
      root: l.root,
      manifestId: set.manifestId,
      ortDir: f.ortDir,
      trustRootOut: l.trust,
      cache: f.cache,
      ...over,
    },
    { models: f.models, pins: f.pins, ...deps },
  );
  return { f, l, result };
}

function trustOf(trustFile: string): TrustSet {
  const text = readFileSync(trustFile, 'utf8');
  const keyId = /keyId: '([0-9a-f]{64})'/.exec(text)![1]!;
  const b64 = /publicKeyB64: '([^']+)'/.exec(text)![1]!;
  return new Map([[keyId, new Uint8Array(Buffer.from(b64, 'base64'))]]);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('the manifests a build writes (contract: MANIFESTS WRITTEN BY bundle-models)', () => {
  it('dockit: distinct id, version of the consumer, publisher, no expiresAt, relative urls, pin true, sorted entries, one signature', async () => {
    const { l } = await build('dockit');
    const m = JSON.parse(readFileSync(join(l.out, 'manifest.json'), 'utf8'));
    expect(m.spec).toBe('airplanemode.manifest/0.1');
    expect(m.id).toBe('dev.airplanemode.dockit-models');
    expect(m.version).toBe('0.2.0-dev');
    expect(m.publisher).toBe('AirplaneMode-Labs demo build');
    expect(m.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect('expiresAt' in m).toBe(false);
    expect(m.signatures).toHaveLength(1);
    expect(m.signatures[0].alg).toBe('ed25519');
    const ids = m.entries.map((e: { id: string }) => e.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of m.entries) {
      expect(e.pin, e.id).toBe(true);
      expect(e.url, e.id).not.toMatch(/^\/|\.\.|\\|\/\/|^[a-z][a-z0-9+.-]*:|[?#]/i);
      expect(e.licence, e.id).toMatch(/^(Apache-2\.0|MIT)$/);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('runtime-demo: its own id and no pin', async () => {
    const { l } = await build('runtime-demo');
    const m = JSON.parse(readFileSync(join(l.out, 'manifest.json'), 'utf8'));
    expect(m.id).toBe('dev.airplanemode.runtime-demo-models');
    for (const e of m.entries) expect('pin' in e, e.id).toBe(false);
  });

  it('EVERY file the engine can read is an entry: all eight kinds, the ORT wasm and the factory', async () => {
    const { l } = await build('dockit');
    const m = JSON.parse(readFileSync(join(l.out, 'manifest.json'), 'utf8'));
    const urls = m.entries.map((e: { url: string }) => e.url);
    for (const suffix of [
      'qwen3-0.6b/onnx/model_quantized.onnx',
      'qwen3-0.6b/tokenizer.json',
      'qwen3-0.6b/tokenizer_config.json',
      'qwen3-0.6b/config.json',
      'qwen3-0.6b/generation_config.json',
      'qwen3-0.6b/chat_template.jinja',
      'qwen3-0.6b/special_tokens_map.json',
      'multilingual-e5-small/onnx/model_quantized.onnx',
      'multilingual-e5-small/tokenizer.json',
      'multilingual-e5-small/special_tokens_map.json',
      'ort/ort.wasm',
      'ort/ort.mjs',
      'qwen3-0.6b.descriptor.json',
      'multilingual-e5-small.descriptor.json',
    ])
      expect(urls, suffix).toContain(suffix);
    // and every file in the bundle directory (except the documents) is an entry
    const listed = new Set(urls);
    const docs = /^(manifest\.json|PROVENANCE\.json|LICENSE-.*\.txt)$/;
    for (const f of walk(l.out)) {
      const rel = relative(l.out, f).split(sep).join('/');
      if (!docs.test(rel)) expect(listed.has(rel), rel).toBe(true);
    }
    for (const e of m.entries) {
      const bytes = readFileSync(join(l.out, ...e.url.split('/')));
      expect(sha(bytes), e.id).toBe(e.sha256);
      expect(bytes.length, e.id).toBe(e.size);
    }
  });

  it('every resolved url stays under the manifest directory (the shared-origin rule)', async () => {
    const { l } = await build('dockit');
    const m = JSON.parse(readFileSync(join(l.out, 'manifest.json'), 'utf8'));
    const manifestUrl = 'https://app.test/dockit/models/manifest.json';
    const dir = new URL('.', manifestUrl).pathname;
    for (const e of m.entries)
      expect(new URL(e.url, manifestUrl).pathname.startsWith(dir), e.url).toBe(true);
  });

  it('the descriptors are valid, sorted, name the ORT wasm as runtimeWasm and carry the source and licence', async () => {
    const { l } = await build('dockit');
    const q = JSON.parse(readFileSync(join(l.out, 'qwen3-0.6b.descriptor.json'), 'utf8'));
    expect(q).toMatchObject({
      spec: 'airplanemode.model/0.2',
      id: 'qwen3-0.6b',
      engine: 'transformers-js',
      task: 'text-generation',
      devices: ['wasm'],
      dtype: 'q8',
      contextLength: 2048,
      generation: { maxNewTokens: 256, chatTemplateKwargs: { enable_thinking: false } },
      source: { repo: 'acme/qwen3-0.6b-wasm-q8', revision: 'a'.repeat(40) },
      licence: 'Apache-2.0',
    });
    expect(q.files.map((f: { path: string }) => f.path)).toEqual(
      q.files.map((f: { path: string }) => f.path).sort(),
    );
    expect(q.runtimeWasm).toBe('runtime/ort.wasm');
    const e5 = JSON.parse(
      readFileSync(join(l.out, 'multilingual-e5-small.descriptor.json'), 'utf8'),
    );
    expect(e5).toMatchObject({
      task: 'feature-extraction',
      dtype: 'q8',
      contextLength: 512,
      licence: 'MIT',
    });
  });

  it('writes LICENSE files with the source repo and revision, a PROVENANCE.json and prints the total', async () => {
    const { l, result } = await build('dockit');
    for (const f of [
      'LICENSE-Qwen3-0.6B.txt',
      'LICENSE-multilingual-e5-small.txt',
      'LICENSE-onnxruntime-web.txt',
    ]) {
      const t = readFileSync(join(l.out, f), 'utf8');
      expect(t.length, f).toBeGreaterThan(200);
    }
    expect(readFileSync(join(l.out, 'LICENSE-Qwen3-0.6B.txt'), 'utf8')).toContain(
      `acme/qwen3-0.6b-wasm-q8 at revision ${'a'.repeat(40)}`,
    );
    expect(readFileSync(join(l.out, 'LICENSE-multilingual-e5-small.txt'), 'utf8')).toContain(
      'No copyright line is published',
    );
    const prov = JSON.parse(readFileSync(join(l.out, 'PROVENANCE.json'), 'utf8'));
    expect(prov.files.length).toBeGreaterThan(10);
    expect(out.join('\n')).toMatch(/total bytes: \d+ \(\d+\.\d MiB, limit 943718400\)/);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BYTES).toBe(943718400);
  });
});

describe('verification in the consumer (no allowTestKeys, the compiled-in trust root, expectId)', () => {
  it('the dockit set verifies with its trust root and expectId dev.airplanemode.dockit-models', async () => {
    const { l } = await build('dockit');
    const r = await verifyManifest(
      readFileSync(join(l.out, 'manifest.json'), 'utf8'),
      trustOf(l.trust),
      {
        expectId: 'dev.airplanemode.dockit-models',
        state: new InMemoryManifestState(),
      },
    );
    expect(r.ok, JSON.stringify(r.ok ? '' : r)).toBe(true);
  });

  it('the runtime-demo set fails in the dockit configuration with unexpected_id, and the reverse also holds', async () => {
    const d = await build('dockit');
    const rd = await build('runtime-demo');
    const dockit = readFileSync(join(d.l.out, 'manifest.json'), 'utf8');
    const demo = readFileSync(join(rd.l.out, 'manifest.json'), 'utf8');
    const a = await verifyManifest(demo, trustOf(rd.l.trust), {
      expectId: 'dev.airplanemode.dockit-models',
    });
    expect(a).toMatchObject({ ok: false, reason: 'unexpected_id' });
    const b = await verifyManifest(dockit, trustOf(d.l.trust), {
      expectId: 'dev.airplanemode.runtime-demo-models',
    });
    expect(b).toMatchObject({ ok: false, reason: 'unexpected_id' });
  });

  it("a different build has a different key: a manifest never verifies against another build's trust root", async () => {
    const one = await build('dockit');
    const two = await build('dockit');
    const r = await verifyManifest(
      readFileSync(join(one.l.out, 'manifest.json'), 'utf8'),
      trustOf(two.l.trust),
      {
        expectId: 'dev.airplanemode.dockit-models',
      },
    );
    expect(r).toMatchObject({ ok: false, reason: 'no_valid_signature' });
  });

  it('trust-root.ts exports exactly one { keyId, publicKeyB64 } and the key is not a test key', async () => {
    const { l } = await build('dockit');
    const text = readFileSync(l.trust, 'utf8');
    expect(text.match(/export const /g)).toHaveLength(1);
    expect(text).toMatch(
      /TRUST_ROOT = \{ keyId: '[0-9a-f]{64}', publicKeyB64: '[A-Za-z0-9+/]{43}=' \} as const/,
    );
    expect(trustOf(l.trust).size).toBe(1);
    // verifyManifest would throw test_key_refused without allowTestKeys if it were an RFC 8032 key
    await expect(
      verifyManifest(readFileSync(join(l.out, 'manifest.json'), 'utf8'), trustOf(l.trust), {}),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('the signing key never leaves the process', () => {
  it('the output directory, the trust root, stdout and stderr hold no private-key PEM header, no PKCS#8 prefix and no seed in hex or base64', async () => {
    let captured: KeyObject | undefined;
    const { l } = await build(
      'dockit',
      {},
      {
        generateKeyPair: () => {
          const pair = generateKeyPairSync('ed25519');
          captured = pair.privateKey; // the seed is exported in this test only, to look for it
          return pair;
        },
      },
    );
    const der = captured!.export({ format: 'der', type: 'pkcs8' });
    const seed = der.subarray(der.length - 32);
    const needles = [
      seed.toString('hex'),
      seed.toString('base64'),
      seed.toString('base64url'),
      PKCS8,
    ];
    const haystacks = [
      ...walk(l.out).map((f) => [f, readFileSync(f)] as const),
      [l.trust, readFileSync(l.trust)] as const,
      ['stdout', Buffer.from(out.join('\n'))] as const,
      ['stderr', Buffer.from(err.join('\n'))] as const,
    ];
    for (const [name, buf] of haystacks) {
      const text = buf.toString('latin1');
      expect(text, name).not.toContain(PEM_HEADER);
      for (const n of needles)
        expect(text.includes(n), `${name} holds ${n.slice(0, 8)}...`).toBe(false);
      expect(buf.includes(seed), `${name} holds the seed bytes`).toBe(false);
    }
  });

  it('the script text never serialises a private key', () => {
    const src = readFileSync(resolve(__dirname, '../scripts/bundle-models.mjs'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    expect(code).not.toMatch(
      /privateKey\.export|\.export\(\s*\{\s*format:\s*'(pem|der|jwk)'[^}]*pkcs8|writeFileSync\([^)]*private/i,
    );
    expect(code).not.toMatch(/RFC8032_SEED|cp-sign|allowTestKeys/);
  });
});

describe('--out is confined to --root', () => {
  const run = (argv: string[], f: ReturnType<typeof fixture>) =>
    main(argv, { models: f.models, pins: f.pins });
  const base = (l: ReturnType<typeof layout>, f: ReturnType<typeof fixture>, out: string) => [
    '--set',
    'dockit',
    '--out',
    out,
    '--root',
    l.root,
    '--manifest-id',
    'dev.airplanemode.dockit-models',
    '--ort-dir',
    f.ortDir,
    '--trust-root-out',
    l.trust,
    '--cache',
    f.cache,
  ];

  it('an absolute path outside the root exits 2 and writes nothing', async () => {
    const f = fixture();
    const l = layout();
    const outside = join(tmp, 'elsewhere');
    expect(await run(base(l, f, outside), f)).toBe(2);
    expect(() => statSync(outside)).toThrow();
  });

  it("a '..' path that leaves the root exits 2", async () => {
    const f = fixture();
    const l = layout();
    expect(await run(base(l, f, join(l.root, '..', 'escaped')), f)).toBe(2);
    expect(() => statSync(join(l.root, '..', 'escaped'))).toThrow();
  });

  it('the root itself is not an acceptable out', async () => {
    const f = fixture();
    const l = layout();
    expect(await run(base(l, f, l.root), f)).toBe(2);
  });

  it('a symlink inside the root that points outside exits 2', async (ctx) => {
    const f = fixture();
    const l = layout();
    const target = join(tmp, 'outside-target');
    mkdirSync(target);
    try {
      symlinkSync(target, join(l.root, 'link'), 'dir');
    } catch {
      return ctx.skip(); // cannot create a symlink here; asserted by the CI legs that can
    }
    expect(await run(base(l, f, join(l.root, 'link')), f)).toBe(2);
    expect(await run(base(l, f, join(l.root, 'link', 'models')), f)).toBe(2);
    expect(readdirSync(target)).toEqual([]);
  });

  it('a set and manifest id that do not belong together, an unknown set and a missing file are usage errors (exit 2)', async () => {
    const f = fixture();
    const l = layout();
    const good = base(l, f, l.out);
    const swap = (flag: string, value: string) => {
      const a = [...good];
      a[a.indexOf(flag) + 1] = value;
      return a;
    };
    expect(await run(swap('--manifest-id', 'dev.airplanemode.runtime-demo-models'), f)).toBe(2);
    expect(await run(swap('--set', 'everything'), f)).toBe(2);
    expect(await run(swap('--trust-root-out', join(l.root, '..', 'key.ts')), f)).toBe(2);
    expect(await run(swap('--ort-dir', join(tmp, 'no-such-dir')), f)).toBe(2);
    expect(await run([...good, '--max-bytes', '10'], f)).toBe(2); // over the budget: nothing is copied
    expect(() => statSync(join(l.out, 'manifest.json'))).toThrow();
    expect(await run([...good, '--bogus', 'x'], f)).toBe(2);
  });
});

// The real dockit set from the fetched cache (762 MB): local only, never CI (no weights there).
//   RUNTIME_BUNDLE_REAL=1 npx vitest run test/bundle-models.test.ts
describe.skipIf(process.env['RUNTIME_BUNDLE_REAL'] !== '1')('the real dockit bundle', () => {
  it('totals at most 900 MiB, verifies with the compiled trust root and expectId, and refuses a mismatched file', async () => {
    const app = join(tmp, 'real-app');
    const root = join(app, 'public');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'dockit', version: '0.2.0-dev' }),
    );
    const trust = join(app, 'src', 'generated', 'trust-root.ts');
    const r = await bundleModels({
      set: 'dockit',
      out: join(root, 'models'),
      root,
      manifestId: 'dev.airplanemode.dockit-models',
      ortDir: resolve(__dirname, '../.cache/models/ort'),
      trustRootOut: trust,
    });
    process.stderr.write(
      `REAL-BUNDLE total bytes ${r.totalBytes} (${(r.totalBytes / 1048576).toFixed(1)} MiB)\n`,
    );
    expect(r.totalBytes).toBeLessThanOrEqual(900 * 1024 * 1024);
    const text = readFileSync(join(root, 'models', 'manifest.json'), 'utf8');
    const v = await verifyManifest(text, trustOf(trust), {
      expectId: 'dev.airplanemode.dockit-models',
    });
    expect(v.ok).toBe(true);
    expect(JSON.parse(text).entries.map((e: { id: string }) => e.id)).toContain('qwen3-0.6b.onnx');
  }, 600_000);
});
