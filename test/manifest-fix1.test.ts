// Fix round 1 (team decision TD-26, 14 Nov 2026): manifest 0.1.1 is amended in place before the first push.
//   - strict SemVer 2.0 for Manifest.version and ManifestEntry.version, one grammar everywhere (BUG-T2-S4-04);
//   - compareSemver compares numeric identifiers exactly (BUG-T2-S4-05);
//   - verifyManifest runs the parse stage over the whole text, signatures[] included, and applies the
//     published Signature schema to every item (BUG-T2-S4-02);
//   - the signatures is-an-array check comes after the parse-stage checks (BUG-T2-S4-03);
//   - assertTestKeysAllowed fails closed, and the signature loop refuses a trusted test key (S1-089);
//   - allowDowngrade is stated as an explicit rollback (S1-091); storage-api.md key wording (BUG-T2-S4-10).
// Written before any fix (red run: evidence/sprint-4/D1/red-fix1-D1.log).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_RELEASE, SPEC_STATUS, SPEC_VERSIONS, SPEC_WIRE } from '../spec/index';
import { SEMVER_PATTERN } from '../spec/manifest';
import type { Manifest } from '../spec/manifest';
import {
  InMemoryManifestState,
  ManifestError,
  assertTestKeysAllowed,
  isValidManifestState,
  parseManifest,
  verifyManifest,
  type ManifestState,
  type ManifestStateStore,
} from '../src/manifest';
import { SCHEMAS } from '../src/schema';
import { compareSemver, parseSemver } from '../src/semver';
import {
  OTHER_KEY_ID,
  OTHER_PUBLIC,
  OTHER_SEED_HEX,
  RFC8032_PUBLIC,
  RFC8032_TEST2_PUBLIC,
  b64,
  hexToBytes,
  makeEntry,
  makeManifest,
  makeSignature,
  otherTrust,
  readJson,
  readText,
  signManifest,
  specDir,
  testTrust,
} from './helpers';
import { RFC8032_TEST_KEY_IDS, RFC8032_TEST_PUBLIC_KEYS_HEX } from '../spec/manifest';

const T0 = Date.parse('2026-11-10T00:00:00Z');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const flatTs = (s: string) => flat(s.replace(/\n\s*\*/g, ' '));

/** The grammar of the instruction, character for character. */
const STRICT_SEMVER =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?$';

const GOOD = [
  '0.0.0',
  '1.0.0',
  '10.20.30',
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-0',
  '1.0.0-0a',
  '1.0.0--',
  '1.0.0-a-b.c',
  '1.0.0-x.7.z.92',
  '1.0.0-9007199254740993',
  '1.0.0-rc.1',
  '99999999999999999999.0.0',
];
const BAD = [
  '01.0.0',
  '1.00.0',
  '1.0.00',
  '1.0',
  '1',
  '1.0.0.0',
  '1.0.0-',
  '1.0.0-.',
  '1.0.0-a..b',
  '1.0.0-a.',
  '1.0.0-.a',
  '1.0.0-01',
  '1.0.0-a.01',
  '1.0.0+build',
  '1.0.0-a+b',
  'v1.0.0',
  ' 1.0.0',
  '1.0.0 ',
  '-1.0.0',
  '1.0.0-é',
  '1.0.0\n',
  '',
];

describe('TD-26: strict SemVer 2.0 grammar, one grammar everywhere (BUG-T2-S4-04)', () => {
  it('the schema patterns of Manifest.version and ManifestEntry.version are the strict grammar, and manifest.ts exports it', () => {
    expect(SEMVER_PATTERN).toBe(STRICT_SEMVER);
    const schema = SCHEMAS.manifest as unknown as {
      properties: { version: { pattern: string } };
      $defs: { ManifestEntry: { properties: { version: { pattern: string } } } };
    };
    expect(schema.properties.version.pattern).toBe(STRICT_SEMVER);
    expect(schema.$defs.ManifestEntry.properties.version.pattern).toBe(STRICT_SEMVER);
    const onDisk = readJson<typeof schema>(resolve(specDir, 'manifest.schema.json'));
    expect(onDisk.properties.version.pattern).toBe(STRICT_SEMVER);
    expect(onDisk.$defs.ManifestEntry.properties.version.pattern).toBe(STRICT_SEMVER);
  });

  it('the contract is manifest 0.1.2 (the 0.1.1 wire string is unchanged) in release 0.5.0 on the same wire string', () => {
    expect(SPEC_VERSIONS.manifest).toBe('0.1.2');
    expect(SPEC_RELEASE).toBe('0.5.0');
    expect(SPEC_STATUS.manifest).toBe('published');
    expect(SPEC_WIRE.manifest).toBe('airplanemode.manifest/0.1');
    expect(readJson<{ $id: string }>(resolve(specDir, 'manifest.schema.json')).$id).toBe(
      'urn:airplanemode:spec:manifest:0.1.2',
    );
  });

  for (const v of GOOD) {
    it(`accepts ${JSON.stringify(v)} in the manifest version, an entry version, parseSemver and the stored state`, () => {
      expect(() => parseManifest(makeManifest({ version: v }))).not.toThrow();
      expect(() =>
        parseManifest(makeManifest({ entries: [makeEntry('a', { version: v })] })),
      ).not.toThrow();
      expect(() => parseSemver(v)).not.toThrow();
      expect(isValidManifestState({ version: v, createdAt: '2026-11-09T00:00:00Z' })).toBe(true);
    });
  }

  for (const v of BAD) {
    it(`refuses ${JSON.stringify(v)} everywhere (schema, parseSemver, stored state)`, () => {
      const atManifest = () => parseManifest(makeManifest({ version: v }));
      expect(atManifest, 'manifest version').toThrow(expect.objectContaining({ reason: 'schema' }));
      const atEntry = () =>
        parseManifest(makeManifest({ entries: [makeEntry('a', { version: v })] }));
      expect(atEntry, 'entry version').toThrow(expect.objectContaining({ reason: 'schema' }));
      expect(() => parseSemver(v)).toThrow(RangeError);
      expect(isValidManifestState({ version: v, createdAt: '2026-11-09T00:00:00Z' })).toBe(false);
    });
  }

  it('an accepted manifest can always be stored and read back: no accepted version locks its id into reason state', async () => {
    for (const v of GOOD) {
      const state = new InMemoryManifestState();
      const first = signManifest(makeManifest({ version: v }), OTHER_SEED_HEX);
      const a = await verifyManifest(first, otherTrust(), { now: T0, state });
      expect(a.ok, `first use of ${v}`).toBe(true);
      // the stored value is valid on the next read, so a later update is judged by the rule, never by 'state'
      const next = signManifest(
        makeManifest({ version: '100000000000000000000.0.0' }),
        OTHER_SEED_HEX,
      );
      const b = await verifyManifest(next, otherTrust(), { now: T0, state });
      expect(b.ok, `update over ${v}`).toBe(true);
      // and the same version again is not a downgrade either
      const again = await verifyManifest(next, otherTrust(), { now: T0, state });
      expect(again.ok, `repeat over ${v}`).toBe(true);
    }
  });

  it('the downgrade-state parser uses the same grammar: a stored leading-zero version is an unreadable store', async () => {
    const state: ManifestStateStore = {
      get: async () => ({ version: '01.0.0', createdAt: '2026-11-09T00:00:00Z' }),
      set: async () => undefined,
    };
    const r = await verifyManifest(signManifest(makeManifest(), OTHER_SEED_HEX), otherTrust(), {
      now: T0,
      state,
    });
    expect(r).toMatchObject({ ok: false, reason: 'state' });
  });
});

describe('BUG-T2-S4-05: compareSemver compares numeric identifiers exactly', () => {
  const cases: [string, string, -1 | 0 | 1][] = [
    ['1.0.9007199254740993', '1.0.9007199254740992', 1],
    ['1.0.9007199254740992', '1.0.9007199254740993', -1],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
    ['0.9007199254740993.0', '0.9007199254740992.0', 1],
    ['1.0.0-9007199254740993', '1.0.0-9007199254740992', 1],
    ['1.0.0-alpha.9007199254740993', '1.0.0-alpha.9007199254740992', 1],
    ['1.0.99999999999999999999', '1.0.99999999999999999998', 1],
    ['1.0.99999999999999999999', '1.0.99999999999999999999', 0],
    ['1.0.0-99999999999999999999', '1.0.0-100000000000000000000', -1],
    ['1.0.0-100000000000000000000', '1.0.0-99999999999999999999', 1],
    // SemVer 2.0 section 11 sanity: unchanged by the exact comparison
    ['1.10.0', '1.9.0', 1],
    ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
    ['1.0.0-1', '1.0.0-a', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
  ];
  for (const [a, b, want] of cases)
    it(`${a} vs ${b} = ${want}`, () => {
      expect(compareSemver(a, b)).toBe(want);
      expect(compareSemver(b, a)).toBe(want === 0 ? 0 : -want);
    });

  it('a patch above 2^53 refuses a rollback that Number() would call equal (through verifyManifest)', async () => {
    const state = new InMemoryManifestState();
    await state.set('dev.airplanemode.test', {
      version: '1.0.9007199254740993',
      createdAt: '2026-11-01T00:00:00Z',
    });
    const older = signManifest(
      makeManifest({ version: '1.0.9007199254740992', createdAt: '2026-11-09T00:00:00Z' }),
      OTHER_SEED_HEX,
    );
    const r = await verifyManifest(older, otherTrust(), { now: T0, state });
    expect(r).toMatchObject({ ok: false, reason: 'downgrade' });
    expect((await state.get('dev.airplanemode.test'))?.version).toBe('1.0.9007199254740993');
  });

  it('semver.ts does not call Number() on an identifier', () => {
    const src = readFileSync(resolve(specDir, '../src/semver.ts'), 'utf8');
    expect(src).not.toMatch(/\bNumber\(/);
  });
});

/** A signed manifest (OTHER key, so no test key is involved) as text and as an object. */
function signedBase(): Manifest {
  return signManifest(makeManifest(), OTHER_SEED_HEX);
}
const opts = { now: T0 } as const;
async function reasonOf(input: unknown, trust = otherTrust()): Promise<string> {
  const r = await verifyManifest(input, trust, opts);
  return r.ok ? 'VALID' : r.reason;
}

describe('BUG-T2-S4-02: the published Signature schema applies to every signatures[] item (reason schema)', () => {
  it('control: the unchanged signed manifest is valid, as text and as an object', async () => {
    expect(await reasonOf(signedBase())).toBe('VALID');
    expect(await reasonOf(JSON.stringify(signedBase()))).toBe('VALID');
  });

  const mutations: [string, (s: Record<string, unknown>) => void][] = [
    ['an extra member', (s) => (s['x'] = 1)],
    ['an extra null member', (s) => (s['extra'] = null)],
    ['signedAt that is not a timestamp', (s) => (s['signedAt'] = 'garbage')],
    ['signedAt that is calendar-invalid', (s) => (s['signedAt'] = '2026-99-99T00:00:00Z')],
    ['signedAt that is 2026-02-29', (s) => (s['signedAt'] = '2026-02-29T00:00:00Z')],
    ['signedAt with an offset', (s) => (s['signedAt'] = '2026-11-09T00:00:00+00:00')],
    ['a missing signedAt', (s) => delete s['signedAt']],
    ['a missing keyId', (s) => delete s['keyId']],
    ['a missing sig', (s) => delete s['sig']],
    ['a missing alg', (s) => delete s['alg']],
    ['an upper-case keyId', (s) => (s['keyId'] = String(s['keyId']).toUpperCase())],
    ['a short keyId', (s) => (s['keyId'] = 'abc')],
    ['a non-hex keyId', (s) => (s['keyId'] = 'g'.repeat(64))],
    ['a sig of 63 bytes', (s) => (s['sig'] = b64(new Uint8Array(63)))],
    ['a sig of 65 bytes', (s) => (s['sig'] = b64(new Uint8Array(65)))],
    ['a sig that is not base64', (s) => (s['sig'] = '!!!not base64!!!')],
    ['an unpadded sig', (s) => (s['sig'] = String(s['sig']).replace(/=+$/, ''))],
    ['a malformed publicKey', (s) => (s['publicKey'] = 'AAAA')],
    ['a publicKey of 31 bytes', (s) => (s['publicKey'] = b64(new Uint8Array(31)))],
    ['a numeric keyId', (s) => (s['keyId'] = 7)],
    ['a null sig', (s) => (s['sig'] = null)],
    ['a numeric alg', (s) => (s['alg'] = 7)],
    ['an alg that is not a token', (s) => (s['alg'] = 'ED25519')],
  ];
  for (const [name, mutate] of mutations)
    it(`${name} is schema, as an object and as text, and never moves the state`, async () => {
      const m = signedBase();
      const sig = { ...m.signatures[0]! } as unknown as Record<string, unknown>;
      mutate(sig);
      const doc = { ...m, signatures: [sig] };
      for (const input of [doc, JSON.stringify(doc)]) {
        const sets: unknown[] = [];
        const state: ManifestStateStore = {
          get: async () => undefined,
          set: async (...a) => void sets.push(a),
        };
        const r = await verifyManifest(input, otherTrust(), { ...opts, state });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason, name).toBe('schema');
          expect(r.signatures).toEqual([]);
        }
        expect(sets).toHaveLength(0);
      }
    });

  for (const [name, item] of [
    ['a number', 5],
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['a boolean', true],
  ] as const)
    it(`a signatures[] item that is ${name} is schema, never an exception`, async () => {
      const m = signedBase();
      const doc = { ...m, signatures: [item] };
      expect(await reasonOf(doc)).toBe('schema');
      expect(await reasonOf(JSON.stringify(doc))).toBe('schema');
    });

  it('a second, malformed signature next to a good one still refuses the whole manifest as schema', async () => {
    const m = signedBase();
    const bad = { ...m.signatures[0]!, x: 1 };
    expect(await reasonOf({ ...m, signatures: [m.signatures[0]!, bad] })).toBe('schema');
  });

  it('an alg token that is not ed25519 stays schema-valid and is ignored (unknown_alg)', async () => {
    const m = signedBase();
    for (const alg of ['future-pq', 'none', 'rsa-pss', 'ml-dsa-65']) {
      const doc = { ...m, signatures: [{ ...m.signatures[0]!, alg }] };
      const r = await verifyManifest(doc, otherTrust(), opts);
      expect(r, alg).toMatchObject({ ok: false, reason: 'no_valid_signature' });
      expect(r.signatures[0], alg).toMatchObject({ valid: false, reason: 'unknown_alg' });
    }
    // and next to a good signature it does not stop the manifest from being accepted
    const mixed = {
      ...m,
      signatures: [{ ...m.signatures[0]!, alg: 'future-pq' }, m.signatures[0]!],
    };
    expect(await reasonOf(mixed)).toBe('VALID');
  });

  describe('the parse stage covers signatures[] as well (text input)', () => {
    const textWith = (edit: (t: string) => string): string => edit(JSON.stringify(signedBase()));
    const cases: [string, (t: string) => string, string][] = [
      [
        'a digit-leading key inside a signature',
        (t) => t.replace('"alg":', '"1x":1,"alg":'),
        'digit_key',
      ],
      [
        'an invalid key inside a signature',
        (t) => t.replace('"alg":', '"a-b":1,"alg":'),
        'invalid_key',
      ],
      [
        'a float inside a signature',
        (t) => t.replace(/"signedAt":"[^"]*"/, '"signedAt":1.5'),
        'float',
      ],
      [
        'an integer above 2^53-1 inside a signature',
        (t) => t.replace(/"signedAt":"[^"]*"/, '"signedAt":9007199254740993'),
        'bigint',
      ],
      [
        'a lone surrogate inside a signature string',
        (t) => t.replace(/"signedAt":"[^"]*"/, '"signedAt":"\\ud800"'),
        'lone_surrogate',
      ],
      [
        'a repeated member inside a signature',
        (t) => t.replace('"alg":"ed25519"', '"alg":"ed25519","alg":"ed25519"'),
        'invalid_json',
      ],
    ];
    for (const [name, edit, reason] of cases)
      it(`${name} is ${reason}, not schema`, async () => {
        const text = textWith(edit);
        expect(await reasonOf(text)).toBe(reason);
        // an already-parsed object takes the same path through the parse-stage walk (a repeated member
        // cannot be seen in an object: the duplicate collapses before verifyManifest sees it)
        if (reason !== 'invalid_json') expect(await reasonOf(JSON.parse(text))).toBe(reason);
      });
  });
});

describe('BUG-T2-S4-03: MANIFEST_REJECT_PRECEDENCE holds for a missing or non-array signatures member', () => {
  const body = (): Record<string, unknown> => {
    const { signatures: _s, ...rest } = signedBase();
    return rest;
  };
  const text = (o: Record<string, unknown>) => JSON.stringify(o);

  it('signatures missing + a digit-leading top-level key is digit_key (parse stage first)', async () => {
    expect(await reasonOf(text({ ...body(), '1x': 1 }))).toBe('digit_key');
  });
  it('signatures missing + an invalid key is invalid_key', async () => {
    expect(await reasonOf(text({ ...body(), 'a-b': 1 }))).toBe('invalid_key');
  });
  it('signatures missing + a float is float; + an integer above 2^53-1 is bigint', async () => {
    const base = text({ ...body(), publisher: 'p' });
    expect(await reasonOf(base.replace('"size":0', '"size":1.5'))).toBe('float');
    expect(await reasonOf(base.replace('"size":0', '"size":9007199254740993'))).toBe('bigint');
  });
  it('signatures is a number + a lone surrogate is lone_surrogate', async () => {
    const t = text({ ...body(), signatures: 5 }).replace('"publisher":"', '"publisher":"\\ud800');
    expect(await reasonOf(t)).toBe('lone_surrogate');
  });
  it('signatures is a number + a digit-leading key is digit_key', async () => {
    expect(await reasonOf(text({ ...body(), signatures: 5, '1x': 1 }))).toBe('digit_key');
  });
  it('a missing signatures member alone is schema; so are null, a number, a string and an object', async () => {
    expect(await reasonOf(text(body()))).toBe('schema');
    for (const v of [null, 5, 'x', {}, true])
      expect(await reasonOf(text({ ...body(), signatures: v })), String(v)).toBe('schema');
    expect(await reasonOf(body())).toBe('schema');
  });
  it('a missing signatures member + a bad spec is bad_spec; + a bad url is bad_url (stage order)', async () => {
    expect(await reasonOf(text({ ...body(), spec: 'airplanemode.manifest/0.9' }))).toBe('bad_spec');
    expect(
      await reasonOf(
        text({
          ...body(),
          entries: [makeEntry('a', { url: 'data:application/octet-stream;base64,AA==' })],
        }),
      ),
    ).toBe('bad_url');
    expect(await reasonOf(text({ ...body(), signatures: 5, spec: 'x' }))).toBe('bad_spec');
  });
  it('signatures missing + unsorted entries is schema (the schema stage comes before ordering)', async () => {
    expect(await reasonOf(text({ ...body(), entries: [makeEntry('b'), makeEntry('a')] }))).toBe(
      'schema',
    );
  });
  it('JSON text that is a string holding a manifest text is schema: the inner text is never parsed a second time', async () => {
    const inner = JSON.stringify(signedBase());
    expect(await reasonOf(JSON.stringify(inner))).toBe('schema');
    // the outer text is the one the repeated-member scan sees; the inner one must not slip past it
    const dup = inner.replace('"alg":"ed25519"', '"alg":"ed25519","alg":"ed25519"');
    expect(await reasonOf(JSON.stringify(dup))).toBe('schema');
    expect(await reasonOf(dup)).toBe('invalid_json');
  });

  it('a document that is not an object stays schema, never an exception (text that is not JSON is invalid_json)', async () => {
    for (const v of [null, 5, [], true, undefined, '5', '[]', 'null', 'true', '"x"'])
      expect(await reasonOf(v), String(v)).toBe('schema');
    for (const v of ['x', '', '{', '{"a":1,}'])
      expect(await reasonOf(v), JSON.stringify(v)).toBe('invalid_json');
  });
});

describe('S1-089: test keys fail closed (hostile and non-Map trust sets)', () => {
  const TEST1 = hexToBytes(RFC8032_TEST_PUBLIC_KEYS_HEX[0]);
  const TEST1_ID = RFC8032_TEST_KEY_IDS[0];
  const tamper11 = readText(resolve(specDir, 'vectors/tamper/tamper-11-rotation-ok.json'));
  const now = Date.parse('2026-11-14T00:00:00Z');

  /** S1's repro: iteration throws, get() still returns the TEST 1 key. */
  const hostile = {
    get: (k: string) => (k === TEST1_ID ? TEST1 : undefined),
    has: (k: string) => k === TEST1_ID,
    size: 1,
    [Symbol.iterator]() {
      throw new Error('no');
    },
    entries() {
      throw new Error('no');
    },
  };

  it('S1 repro: a trust set whose iterator throws but whose get() returns TEST 1 is refused with test_key_refused', async () => {
    for (const allow of [undefined, false, 'true', 1, {}] as unknown[])
      await expect(
        verifyManifest(tamper11, hostile as unknown as Map<string, Uint8Array>, {
          now,
          allowTestKeys: allow as boolean,
        }),
      ).rejects.toMatchObject({ name: 'ManifestError', reason: 'test_key_refused' });
  });

  it('the same hostile trust set is accepted only with allowTestKeys === true', async () => {
    const r = await verifyManifest(tamper11, hostile as unknown as Map<string, Uint8Array>, {
      now,
      allowTestKeys: true,
    });
    expect(r.ok).toBe(true);
  });

  it('assertTestKeysAllowed throws for anything that is not a Map, and for an iterator that throws', () => {
    for (const trust of [
      hostile,
      null,
      undefined,
      [],
      [[TEST1_ID, TEST1]],
      {},
      { get: () => TEST1 },
      5,
      'x',
    ])
      expect(
        () => assertTestKeysAllowed(trust as unknown as Map<string, Uint8Array>, false),
        String(trust),
      ).toThrow(expect.objectContaining({ reason: 'test_key_refused' }));
    expect(() => assertTestKeysAllowed(hostile as never, true)).not.toThrow();
    expect(() => assertTestKeysAllowed(otherTrust(), false)).not.toThrow();
    expect(() => assertTestKeysAllowed(new Map(), undefined)).not.toThrow();
  });

  it('a Map subclass that hides its entries from iteration but returns a test key from get() is refused by the signature loop (by keyId)', async () => {
    class Hidden extends Map<string, Uint8Array> {
      override get(k: string): Uint8Array | undefined {
        return k === TEST1_ID ? TEST1 : undefined;
      }
      override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
        return new Map<string, Uint8Array>()[Symbol.iterator](); // yields nothing
      }
    }
    await expect(verifyManifest(tamper11, new Hidden(), { now })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
    const ok = await verifyManifest(tamper11, new Hidden(), { now, allowTestKeys: true });
    expect(ok.ok).toBe(true);
  });

  it('a Map subclass that returns a test key under an innocent keyId is refused by raw bytes in the signature loop', async () => {
    class Hidden extends Map<string, Uint8Array> {
      override get(): Uint8Array | undefined {
        return RFC8032_TEST2_PUBLIC;
      }
      override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
        return new Map<string, Uint8Array>()[Symbol.iterator](); // yields nothing
      }
    }
    // a signature filed under the OTHER key id, whose trusted bytes turn out to be a test key
    const signed = signedBase();
    expect(signed.signatures[0]!.keyId).toBe(OTHER_KEY_ID);
    await expect(verifyManifest(signed, new Hidden(), { now: T0 })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
  });

  it('no state write happens when a test key is refused in the loop', async () => {
    const sets: unknown[] = [];
    const state: ManifestStateStore = {
      get: async () => undefined,
      set: async (...a: [string, ManifestState]) => void sets.push(a),
    };
    await expect(
      verifyManifest(tamper11, hostile as unknown as Map<string, Uint8Array>, { now, state }),
    ).rejects.toBeInstanceOf(ManifestError);
    expect(sets).toHaveLength(0);
  });

  it('control: the real RFC 8032 TEST 1 key as a plain Map is still refused, and an unrelated Map is not', async () => {
    await expect(verifyManifest(tamper11, testTrust(), { now })).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
    expect(RFC8032_PUBLIC).toEqual(TEST1);
    const r = await verifyManifest(signedBase(), otherTrust(), opts);
    expect(r.ok).toBe(true);
    expect(OTHER_PUBLIC.length).toBe(32);
    void makeSignature;
  });
});

describe('S1-091: allowDowngrade is an explicit rollback (MANIFEST.md Security considerations, no code change)', () => {
  const md = readText(resolve(specDir, 'MANIFEST.md'));
  const sec = flat(
    md.slice(md.indexOf('## Security considerations'), md.indexOf('## Conformance')),
  );

  it('says allowDowngrade is an explicit rollback that lowers the stored state', () => {
    expect(sec).toContain('allowDowngrade is an explicit rollback');
    expect(sec).toContain('lowers the stored state');
  });
  it('says it must be reachable only from an authenticated admin action', () => {
    expect(sec).toContain('reachable only from an authenticated admin action');
  });
  it('the Downgrade section says the same of the option, in the same words', () => {
    const d = flat(md.slice(md.indexOf('## Downgrade'), md.indexOf('## Test keys')));
    expect(d).toContain('explicit rollback');
    expect(d).toContain('authenticated admin action');
  });
});

describe('TD-26: the prose says what the code does', () => {
  const md = readText(resolve(specDir, 'MANIFEST.md'));
  const changelog = readText(resolve(specDir, 'CHANGELOG.md'));
  const vectorsReadme = readText(resolve(specDir, 'vectors/README.md'));
  const ts = readText(resolve(specDir, 'manifest.ts'));

  it('MANIFEST.md Shape states the strict SemVer 2.0 grammar for both versions and the \\d meaning', () => {
    const shape = flat(md.slice(md.indexOf('## Shape'), md.indexOf('## Canonicalisation')));
    expect(shape).toContain(STRICT_SEMVER);
    expect(shape).toContain('no leading zeros');
    expect(shape).toContain('`\\d` means an ASCII digit');
    expect(shape).toContain('no build metadata');
  });

  it('manifest.ts documents the strict grammar and exports it', () => {
    expect(ts).toContain('SEMVER_PATTERN');
    expect(flatTs(ts)).toContain('strict SemVer 2.0');
  });

  it('MANIFEST.md Verification order applies the Signature schema to every signatures[] item, in the parse and schema steps', () => {
    const v = flat(
      md.slice(md.indexOf('## Verification order'), md.indexOf('## Reason precedence')),
    );
    expect(v).toContain('The parse stage runs over the whole text, signatures[] included');
    expect(v).toContain('Signature schema');
    expect(v).toContain('every signatures[] item');
    expect(v).toContain('reason schema');
    expect(v).toContain('additionalProperties false');
    // the old promise that malformed signature members are judged one by one in step 5 is gone
    expect(v).not.toContain('is judged in step 5');
  });

  it('MANIFEST.md Reason precedence names the missing or non-array signatures member as schema, after the parse stage', () => {
    const r = flat(md.slice(md.indexOf('## Reason precedence'), md.indexOf('## Downgrade')));
    expect(r).toContain('A missing or non-array "signatures" member is schema');
    expect(r).toContain('after the parse stage');
  });

  it('MANIFEST.md Conformance counts 32 negative vectors and nothing says 17 any more', () => {
    const c = flat(md.slice(md.indexOf('## Conformance')));
    expect(c).toContain('vectors/negative.json (32)');
    expect(c).not.toContain('(17)');
  });

  it('spec/CHANGELOG.md [0.4.0] records the amendment (TD-26) without a version bump', () => {
    const entry = flat(
      changelog.slice(changelog.indexOf('## [0.4.0]'), changelog.indexOf('## [0.3.0]')),
    );
    expect(entry).toContain('TD-26');
    expect(entry).toContain('amended in place before the first push');
    expect(entry).toContain('strict SemVer 2.0');
    expect(entry).toContain('Signature schema');
    expect(entry).toContain('wire string');
    expect(entry).toContain('32');
  });

  it('vectors/README.md lists the six new negatives and says thirty-two', () => {
    for (const f of [
      'neg-version-leading-zero.json',
      'neg-version-empty-prerelease-id.json',
      'neg-null-optional.json',
      'neg-sig-unknown-member.json',
      'neg-sig-bad-signedat.json',
      'neg-precedence-digitkey-nosigs.json',
    ])
      expect(vectorsReadme, f).toContain(f);
    expect(flat(vectorsReadme)).toContain('Thirty-two negative vectors');
  });

  it('spec/storage-api.md (prose only): the 1024 UTF-16-unit key rule dominates for vector keys; 4096 bytes is the on-disk bound', () => {
    const doc = flat(readText(resolve(specDir, 'storage-api.md')));
    expect(doc).toContain('1024 UTF-16 code units');
    expect(doc).toContain('dominates');
    expect(doc).toContain('4096 UTF-8 bytes is the on-disk bound');
    expect(doc).not.toContain('and at most 4096 UTF-8 bytes (`VECTOR_KEY_UTF8_MAX`)');
  });
});

describe('BUG-T3-S4-07: NOTICE is version-neutral', () => {
  it('runtime/NOTICE names no package version of its own', () => {
    const notice = readFileSync(resolve(specDir, '../NOTICE'), 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(specDir, '../package.json'), 'utf8')) as {
      version: string;
    };
    expect(notice).not.toContain(pkg.version);
    expect(notice).not.toMatch(/0\.\d+\.\d+-alpha/);
    expect(notice).toContain('no runtime dependencies'); // package-meta.test.ts pins this sentence
  });
});
