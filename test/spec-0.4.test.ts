// Spec release 0.4.0: manifest 0.1.1 ("manifest spec v0.1", status published), event 0.1.3, storage API
// 0.2.0, backend adapter 0.3.1, model descriptor 0.2.1. Written before any spec file changed (D1-01);
// the red run is in evidence/sprint-4/D1/red-D1-01.log.

import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORAGE_EVENT_NAMES } from '../spec/event';
import { SPEC_RELEASE, SPEC_STATUS, SPEC_VERSIONS, SPEC_WIRE } from '../spec/index';
import {
  MANIFEST_REJECT_PRECEDENCE,
  RFC8032_TEST_KEY_IDS,
  RFC8032_TEST_PUBLIC_KEYS_HEX,
  SEMVER_PATTERN,
} from '../spec/manifest';
import {
  VECTOR_DIM_MAX,
  VECTOR_KEY_UTF8_MAX,
  VECTOR_VALUE_BYTES_MAX,
  StorageError,
  type PutVectorsResult,
  type QueryOptions,
  type StorageErrorCode,
  type UsageResult,
  type VectorIndexInfo,
  type VectorMetric,
  type VectorRow,
} from '../spec/storage-api';
import { DESCRIPTOR_REJECT_PRECEDENCE } from '../spec/model-descriptor';
import { RFC8032_TEST_KEY_ID } from '../src/manifest';
import { SCHEMAS } from '../src/schema';
import {
  readJson as readJsonStrict,
  readText as readTextStrict,
  repoDir,
  specDir,
} from './helpers';

// A missing file fails the test that needs it, not the whole suite at collection time.
const readText = (p: string): string => {
  try {
    return readTextStrict(p);
  } catch {
    return '';
  }
};
const readJson = <T>(p: string): T => {
  try {
    return readJsonStrict<T>(p);
  } catch {
    return [] as unknown as T;
  }
};

const flat = (s: string) => s.replace(/\s+/g, ' ');
const flatTs = (s: string) => flat(s.replace(/\n\s*\*/g, ' '));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const vectorsDir = resolve(specDir, 'vectors');

/** RFC 8032 section 7.1 seeds (public, non-secret test data). The RFC wins on any mismatch. */
const RFC_SEEDS: Record<string, string> = {
  'TEST 1': '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'TEST 2': '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
  'TEST 3': 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
  'TEST 1024': 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5',
  'TEST SHA(abc)': '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
};

describe('spec 0.4.0: release, versions, status, wire strings', () => {
  it('SPEC_VERSIONS, SPEC_RELEASE, SPEC_STATUS and SPEC_WIRE carry the current (0.5.0) values; the statuses and wire strings are those set in 0.4.0', () => {
    expect(SPEC_RELEASE).toBe('0.5.0');
    expect(SPEC_VERSIONS).toEqual({
      manifest: '0.1.2',
      capabilityProfile: '0.1.0',
      event: '0.1.4',
      storageApi: '0.3.0',
      backendAdapter: '0.4.0',
      modelDescriptor: '0.2.1',
    });
    expect(SPEC_STATUS).toEqual({
      manifest: 'published',
      capabilityProfile: 'draft',
      event: 'draft',
      storageApi: 'draft',
      backendAdapter: 'draft',
      modelDescriptor: 'draft',
    });
    expect(Object.keys(SPEC_STATUS).sort()).toEqual(Object.keys(SPEC_VERSIONS).sort());
    // wire strings never change on a patch or on this release
    expect(SPEC_WIRE).toEqual({
      manifest: 'airplanemode.manifest/0.1',
      capabilityProfile: 'airplanemode.capability/0.1',
      event: 'airplanemode.event/0.1',
      modelDescriptor: 'airplanemode.model/0.2',
    });
  });

  it('every schema $id carries its own contract version', () => {
    expect(SCHEMAS.manifest.$id).toBe('urn:airplanemode:spec:manifest:0.1.2');
    expect(SCHEMAS.capabilityProfile.$id).toBe('urn:airplanemode:spec:capability-profile:0.1.0');
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.4');
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.2.1');
  });

  it('the event schema body is unchanged (only the $id moved); the manifest schema body changed only in its two version members (TD-26) and in the sig, publicKey and url members (TD-29)', () => {
    // TD-26 (amended before the first push): Manifest.version and ManifestEntry.version take the strict
    // SemVer 2.0 grammar. Put the 0.1.0 text of exactly those two members back and the file is the 0.1.0
    // schema, byte for byte, apart from the $id.
    const strict = JSON.stringify(SEMVER_PATTERN);
    const current = readText(resolve(specDir, 'manifest.schema.json'));
    expect(current).toContain(`"pattern": ${strict},`);
    const old0 = String.raw`"pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"`;
    // TD-29 (fix round 2): the sig, publicKey and url patterns and their descriptions changed too. Put the
    // 0.1.0 text of those three members back as well.
    const URL_CLASS = String.raw`[^?#\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]`;
    const td29: [string, string][] = [
      [URL_CLASS, String.raw`[^\\s?#]`],
      [
        " The forbidden characters are explicit, not \\\\s: '?', '#', U+0000 to U+0020, U+007F to U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF (reason bad_url); every other code point is allowed.",
        '',
      ],
      [
        String.raw`"pattern": "^[A-Za-z0-9+/]{85}[AQgw]==$"`,
        String.raw`"pattern": "^[A-Za-z0-9+/]{86}==$"`,
      ],
      [
        String.raw`"pattern": "^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$"`,
        String.raw`"pattern": "^[A-Za-z0-9+/]{43}=$"`,
      ],
      [
        'Canonical standard padded base64 of the 64-byte Ed25519 signature over signedBytes: the pad bits of the last character are zero (RFC 4648 section 3.5), and any other encoding of the same bytes is a schema fault.',
        'Standard padded base64 of the 64-byte Ed25519 signature over signedBytes.',
      ],
      [
        'Canonical standard padded base64 of the raw 32-byte public key (RFC 4648 section 3.5: the pad bits of the last character are zero; any other encoding of the same bytes is a schema fault). Informational only',
        'Standard padded base64 of the raw 32-byte public key. Informational only',
      ],
    ];
    let current0 = current;
    for (const [fresh, old] of td29) current0 = current0.split(fresh).join(old);
    const manifest = current0
      .replace('urn:airplanemode:spec:manifest:0.1.2', 'urn:airplanemode:spec:manifest:0.1.0')
      .replace(
        new RegExp(
          `"pattern": ${strict.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\n(\\s+)"description": "Strict SemVer 2.0 version of the manifest[^\\n]*"`,
        ),
        `${old0},\n$1"description": "SemVer 2.0 version of the manifest (no build metadata). Compared with the precise SemVer rule for downgrade protection."`,
      )
      .replace(
        new RegExp(
          `"pattern": ${strict.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\n\\s+"description": "Strict SemVer 2.0 version of the file[^\\n]*"`,
        ),
        old0,
      );
    expect(sha(manifest)).toBe('5e9707c92d9d1d73e11e5010ff28afb550ba40ffdd45f208ce3b8245a03608d2');
    const event = readText(resolve(specDir, 'event.schema.json')).replace(
      'urn:airplanemode:spec:event:0.1.4',
      'urn:airplanemode:spec:event:0.1.2',
    );
    expect(sha(event)).toBe('f7dfb591970434a3ee32d17b1455bb56eee4bfc56d02200818732d512092988a');
  });

  it('the headers of the changed contract files carry their new versions', () => {
    expect(flatTs(readText(resolve(specDir, 'manifest.ts')))).toContain('Manifest contract 0.1.2');
    expect(flatTs(readText(resolve(specDir, 'event.ts')))).toContain('Event contract 0.1.4');
    expect(flatTs(readText(resolve(specDir, 'storage-api.ts')))).toContain(
      'Storage API contract 0.3.0',
    );
    expect(flatTs(readText(resolve(specDir, 'backend-adapter.ts')))).toContain(
      'Backend adapter contract 0.4.0',
    );
    expect(flatTs(readText(resolve(specDir, 'model-descriptor.ts')))).toContain(
      'Model descriptor contract 0.2.1',
    );
    expect(
      readText(resolve(specDir, 'backend-adapter.md')).startsWith('# Backend adapter 0.4.0'),
    ).toBe(true);
  });
});

describe('spec 0.4.0: README versioning and status vocabulary', () => {
  const readme = readText(resolve(specDir, 'README.md'));
  const f = flat(readme);

  it('defines draft and published and the release numbering rule', () => {
    expect(f).toContain('Each contract has a status, "draft" or "published"');
    expect(f).toContain(
      '"published" means frozen on its wire string: later changes are additive patches that change no accepted or refused input, or a new wire string',
    );
    expect(f).toContain('"draft" may change in a minor version');
    expect(f).toContain(
      'the release minor bumps when any contract takes a minor bump, and the patch bumps otherwise',
    );
    expect(f).toContain('the wire discriminator changes only on a contract major or minor');
  });

  it('release table says manifest 0.1.2: published; other contracts: draft, with the push-wording rule', () => {
    expect(f).toContain('Spec release **0.5.0**');
    expect(f).toContain('manifest 0.1.2: published; other contracts: draft');
    expect(f).toContain("committed; public after the owner's push");
    expect(f).toMatch(/\| Manifest\s+\|[^|]*\|\s*0\.1\.2\s*\|\s*published/);
    expect(f).toMatch(/\| Event\s+\|[^|]*\|\s*0\.1\.4\s*\|\s*draft/);
    expect(f).toMatch(/\| Storage API\s+\|[^|]*\|\s*0\.3\.0\s*\|\s*draft/);
    expect(f).toMatch(/\| Backend adapter\s+\|[^|]*\|\s*0\.4\.0\s*\|\s*draft/);
    expect(f).toMatch(/\| Model descriptor\s+\|[^|]*\|\s*0\.2\.1\s*\|\s*draft/);
    expect(f).toContain('urn:airplanemode:spec:event:0.1.4');
    expect(f).toContain('manifest spec v0.1');
    expect(readme).toContain('MANIFEST.md');
  });
});

describe('spec 0.4.0: MANIFEST.md', () => {
  const md = readText(resolve(specDir, 'MANIFEST.md'));
  const f = flat(md);

  it('has the thirteen sections in order, then the two sections of manifest 0.1.2', () => {
    const headings = [
      'Scope',
      'Shape',
      'Canonicalisation',
      'Duplicate members',
      'Signing',
      'Trust roots',
      'Verification order',
      'Reason precedence',
      'Downgrade',
      'Test keys',
      'Tamper vectors',
      'Security considerations',
      'Conformance',
      'Manifest 0.1.2',
      'Demo bundles',
    ];
    let last = -1;
    for (const h of headings) {
      const at = md.indexOf(`\n## ${h}\n`);
      expect(at, h).toBeGreaterThan(last);
      last = at;
    }
    expect(md.match(/^## /gm)).toHaveLength(15);
    expect(md.startsWith('# Manifest spec v0.1')).toBe(true);
  });

  it('maps manifest spec v0.1 to wire /0.1 and contract 0.1.1, status published', () => {
    expect(f).toContain('airplanemode.manifest/0.1');
    expect(f).toContain('manifest 0.1.1');
    expect(f).toContain('status: published');
    expect(f).toContain("committed; public after the owner's push");
  });

  it('states the duplicate-member rule, S < L and the precedence list', () => {
    const dup = f.slice(f.indexOf('## Duplicate members'));
    expect(dup).toContain('invalid_json');
    expect(dup).toContain('any depth');
    expect(dup).toContain('JSON.parse cannot detect');
    expect(f).toContain('S MUST be < L');
    expect(f).toContain('27742317777372353535851937790883648493');
    const prec = md.slice(md.indexOf('## Reason precedence'), md.indexOf('## Downgrade'));
    for (const r of [
      'invalid_json',
      'bad_spec',
      'bad_url',
      'schema',
      'unsorted_entries',
      'duplicate_entries',
      'expired',
      'no_valid_signature',
      'downgrade',
    ])
      expect(prec, r).toContain(r);
    expect(flat(prec)).toContain('A missing "spec" key is bad_spec, never schema');
    expect(flat(prec)).toContain('Shared vectors never combine two parse-stage faults');
  });

  it('Security considerations carries every line the plan requires', () => {
    const sec = flat(
      md.slice(md.indexOf('## Security considerations'), md.indexOf('## Conformance')),
    );
    for (const line of [
      'no revocation',
      'no transparency log',
      'one signature is enough',
      'the browser clock is trusted for expiresAt',
      'signedAt is unauthenticated',
      'sha256 proves integrity against the signed manifest only',
      'the trust root is application configuration',
      'consumers MUST check that manifest.id equals the id they expect',
      'pass the expectId option',
      'downgrade state is first-use and per-profile',
      'cleared site data, accepts any validly signed older version',
      'publishers SHOULD set expiresAt',
      'state is written only after a valid signature',
      'duplicate members are refused',
      'small-order public keys in a trust set are a configuration error',
    ])
      expect(sec.toLowerCase(), line).toContain(line.toLowerCase());
  });

  it('Conformance states the counts: 5 positive, 32 negative, 15 tamper rows', () => {
    const c = flat(md.slice(md.indexOf('## Conformance')));
    expect(c).toContain('An implementation conforms to manifest spec v0.1 when');
    expect(c).toContain('accepts the 5 positive vectors byte-for-byte');
    expect(c).toContain('rejects every row of vectors/negative.json (32)');
    expect(c).toContain('every row of vectors/tamper/tamper.json (15)');
    expect(c).toContain('skipping only requiresState rows');
    expect(c).toContain('tamper-assets is runtime-specific');
  });
});

describe('spec 0.4.0: manifest.ts exports', () => {
  it('exports the five test public keys and keyIds, and the precedence list', () => {
    expect(RFC8032_TEST_PUBLIC_KEYS_HEX).toHaveLength(5);
    expect(RFC8032_TEST_KEY_IDS).toHaveLength(5);
    expect(RFC8032_TEST_KEY_ID).toBe(RFC8032_TEST_KEY_IDS[0]);
    expect(Object.isFrozen(RFC8032_TEST_PUBLIC_KEYS_HEX)).toBe(true);
    expect(Object.isFrozen(RFC8032_TEST_KEY_IDS)).toBe(true);
    expect(MANIFEST_REJECT_PRECEDENCE).toHaveLength(10);
    expect(MANIFEST_REJECT_PRECEDENCE.map((g) => [...g])).toEqual([
      ['invalid_json', 'lone_surrogate', 'float', 'bigint', 'digit_key', 'invalid_key'],
      ['bad_spec'],
      ['bad_url'],
      ['schema'],
      ['unsorted_entries'],
      ['duplicate_entries'],
      ['expired'],
      ['no_valid_signature'],
      ['unexpected_id'],
      ['downgrade', 'state'],
    ]);
  });

  it('the five RFC 8032 keys derived from their seeds equal the exported constants (RFC wins on mismatch)', () => {
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const derived = Object.values(RFC_SEEDS).map((seed) => {
      const key = createPrivateKey({
        key: Buffer.concat([prefix, Buffer.from(seed, 'hex')]),
        format: 'der',
        type: 'pkcs8',
      });
      const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
      const pub = spki.subarray(spki.length - 32);
      return { pub: pub.toString('hex'), id: sha(pub) };
    });
    expect(derived.map((d) => d.pub)).toEqual([...RFC8032_TEST_PUBLIC_KEYS_HEX]);
    expect(derived.map((d) => d.id)).toEqual([...RFC8032_TEST_KEY_IDS]);
  });

  it('MANIFEST.md and examples/TEST-KEY.md list all five keys, seeds only for the two vector keys', () => {
    const md = readText(resolve(specDir, 'MANIFEST.md'));
    const tk = readText(resolve(specDir, 'examples/TEST-KEY.md'));
    for (const [i, hex] of RFC8032_TEST_PUBLIC_KEYS_HEX.entries()) {
      expect(md, hex).toContain(hex);
      expect(md).toContain(RFC8032_TEST_KEY_IDS[i]!);
      expect(tk, hex).toContain(hex);
      expect(tk).toContain(RFC8032_TEST_KEY_IDS[i]!);
    }
    for (const seed of [RFC_SEEDS['TEST 1']!, RFC_SEEDS['TEST 2']!]) expect(tk).toContain(seed);
    expect(md).toContain('rfc8032-1');
    expect(md).toContain('rfc8032-2');
    expect(flat(md)).toContain('allowTestKeys === true');
  });
});

describe('spec 0.4.0: manifest vectors (32 negatives)', () => {
  const rows = readJson<{ file: string; reason: string; stage: string }[]>(
    resolve(vectorsDir, 'negative.json'),
  );

  it('negative.json has 13 old rows, the 4 of release 0.4.0, the 6 of the TD-26 amendment, then the 9 of the TD-29 fix round', () => {
    expect(rows).toHaveLength(32);
    expect(rows.slice(13, 17)).toEqual([
      { file: 'neg-missing-spec.json', reason: 'bad_spec', stage: 'parse' },
      { file: 'neg-multi-badspec-unsorted.json', reason: 'bad_spec', stage: 'parse' },
      { file: 'neg-multi-badurl-unsorted.json', reason: 'bad_url', stage: 'parse' },
      { file: 'neg-duplicate-member.json', reason: 'invalid_json', stage: 'parse' },
    ]);
    expect(rows.slice(17, 23)).toEqual([
      { file: 'neg-version-leading-zero.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-version-empty-prerelease-id.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-null-optional.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-unknown-member.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-bad-signedat.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-precedence-digitkey-nosigs.json', reason: 'digit_key', stage: 'parse' },
    ]);
    expect(rows.slice(23)).toEqual([
      { file: 'neg-proto-member-entry.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-proto-member.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-malformed-keyid-rotation.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-malformed-sig-rotation.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-malformed-pubkey-rotation.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-sig-noncanonical-base64.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-pubkey-noncanonical-base64.json', reason: 'schema', stage: 'parse' },
      { file: 'neg-url-control-char.json', reason: 'bad_url', stage: 'parse' },
      { file: 'neg-url-unicode-space.json', reason: 'bad_url', stage: 'parse' },
    ]);
    for (const r of rows) expect(existsSync(resolve(vectorsDir, r.file)), r.file).toBe(true);
  });

  it('vectors/README.md has a table row for every negative vector and the new rule text', () => {
    const readme = readText(resolve(vectorsDir, 'README.md'));
    for (const r of rows) expect(readme, r.file).toContain(r.file);
    expect(flat(readme)).toContain('Shared vectors never combine two parse-stage faults');
    expect(readme).toContain('tamper/');
    expect(readme).toContain('tamper-assets/');
  });

  it('neg-missing-spec has no spec member; neg-duplicate-member repeats sha256 in entries[1] before the real one', () => {
    const missing = JSON.parse(readText(resolve(vectorsDir, 'neg-missing-spec.json'))) as Record<
      string,
      unknown
    >;
    expect('spec' in missing).toBe(false);
    const raw = readText(resolve(vectorsDir, 'neg-duplicate-member.json'));
    const parsed = JSON.parse(raw) as { entries: { id: string; sha256: string }[] };
    // JSON.parse keeps the LAST member, so the parsed value is vector 05 exactly
    const v05 = readJson<{ entries: unknown[] }>(resolve(vectorsDir, '05-four-entries.json'));
    expect(parsed.entries).toEqual(v05.entries);
    const second = raw.slice(raw.indexOf('"id": "m.x"'));
    expect((second.match(/"sha256"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('spec 0.4.0: descriptor vectors (20 negatives)', () => {
  const dir = resolve(vectorsDir, 'descriptor');
  const rows = readJson<{ file: string; reason: string }[]>(resolve(dir, 'negative.json'));

  it('negative.json has 14 old rows, the 5 of release 0.4.0, then neg-proto-member of the TD-29 fix round', () => {
    expect(rows).toHaveLength(20);
    expect(rows.slice(14)).toEqual([
      { file: 'neg-webllm-spec-0.1.json', reason: 'schema' },
      { file: 'neg-missing-spec.json', reason: 'bad_spec' },
      { file: 'neg-dup-devices.json', reason: 'schema' },
      { file: 'neg-multi-badspec-unsorted.json', reason: 'bad_spec' },
      { file: 'neg-multi-schema-unsorted.json', reason: 'schema' },
      { file: 'neg-proto-member.json', reason: 'schema' },
    ]);
    const readme = readText(resolve(dir, 'README.md'));
    for (const r of rows) {
      expect(existsSync(resolve(dir, r.file)), r.file).toBe(true);
      expect(readme, r.file).toContain(r.file.replace(/\.json$/, ''));
    }
  });

  it('the precedence list is exported and written down', () => {
    expect(DESCRIPTOR_REJECT_PRECEDENCE.map((g) => [...g])).toEqual([
      ['invalid_json', 'float', 'bigint', 'digit_key', 'invalid_key', 'lone_surrogate'],
      ['bad_spec'],
      ['schema'],
      ['unsorted_files'],
      ['duplicate_paths'],
      ['unsorted_devices'],
    ]);
    const readme = flat(readText(resolve(dir, 'README.md')));
    expect(readme).toContain('Reason precedence');
    expect(readme).toContain('duplicate members');
  });

  it('branch C of the schema pins airplanemode.model/0.2 (BUG-T2-S3-22)', () => {
    const s = SCHEMAS.modelDescriptor as {
      anyOf: { properties: Record<string, { const?: unknown }> }[];
    };
    expect(s.anyOf[2]!.properties['spec']!.const).toBe('airplanemode.model/0.2');
  });
});

describe('spec 0.4.0: tamper vectors', () => {
  const dir = resolve(vectorsDir, 'tamper');
  interface Row {
    file: string;
    trust: string[];
    allowTestKeys: boolean;
    now: string;
    state: { version: string; createdAt: string } | null;
    requiresState: boolean;
    expect: { valid: boolean; stage?: string; reason?: string; signatures?: string[] };
  }
  const rows = readJson<Row[]>(resolve(dir, 'tamper.json'));

  it('tamper.json has the 15 documented rows in order', () => {
    expect(rows.map((r) => r.file)).toEqual([
      'tamper-01-entry-sha-byte.json',
      'tamper-02-entry-size.json',
      'tamper-03-sig-bitflip.json',
      'tamper-04-swapped-key.json',
      'tamper-05-publickey-mismatch.json',
      'tamper-06-untrusted-key.json',
      'tamper-07-truncated.txt',
      'tamper-08-rollback.json',
      'tamper-09-replay-older-createdAt.json',
      'tamper-10-expired.json',
      'tamper-11-rotation-ok.json',
      'tamper-12-stripped.json',
      'tamper-13-alg-none.json',
      'tamper-14-test-key-refused.json',
      'tamper-15-noncanonical-s.json',
    ]);
    for (const r of rows) {
      expect(existsSync(resolve(dir, r.file)), r.file).toBe(true);
      expect(r.now).toBe('2026-11-14T00:00:00Z');
      expect(typeof r.allowTestKeys).toBe('boolean');
      expect(typeof r.requiresState).toBe('boolean');
    }
    expect(rows.filter((r) => r.requiresState).map((r) => r.file.slice(0, 9))).toEqual([
      'tamper-08',
      'tamper-09',
    ]);
    const by = (n: string) => rows.find((r) => r.file.startsWith(n))!;
    expect(by('tamper-01').expect).toEqual({
      valid: false,
      stage: 'verify',
      reason: 'no_valid_signature',
      signatures: ['bad_signature'],
    });
    expect(by('tamper-05').expect.signatures).toEqual(['key_mismatch']);
    expect(by('tamper-06').expect.signatures).toEqual(['untrusted_key']);
    expect(by('tamper-07').expect).toMatchObject({
      valid: false,
      stage: 'parse',
      reason: 'invalid_json',
    });
    expect(by('tamper-08').expect.reason).toBe('downgrade');
    expect(by('tamper-09').expect.reason).toBe('downgrade');
    expect(by('tamper-10').expect.reason).toBe('expired');
    expect(by('tamper-11').expect).toMatchObject({
      valid: true,
      signatures: ['untrusted_key', 'valid'],
    });
    expect(by('tamper-13').expect.signatures).toEqual(['unknown_alg']);
    expect(by('tamper-14').allowTestKeys).toBe(false);
    expect(by('tamper-14').expect.reason).toBe('test_key_refused');
    expect(by('tamper-15').expect.signatures).toEqual(['bad_signature']);
  });

  it('tamper/README.md names every file and the trust-name table', () => {
    const readme = readText(resolve(dir, 'README.md'));
    for (const r of rows) expect(readme, r.file).toContain(r.file);
    expect(readme).toContain('rfc8032-1');
    expect(readme).toContain('rfc8032-2');
  });

  it('tamper-15 carries S + L (little-endian) in place of S, still 64 bytes', () => {
    const m = readJson<{ signatures: { sig: string }[] }>(
      resolve(dir, 'tamper-15-noncanonical-s.json'),
    );
    const bytes = Buffer.from(m.signatures[0]!.sig, 'base64');
    expect(bytes).toHaveLength(64);
    const s = BigInt('0x' + Buffer.from(bytes.subarray(32)).reverse().toString('hex'));
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    expect(s >= L).toBe(true);
    expect(s < 2n * L).toBe(true);
  });

  it('tamper-assets has three signed manifests, three .bin files and expect.json with normative and informative fields', () => {
    const adir = resolve(vectorsDir, 'tamper-assets');
    const ok = readFileSync(resolve(adir, 'asset-ok.bin'));
    const flip = readFileSync(resolve(adir, 'asset-flip.bin'));
    const trunc = readFileSync(resolve(adir, 'asset-truncated.bin'));
    expect(ok).toHaveLength(4096);
    for (let i = 0; i < 4096; i++) expect(ok[i]).toBe((i * 31 + 7) % 256);
    expect(flip).toHaveLength(4096);
    for (let i = 0; i < 4096; i++) expect(flip[i]).toBe(i === 2048 ? ok[i]! ^ 1 : ok[i]);
    expect(trunc).toEqual(ok.subarray(0, 4095));
    const names: Record<string, string> = {
      'manifest-ok.json': 'asset-ok.bin',
      'manifest-flip.json': 'asset-flip.bin',
      'manifest-truncated.json': 'asset-truncated.bin',
    };
    for (const [file, url] of Object.entries(names)) {
      const m = readJson<{
        entries: { id: string; size: number; sha256: string; url: string }[];
        signatures: unknown[];
      }>(resolve(adir, file));
      expect(m.entries).toHaveLength(1);
      expect(m.entries[0]).toMatchObject({ id: 'asset-ok', size: 4096, url, sha256: sha(ok) });
      expect(m.signatures).toHaveLength(1);
    }
    const expectJson = readJson<
      Record<
        string,
        {
          normative: Record<string, unknown>;
          informative: Record<string, unknown>;
        }
      >
    >(resolve(adir, 'expect.json'));
    expect(Object.keys(expectJson).sort()).toEqual(Object.keys(names).sort());
    for (const file of ['manifest-flip.json', 'manifest-truncated.json']) {
      expect(expectJson[file]!.normative).toEqual({
        refused: true,
        bytesToConsumer: 0,
        getBlob: 'rejects',
        blobUrl: false,
      });
      expect(Object.keys(expectJson[file]!.informative).sort()).toEqual([
        'runtimeCode',
        'runtimeReason',
      ]);
    }
    expect(expectJson['manifest-ok.json']!.normative).toMatchObject({ refused: false });
    const readme = flat(readText(resolve(adir, 'README.md')));
    expect(readme).toContain('runtime-specific');
    expect(readme).toContain('FRESH memory store');
  });
});

describe('spec 0.4.0: generators are deterministic', () => {
  for (const script of [
    'make-vectors.mjs',
    'make-descriptor-vectors.mjs',
    'make-tamper-vectors.mjs',
  ]) {
    it(`${script} --check exits 0`, () => {
      const r = spawnSync(process.execPath, [resolve(repoDir, 'test/tools', script), '--check'], {
        encoding: 'utf8',
      });
      expect(r.stderr, r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }
});

describe('spec 0.4.0: files that must not change are byte-identical to spec release 0.3.0', () => {
  const fixture = readText(resolve(repoDir, 'test/fixtures/spec-unchanged-since-0.3.0.sha256.txt'))
    .trim()
    .split('\n')
    .map((l) => l.split(/\s+/) as [string, string]);

  it('the 5 positive vectors and the 13 Sprint 3 negatives hash exactly as before', () => {
    const files = fixture.map(([, f]) => f);
    for (let n = 1; n <= 5; n++)
      for (const ext of ['json', 'canonical.txt', 'sig.txt'])
        expect(files.some((f) => new RegExp(`^vectors/0${n}-.*\\.${ext}$`).test(f))).toBe(true);
    expect(files.filter((f) => /^vectors\/neg-/.test(f))).toHaveLength(13);
    for (const [hash, file] of fixture)
      expect(sha(readFileSync(resolve(specDir, file))), file).toBe(hash);
  });

  it('the 4 release 0.4.0 negatives are unchanged by the TD-26 amendment: the 5 positives and the 17 existing negatives stay byte-identical', () => {
    const added = readText(
      resolve(repoDir, 'test/fixtures/spec-manifest-negatives-0.4.0.sha256.txt'),
    )
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/) as [string, string]);
    expect(added.map(([, f]) => f)).toEqual([
      'vectors/neg-missing-spec.json',
      'vectors/neg-multi-badspec-unsorted.json',
      'vectors/neg-multi-badurl-unsorted.json',
      'vectors/neg-duplicate-member.json',
    ]);
    for (const [hash, file] of added)
      expect(sha(readFileSync(resolve(specDir, file))), file).toBe(hash);
    // 5 positives (15 files) + 13 Sprint 3 negatives + these 4 = 5 + 17 byte-identical vector sets
    expect(fixture.filter(([, f]) => /^vectors\/(0\d-|neg-)/.test(f))).toHaveLength(15 + 13);
  });

  it('the fixture agrees with evidence/sprint-3/D1/SPEC-LANDED.txt when the workspace has it', () => {
    const landed = resolve(repoDir, '../evidence/sprint-3/D1/SPEC-LANDED.txt');
    if (!existsSync(landed)) return; // the runtime repo alone has no workspace evidence folder
    const table = new Map(
      readFileSync(landed, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          const [h, ...rest] = l.split(/\s+/);
          return [rest.join(' '), h!] as const;
        }),
    );
    for (const [hash, file] of fixture) expect(table.get(file), file).toBe(hash);
  });

  it('the old vectors directory only grew: 5 positives, 32 negatives, tamper folders', () => {
    const top = readdirSync(vectorsDir, { withFileTypes: true });
    const names = top.filter((d) => d.isFile()).map((d) => d.name);
    expect(names.filter((f) => /^0\d-.*\.json$/.test(f))).toHaveLength(5);
    expect(names.filter((f) => f.startsWith('neg-') && f !== 'negative.json')).toHaveLength(32);
    expect(
      top
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort(),
    ).toEqual(['descriptor', 'expect-id', 'state-ids', 'tamper', 'tamper-assets']);
  });
});

describe('spec 0.4.0: storage API 0.2.0', () => {
  it('exports the vector constants and the new error code', () => {
    expect(VECTOR_DIM_MAX).toBe(4096);
    expect(VECTOR_KEY_UTF8_MAX).toBe(4096);
    expect(VECTOR_VALUE_BYTES_MAX).toBe(1048576);
    const code: StorageErrorCode = 'corrupt';
    expect(new StorageError(code, 'x', { ns: 'a', file: 'HEAD', reason: 'crc' }).code).toBe(
      'corrupt',
    );
    // type-level: these compile only when the 0.2.0 shapes exist
    const metric: VectorMetric = 'cosine';
    const row: VectorRow = { key: 'k', vector: new Float32Array(2), value: { a: 1 } };
    const res: PutVectorsResult = { written: 1, replaced: 0, rows: 1 };
    const opts: QueryOptions = { filterPrefix: 'a', metric, values: false };
    const info: VectorIndexInfo = {
      formatVersion: 1,
      dtype: 'f32',
      dim: 2,
      rows: 1,
      totalRows: 1,
      segments: 1,
      bytes: 10,
      generation: 1,
      kernel: 'scalar',
    };
    const usage: UsageResult = { bytes: 1, items: 0, vectorRows: 1, vectorBytes: 1 };
    expect([row.key, res.rows, opts.metric, info.dim, usage.vectorRows]).toEqual([
      'k',
      1,
      'cosine',
      2,
      1,
    ]);
  });

  it('storage-api.ts documents putVectors, indexInfo, query and the reserved namespace prefix', () => {
    // prettier may break a long signature over lines: compare with the brackets tightened
    const ts = flatTs(readText(resolve(specDir, 'storage-api.ts')))
      .replace(/\(\s+/g, '(')
      .replace(/,?\s+\)/g, ')');
    for (const w of [
      'putVectors(ns: string, rows: Iterable<VectorRow> | AsyncIterable<VectorRow>): Promise<PutVectorsResult>',
      'indexInfo(ns: string): Promise<VectorIndexInfo | undefined>',
      'query(ns: string, vector: Float32Array, k: number, opts?: QueryOptions): Promise<QueryHit[]>',
      "'corrupt'",
      '__ld_',
    ])
      expect(ts, w).toContain(w);
    expect(ts).not.toContain('MUST throw StorageError "not_implemented"');
  });

  it('storage-api.md has validation steps 1 to 9, the reasons, the error-hygiene sentence and the reserved namespace rule', () => {
    const md = readText(resolve(specDir, 'storage-api.md'));
    expect(md.startsWith('# Storage API 0.3.0')).toBe(true);
    const start = md.indexOf('## Query validation order');
    expect(start).toBeGreaterThan(-1);
    const section = md.slice(
      start,
      md.indexOf('\n## ', start + 5) === -1 ? undefined : md.indexOf('\n## ', start + 5),
    );
    expect(section.match(/^\d+\. /gm)).toHaveLength(9);
    const f = flat(md);
    for (const w of [
      'filter_prefix',
      'metric',
      'max_index_bytes',
      'wasm_memory',
      "'__ld_vec.' + ns",
      'all-or-nothing',
      'generation',
      'duplicate_key',
      'IEEE-754 binary32',
      'no FMA',
      'dot4',
      'score descending, then key ascending by UTF-8 bytes',
      'details.row',
      'StorageError messages and details for vector operations never contain a key, filterPrefix, vector component, score or value.',
      "reserved: validateNamespace rejects the prefix '__ld_'",
    ])
      expect(f, w).toContain(w);
  });

  it('STORAGE_EVENT_NAMES grows from 4 to 7 with the three vector events (ten since 0.1.4)', () => {
    expect([...STORAGE_EVENT_NAMES].slice(0, 7)).toEqual([
      'storage.set',
      'storage.get',
      'storage.delete',
      'storage.quota',
      'storage.query',
      'storage.index.open',
      'storage.index.write',
    ]);
    const ts = readText(resolve(specDir, 'event.ts'));
    for (const w of ['candidates', 'kernel', 'segments', 'replaced', 'metric'])
      expect(ts, w).toContain(w);
  });
});

describe('spec 0.4.0: event 0.1.3 and S1-074', () => {
  const ts = readText(resolve(specDir, 'event.ts'));

  it('backend.egress.refused documents reporter, count, the host adapter id and URL.origin', () => {
    const at = ts.indexOf("'backend.egress.refused'");
    expect(at).toBeGreaterThan(-1);
    const doc = flatTs(ts.slice(Math.max(0, at - 1800), at));
    for (const w of [
      'reporter',
      'count',
      "HOST's own adapter id",
      'new URL(x).origin',
      "'worker-reported'",
      "'null'",
      'at most 16',
      'per loadId',
    ])
      expect(doc, w).toContain(w);
  });

  it('the privacy paragraph says no worker-provided string, without exception', () => {
    expect(flatTs(ts)).toContain('no worker-provided string, without exception');
  });
});

describe('spec 0.4.0: backend adapter 0.3.1', () => {
  const md = flat(readText(resolve(specDir, 'backend-adapter.md')));
  it('R13 is amended for S1-074 and notes the WebLLM cut', () => {
    const r13 = md.slice(md.indexOf('## R13'));
    expect(r13).toContain("reporter 'worker'");
    expect(r13).toContain("origin 'worker-reported'");
    expect(r13).toContain('host never forwards worker text');
    expect(r13).not.toContain('`egress.origin` must match');
    expect(md).toContain('R11 stays specified and unimplemented');
    expect(md).toContain('TD-08');
  });
});

describe('spec 0.4.0: CHANGELOG', () => {
  const log = readText(resolve(specDir, 'CHANGELOG.md'));
  it('has the [0.4.0] section with the manifest-spec-v0.1 mapping and the folded 0.3.1 patch', () => {
    expect(log).toContain('## [0.4.0] - 2026-11-14 (untagged)');
    const section = flat(log.slice(log.indexOf('## [0.4.0]'), log.indexOf('## [0.3.0]')));
    expect(section).toContain(
      "The plan's 'manifest spec v0.1' is the manifest contract on wire airplanemode.manifest/0.1.",
    );
    expect(section).toContain('publishes it as manifest 0.1.1 in MANIFEST.md, status published');
    expect(section).toContain('manifest 0.1.1: published; other contracts: draft');
    expect(section).toContain(
      'The 0.3.1 patch planned in Sprint 3 is folded into 0.4.0 because storage API 0.2.0 is a minor change.',
    );
    expect(section).toContain("committed; public after the owner's push");
    for (const id of ['S1-074', 'S1-075', 'BUG-T2-S3-22', 'BUG-T2-S3-23-R2'])
      expect(section, id).toContain(id);
  });

  it('corrects the [0.1.0] date to the date of the spec 0.1.0 commit', () => {
    expect(log).toContain('## [0.1.0] - 2026-11-09 (draft)');
    expect(log).not.toContain('## [0.1.0] - 2026-11-22');
    const section = flat(log.slice(log.indexOf('## [0.1.0]')));
    expect(section).toContain('2026-11-22');
    expect(section).toContain('git log');
  });
});
