import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_FORBIDDEN_KEY_PATTERN, RUNTIME_EVENT_NAMES } from '../spec/event';
import { SPEC_VERSIONS, SPEC_WIRE } from '../spec/index';
import type { Manifest } from '../spec/manifest';
import {
  MODEL_DESCRIPTOR_MAX_BYTES,
  MODEL_DESCRIPTOR_MEDIA_TYPE,
  MODEL_DESCRIPTOR_SPEC,
} from '../spec/model-descriptor';
import { newEvent } from '../src/events';
import { parseManifest, verifyManifest, ManifestError } from '../src/manifest';
import { SCHEMAS, validateModelDescriptor, validateSchema } from '../src/schema';
import { signedBytes } from '../src/canonical';
import {
  RFC8032_KEY_ID,
  RFC8032_PUBLIC,
  keyIdOf,
  readJson,
  readText,
  specDir,
  hexToBytes,
} from './helpers';

const examples = resolve(specDir, 'examples');
const vectors = resolve(specDir, 'vectors');

async function verifyEd25519(message: Uint8Array, sig: Uint8Array, pub: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'raw',
    pub as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sig as BufferSource,
    message as BufferSource,
  );
}

describe('spec: schemas', () => {
  it('every schema is JSON Schema 2020-12 with the urn $id of its own contract version', () => {
    const ids: Record<string, string> = {
      manifest: 'urn:airplanemode:spec:manifest:0.1.0',
      capabilityProfile: 'urn:airplanemode:spec:capability-profile:0.1.0',
      event: 'urn:airplanemode:spec:event:0.1.1',
      modelDescriptor: 'urn:airplanemode:spec:model-descriptor:0.1.0',
    };
    expect(Object.keys(SCHEMAS).sort()).toEqual(Object.keys(ids).sort());
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id, name).toBe(ids[name]);
    }
  });

  it('SPEC_VERSIONS and SPEC_WIRE carry the 0.2.0 release values', () => {
    expect(SPEC_VERSIONS).toEqual({
      manifest: '0.1.0',
      capabilityProfile: '0.1.0',
      event: '0.1.1',
      storageApi: '0.1.0',
      backendAdapter: '0.2.0',
      modelDescriptor: '0.1.0',
    });
    expect(SPEC_WIRE).toEqual({
      manifest: 'airplanemode.manifest/0.1',
      capabilityProfile: 'airplanemode.capability/0.1',
      event: 'airplanemode.event/0.1',
      modelDescriptor: 'airplanemode.model/0.1',
    });
    expect(MODEL_DESCRIPTOR_SPEC).toBe('airplanemode.model/0.1');
    expect(MODEL_DESCRIPTOR_MEDIA_TYPE).toBe('application/vnd.airplanemode.model+json');
    expect(MODEL_DESCRIPTOR_MAX_BYTES).toBe(65536);
  });

  it('backend-adapter.ts imports nothing from model-descriptor.ts, and model-descriptor.ts imports nothing', () => {
    const adapter = readText(resolve(specDir, 'backend-adapter.ts'));
    expect(adapter).not.toMatch(/from\s+['"]\.\/model-descriptor['"]/);
    const descriptor = readText(resolve(specDir, 'model-descriptor.ts'));
    expect(descriptor).not.toMatch(/^\s*import\s/m);
  });

  it('spec files exist for all five contracts', () => {
    const files = readdirSync(specDir);
    for (const f of [
      'manifest.schema.json',
      'manifest.ts',
      'capability-profile.schema.json',
      'capability-profile.ts',
      'event.schema.json',
      'event.ts',
      'storage-api.ts',
      'storage-api.md',
      'backend-adapter.ts',
      'backend-adapter.md',
      'model-descriptor.ts',
      'model-descriptor.schema.json',
      'index.ts',
      'README.md',
      'CHANGELOG.md',
    ])
      expect(files, f).toContain(f);
  });

  it('manifest schema carries the unauthenticated-fields sentence on signedAt', () => {
    const schema = SCHEMAS.manifest as {
      $defs: { Signature: { properties: { signedAt: { description: string } } } };
    };
    expect(schema.$defs.Signature.properties.signedAt.description).toContain(
      'signedAt, alg, keyId and publicKey are NOT covered by the signature',
    );
  });

  it('attrs and details keys are constrained via propertyNames', () => {
    const ev = SCHEMAS.event as { properties: { attrs: { propertyNames: { pattern: string } } } };
    expect(ev.properties.attrs.propertyNames.pattern).toBe('^[A-Za-z][A-Za-z0-9_]{0,63}$');
    const cp = SCHEMAS.capabilityProfile as {
      properties: { details: { propertyNames: { pattern: string; enum: string[] } } };
    };
    expect(cp.properties.details.propertyNames.pattern).toBe('^[A-Za-z_][A-Za-z0-9_]{0,63}$');
    expect(cp.properties.details.propertyNames.enum).toEqual([
      'vendor',
      'architecture',
      'maxBufferSize',
      'maxStorageBufferBindingSize',
      'maxComputeWorkgroupStorageSize',
      'maxComputeInvocationsPerWorkgroup',
    ]);
  });
});

describe('spec: examples validate', () => {
  it('manifest.unsigned.example.json validates and parses', () => {
    const doc = readJson(resolve(examples, 'manifest.unsigned.example.json'));
    expect(validateSchema(SCHEMAS.manifest, doc).ok).toBe(true);
    const m = parseManifest(readText(resolve(examples, 'manifest.unsigned.example.json')));
    expect(m.entries[0]!.id).toBe('hello-data');
    expect(m.entries[0]!.size).toBe(1048576);
    expect(m.entries[0]!.chunkSize).toBe(1048576);
    expect(m.signatures).toEqual([]);
  });

  it('manifest.signed.example.json validates, has an identical body and one signature', () => {
    const unsigned = readJson<Manifest>(resolve(examples, 'manifest.unsigned.example.json'));
    const signed = readJson<Manifest>(resolve(examples, 'manifest.signed.example.json'));
    expect(validateSchema(SCHEMAS.manifest, signed).ok).toBe(true);
    expect({ ...signed, signatures: [] }).toEqual(unsigned);
    expect(signed.signatures).toHaveLength(1);
    expect(signed.expiresAt).toBeUndefined();
  });

  it('capability-profile.example.json validates', () => {
    const r = validateSchema(
      SCHEMAS.capabilityProfile,
      readJson(resolve(examples, 'capability-profile.example.json')),
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('event.example.json validates', () => {
    const r = validateSchema(SCHEMAS.event, readJson(resolve(examples, 'event.example.json')));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects an example with an extra top-level key (additionalProperties false)', () => {
    const doc = readJson<Record<string, unknown>>(resolve(examples, 'event.example.json'));
    doc['extra'] = 1;
    expect(validateSchema(SCHEMAS.event, doc).ok).toBe(false);
  });
});

describe('spec: signed example verifies with WebCrypto under the RFC 8032 key', () => {
  it('keyId equals sha256 of the raw public key', () => {
    const signed = readJson<Manifest>(resolve(examples, 'manifest.signed.example.json'));
    const sig = signed.signatures[0]!;
    expect(sig.keyId).toBe(keyIdOf(RFC8032_PUBLIC));
    expect(sig.keyId).toBe(RFC8032_KEY_ID);
    expect(Buffer.from(sig.publicKey!, 'base64')).toEqual(Buffer.from(RFC8032_PUBLIC));
  });

  it('the sig verifies over prefix + canonical body', async () => {
    const signed = readJson<Manifest>(resolve(examples, 'manifest.signed.example.json'));
    const sig = Buffer.from(signed.signatures[0]!.sig, 'base64');
    expect(sig).toHaveLength(64);
    expect(await verifyEd25519(signedBytes(signed), sig, RFC8032_PUBLIC)).toBe(true);
    // and not under a different key
    const other = hexToBytes('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c');
    expect(await verifyEd25519(signedBytes(signed), sig, other)).toBe(false);
  });
});

describe('spec: shared vectors', () => {
  const positive = [
    '01-unsigned-example',
    '02-escapes',
    '03-devanagari',
    '04-minprofile-full',
    '05-four-entries',
  ];

  for (const name of positive) {
    it(`${name}.json validates and its .sig.txt verifies over its .canonical.txt`, async () => {
      const doc = readJson<Manifest>(resolve(vectors, `${name}.json`));
      const r = validateSchema(SCHEMAS.manifest, doc);
      expect(r.errors).toEqual([]);
      expect(() => parseManifest(readText(resolve(vectors, `${name}.json`)))).not.toThrow();
      const canonical = readText(resolve(vectors, `${name}.canonical.txt`));
      expect(canonical.startsWith('airplanemode-manifest-v1\n')).toBe(true);
      const sig = Buffer.from(readText(resolve(vectors, `${name}.sig.txt`)).trim(), 'base64');
      expect(sig).toHaveLength(64);
      expect(await verifyEd25519(new TextEncoder().encode(canonical), sig, RFC8032_PUBLIC)).toBe(
        true,
      );
    });
  }

  const negative = readJson<{ file: string; reason: string; stage: 'parse' | 'verify' }[]>(
    resolve(vectors, 'negative.json'),
  );
  it('negative.json lists the thirteen negative vectors, each with a stage', () => {
    expect(negative.map((n) => n.file).sort()).toEqual(
      readdirSync(vectors)
        .filter((f) => f.startsWith('neg-'))
        .sort(),
    );
    expect(negative).toHaveLength(13);
    for (const n of negative) expect(['parse', 'verify']).toContain(n.stage);
    expect(negative.find((n) => n.file === 'neg-unknown-alg-only.json')).toEqual({
      file: 'neg-unknown-alg-only.json',
      reason: 'no_valid_signature',
      stage: 'verify',
    });
    expect(negative.find((n) => n.file === 'neg-bad-date.json')).toEqual({
      file: 'neg-bad-date.json',
      reason: 'schema',
      stage: 'parse',
    });
    expect(negative.find((n) => n.file === 'neg-bad-alg-token.json')).toEqual({
      file: 'neg-bad-alg-token.json',
      reason: 'schema',
      stage: 'parse',
    });
  });

  it('neg-bad-alg-token.json is the unsigned example plus one correctly signed ED25519 (upper-case alg) signature', async () => {
    const doc = readJson<Manifest>(resolve(vectors, 'neg-bad-alg-token.json'));
    const unsigned = readJson<Manifest>(resolve(examples, 'manifest.unsigned.example.json'));
    expect({ ...doc, signatures: [] }).toEqual(unsigned);
    expect(doc.signatures).toHaveLength(1);
    const sig = doc.signatures[0]!;
    expect(sig.alg).toBe('ED25519');
    expect(sig.keyId).toBe(RFC8032_KEY_ID);
    expect(Buffer.from(sig.publicKey!, 'base64')).toEqual(Buffer.from(RFC8032_PUBLIC));
    expect(sig.signedAt).toBe('2026-11-09T00:00:00Z');
    // the signature itself is correct: the manifest is rejected for the token, not for the maths
    expect(
      await verifyEd25519(signedBytes(doc), Buffer.from(sig.sig, 'base64'), RFC8032_PUBLIC),
    ).toBe(true);
  });

  for (const { file, reason, stage } of negative) {
    if (stage === 'verify') {
      it(`${file} parses but is rejected at verify stage with reason ${reason}`, async () => {
        const parsed = parseManifest(readText(resolve(vectors, file)));
        const r = await verifyManifest(parsed, new Map([[RFC8032_KEY_ID, RFC8032_PUBLIC]]), {
          allowTestKeys: true,
          now: Date.parse('2026-11-10T00:00:00Z'),
        });
        expect(r).toMatchObject({ ok: false, reason });
      });
      continue;
    }
    it(`${file} is rejected at parse stage with reason ${reason}`, () => {
      const text = readText(resolve(vectors, file));
      try {
        parseManifest(text);
        expect.unreachable(`${file} should have been rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(ManifestError);
        expect((e as ManifestError).reason).toBe(reason);
      }
    });
  }
});

describe('spec: model descriptor 0.1.0', () => {
  const example = () =>
    readJson<Record<string, unknown>>(resolve(examples, 'model-descriptor.example.json'));
  const files = (d: Record<string, unknown>) => d['files'] as { path: string; entryId: string }[];

  it('the example validates', () => {
    const r = validateModelDescriptor(example());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(example()['spec']).toBe(MODEL_DESCRIPTOR_SPEC);
  });

  const mutations: [string, (d: Record<string, unknown>) => void][] = [
    ['a ".." path', (d) => (files(d)[0]!.path = '../etc/passwd')],
    ['a ".." segment', (d) => (files(d)[0]!.path = 'onnx/../model.onnx')],
    ['a leading-"." path', (d) => (files(d)[0]!.path = '.hidden')],
    ['a leading-"/" path', (d) => (files(d)[0]!.path = '/etc/passwd')],
    ['a backslash path', (d) => (files(d)[0]!.path = 'onnx\\model.onnx')],
    ['a percent-encoded dot path', (d) => (files(d)[0]!.path = '%2e%2e/model.onnx')],
    [
      'duplicate paths',
      (d) => {
        const f = files(d);
        f[1] = { ...f[1]!, path: f[0]!.path };
      },
    ],
    [
      'unsorted files',
      (d) => {
        const f = files(d);
        [f[0], f[1]] = [f[1]!, f[0]!];
      },
    ],
    ['a float contextLength', (d) => (d['contextLength'] = 8192.5)],
    ['a zero contextLength', (d) => (d['contextLength'] = 0)],
    ['an unknown top-level key', (d) => (d['extra'] = 1)],
    ['an unknown key in a file', (d) => ((files(d)[0] as Record<string, unknown>)['url'] = 'x')],
    ['an unknown key in source', (d) => ((d['source'] as Record<string, unknown>)['url'] = 'x')],
    [
      'webllm without modelLib',
      (d) => {
        d['engine'] = 'webllm';
        delete d['runtimeWasm'];
      },
    ],
    ['transformers-js without runtimeWasm', (d) => delete d['runtimeWasm']],
    ['an unknown engine', (d) => (d['engine'] = 'llama-cpp')],
    [
      'a revision that is not 40-hex',
      (d) => ((d['source'] as { revision: string }).revision = 'main'),
    ],
    [
      'an upper-case revision',
      (d) => ((d['source'] as { revision: string }).revision = 'A'.repeat(40)),
    ],
    ['an unknown spec string', (d) => (d['spec'] = 'airplanemode.model/0.2')],
    ['unsorted devices', (d) => (d['devices'] = ['webgpu', 'wasm'])],
    ['duplicate devices', (d) => (d['devices'] = ['wasm', 'wasm'])],
    ['an empty devices list', (d) => (d['devices'] = [])],
    ['an unknown device', (d) => (d['devices'] = ['cpu'])],
    ['an unknown task', (d) => (d['task'] = 'image-to-text')],
    ['an empty files list', (d) => (d['files'] = [])],
    ['a float maxNewTokens', (d) => (d['generation'] = { maxNewTokens: 1.5 })],
    [
      'a float chatTemplateKwargs value',
      (d) => (d['generation'] = { chatTemplateKwargs: { temperature: 0.5 } }),
    ],
    [
      'a digit-leading chatTemplateKwargs key',
      (d) => (d['generation'] = { chatTemplateKwargs: { '1a': true } }),
    ],
    ['a bad dtype', (d) => (d['dtype'] = 'Q4 F16')],
    ['a runtimeWasm that is not a path', (d) => (d['runtimeWasm'] = '../ort.wasm')],
  ];
  for (const [label, mutate] of mutations) {
    it(`rejects ${label}`, () => {
      const d = structuredClone(example());
      mutate(d);
      const r = validateModelDescriptor(d);
      expect(r.ok, JSON.stringify(r.errors)).toBe(false);
    });
  }

  it('accepts a webllm descriptor with modelLib and no runtimeWasm', () => {
    const d = structuredClone(example());
    d['engine'] = 'webllm';
    delete d['runtimeWasm'];
    d['modelLib'] = 'runtime/model-lib.wasm';
    expect(validateModelDescriptor(d).errors).toEqual([]);
  });

  it('accepts chatTemplateKwargs of string, integer and boolean values', () => {
    const d = structuredClone(example());
    d['generation'] = {
      maxNewTokens: 256,
      chatTemplateKwargs: { enable_thinking: false, level: 2, style: 'plain' },
    };
    expect(validateModelDescriptor(d).errors).toEqual([]);
  });

  it('the schema registered under SCHEMAS.modelDescriptor is the one on disk', () => {
    const onDisk = readJson<Record<string, unknown>>(
      resolve(specDir, 'model-descriptor.schema.json'),
    );
    expect(SCHEMAS.modelDescriptor).toEqual(onDisk);
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.1.0');
  });

  it('plain validateSchema (no ordering checks) already rejects the schema-expressible faults', () => {
    const d = structuredClone(example());
    files(d)[0]!.path = '../x';
    expect(validateSchema(SCHEMAS.modelDescriptor, d).ok).toBe(false);
  });
});

describe('spec: event 0.1.1', () => {
  const names = [
    'backend.select',
    'backend.refused',
    'backend.egress.refused',
    'model.load',
    'model.load.failed',
    'model.generate',
  ];

  it('RUNTIME_EVENT_NAMES contains the six new names and the earlier ones', () => {
    for (const n of names) expect(RUNTIME_EVENT_NAMES as readonly string[], n).toContain(n);
    for (const n of ['asset.quota', 'asset.reconcile', 'capability.measured', 'manifest.verify.ok'])
      expect(RUNTIME_EVENT_NAMES as readonly string[], n).toContain(n);
  });

  const documented: Record<
    string,
    {
      kind: Parameters<typeof newEvent>[0]['kind'];
      level: 'info' | 'warn' | 'error' | 'debug';
      attrs: Record<string, string | number | boolean | null>;
    }[]
  > = {
    'asset.quota': [
      {
        kind: 'asset',
        level: 'warn',
        attrs: { usage: 100, quota: 200, needed: 50, usageSource: 'estimate' },
      },
      {
        kind: 'asset',
        level: 'warn',
        attrs: { usage: 100, quota: 200, needed: 50, usageSource: 'accounted' },
      },
    ],
    'backend.select': [
      'ok',
      'no_webgpu',
      'tier_too_low',
      'profile',
      'unavailable',
      'load_failed',
      'declined',
      'forced',
      'not_allowed',
    ].map((reason) => ({
      kind: 'log' as const,
      level: reason === 'ok' ? ('info' as const) : ('warn' as const),
      attrs: {
        rung: 'webgpu',
        adapter: 'transformers-js',
        model: 'smollm2-135m-instruct.descriptor',
        outcome: reason === 'ok' ? 'selected' : 'skipped',
        reason,
      },
    })),
    'backend.refused': [
      {
        kind: 'error',
        level: 'error',
        attrs: { attempts: 3, reasons: 'no_webgpu,unavailable,not_allowed' },
      },
    ],
    'backend.egress.refused': [
      {
        kind: 'error',
        level: 'error',
        attrs: { adapter: 'transformers-js', origin: 'https://huggingface.co' },
      },
      { kind: 'error', level: 'error', attrs: { adapter: 'transformers-js', origin: 'data:' } },
    ],
    'model.load': [
      {
        kind: 'model-load',
        level: 'info',
        attrs: {
          adapter: 'transformers-js',
          model: 'smollm2-135m-instruct.descriptor',
          device: 'wasm',
          dtype: 'q4',
          files: 6,
          tier: 'wasm',
          verified: true,
        },
      },
      {
        kind: 'model-load',
        level: 'info',
        attrs: {
          adapter: 'chrome-prompt-api',
          model: 'browser-builtin',
          device: 'builtin',
          dtype: '',
          files: 0,
          tier: 'none',
          verified: false,
        },
      },
    ],
    'model.load.failed': [
      {
        kind: 'model-load',
        level: 'error',
        attrs: { adapter: 'transformers-js', model: 'm', device: 'webgpu', code: 'backend' },
      },
    ],
    'model.generate': [
      {
        kind: 'timing',
        level: 'info',
        attrs: {
          adapter: 'transformers-js',
          device: 'wasm',
          finishReason: 'stop',
          inTokens: 20,
          outTokens: 2,
          tokensPerSecond: 12.5,
          prefillMs: 100,
          decodeMs: 160,
        },
      },
    ],
  };

  for (const [name, variants] of Object.entries(documented)) {
    it(`newEvent accepts every documented attr set of ${name}, and the result validates against event.schema.json`, () => {
      for (const v of variants) {
        const e = newEvent({
          source: 'runtime',
          kind: v.kind,
          name,
          level: v.level,
          attrs: v.attrs,
        });
        expect(e.attrs).toEqual(v.attrs);
        expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
        for (const key of Object.keys(v.attrs))
          expect(EVENT_FORBIDDEN_KEY_PATTERN.test(key), `${name}.${key}`).toBe(false);
      }
    });
  }

  it('every documented attr key of the new names appears in event.ts documentation', () => {
    const text = readText(resolve(specDir, 'event.ts'));
    for (const variants of Object.values(documented))
      for (const v of variants)
        for (const key of Object.keys(v.attrs)) expect(text, key).toContain(key);
    for (const reason of ['not_allowed', 'tier_too_low', 'load_failed', 'declined', 'forced'])
      expect(text, reason).toContain(reason);
    expect(text).toContain('usageSource');
    expect(text).toContain('verified');
  });

  it('the event schema carries the 0.1.1 $id and an unchanged body (wire string stays 0.1)', () => {
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.1');
    expect(
      (SCHEMAS.event as { properties: { spec: { const: string } } }).properties.spec.const,
    ).toBe('airplanemode.event/0.1');
  });
});
