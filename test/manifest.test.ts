import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../spec/manifest';
import { EventBus } from '../src/events';
import {
  InMemoryManifestState,
  ManifestError,
  RFC8032_TEST_KEY_ID,
  parseManifest,
  verifyManifest,
} from '../src/manifest';
import { compareSemver } from '../src/semver';
import {
  OTHER_KEY_ID,
  OTHER_PUBLIC,
  OTHER_SEED_HEX,
  RFC8032_KEY_ID,
  RFC8032_PUBLIC,
  b64,
  makeEntry,
  makeManifest,
  makeSignature,
  otherTrust,
  readText,
  signManifest,
  specDir,
  testTrust,
} from './helpers';

const T0 = Date.parse('2026-11-10T00:00:00Z');
const opts = { allowTestKeys: true, now: T0 } as const;

async function expectReason(p: Promise<unknown>, reason: string) {
  const r = (await p) as { ok: boolean; reason?: string };
  expect(r.ok).toBe(false);
  expect(r.reason).toBe(reason);
}

describe('parseManifest', () => {
  it('parses the signed example from text', () => {
    const m = parseManifest(readText(resolve(specDir, 'examples/manifest.signed.example.json')));
    expect(m.id).toBe('dev.airplanemode.examples.tiny');
  });

  it('accepts an already-parsed object', () => {
    expect(parseManifest(makeManifest()).id).toBe('dev.airplanemode.test');
  });

  it('rejects invalid JSON text', () => {
    expect(() => parseManifest('{')).toThrow(ManifestError);
  });

  it('rejects floats before schema validation', () => {
    const text = JSON.stringify(makeManifest()).replace('"size":0', '"size":0.5');
    expect(() => parseManifest(text)).toThrow(expect.objectContaining({ reason: 'float' }));
  });

  it('rejects integers above 2^53-1', () => {
    const text = JSON.stringify(makeManifest()).replace('"size":0', '"size":9007199254740992');
    expect(() => parseManifest(text)).toThrow(expect.objectContaining({ reason: 'bigint' }));
  });

  it('accepts 1.0 and 1e3 spellings (documented asymmetry with Rust)', () => {
    const text = JSON.stringify(makeManifest()).replace('"size":0', '"size":1.0');
    expect(parseManifest(text).entries[0]!.size).toBe(1);
    const text2 = JSON.stringify(makeManifest()).replace('"size":0', '"size":1e3');
    expect(parseManifest(text2).entries[0]!.size).toBe(1000);
  });

  it('rejects digit-leading keys anywhere', () => {
    const text = JSON.stringify(makeManifest()).replace(
      '"minProfile":{}',
      '"minProfile":{"b":1,"10":2,"a":3}',
    );
    expect(() => parseManifest(text)).toThrow(expect.objectContaining({ reason: 'digit_key' }));
  });

  it('rejects lone surrogates in any string', () => {
    const text = JSON.stringify(makeManifest()).replace('"Airplane Mode Labs (test)"', '"\\ud800"');
    expect(() => parseManifest(text)).toThrow(
      expect.objectContaining({ reason: 'lone_surrogate' }),
    );
  });

  it('rejects a wrong spec string with bad_spec', () => {
    expect(() => parseManifest({ ...makeManifest(), spec: 'airplanemode.manifest/0.2' })).toThrow(
      expect.objectContaining({ reason: 'bad_spec' }),
    );
  });

  it('rejects unsorted entries and duplicate entries', () => {
    expect(() =>
      parseManifest(makeManifest({ entries: [makeEntry('b'), makeEntry('a')] })),
    ).toThrow(expect.objectContaining({ reason: 'unsorted_entries' }));
    expect(() =>
      parseManifest(makeManifest({ entries: [makeEntry('a'), makeEntry('a')] })),
    ).toThrow(expect.objectContaining({ reason: 'duplicate_entries' }));
  });

  it('sorts by byte order: m-x < m.x < m_x < mx', () => {
    const ok = makeManifest({ entries: ['m-x', 'm.x', 'm_x', 'mx'].map((id) => makeEntry(id)) });
    expect(() => parseManifest(ok)).not.toThrow();
    const bad = makeManifest({ entries: ['m.x', 'm-x'].map((id) => makeEntry(id)) });
    expect(() => parseManifest(bad)).toThrow(
      expect.objectContaining({ reason: 'unsorted_entries' }),
    );
  });

  it('rejects http:// to a non-loopback host, data: and blob: urls with bad_url', () => {
    for (const url of [
      'http://example.com/a',
      'data:application/octet-stream;base64,AA==',
      'blob:https://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://example.com/a?x=1',
      'https://example.com/a#frag',
      'assets/a?x=1',
    ]) {
      expect(
        () => parseManifest(makeManifest({ entries: [makeEntry('a', { url })] })),
        url,
      ).toThrow(expect.objectContaining({ reason: 'bad_url' }));
    }
  });

  it('accepts https, loopback http and relative urls', () => {
    for (const url of [
      'https://example.com/a',
      'http://127.0.0.1:8080/assets/a',
      'http://localhost/a',
      'http://[::1]:9/a',
      'assets/a',
      './a',
      '../a',
    ]) {
      expect(
        () => parseManifest(makeManifest({ entries: [makeEntry('a', { url })] })),
        url,
      ).not.toThrow();
    }
  });

  it('rejects calendar-invalid or non-round-tripping RFC 3339 timestamps with schema (S1-014)', () => {
    const bad = [
      '2026-99-99T00:00:00Z',
      '2026-02-30T25:61:61Z',
      '2026-02-29T00:00:00Z', // 2026 is not a leap year
      '2026-13-01T00:00:00Z',
      '2026-11-09T24:00:00Z',
      '2026-11-09T00:60:00Z',
      '2026-11-09T00:00:60Z',
      '0000-00-00T00:00:00Z',
    ];
    for (const createdAt of bad) {
      expect(() => parseManifest(makeManifest({ createdAt })), createdAt).toThrow(
        expect.objectContaining({ reason: 'schema' }),
      );
      expect(() => parseManifest(makeManifest({ expiresAt: createdAt })), createdAt).toThrow(
        expect.objectContaining({ reason: 'schema' }),
      );
      const m = signManifest(makeManifest());
      m.signatures[0]!.signedAt = createdAt;
      expect(() => parseManifest(m), createdAt).toThrow(
        expect.objectContaining({ reason: 'schema' }),
      );
    }
    for (const ok of ['2028-02-29T00:00:00Z', '2026-12-31T23:59:59Z', '1970-01-01T00:00:00Z']) {
      expect(() => parseManifest(makeManifest({ createdAt: ok })), ok).not.toThrow();
    }
  });

  it('accepts any lowercase alg token at parse time; verification decides (S1-011)', () => {
    const base = makeManifest();
    const good = makeSignature(base);
    expect(() =>
      parseManifest({ ...base, signatures: [{ ...good, alg: 'ml-dsa-65' }, good] }),
    ).not.toThrow();
    expect(() => parseManifest({ ...base, signatures: [{ ...good, alg: 'none' }] })).not.toThrow();
    for (const alg of ['ED25519', '', '-x', 'a'.repeat(33), 'has space']) {
      expect(() => parseManifest({ ...base, signatures: [{ ...good, alg }] }), alg).toThrow(
        expect.objectContaining({ reason: 'schema' }),
      );
    }
  });

  it('rejects extra properties and missing required fields with schema', () => {
    expect(() => parseManifest({ ...makeManifest(), extra: 1 })).toThrow(
      expect.objectContaining({ reason: 'schema' }),
    );
    const { publisher: _p, ...rest } = makeManifest();
    expect(() => parseManifest(rest)).toThrow(expect.objectContaining({ reason: 'schema' }));
  });

  it('rejects an empty entries array', () => {
    expect(() => parseManifest(makeManifest({ entries: [] }))).toThrow(
      expect.objectContaining({ reason: 'schema' }),
    );
  });
});

describe('verifyManifest: signatures', () => {
  it('verifies the signed example with the RFC 8032 key (allowTestKeys) and emits manifest.verify.ok', async () => {
    const m = parseManifest(readText(resolve(specDir, 'examples/manifest.signed.example.json')));
    const events = new EventBus();
    const r = await verifyManifest(m, testTrust(), { ...opts, events });
    expect(r.ok).toBe(true);
    expect(r.signatures).toEqual([{ keyId: RFC8032_KEY_ID, valid: true }]);
    const names = events.snapshot().map((e) => e.name);
    expect(names).toContain('manifest.verify.ok');
  });

  it('throws when the trust set contains the RFC 8032 key without allowTestKeys', async () => {
    const m = signManifest(makeManifest());
    expect(RFC8032_TEST_KEY_ID).toBe(RFC8032_KEY_ID);
    await expect(verifyManifest(m, testTrust(), { now: T0 })).rejects.toThrow(
      expect.objectContaining({ reason: 'test_key_refused' }),
    );
  });

  it('does not throw for a trust set without the test key, even without allowTestKeys', async () => {
    const m = signManifest(makeManifest(), OTHER_SEED_HEX);
    const r = await verifyManifest(m, otherTrust(), { now: T0 });
    expect(r.ok).toBe(true);
  });

  it('rejects a tampered byte in a sha256 with no_valid_signature', async () => {
    const m = signManifest(makeManifest());
    const e = m.entries[0]!;
    const tampered: Manifest = {
      ...m,
      entries: [{ ...e, sha256: '1' + e.sha256.slice(1) }],
    };
    const r = await verifyManifest(tampered, testTrust(), opts);
    expect(r).toMatchObject({ ok: false, reason: 'no_valid_signature' });
    expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a signature made with a different key (wrong key)', async () => {
    const m = signManifest(makeManifest(), OTHER_SEED_HEX);
    // Trust set maps the RFC key id but the signature is by OTHER: keyId not in trust set.
    const r = await verifyManifest(m, testTrust(), opts);
    expect(r.ok).toBe(false);
    expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'untrusted_key' });
  });

  it('rejects keyId not in the trust set', async () => {
    const m = signManifest(makeManifest());
    const r = await verifyManifest(m, otherTrust(), { now: T0 });
    expect(r.ok).toBe(false);
    expect(r.signatures[0]).toMatchObject({
      keyId: RFC8032_KEY_ID,
      valid: false,
      reason: 'untrusted_key',
    });
  });

  it('embedded publicKey mismatching the trusted key => invalid with reason key_mismatch', async () => {
    const base = makeManifest();
    const sig = makeSignature(base);
    sig.publicKey = b64(OTHER_PUBLIC);
    const r = await verifyManifest({ ...base, signatures: [sig] }, testTrust(), opts);
    expect(r.ok).toBe(false);
    expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'key_mismatch' });
  });

  it('embedded publicKey that matches is fine; absent publicKey is fine', async () => {
    const base = makeManifest();
    const withKey = makeSignature(base, undefined, { includePublicKey: true });
    const noKey = makeSignature(base, undefined, { includePublicKey: false });
    expect((await verifyManifest({ ...base, signatures: [withKey] }, testTrust(), opts)).ok).toBe(
      true,
    );
    expect((await verifyManifest({ ...base, signatures: [noKey] }, testTrust(), opts)).ok).toBe(
      true,
    );
  });

  it('sig of 63 or 65 bytes => invalid (malformed_sig), never throws', async () => {
    const base = makeManifest();
    for (const len of [63, 65, 0, 1]) {
      const sig = makeSignature(base);
      sig.sig = b64(new Uint8Array(len));
      const r = await verifyManifest({ ...base, signatures: [sig] }, testTrust(), opts);
      expect(r.ok).toBe(false);
      expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'malformed_sig' });
    }
  });

  it('non-base64 sig => malformed_sig, never throws', async () => {
    const base = makeManifest();
    const sig = makeSignature(base);
    sig.sig = '!!!not base64!!!';
    const r = await verifyManifest({ ...base, signatures: [sig] }, testTrust(), opts);
    expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'malformed_sig' });
  });

  it('malformed keyId => invalid (malformed_key_id), never throws', async () => {
    const base = makeManifest();
    for (const keyId of ['abc', 'G'.repeat(64), RFC8032_KEY_ID.toUpperCase(), '']) {
      const sig = { ...makeSignature(base), keyId };
      const r = await verifyManifest({ ...base, signatures: [sig] }, testTrust(), opts);
      expect(r.ok).toBe(false);
      expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'malformed_key_id' });
    }
  });

  it('unknown alg only => ignored, manifest fails with no_valid_signature; "none" is never valid', async () => {
    const base = makeManifest();
    for (const alg of ['none', 'rsa-pss', 'ED25519']) {
      const sig = { ...makeSignature(base), alg };
      const r = await verifyManifest({ ...base, signatures: [sig] }, testTrust(), opts);
      expect(r).toMatchObject({ ok: false, reason: 'no_valid_signature' });
      expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'unknown_alg' });
    }
  });

  it('an unknown-alg signature beside a valid ed25519 one is ignored and the manifest passes', async () => {
    const base = makeManifest();
    const good = makeSignature(base);
    const weird = { ...makeSignature(base), alg: 'future-pq' };
    const r = await verifyManifest({ ...base, signatures: [weird, good] }, testTrust(), opts);
    expect(r.ok).toBe(true);
    expect(r.signatures.map((s) => s.valid)).toEqual([false, true]);
  });

  it('empty signatures array => no_valid_signature', async () => {
    await expectReason(verifyManifest(makeManifest(), testTrust(), opts), 'no_valid_signature');
  });

  it('a manifest signed by two keys verifies when only one is trusted', async () => {
    const m = signManifest(signManifest(makeManifest()), OTHER_SEED_HEX);
    const r = await verifyManifest(m, testTrust(), opts);
    expect(r.ok).toBe(true);
    expect(r.signatures).toEqual([
      { keyId: RFC8032_KEY_ID, valid: true },
      { keyId: OTHER_KEY_ID, valid: false, reason: 'untrusted_key' },
    ]);
  });

  it('a corrupt trust set entry (wrong key length) is an invalid signature, not a throw', async () => {
    const m = signManifest(makeManifest());
    const trust = new Map([[RFC8032_KEY_ID, new Uint8Array(31)]]);
    const r = await verifyManifest(m, trust, opts);
    expect(r.ok).toBe(false);
    expect(r.signatures[0]!.valid).toBe(false);
  });

  it('a trust set whose key bytes do not hash to its keyId is an invalid signature (key_mismatch)', async () => {
    const m = signManifest(makeManifest());
    const trust = new Map([[RFC8032_KEY_ID, OTHER_PUBLIC]]);
    const r = await verifyManifest(m, trust, opts);
    expect(r.ok).toBe(false);
    expect(r.signatures[0]).toMatchObject({ valid: false, reason: 'key_mismatch' });
  });
});

describe('verifyManifest: parse-level agility and malformed input', () => {
  it('[unknown-alg, valid ed25519] passes through parseManifest and verifies (S1-011)', async () => {
    const base = makeManifest();
    const good = makeSignature(base);
    const text = JSON.stringify({ ...base, signatures: [{ ...good, alg: 'ml-dsa-65' }, good] });
    const parsed = parseManifest(text);
    const r = await verifyManifest(parsed, testTrust(), opts);
    expect(r.ok).toBe(true);
    expect(r.signatures.map((s) => s.valid)).toEqual([false, true]);
    expect(r.signatures[0]!.reason).toBe('unknown_alg');
  });

  it('[unknown-alg only] passes parseManifest and fails verification with no_valid_signature (S1-011)', async () => {
    const base = makeManifest();
    const good = makeSignature(base);
    const parsed = parseManifest(
      JSON.stringify({ ...base, signatures: [{ ...good, alg: 'future-pq' }] }),
    );
    await expectReason(verifyManifest(parsed, testTrust(), opts), 'no_valid_signature');
  });

  it('verifyManifest never throws for an unparsed object, even with an events sink (S1-012)', async () => {
    const events = new EventBus();
    const probeC = {
      spec: 'airplanemode.manifest/0.1',
      entries: [],
      signatures: [],
      expiresAt: '2000-01-01T00:00:00Z',
    };
    const r = await verifyManifest(probeC as unknown as Manifest, testTrust(), { ...opts, events });
    expect(r).toMatchObject({ ok: false, reason: 'schema' });
    const failed = events.snapshot().find((e) => e.name === 'manifest.verify.failed');
    expect(failed?.attrs['reason']).toBe('schema');
    expect(typeof failed?.attrs['manifestId']).toBe('string');
    for (const junk of [null, 42, 'text', [], { id: 7, version: null }, { spec: 'x' }]) {
      const rr = await verifyManifest(junk as unknown as Manifest, testTrust(), {
        ...opts,
        events,
      });
      expect(rr.ok, JSON.stringify(junk)).toBe(false);
    }
  });

  it('a float, bigint or digit-leading key in an unparsed object reports the precise parse reason', async () => {
    const base = signManifest(makeManifest());
    const withFloat = { ...base, entries: [{ ...base.entries[0]!, size: 1.5 }] };
    await expectReason(verifyManifest(withFloat as Manifest, testTrust(), opts), 'float');
  });
});

describe('verifyManifest: state store failures (S1-013)', () => {
  const throwing = {
    get: async () => {
      throw new Error('io');
    },
    set: async () => {},
  };

  it('fails closed with reason state and emits manifest.verify.failed reason state_unavailable', async () => {
    const events = new EventBus();
    const r = await verifyManifest(signManifest(makeManifest()), testTrust(), {
      ...opts,
      state: throwing,
      events,
    });
    expect(r).toMatchObject({ ok: false, reason: 'state' });
    expect(r.signatures[0]!.valid).toBe(true);
    const failed = events.snapshot().find((e) => e.name === 'manifest.verify.failed');
    expect(failed?.attrs['reason']).toBe('state_unavailable');
    expect(events.snapshot().some((e) => e.name === 'manifest.verify.ok')).toBe(false);
  });

  it('allowDowngrade: true bypasses an unreadable state store', async () => {
    const r = await verifyManifest(signManifest(makeManifest()), testTrust(), {
      ...opts,
      state: throwing,
      allowDowngrade: true,
    });
    expect(r.ok).toBe(true);
  });

  it('a failing state.set() after acceptance is also reason state (no silent acceptance)', async () => {
    const state = {
      get: async () => undefined,
      set: async () => {
        throw new Error('io');
      },
    };
    const r = await verifyManifest(signManifest(makeManifest()), testTrust(), { ...opts, state });
    expect(r).toMatchObject({ ok: false, reason: 'state' });
  });
});

describe('verifyManifest: expiry', () => {
  it('rejects an expired manifest with reason expired', async () => {
    const m = signManifest(makeManifest({ expiresAt: '2026-11-09T12:00:00Z' }));
    await expectReason(verifyManifest(m, testTrust(), opts), 'expired');
  });

  it('accepts a manifest whose expiresAt is in the future', async () => {
    const m = signManifest(makeManifest({ expiresAt: '2027-01-01T00:00:00Z' }));
    expect((await verifyManifest(m, testTrust(), opts)).ok).toBe(true);
  });

  it('expiresAt equal to now is expired (requires expiresAt > now)', async () => {
    const m = signManifest(makeManifest({ expiresAt: '2026-11-10T00:00:00Z' }));
    await expectReason(verifyManifest(m, testTrust(), opts), 'expired');
  });

  it('a manifest without expiresAt never expires', async () => {
    const m = signManifest(makeManifest());
    const far = Date.parse('2099-01-01T00:00:00Z');
    expect((await verifyManifest(m, testTrust(), { ...opts, now: far })).ok).toBe(true);
  });

  it('expiry is checked before signatures (an expired unsigned manifest reports expired)', async () => {
    const m = makeManifest({ expiresAt: '2026-11-09T12:00:00Z' });
    await expectReason(verifyManifest(m, testTrust(), opts), 'expired');
  });
});

describe('verifyManifest: downgrade rule', () => {
  const T = '2026-11-09T00:00:00Z';
  const accepted = (version: string, createdAt = T) =>
    signManifest(makeManifest({ version, createdAt }));

  async function stateAfter120() {
    const state = new InMemoryManifestState();
    const r = await verifyManifest(accepted('1.2.0'), testTrust(), { ...opts, state });
    expect(r.ok).toBe(true);
    expect(await state.get('dev.airplanemode.test')).toEqual({ version: '1.2.0', createdAt: T });
    return state;
  }

  it('after accepting 1.2.0, refuses 1.1.9 with reason downgrade and emits manifest.verify.failed', async () => {
    const state = await stateAfter120();
    const events = new EventBus();
    await expectReason(
      verifyManifest(accepted('1.1.9'), testTrust(), { ...opts, state, events }),
      'downgrade',
    );
    const failed = events.snapshot().find((e) => e.name === 'manifest.verify.failed');
    expect(failed?.attrs['reason']).toBe('downgrade');
    expect(await state.get('dev.airplanemode.test')).toEqual({ version: '1.2.0', createdAt: T });
  });

  it('refuses 1.2.0 with createdAt earlier than the accepted one', async () => {
    const state = await stateAfter120();
    await expectReason(
      verifyManifest(accepted('1.2.0', '2026-11-08T23:59:59Z'), testTrust(), { ...opts, state }),
      'downgrade',
    );
  });

  it('accepts 1.2.0 with the same createdAt (re-verification of the same manifest)', async () => {
    const state = await stateAfter120();
    expect((await verifyManifest(accepted('1.2.0', T), testTrust(), { ...opts, state })).ok).toBe(
      true,
    );
  });

  it('refuses 1.2.0-rc.1 (prerelease is lower than the release)', async () => {
    const state = await stateAfter120();
    await expectReason(
      verifyManifest(accepted('1.2.0-rc.1'), testTrust(), { ...opts, state }),
      'downgrade',
    );
  });

  it('accepts 1.2.1 and 1.3.0 and replaces the state', async () => {
    const state = await stateAfter120();
    expect((await verifyManifest(accepted('1.2.1'), testTrust(), { ...opts, state })).ok).toBe(
      true,
    );
    expect((await state.get('dev.airplanemode.test'))?.version).toBe('1.2.1');
    expect((await verifyManifest(accepted('1.3.0'), testTrust(), { ...opts, state })).ok).toBe(
      true,
    );
    expect((await state.get('dev.airplanemode.test'))?.version).toBe('1.3.0');
  });

  it('allowDowngrade accepts and replaces the state', async () => {
    const state = await stateAfter120();
    const r = await verifyManifest(accepted('1.1.9'), testTrust(), {
      ...opts,
      state,
      allowDowngrade: true,
    });
    expect(r.ok).toBe(true);
    expect(await state.get('dev.airplanemode.test')).toEqual({ version: '1.1.9', createdAt: T });
  });

  it('state is keyed by manifest id: a different id is unaffected', async () => {
    const state = await stateAfter120();
    const other = signManifest(makeManifest({ id: 'dev.airplanemode.other', version: '0.0.1' }));
    expect((await verifyManifest(other, testTrust(), { ...opts, state })).ok).toBe(true);
  });

  it('a failing signature does not touch the state', async () => {
    const state = await stateAfter120();
    const r = await verifyManifest(makeManifest({ version: '9.9.9' }), testTrust(), {
      ...opts,
      state,
    });
    expect(r.ok).toBe(false);
    expect((await state.get('dev.airplanemode.test'))?.version).toBe('1.2.0');
  });
});

describe('compareSemver', () => {
  const cases: [string, string, number][] = [
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.1', -1],
    ['1.2.0', '1.1.9', 1],
    ['1.10.0', '1.9.0', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta', '1.0.0-beta.2', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-beta.11', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.2.0-rc.1', '1.2.0', -1],
    ['2.0.0', '1.99.99', 1],
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} vs ${b} = ${expected}`, () => {
      expect(compareSemver(a, b)).toBe(expected);
      expect(compareSemver(b, a)).toBe(-expected || 0);
    });
  }
  it('rejects malformed versions', () => {
    expect(() => compareSemver('1.0', '1.0.0')).toThrow();
    expect(() => compareSemver('1.0.0+build', '1.0.0')).toThrow();
    expect(() => compareSemver('01.0.0', '1.0.0')).toThrow();
  });
});
