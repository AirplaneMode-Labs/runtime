import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FetchModelError,
  copyOrtFiles,
  fetchModel,
  gitBlobSha1,
  validateModelPath,
  type ModelsJson,
} from './tools/fetch-model.mjs';
import { repoDir } from './helpers';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

const CONFIG = enc('{"hidden_size": 4}\n');
const WEIGHTS = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) & 0xff);
const REVISION = 'a'.repeat(40);

interface Served {
  url: string;
  headers: Record<string, string>;
}

/** A fake Hugging Face: serves bytes by URL, records every request. */
function fakeHub(files: Record<string, Uint8Array>) {
  const requests: Served[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    requests.push({ url, headers });
    const body = files[url];
    if (!body) return new Response('not found', { status: 404 });
    // stream in 4 KiB pieces
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (off >= body.length) return ctrl.close();
        ctrl.enqueue(body.subarray(off, off + 4096));
        off += 4096;
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { impl, requests };
}

const url = (path: string) => `https://huggingface.co/acme/tiny/resolve/${REVISION}/${path}`;

function modelsJson(over: Partial<ModelsJson['models'][string]> = {}): ModelsJson {
  return {
    schema: 1,
    models: {
      tiny: {
        repo: 'acme/tiny',
        revision: REVISION,
        licence: 'Apache-2.0',
        files: [
          {
            path: 'config.json',
            size: CONFIG.length,
            gitBlobSha1: gitBlobSha1(CONFIG),
            sha256: sha256(CONFIG),
          },
          { path: 'onnx/model.onnx', size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
        ],
        ...over,
      },
    },
  };
}

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fetch-model-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const hubFiles = () => ({ [url('config.json')]: CONFIG, [url('onnx/model.onnx')]: WEIGHTS });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FetchModelError);
    return (e as FetchModelError).code;
  }
  throw new Error('expected FetchModelError');
}

describe('fetch-model: happy path and caching', () => {
  it('downloads every file once, verifies size, sha256 and git blob, writes under dest/<name>/<path>', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    const r = await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    expect(r.files.map((f) => f.status)).toEqual(['downloaded', 'downloaded']);
    expect(readFileSync(join(dest, 'tiny/onnx/model.onnx')).equals(Buffer.from(WEIGHTS))).toBe(
      true,
    );
    expect(readFileSync(join(dest, 'tiny/config.json')).equals(Buffer.from(CONFIG))).toBe(true);
    // no .part left over
    expect(readdirSync(join(dest, 'tiny/onnx'))).toEqual(['model.onnx']);
  });

  it('sends no Authorization header, only https, and never reads HF_TOKEN', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    const prev = process.env['HF_TOKEN'];
    process.env['HF_TOKEN'] = 'hf_SENTINEL_TOKEN_must_never_be_sent';
    try {
      await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    } finally {
      if (prev === undefined) delete process.env['HF_TOKEN'];
      else process.env['HF_TOKEN'] = prev;
    }
    expect(hub.requests).toHaveLength(2);
    for (const r of hub.requests) {
      expect(r.url.startsWith('https://')).toBe(true);
      expect(JSON.stringify(r.headers).toLowerCase()).not.toContain('authorization');
      expect(JSON.stringify(r.headers)).not.toContain('SENTINEL');
    }
    expect(readFileSync(resolve(repoDir, 'test/tools/fetch-model.mjs'), 'utf8')).not.toMatch(
      /process\.env\.HF_TOKEN|env\[['"]HF_TOKEN/,
    );
  });

  it('a second run re-hashes every file and downloads nothing', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    const r = await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    expect(r.files.map((f) => f.status)).toEqual(['cached', 'cached']);
    expect(hub.requests).toHaveLength(2);
  });

  it('one changed byte in a cached file (same size, same mtime) triggers a re-download of that file only', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    const target = join(dest, 'tiny/onnx/model.onnx');
    const before = statSync(target);
    const bytes = readFileSync(target);
    bytes[1234] = bytes[1234]! ^ 0xff;
    writeFileSync(target, bytes);
    expect(statSync(target).size).toBe(before.size);
    const r = await fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl });
    expect(r.files.map((f) => `${f.path}:${f.status}`)).toEqual([
      'config.json:cached',
      'onnx/model.onnx:downloaded',
    ]);
    expect(hub.requests).toHaveLength(3);
    expect(readFileSync(target).equals(Buffer.from(WEIGHTS))).toBe(true);
  });
});

describe('fetch-model: refusals (nothing is renamed into place on failure)', () => {
  it('size mismatch (server sends fewer bytes) is refused and leaves no file and no .part', async () => {
    const dest = temp();
    const hub = fakeHub({ ...hubFiles(), [url('onnx/model.onnx')]: WEIGHTS.subarray(0, 1000) });
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('size_mismatch');
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx'))).toBe(false);
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx.part'))).toBe(false);
  });

  it('size mismatch (server sends more bytes) is refused before the whole body is stored', async () => {
    const dest = temp();
    const longer = new Uint8Array(WEIGHTS.length + 5000);
    longer.set(WEIGHTS);
    const hub = fakeHub({ ...hubFiles(), [url('onnx/model.onnx')]: longer });
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('size_mismatch');
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx'))).toBe(false);
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx.part'))).toBe(false);
  });

  it('sha256 mismatch (same size, one flipped byte) is refused', async () => {
    const dest = temp();
    const bad = WEIGHTS.slice();
    bad[10] = bad[10]! ^ 1;
    const hub = fakeHub({ ...hubFiles(), [url('onnx/model.onnx')]: bad });
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('sha256_mismatch');
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx'))).toBe(false);
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx.part'))).toBe(false);
  });

  it('git-blob mismatch on a non-LFS file is refused', async () => {
    const dest = temp();
    const tampered = enc('{"hidden_size": 5}\n'); // same length, different content
    expect(tampered.length).toBe(CONFIG.length);
    const hub = fakeHub({ ...hubFiles(), [url('config.json')]: tampered });
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('git_blob_mismatch');
    expect(existsSync(join(dest, 'tiny/config.json'))).toBe(false);
    expect(existsSync(join(dest, 'tiny/config.json.part'))).toBe(false);
  });

  it('a file without a sha256 is refused in default mode before anything is fetched', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    const m = modelsJson({
      files: [
        { path: 'config.json', size: CONFIG.length, gitBlobSha1: gitBlobSha1(CONFIG) },
        { path: 'onnx/model.onnx', size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
      ],
    });
    expect(await code(fetchModel({ name: 'tiny', models: m, dest, fetchImpl: hub.impl }))).toBe(
      'missing_sha256',
    );
    expect(hub.requests).toHaveLength(0);
    expect(existsSync(join(dest, 'tiny'))).toBe(false);
  });

  it('a path that escapes --dest is refused (traversal spellings)', async () => {
    for (const path of [
      '../evil.json',
      'onnx/../../evil.json',
      '/etc/passwd',
      '.hidden',
      'a\\b',
      'a//b',
      '%2e%2e/x',
    ]) {
      expect(() => validateModelPath(path), path).toThrow(FetchModelError);
      const dest = temp();
      const hub = fakeHub({});
      const m = modelsJson({
        files: [{ path, size: 1, sha256: 'b'.repeat(64) }],
      });
      expect(
        await code(fetchModel({ name: 'tiny', models: m, dest, fetchImpl: hub.impl })),
        path,
      ).toBe('bad_path');
      expect(hub.requests).toHaveLength(0);
    }
    expect(() => validateModelPath('onnx/model_q4.onnx')).not.toThrow();
  });

  it('a symlink inside --dest that points outside is refused (dest_escape) and nothing is written outside', async (ctx) => {
    const dest = temp();
    const outside = temp();
    try {
      symlinkSync(outside, join(dest, 'tiny'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip(); // Windows without symlink rights
      throw e;
    }
    const hub = fakeHub(hubFiles());
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('dest_escape');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a bad model name, an unknown model and a non-40-hex revision are refused', async () => {
    const dest = temp();
    const hub = fakeHub(hubFiles());
    const m = modelsJson();
    expect(await code(fetchModel({ name: 'nope', models: m, dest, fetchImpl: hub.impl }))).toBe(
      'unknown_model',
    );
    expect(await code(fetchModel({ name: '../tiny', models: m, dest, fetchImpl: hub.impl }))).toBe(
      'unknown_model',
    );
    const badRev = modelsJson({ revision: 'main' });
    expect(
      await code(fetchModel({ name: 'tiny', models: badRev, dest, fetchImpl: hub.impl })),
    ).toBe('bad_models_json');
    expect(hub.requests).toHaveLength(0);
  });

  it('a non-200 status is refused (http_status) without storing anything', async () => {
    const dest = temp();
    const hub = fakeHub({ [url('config.json')]: CONFIG }); // weights 404
    expect(
      await code(fetchModel({ name: 'tiny', models: modelsJson(), dest, fetchImpl: hub.impl })),
    ).toBe('http_status');
    expect(existsSync(join(dest, 'tiny/onnx/model.onnx'))).toBe(false);
  });
});

describe('fetch-model --pin', () => {
  const unpinned = (): ModelsJson =>
    modelsJson({
      files: [
        { path: 'config.json', size: CONFIG.length, gitBlobSha1: gitBlobSha1(CONFIG) },
        { path: 'onnx/model.onnx', size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
      ],
    });

  it('pins the sha256 of a non-LFS file after the git-blob check passes, rewriting models.json; already pinned files are not fetched', async () => {
    const dest = temp();
    const modelsPath = join(temp(), 'models.json');
    const m = unpinned();
    writeFileSync(modelsPath, JSON.stringify(m, null, 2) + '\n');
    const hub = fakeHub(hubFiles());
    const r = await fetchModel({
      name: 'tiny',
      models: m,
      dest,
      pin: true,
      modelsPath,
      fetchImpl: hub.impl,
    });
    expect(r.pinned).toBe(1);
    expect(hub.requests.map((x) => x.url)).toEqual([url('config.json')]);
    const written = JSON.parse(readFileSync(modelsPath, 'utf8')) as ModelsJson;
    expect(written.models['tiny']!.files[0]!.sha256).toBe(sha256(CONFIG));
    expect(written.models['tiny']!.files[1]!.sha256).toBe(sha256(WEIGHTS));
  });

  it('refuses to pin when the git blob does not match, and models.json is left byte-identical', async () => {
    const dest = temp();
    const modelsPath = join(temp(), 'models.json');
    const m = unpinned();
    const text = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(modelsPath, text);
    const hub = fakeHub({ ...hubFiles(), [url('config.json')]: enc('{"hidden_size": 9}\n') });
    expect(
      await code(
        fetchModel({ name: 'tiny', models: m, dest, pin: true, modelsPath, fetchImpl: hub.impl }),
      ),
    ).toBe('git_blob_mismatch');
    expect(readFileSync(modelsPath, 'utf8')).toBe(text);
    expect(existsSync(join(dest, 'tiny/config.json'))).toBe(false);
  });

  it('refuses to pin a file that has neither a sha256 nor a git blob to check (an LFS file cannot be trust-on-first-use pinned)', async () => {
    const dest = temp();
    const m = modelsJson({ files: [{ path: 'onnx/model.onnx', size: WEIGHTS.length }] });
    const hub = fakeHub(hubFiles());
    expect(
      await code(
        fetchModel({
          name: 'tiny',
          models: m,
          dest,
          pin: true,
          modelsPath: join(temp(), 'm.json'),
          fetchImpl: hub.impl,
        }),
      ),
    ).toBe('unpinnable');
    expect(hub.requests).toHaveLength(0);
  });

  it('default mode never rewrites models.json', async () => {
    const dest = temp();
    const modelsPath = join(temp(), 'models.json');
    const m = modelsJson({
      files: [
        {
          path: 'config.json',
          size: CONFIG.length,
          gitBlobSha1: gitBlobSha1(CONFIG),
          sha256: sha256(CONFIG),
        },
        { path: 'onnx/model.onnx', size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
      ],
    });
    const text = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(modelsPath, text);
    const hub = fakeHub(hubFiles());
    await fetchModel({ name: 'tiny', models: m, dest, modelsPath, fetchImpl: hub.impl });
    expect(readFileSync(modelsPath, 'utf8')).toBe(text);
  });
});

describe('copyOrtFiles', () => {
  function ortFixture(wasm = enc('wasm-bytes'), factory = enc('factory-bytes')) {
    const distDir = temp();
    writeFileSync(join(distDir, 'ort-test.wasm'), wasm);
    writeFileSync(join(distDir, 'ort-test.mjs'), factory);
    const pinsPath = join(temp(), 'ort-pins.ts');
    writeFileSync(
      pinsPath,
      [
        `export const ORT_WEB_VERSION = '1.0.0';`,
        `export const ORT_WASM_FILE = 'ort-test.wasm';`,
        `export const ORT_WASM_SHA256 = '${sha256(enc('wasm-bytes'))}';`,
        `export const ORT_FACTORY_FILE = 'ort-test.mjs';`,
        `export const ORT_FACTORY_SHA256 = '${sha256(enc('factory-bytes'))}';`,
      ].join('\n'),
    );
    return { distDir, pinsPath };
  }

  it('copies the pinned wasm and factory into <dest>/ort/ after checking them against ort-pins.ts', async () => {
    const dest = temp();
    const { distDir, pinsPath } = ortFixture();
    const r = await copyOrtFiles({ dest, distDir, pinsPath });
    expect(r.checked).toBe(true);
    expect(readdirSync(join(dest, 'ort')).sort()).toEqual(['ort-test.mjs', 'ort-test.wasm']);
  });

  it('refuses a file whose hash differs from the pin and copies nothing', async () => {
    const dest = temp();
    const { distDir, pinsPath } = ortFixture(enc('tampered-wasm'));
    expect(await code(copyOrtFiles({ dest, distDir, pinsPath }))).toBe('ort_pin_mismatch');
    expect(existsSync(join(dest, 'ort'))).toBe(false);
  });

  it('without a pins file it refuses with ort_missing (main() skips the ORT step until the pins exist)', async () => {
    const dest = temp();
    const { distDir } = ortFixture();
    expect(await code(copyOrtFiles({ dest, distDir, pinsPath: join(temp(), 'missing.ts') }))).toBe(
      'ort_missing',
    );
    expect(existsSync(join(dest, 'ort'))).toBe(false);
  });
});

describe('models.json in the repository', () => {
  const json = JSON.parse(
    readFileSync(resolve(repoDir, 'test/tools/models.json'), 'utf8'),
  ) as ModelsJson;

  it('every file of every model has a size and a sha256 before commit', () => {
    for (const [name, m] of Object.entries(json.models)) {
      expect(m.revision, name).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.length, name).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.sha256, `${name}/${f.path}`).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isSafeInteger(f.size) && f.size > 0, `${name}/${f.path}`).toBe(true);
        if (f.gitBlobSha1 !== undefined) expect(f.gitBlobSha1).toMatch(/^[0-9a-f]{40}$/);
        expect(() => validateModelPath(f.path)).not.toThrow();
      }
    }
  });

  it('names the test model and the planned production model with their expected sizes', () => {
    const smol = json.models['smollm2-135m-instruct']!;
    expect(smol.repo).toBe('HuggingFaceTB/SmolLM2-135M-Instruct');
    expect(smol.revision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    const q4 = smol.files.find((f) => f.path === 'onnx/model_q4.onnx')!;
    expect(q4.size).toBe(182_068_553);
    expect(q4.sha256).toMatch(/^9335771103/);
    expect(q4.sha256).toMatch(/f392a$/);
    const qwen = json.models['qwen3-1.7b-webgpu-q4f16']!;
    expect(qwen.repo).toBe('onnx-community/Qwen3-1.7B-ONNX');
    expect(qwen.revision).toBe('3231b522c6e703b2f9b3cd8ea27426a1289a02f2');
    expect(qwen.files.find((f) => f.path === 'onnx/model_q4f16.onnx')!.size).toBe(1_426_069_098);
  });

  it('.cache is gitignored', () => {
    expect(readFileSync(resolve(repoDir, '.gitignore'), 'utf8').split('\n')).toContain('.cache/');
  });
});
