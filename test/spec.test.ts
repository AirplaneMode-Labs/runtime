import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_VERSIONS } from '../spec/index';
import type { Manifest } from '../spec/manifest';
import { parseManifest, verifyManifest, ManifestError } from '../src/manifest';
import { SCHEMAS, validateSchema } from '../src/schema';
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
  it('every schema is JSON Schema 2020-12 with the urn $id and version 0.1.0', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toMatch(/^urn:airplanemode:spec:[a-z-]+:0\.1\.0$/);
      expect(name).toBeTruthy();
    }
    expect(SPEC_VERSIONS).toEqual({
      manifest: '0.1.0',
      capabilityProfile: '0.1.0',
      event: '0.1.0',
      storageApi: '0.1.0',
      backendAdapter: '0.1.0',
    });
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
  it('negative.json lists the twelve negative vectors, each with a stage', () => {
    expect(negative.map((n) => n.file).sort()).toEqual(
      readdirSync(vectors)
        .filter((f) => f.startsWith('neg-'))
        .sort(),
    );
    expect(negative).toHaveLength(12);
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
