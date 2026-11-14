// D1-02: manifest spec v0.1 conformance. Every row of spec/vectors/tamper/tamper.json and every row of
// spec/vectors/negative.json goes through verifyManifest() with the row's clock, the row's trust set and
// a SPY downgrade store; the three asset manifests of spec/vectors/tamper-assets go through the asset
// manager, each on a FRESH memory store. Written before the verifier changes (red run:
// evidence/sprint-4/D1/red-D1-02.log).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RFC8032_TEST_KEY_IDS, RFC8032_TEST_PUBLIC_KEYS_HEX } from '../spec/manifest';
import type { Manifest } from '../spec/manifest';
import { AssetManager } from '../src/asset-manager';
import { AssetError } from '../src/errors';
import {
  ManifestError,
  verifyManifest,
  type ManifestState,
  type ManifestStateStore,
  type SignatureCheck,
} from '../src/manifest';
import { MemoryAssetStore } from '../src/store/memory';
import { FakeServer } from './fake-fetch';
import {
  RFC8032_PUBLIC,
  RFC8032_TEST2_PUBLIC,
  hexToBytes,
  keyIdOf,
  readJson,
  specDir,
} from './helpers';

const tamperDir = resolve(specDir, 'vectors/tamper');
const assetsDir = resolve(specDir, 'vectors/tamper-assets');
const vectorsDir = resolve(specDir, 'vectors');

interface Row {
  file: string;
  trust: string[];
  allowTestKeys: boolean;
  now: string;
  state: ManifestState | null;
  requiresState: boolean;
  expect: { valid: boolean; stage?: string; reason?: string; signatures?: string[] };
}
const rows = readJson<Row[]>(resolve(tamperDir, 'tamper.json'));

const KEYS: Record<string, Uint8Array> = {
  'rfc8032-1': RFC8032_PUBLIC,
  'rfc8032-2': RFC8032_TEST2_PUBLIC,
};
const trustOf = (names: string[]): Map<string, Uint8Array> =>
  new Map(names.map((n) => [keyIdOf(KEYS[n]!), KEYS[n]!]));

/** A downgrade store that records every call. */
class SpyState implements ManifestStateStore {
  readonly sets: [string, ManifestState][] = [];
  gets = 0;
  private stored: ManifestState | undefined;
  constructor(
    seed: ManifestState | null,
    private readonly failGet = false,
  ) {
    this.stored = seed ?? undefined;
  }
  async get(): Promise<ManifestState | undefined> {
    this.gets++;
    if (this.failGet) throw new Error('store unreadable');
    return this.stored ? { ...this.stored } : undefined;
  }
  async set(id: string, state: ManifestState): Promise<void> {
    this.sets.push([id, { ...state }]);
    this.stored = { ...state };
  }
}

const PARSE_REASONS = new Set([
  'invalid_json',
  'lone_surrogate',
  'float',
  'bigint',
  'digit_key',
  'invalid_key',
  'bad_spec',
  'bad_url',
  'schema',
  'unsorted_entries',
  'duplicate_entries',
]);
const stageOf = (reason: string): string => (PARSE_REASONS.has(reason) ? 'parse' : 'verify');
const perSignature = (sigs: SignatureCheck[]): string[] =>
  sigs.map((c) => (c.valid ? 'valid' : (c.reason ?? '?')));

const text = (dir: string, file: string): string => readFileSync(resolve(dir, file), 'utf8');

describe('tamper vectors: every row through verifyManifest', () => {
  for (const row of rows) {
    it(`${row.file}: ${row.expect.valid ? 'valid' : (row.expect.reason ?? '?')}`, async () => {
      const spy = new SpyState(row.state);
      const verify = () =>
        verifyManifest(text(tamperDir, row.file), trustOf(row.trust), {
          allowTestKeys: row.allowTestKeys,
          now: Date.parse(row.now),
          state: spy,
        });
      if (row.expect.reason === 'test_key_refused') {
        await expect(verify()).rejects.toMatchObject({
          name: 'ManifestError',
          reason: 'test_key_refused',
        });
        expect(spy.gets).toBe(0);
        expect(spy.sets).toHaveLength(0);
        return;
      }
      const r = await verify();
      expect(r.ok, JSON.stringify(r.ok ? '' : r)).toBe(row.expect.valid);
      if (!r.ok) {
        expect(r.reason).toBe(row.expect.reason);
        if (row.expect.stage !== undefined) expect(stageOf(r.reason)).toBe(row.expect.stage);
      }
      if (row.expect.signatures !== undefined)
        expect(perSignature(r.signatures)).toEqual(row.expect.signatures);
      // the downgrade store moves only for an accepted manifest
      if (r.ok)
        expect(spy.sets).toEqual([
          ['tamper-base', { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' }],
        ]);
      else expect(spy.sets).toHaveLength(0);
    });
  }

  it('tamper-11 (rotation) is the only accepted row, and it records exactly one state write', () => {
    expect(rows.filter((r) => r.expect.valid).map((r) => r.file)).toEqual([
      'tamper-11-rotation-ok.json',
    ]);
  });

  it('the requiresState rows are exactly tamper-08 and tamper-09, and each is accepted on first use (empty store)', async () => {
    expect(rows.filter((r) => r.requiresState).map((r) => r.file.slice(0, 9))).toEqual([
      'tamper-08',
      'tamper-09',
    ]);
    for (const row of rows.filter((r) => r.requiresState)) {
      const spy = new SpyState(null);
      const r = await verifyManifest(text(tamperDir, row.file), trustOf(row.trust), {
        allowTestKeys: true,
        now: Date.parse(row.now),
        state: spy,
      });
      expect(r.ok, row.file).toBe(true); // first use: nothing to downgrade from
    }
  });

  it('an unreadable store gives reason state for the valid row, with no write', async () => {
    const row = rows.find((r) => r.file.startsWith('tamper-11'))!;
    const spy = new SpyState(null, true);
    const r = await verifyManifest(text(tamperDir, row.file), trustOf(row.trust), {
      allowTestKeys: true,
      now: Date.parse(row.now),
      state: spy,
    });
    expect(r).toMatchObject({ ok: false, reason: 'state' });
    expect(spy.sets).toHaveLength(0);
  });

  it('a manifest already parsed to an object verifies the same as its text', async () => {
    for (const row of rows) {
      if (row.file.endsWith('.txt') || row.expect.reason === 'test_key_refused') continue;
      const obj = JSON.parse(text(tamperDir, row.file)) as Manifest;
      const a = await verifyManifest(obj, trustOf(row.trust), {
        allowTestKeys: true,
        now: Date.parse(row.now),
        state: new SpyState(row.state),
      });
      expect(a.ok, row.file).toBe(row.expect.valid);
    }
  });
});

describe('negative vectors: the downgrade store is never written for a refused manifest', () => {
  const neg = readJson<{ file: string; reason: string; stage: string }[]>(
    resolve(vectorsDir, 'negative.json'),
  );
  for (const n of neg) {
    it(`${n.file} -> ${n.reason}, 0 state writes`, async () => {
      const spy = new SpyState(null);
      const r = await verifyManifest(text(vectorsDir, n.file), trustOf(['rfc8032-1']), {
        allowTestKeys: true,
        now: Date.parse('2026-11-10T00:00:00Z'),
        state: spy,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(n.reason);
        expect(stageOf(r.reason)).toBe(n.stage === 'parse' ? 'parse' : 'verify');
      }
      expect(spy.sets).toHaveLength(0);
    });
  }
});

describe('test keys: all five RFC 8032 keys are refused unless allowTestKeys === true', () => {
  const valid = readJson<Manifest>(resolve(tamperDir, 'tamper-11-rotation-ok.json'));

  for (const [i, hex] of RFC8032_TEST_PUBLIC_KEYS_HEX.entries()) {
    const keyId = RFC8032_TEST_KEY_IDS[i]!;
    it(`test key ${i + 1}: refused by keyId, and by bytes under a wrong keyId`, async () => {
      const bytes = hexToBytes(hex);
      for (const trust of [
        new Map([[keyId, bytes]]),
        new Map([['f'.repeat(64), bytes]]), // right bytes, wrong keyId
        new Map([[keyId, new Uint8Array(32)]]), // right keyId, wrong bytes
      ]) {
        await expect(verifyManifest(valid, trust, { now: 1 })).rejects.toBeInstanceOf(
          ManifestError,
        );
        await expect(verifyManifest(valid, trust, { now: 1 })).rejects.toMatchObject({
          reason: 'test_key_refused',
        });
      }
    });
  }

  it('refuses before parsing: a hostile string input still throws test_key_refused', async () => {
    const trust = new Map([
      [RFC8032_TEST_KEY_IDS[2]!, hexToBytes(RFC8032_TEST_PUBLIC_KEYS_HEX[2])],
    ]);
    await expect(verifyManifest('{ not json', trust, {})).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
  });

  it('allowTestKeys must be the boolean true: the string "true", 1 and {} still refuse', async () => {
    const trust = trustOf(['rfc8032-1']);
    for (const bad of ['true', 1, {}, [], 'yes']) {
      await expect(
        verifyManifest(valid, trust, { allowTestKeys: bad as unknown as boolean, now: 1 }),
      ).rejects.toMatchObject({ reason: 'test_key_refused' });
    }
    await expect(
      verifyManifest(valid, trust, {
        allowTestKeys: false,
        now: Date.parse('2026-11-14T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ reason: 'test_key_refused' });
    const ok = await verifyManifest(valid, trust, {
      allowTestKeys: true,
      now: Date.parse('2026-11-14T00:00:00Z'),
    });
    expect(ok.ok).toBe(true);
  });

  it('the library default is false', async () => {
    await expect(verifyManifest(valid, trustOf(['rfc8032-1']), {})).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
    const src = readFileSync(resolve(specDir, '../src/manifest.ts'), 'utf8');
    expect(src).toContain('opts.allowTestKeys !== true');
  });

  it('a trust set without any test key is never refused, whatever allowTestKeys says', async () => {
    const real = new Map([['a'.repeat(64), new Uint8Array(32).fill(7)]]);
    const r = await verifyManifest(valid, real, { now: Date.parse('2026-11-14T00:00:00Z') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_valid_signature');
  });
});

describe('S < L is checked explicitly, before WebCrypto (tamper-15)', () => {
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const toBytes = (n: bigint): Buffer =>
    Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();

  async function verdictFor(sValue: bigint) {
    const good = readJson<Manifest>(resolve(tamperDir, 'tamper-11-rotation-ok.json'));
    const sig = Buffer.from(good.signatures[1]!.sig, 'base64');
    toBytes(sValue).copy(sig, 32);
    const m = { ...good, signatures: [{ ...good.signatures[1]!, sig: sig.toString('base64') }] };
    return verifyManifest(m, trustOf(['rfc8032-1']), {
      allowTestKeys: true,
      now: Date.parse('2026-11-14T00:00:00Z'),
    });
  }

  it('S = L and S = L + 1 and S = 2^256 - 1 are bad_signature; S = L - 1 is judged by the maths (also bad_signature here)', async () => {
    for (const s of [L, L + 1n, (1n << 256n) - 1n, L - 1n]) {
      const r = await verdictFor(s);
      expect(r.ok).toBe(false);
      expect(perSignature(r.signatures)).toEqual(['bad_signature']);
    }
  });

  it('a signature with S >= L never reaches WebCrypto verify', async () => {
    const spy = vi.spyOn(crypto.subtle, 'verify');
    try {
      await verdictFor(L);
      expect(spy).not.toHaveBeenCalled();
      await verdictFor(L - 1n);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('tamper-assets: refused assets expose nothing (each case on a FRESH memory store)', () => {
  const ORIGIN = 'https://assets.test';
  const BASE_URL = `${ORIGIN}/assets/manifest.json`;
  const expectJson = readJson<
    Record<
      string,
      {
        normative: {
          refused: boolean;
          bytesToConsumer: number;
          getBlob: string;
          blobUrl: boolean;
        };
        informative: { runtimeCode: string | null; runtimeReason: string | null };
      }
    >
  >(resolve(assetsDir, 'expect.json'));
  const bytes = (f: string): Uint8Array => new Uint8Array(readFileSync(resolve(assetsDir, f)));
  const URLS: Record<string, string> = {
    'manifest-ok.json': 'asset-ok.bin',
    'manifest-flip.json': 'asset-flip.bin',
    'manifest-truncated.json': 'asset-truncated.bin',
  };

  afterEach(() => vi.restoreAllMocks());

  async function run(manifestFile: string) {
    const server = new FakeServer({ origin: ORIGIN });
    for (const f of ['asset-ok.bin', 'asset-flip.bin', 'asset-truncated.bin'])
      server.addAsset(f, bytes(f));
    const store = new MemoryAssetStore(); // fresh for every case
    const mgr = new AssetManager({
      store,
      fetch: server.fetch,
      allowTestKeys: true,
      allowedOrigins: [ORIGIN],
      headroomBytes: 0,
      progressIntervalMs: 0,
    });
    const manifest = JSON.parse(text(assetsDir, manifestFile)) as Manifest;
    await mgr.loadManifest(manifest, trustOf(['rfc8032-1']), {
      baseUrl: BASE_URL,
      now: Date.parse('2026-11-14T00:00:00Z'),
    });
    return { server, store, mgr };
  }

  it('manifest-ok is accepted: 4096 bytes reach the consumer', async () => {
    const { mgr, server } = await run('manifest-ok.json');
    const handle = await mgr.ensure('asset-ok');
    expect(handle.size).toBe(4096);
    const blob = await mgr.getBlob('asset-ok');
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(bytes('asset-ok.bin')))).toBe(
      true,
    );
    expect(expectJson['manifest-ok.json']!.normative).toMatchObject({
      refused: false,
      bytesToConsumer: 4096,
      getBlob: 'resolves',
    });
    expect(server.requests.length).toBeGreaterThan(0);
  });

  for (const file of ['manifest-flip.json', 'manifest-truncated.json']) {
    it(`${file}: refused, 0 bytes to a consumer, getBlob rejects, no blob: URL, informative code matches expect.json`, async () => {
      const exp = expectJson[file]!;
      expect(exp.normative).toEqual({
        refused: true,
        bytesToConsumer: 0,
        getBlob: 'rejects',
        blobUrl: false,
      });
      const createUrl = vi.spyOn(URL, 'createObjectURL');
      const { mgr, server, store } = await run(file);
      let handle: unknown;
      let err: unknown;
      try {
        handle = await mgr.ensure('asset-ok');
      } catch (e) {
        err = e;
      }
      expect(handle, 'no handle may be returned').toBeUndefined();
      expect(err).toBeInstanceOf(AssetError);
      expect((err as AssetError).code).toBe(exp.informative.runtimeCode);
      expect((err as AssetError).reason ?? null).toBe(exp.informative.runtimeReason);
      // 0 bytes reach a consumer: getBlob rejects and nothing is stored
      await expect(mgr.getBlob('asset-ok')).rejects.toBeInstanceOf(AssetError);
      await expect(mgr.getBlob('asset-ok', { rehash: true })).rejects.toBeInstanceOf(AssetError);
      expect(createUrl).not.toHaveBeenCalled();
      const listing = await store.list();
      expect(listing.bins).toHaveLength(0);
      // the asset was asked for from its own URL only
      expect(
        server.requests.every((r) => r.url === `${ORIGIN}/assets/${URLS[file]}`),
        JSON.stringify(server.requests.map((r) => r.url)),
      ).toBe(true);
    });
  }

  it('the flip asset is requested exactly once', async () => {
    const { mgr, server } = await run('manifest-flip.json');
    await expect(mgr.ensure('asset-ok')).rejects.toBeInstanceOf(AssetError);
    expect(server.requests.filter((r) => r.url.endsWith('asset-flip.bin'))).toHaveLength(1);
  });

  it('a refused manifest triggers no asset request at all', async () => {
    const server = new FakeServer({ origin: ORIGIN });
    server.addAsset('asset-ok.bin', bytes('asset-ok.bin'));
    const mgr = new AssetManager({
      store: new MemoryAssetStore(),
      fetch: server.fetch,
      allowTestKeys: true,
      allowedOrigins: [ORIGIN],
    });
    const m = JSON.parse(text(assetsDir, 'manifest-ok.json')) as Manifest;
    m.signatures[0]!.sig = m.signatures[0]!.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(
      mgr.loadManifest(m, trustOf(['rfc8032-1']), { baseUrl: BASE_URL }),
    ).rejects.toMatchObject({ reason: 'no_valid_signature' });
    expect(server.requests).toHaveLength(0);
  });
});
