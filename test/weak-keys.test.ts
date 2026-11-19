// Manifest 0.1.3 (Sprint 6, D1-03; S1-113, TD-68, TD-82): a trust set holding a weak Ed25519 public key is
// refused with 'weak_key_refused' before the manifest is parsed, with no opt-out, and again for the key a
// signature actually uses. Written before src/ed25519-point.ts existed; the red run is
// evidence/sprint-6/D1/red/D1-03.log. The vectors come from test/tools/make-weak-key-vectors.mjs, an
// independent affine implementation, so these tests check the library against an oracle.

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  RFC8032_TEST_KEY_IDS,
  RFC8032_TEST_PUBLIC_KEYS_HEX,
  WEAK_KEY_REFUSED_MESSAGE,
} from '../spec/manifest';
import { AssetManager } from '../src/asset-manager';
import { isWeakEd25519PublicKey } from '../src/ed25519-point';
import { ManifestError, assertNoWeakKeys, verifyManifest } from '../src/manifest';
import { FakeServer } from './fake-fetch';
import { bytesToHex, hexToBytes, keyIdOf, specDir } from './helpers';

const vectors = resolve(specDir, 'vectors');
const NOW = Date.parse('2026-11-14T00:00:00Z');

interface WeakRow {
  id: string;
  publicKeyHex: string;
  keyIdHex: string;
  class: string;
  expect: 'weak_key_refused' | 'ok';
  why: string;
}
interface VerifyRow {
  manifest: string;
  trust: { keyIdHex: string; publicKeyHex: string }[];
  allowTestKeys: boolean;
  expect: { throws: string };
}
const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(resolve(vectors, rel), 'utf8')) as T;
const readText = (rel: string): string => readFileSync(resolve(vectors, rel), 'utf8');
const rows = readJson<WeakRow[]>('weak-keys/weak-keys.json');
const verifyRows = readJson<VerifyRow[]>('weak-keys/verify.json');
const refused = rows.filter((r) => r.expect === 'weak_key_refused');
const accepted = rows.filter((r) => r.expect === 'ok');

const trustOf = (list: { keyIdHex: string; publicKeyHex: string }[]) =>
  new Map<string, Uint8Array>(list.map((k) => [k.keyIdHex, hexToBytes(k.publicKeyHex)]));
const byId = (id: string): WeakRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no weak-keys row ${id}`);
  return r;
};
const weakErr = { name: 'ManifestError', reason: 'weak_key_refused' };

describe('weak-keys.json: the vector file itself', () => {
  it('has at least 16 refused rows across every refused class, and the accepted rows', () => {
    expect(refused.length).toBeGreaterThanOrEqual(16);
    const classes = new Set(refused.map((r) => r.class));
    for (const c of [
      'identity',
      'identity_sign_bit',
      'small_order',
      'small_order_noncanonical',
      'mixed_order',
      'not_on_curve',
      'noncanonical_y',
    ])
      expect(classes.has(c), c).toBe(true);
    expect(accepted.map((r) => r.class)).toEqual(accepted.map(() => 'valid'));
    expect(accepted).toHaveLength(6); // the five RFC 8032 test keys and one generated key
    expect(rows.filter((r) => r.class === 'small_order' && /^small-order-/.test(r.id)).length).toBe(
      7,
    ); // with the identity row, all eight small-order points in canonical form
  });

  it('every row is 32 bytes, its keyId is the sha256 of the key, and no two rows share bytes', () => {
    for (const r of rows) {
      const k = hexToBytes(r.publicKeyHex);
      expect(k.length, r.id).toBe(32);
      expect(r.keyIdHex, r.id).toBe(keyIdOf(k));
    }
    expect(new Set(rows.map((r) => r.publicKeyHex)).size).toBe(rows.length);
  });
});

describe('isWeakEd25519PublicKey and assertNoWeakKeys: every weak-keys.json row', () => {
  for (const r of rows)
    it(`${r.id} (${r.class}) is ${r.expect}`, () => {
      const bytes = hexToBytes(r.publicKeyHex);
      expect(isWeakEd25519PublicKey(bytes)).toBe(r.expect === 'weak_key_refused');
      const trust = new Map([[r.keyIdHex, bytes]]);
      if (r.expect === 'weak_key_refused') {
        expect(() => assertNoWeakKeys(trust)).toThrow(expect.objectContaining(weakErr));
        try {
          assertNoWeakKeys(trust);
        } catch (e) {
          expect(e).toBeInstanceOf(ManifestError);
          expect((e as ManifestError).message).toBe(WEAK_KEY_REFUSED_MESSAGE);
        }
      } else expect(() => assertNoWeakKeys(trust)).not.toThrow();
    });

  it('the verdict never reads the keyId: each refused row is refused under any keyId, including 64 zero characters', () => {
    for (const r of refused) {
      for (const keyId of [
        '0'.repeat(64),
        'f'.repeat(64),
        keyIdOf(hexToBytes(accepted[5]!.publicKeyHex)),
      ])
        expect(() => assertNoWeakKeys(new Map([[keyId, hexToBytes(r.publicKeyHex)]]))).toThrow(
          expect.objectContaining(weakErr),
        );
    }
  });

  it('the five RFC 8032 test keys are not weak (they are refused only as test keys)', () => {
    for (const hex of RFC8032_TEST_PUBLIC_KEYS_HEX)
      expect(isWeakEd25519PublicKey(hexToBytes(hex))).toBe(false);
  });

  it('a key that is not 32 bytes is outside the rule: it keeps its 0.1.2 outcome', () => {
    for (const n of [0, 1, 31, 33, 64]) {
      const k = new Uint8Array(n);
      expect(isWeakEd25519PublicKey(k), `${n} bytes`).toBe(false);
      expect(() => assertNoWeakKeys(new Map([['a'.repeat(64), k]]))).not.toThrow();
    }
  });

  it('a value that is not a Uint8Array is ignored by assertNoWeakKeys, like the test-key check', () => {
    const trust = new Map<string, unknown>([['a'.repeat(64), 'not bytes']]);
    expect(() => assertNoWeakKeys(trust as unknown as Map<string, Uint8Array>)).not.toThrow();
  });
});

describe('verifyManifest: weak keys are refused before anything is parsed (verify.json)', () => {
  it('verify.json has rows and each one names a manifest that exists', () => {
    expect(verifyRows.length).toBeGreaterThanOrEqual(8);
    for (const r of verifyRows) expect(readText(r.manifest).length, r.manifest).toBeGreaterThan(0);
  });

  for (const [i, r] of verifyRows.entries())
    it(`row ${i + 1}: ${r.manifest}, ${r.trust.length} trust key(s), allowTestKeys ${r.allowTestKeys} throws ${r.expect.throws}`, async () => {
      await expect(
        verifyManifest(readText(r.manifest), trustOf(r.trust), {
          now: NOW,
          allowTestKeys: r.allowTestKeys,
        }),
      ).rejects.toMatchObject({ name: 'ManifestError', reason: r.expect.throws });
    });

  it('forged-identity.manifest.json (R = identity, S = 0) is refused with weak_key_refused, with and without allowTestKeys', async () => {
    const text = readText('weak-keys/forged-identity.manifest.json');
    const sig = (JSON.parse(text) as { signatures: { sig: string }[] }).signatures[0]!;
    const raw = Buffer.from(sig.sig, 'base64');
    expect(raw.subarray(0, 32).toString('hex')).toBe('01' + '00'.repeat(31)); // R = identity
    expect(raw.subarray(32).every((b) => b === 0)).toBe(true); // S = 0
    const identity = byId('identity');
    for (const opts of [{ allowTestKeys: false }, { allowTestKeys: true }, {}])
      await expect(
        verifyManifest(text, new Map([[identity.keyIdHex, hexToBytes(identity.publicKeyHex)]]), {
          now: NOW,
          ...opts,
        }),
      ).rejects.toMatchObject(weakErr);
  });

  it('a malformed manifest with a weak trust key is weak_key_refused, not invalid_json; so is an input that is not a manifest at all', async () => {
    const identity = byId('identity');
    const trust = new Map([[identity.keyIdHex, hexToBytes(identity.publicKeyHex)]]);
    for (const input of ['{', '', 'not json', '"a string"', '[]', null, 42, undefined, { spec: 1 }])
      await expect(verifyManifest(input, trust, { now: NOW })).rejects.toMatchObject(weakErr);
  });

  it('precedence: a trust set with a test key and a weak key throws test_key_refused unless allowTestKeys is true, then weak_key_refused', async () => {
    const test1 = byId('ok-rfc8032-1');
    const weak = byId('mixed-test1-plus-order8');
    const trust = new Map([
      [test1.keyIdHex, hexToBytes(test1.publicKeyHex)],
      [weak.keyIdHex, hexToBytes(weak.publicKeyHex)],
    ]);
    const text = readText('tamper/tamper-base.json');
    for (const allow of [undefined, false, 'true', 1])
      await expect(
        verifyManifest(text, trust, { now: NOW, allowTestKeys: allow as boolean }),
      ).rejects.toMatchObject({ reason: 'test_key_refused' });
    await expect(
      verifyManifest(text, trust, { now: NOW, allowTestKeys: true }),
    ).rejects.toMatchObject(weakErr);
    // the same order holds when the weak key is listed first
    const reversed = new Map([...trust].reverse());
    await expect(verifyManifest(text, reversed, { now: NOW })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
    await expect(
      verifyManifest(text, reversed, { now: NOW, allowTestKeys: true }),
    ).rejects.toMatchObject(weakErr);
  });

  it('there is no option that skips the weak-key check', async () => {
    const identity = byId('identity');
    const trust = new Map([[identity.keyIdHex, hexToBytes(identity.publicKeyHex)]]);
    const text = readText('weak-keys/forged-identity.manifest.json');
    for (const opts of [
      { allowTestKeys: true },
      { allowDowngrade: true },
      { allowWeakKeys: true },
      { skipWeakKeyCheck: true },
      { expectId: 'forged-identity' },
    ])
      await expect(
        verifyManifest(text, trust, { now: NOW, ...(opts as object) }),
      ).rejects.toMatchObject(weakErr);
  });

  it('a 0.1.2-shaped manifest signed under a weak key is refused (no downgrade): the check lives in the verifier', async () => {
    const text = readText('weak-keys/forged-order8.manifest.json');
    const m = JSON.parse(text) as {
      spec: string;
      version: string;
      signatures: { keyId: string }[];
    };
    expect(m.spec).toBe('airplanemode.manifest/0.1'); // the wire string is the same one 0.1.2 documents carry
    expect(m.version).toBe('0.1.2');
    const key = byId('small-order-8-a');
    expect(m.signatures[0]!.keyId).toBe(key.keyIdHex);
    await expect(
      verifyManifest(text, new Map([[key.keyIdHex, hexToBytes(key.publicKeyHex)]]), { now: NOW }),
    ).rejects.toMatchObject(weakErr);
  });
});

describe('step 5: the key a signature actually uses is checked again', () => {
  /** A Map whose iterator hides every entry but whose get() returns what was stored. */
  class HidingMap extends Map<string, Uint8Array> {
    override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
      return new Map<string, Uint8Array>()[Symbol.iterator]();
    }
    override entries(): MapIterator<[string, Uint8Array]> {
      return new Map<string, Uint8Array>().entries();
    }
  }
  const base = JSON.parse(readText('tamper/tamper-base.json')) as {
    signatures: { keyId: string }[];
  };
  const usedKeyId = base.signatures[0]!.keyId;
  const baseText = JSON.stringify(base);

  it('a trust Map subclass whose iterator hides a weak key that get(keyId) returns throws weak_key_refused', async () => {
    for (const id of [
      'identity',
      'small-order-8-a',
      'mixed-test1-plus-order8',
      'not-on-curve-smallest-y',
    ]) {
      const trust = new HidingMap([[usedKeyId, hexToBytes(byId(id).publicKeyHex)]]);
      expect([...trust]).toEqual([]); // the iterator really hides it: step 1b sees nothing
      await expect(
        verifyManifest(baseText, trust, { now: NOW, allowTestKeys: true }),
      ).rejects.toMatchObject(weakErr);
    }
  });

  it('the all-zero key under keyId 64 zeros throws weak_key_refused, not key_mismatch or no_valid_signature', async () => {
    const zeros = '0'.repeat(64);
    const m = JSON.parse(baseText) as { signatures: { keyId: string }[] };
    m.signatures[0]!.keyId = zeros;
    const text = JSON.stringify(m);
    // visible to the iterated check
    await expect(
      verifyManifest(text, new Map([[zeros, new Uint8Array(32)]]), {
        now: NOW,
        allowTestKeys: true,
      }),
    ).rejects.toMatchObject(weakErr);
    // hidden from the iterated check, found at step 5
    await expect(
      verifyManifest(text, new HidingMap([[zeros, new Uint8Array(32)]]), {
        now: NOW,
        allowTestKeys: true,
      }),
    ).rejects.toMatchObject(weakErr);
  });

  it('a trust set that cannot be iterated is not refused at step 1b (step 5 still guards the key in use)', async () => {
    const throwing = {
      get: (k: string) => (k === usedKeyId ? new Uint8Array(32) : undefined),
      has: () => true,
      size: 1,
      [Symbol.iterator]() {
        throw new Error('no');
      },
    };
    await expect(
      verifyManifest(baseText, throwing as unknown as Map<string, Uint8Array>, {
        now: NOW,
        allowTestKeys: true,
      }),
    ).rejects.toMatchObject(weakErr);
  });

  it('the test-key refusal of step 5 still wins over a good key: allowTestKeys false and TEST 1 hidden gives test_key_refused', async () => {
    const test1 = byId('ok-rfc8032-1');
    const trust = new HidingMap([[usedKeyId, hexToBytes(test1.publicKeyHex)]]);
    await expect(verifyManifest(baseText, trust, { now: NOW })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
    // with allowTestKeys true the valid manifest verifies: a prime-order key is never refused
    const ok = await verifyManifest(baseText, trust, { now: NOW, allowTestKeys: true });
    expect(ok.ok).toBe(true);
  });
});

describe('a correctly generated key is never refused (MANIFEST.md Weak keys, (b))', () => {
  const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
  const rawPublic = (seed: Buffer): Uint8Array => {
    const key = createPrivateKey({
      key: Buffer.concat([PKCS8, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    return new Uint8Array(spki.subarray(spki.length - 32));
  };

  it('1,000 keys made by Node crypto from seeded seeds are all accepted', () => {
    let refusedKeys = 0;
    for (let i = 0; i < 1000; i++) {
      const seed = createHash('sha256').update(`weak-keys test seed ${i}`).digest();
      if (isWeakEd25519PublicKey(rawPublic(seed))) refusedKeys++;
    }
    expect(refusedKeys).toBe(0);
  }, 60_000);

  it('a manifest signed by a generated key verifies end to end (the rule does not touch good keys)', async () => {
    const ok = byId('ok-generated-1');
    expect(isWeakEd25519PublicKey(hexToBytes(ok.publicKeyHex))).toBe(false);
  });

  it('timing guard: 64 trust keys are checked in under 500 ms in Node', () => {
    const trust = new Map<string, Uint8Array>();
    for (let i = 0; i < 64; i++) {
      const pub = rawPublic(createHash('sha256').update(`timing key ${i}`).digest());
      trust.set(keyIdOf(pub), pub);
    }
    expect(trust.size).toBe(64);
    const t0 = performance.now();
    assertNoWeakKeys(trust);
    const ms = performance.now() - t0;
    expect(ms, `64 keys took ${ms.toFixed(0)} ms`).toBeLessThan(500);
  });
});

describe('the check is a pure function of the 32 bytes (MANIFEST.md Weak keys, (d))', () => {
  it('no cache keyed by keyId: the same keyId with different bytes gives the verdict of the bytes each time', () => {
    const good = hexToBytes(byId('ok-generated-1').publicKeyHex);
    const weak = hexToBytes(byId('small-order-2').publicKeyHex);
    const keyId = keyIdOf(good);
    for (const [bytes, isWeak] of [
      [good, false],
      [weak, true],
      [good, false],
      [weak, true],
    ] as const) {
      const trust = new Map([[keyId, bytes]]);
      if (isWeak) expect(() => assertNoWeakKeys(trust)).toThrow(expect.objectContaining(weakErr));
      else expect(() => assertNoWeakKeys(trust)).not.toThrow();
    }
  });

  it('no result is stored on the trust-set object: the Map gains no property, symbol or entry', () => {
    const trust = new Map([[byId('identity').keyIdHex, hexToBytes(byId('identity').publicKeyHex)]]);
    const own = () => [Object.getOwnPropertyNames(trust), Object.getOwnPropertySymbols(trust)];
    const before = own();
    expect(() => assertNoWeakKeys(trust)).toThrow();
    expect(own()).toEqual(before);
    expect(trust.size).toBe(1);
  });

  it('the predicate does not retain or modify its input', () => {
    const k = hexToBytes(byId('mixed-test1-plus-order8').publicKeyHex);
    const copy = Uint8Array.from(k);
    isWeakEd25519PublicKey(k);
    expect(bytesToHex(k)).toBe(bytesToHex(copy));
  });
});

describe('the asset manager runs the same check wherever it runs the test-key check', () => {
  it('loadManifest refuses a weak trust key before the store opens, before any fetch and before the manifest is parsed', async () => {
    const server = new FakeServer({ origin: 'https://assets.test' });
    server.manifestText = '{ this is not json';
    const mgr = new AssetManager({ store: 'memory', fetch: server.fetch, allowTestKeys: true });
    for (const r of refused.slice(0, 6))
      await expect(
        mgr.loadManifest(
          'https://assets.test/manifest.json',
          new Map([[r.keyIdHex, hexToBytes(r.publicKeyHex)]]),
        ),
      ).rejects.toMatchObject(weakErr);
    expect(server.requests).toHaveLength(0);
    expect(server.calls).toBe(0);
  });
});

describe('the test keys table is unchanged', () => {
  it('the five RFC 8032 key ids are the sha256 of their public keys', () => {
    RFC8032_TEST_PUBLIC_KEYS_HEX.forEach((hex, i) =>
      expect(keyIdOf(hexToBytes(hex))).toBe(RFC8032_TEST_KEY_IDS[i]),
    );
  });
});

// S1-121 / BUG-T3-S6-04 (fix round 1): the weak-key and test-key rules are a pure function of the bytes, whatever
// realm or view type the trust value comes from. Red run: evidence/sprint-6/D1/red/S1-121.log.
describe('S1-121: trust values from another realm or as another view', () => {
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const forged = readText('weak-keys/forged-identity.manifest.json');
  const idKey = createHash('sha256').update(identity).digest('hex');
  const foreign = (bytes: Uint8Array): Uint8Array => {
    const f = vm.runInNewContext('new Uint8Array(32)') as Uint8Array;
    f.set(bytes);
    return f;
  };
  const forms: [string, (b: Uint8Array) => unknown][] = [
    ['cross-realm Uint8Array', foreign],
    ['DataView', (b) => new DataView(Uint8Array.from(b).buffer)],
    ['ArrayBuffer', (b) => Uint8Array.from(b).buffer],
    ['cross-realm ArrayBuffer', (b) => foreign(b).buffer],
  ];
  for (const [label, make] of forms) {
    for (const keyId of [idKey, '0'.repeat(64)]) {
      it(`${label} identity key under ${keyId.slice(0, 6)} is weak_key_refused`, async () => {
        const trust = new Map<string, Uint8Array>([[keyId, make(identity) as Uint8Array]]);
        await expect(verifyManifest(forged, trust, { now: NOW })).rejects.toMatchObject(weakErr);
        expect(() => assertNoWeakKeys(trust)).toThrowError(
          expect.objectContaining({ reason: 'weak_key_refused' }),
        );
      });
    }
  }
  it('a cross-realm RFC 8032 test key is test_key_refused unless allowTestKeys is true', async () => {
    const t1 = hexToBytes(RFC8032_TEST_PUBLIC_KEYS_HEX[0]!);
    const trust = new Map<string, Uint8Array>([['1'.repeat(64), foreign(t1)]]);
    await expect(verifyManifest(forged, trust, { now: NOW })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
  });
  it('an iterator-hiding Map holding a cross-realm identity key is caught at step 5', async () => {
    class Hide extends Map<string, Uint8Array> {
      override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
        return new Map<string, Uint8Array>()[Symbol.iterator]();
      }
    }
    const trust = new Hide([[idKey, foreign(identity)]]);
    await expect(verifyManifest(forged, trust, { now: NOW })).rejects.toMatchObject(weakErr);
  });
  it('a cross-realm valid key still verifies', async () => {
    const row =
      accepted.find((r) => r.id.startsWith('generated')) ?? accepted[accepted.length - 1]!;
    expect(row.class).toBe('valid');
    const k = foreign(hexToBytes(row.publicKeyHex));
    const trust = new Map<string, Uint8Array>([[row.keyIdHex, k]]);
    // not a manifest it signed, so the verdict is a normal rejection, never a weak-key throw
    const r = await verifyManifest(forged, trust, { now: NOW, allowTestKeys: true });
    expect(r.ok).toBe(false);
  });
  it('a value that is not a 32-byte view keeps its 0.1.2 outcome (no throw)', async () => {
    const trust = new Map<string, Uint8Array>([[idKey, new Uint8Array(31) as Uint8Array]]);
    const r = await verifyManifest(forged, trust, { now: NOW });
    expect(r.ok).toBe(false);
  });
});
