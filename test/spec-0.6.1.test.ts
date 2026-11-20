// Spec release 0.6.1 (Sprint 7, D1-01, TD-103, TD-109, TD-110, TD-111, TD-121): manifest 0.1.4 (the normative
// "Release manifests" section, rules R1 to R5, spec/release.ts), event 0.1.6 (duplicateRows, the 'duplicates'
// fallback), storage API 0.4.1 (idle eviction, non-resident drop, the version rebuild, the params refusal),
// the release vectors. Capability profile 0.1.1, backend adapter 0.5.0 and model descriptor 0.2.1 are unchanged.
// Written before any spec file changed; the red run is D1/red/D1-01-*.log in the sprint scratch.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as eventSpec from '../spec/event';
import * as spec from '../spec/index';
import * as release from '../spec/release';
import * as storageSpec from '../spec/storage-api';
import { SCHEMAS } from '../src/schema';
import { readJson, readText, repoDir, specDir } from './helpers';
// @ts-expect-error: plain ESM oracle (test/tools/lib.mjs never imports src/)
import { applyReleaseMutation, oracleReleaseVerify } from './tools/lib.mjs';

const flat = (s: string) => s.replace(/\s+/g, ' ');
const flatTs = (s: string) => flat(s.replace(/\n\s*\*/g, ' '));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const text = (p: string): string => (existsSync(p) ? readText(p) : '');
const vectorsDir = resolve(specDir, 'vectors');
const releaseDir = resolve(vectorsDir, 'release');

const tmpRoot = mkdtempSync(join(tmpdir(), 'amt-spec061-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('spec 0.6.1: release, versions, status, wire strings, schema ids', () => {
  it('SPEC_RELEASE and SPEC_VERSIONS carry the 0.6.1 values', () => {
    expect(spec.SPEC_RELEASE).toBe('0.6.1');
    expect(spec.SPEC_VERSIONS).toEqual({
      manifest: '0.1.4',
      capabilityProfile: '0.1.1',
      event: '0.1.6',
      storageApi: '0.4.1',
      backendAdapter: '0.5.0',
      modelDescriptor: '0.2.1',
    });
  });

  it('status and wire strings did not move', () => {
    expect(spec.SPEC_STATUS).toEqual({
      manifest: 'published',
      capabilityProfile: 'draft',
      event: 'draft',
      storageApi: 'draft',
      backendAdapter: 'draft',
      modelDescriptor: 'draft',
    });
    expect(spec.SPEC_WIRE).toEqual({
      manifest: 'airplanemode.manifest/0.1',
      capabilityProfile: 'airplanemode.capability/0.1',
      event: 'airplanemode.event/0.1',
      modelDescriptor: 'airplanemode.model/0.2',
    });
  });

  it('the schema $ids: manifest 0.1.4 and event 0.1.6 move; capability profile and descriptor keep theirs', () => {
    expect(SCHEMAS.manifest.$id).toBe('urn:airplanemode:spec:manifest:0.1.4');
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.6');
    expect(SCHEMAS.capabilityProfile.$id).toBe('urn:airplanemode:spec:capability-profile:0.1.1');
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.2.1');
  });

  it('index.ts re-exports release.ts', () => {
    expect(spec.RELEASE_ID_PATTERN).toBe(release.RELEASE_ID_PATTERN);
    expect(spec.RELEASE_KEYS_MAX).toBe(8);
    expect(text(resolve(specDir, 'index.ts'))).toContain("export * from './release';");
  });
});

describe('spec 0.6.1: everything that must not change is byte-identical to release 0.6.0', () => {
  const golden = text(resolve(repoDir, 'test/fixtures/spec-0.6.0.sha256.txt'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l)!;
      return [m[2]!, m[1]!] as const;
    });
  const SCHEMA_ID_ONLY = new Set(['manifest.schema.json', 'event.schema.json']);

  it('the golden list carries the 0.6.0 vectors (5, 32, 15, 3 and 23 descriptor, expect-id, state-ids, weak-keys) and the unchanged contracts', () => {
    const names = golden.map(([p]) => p);
    expect(names.filter((n) => /^vectors\/0\d-.*\.json$/.test(n))).toHaveLength(5);
    expect(names.filter((n) => /^vectors\/neg-.*\.json$/.test(n))).toHaveLength(32);
    expect(names.filter((n) => /^vectors\/tamper\/tamper-\d\d-/.test(n))).toHaveLength(15);
    expect(names.filter((n) => /^vectors\/tamper-assets\/.*\.bin$/.test(n))).toHaveLength(3);
    expect(names.filter((n) => /^vectors\/descriptor\/(pos|neg)-.*\.json$/.test(n))).toHaveLength(
      23,
    );
    expect(names).toContain('vectors/expect-id/expect-id.json');
    expect(names).toContain('vectors/state-ids/state-ids.json');
    expect(names).toContain('vectors/weak-keys/weak-keys.json');
    for (const unchanged of [
      'capability-profile.ts',
      'capability-profile.schema.json',
      'backend-adapter.ts',
      'backend-adapter.md',
      'model-descriptor.ts',
      'model-descriptor.schema.json',
    ])
      expect(names).toContain(unchanged);
    expect(golden.length).toBe(125);
  });

  it('every vector, example and unchanged contract file hashes to its 0.6.0 value', () => {
    const bad = golden
      .filter(([p]) => !SCHEMA_ID_ONLY.has(p))
      .filter(
        ([p, h]) =>
          !existsSync(resolve(specDir, p)) || sha(readFileSync(resolve(specDir, p))) !== h,
      )
      .map(([p]) => p);
    expect(bad).toEqual([]);
  });

  it('manifest.schema.json and event.schema.json differ from their 0.6.0 text only in $id (the bodies are byte-identical)', () => {
    const want = new Map(golden);
    const m = text(resolve(specDir, 'manifest.schema.json')).replace(
      'urn:airplanemode:spec:manifest:0.1.4',
      'urn:airplanemode:spec:manifest:0.1.3',
    );
    const e = text(resolve(specDir, 'event.schema.json')).replace(
      'urn:airplanemode:spec:event:0.1.6',
      'urn:airplanemode:spec:event:0.1.5',
    );
    expect(sha(m)).toBe(want.get('manifest.schema.json'));
    expect(sha(e)).toBe(want.get('event.schema.json'));
  });

  it('no vector outside vectors/release/ is new: the vectors directory holds the golden files and release/', () => {
    const golden0 = new Set(golden.map(([p]) => p));
    const now = walk(vectorsDir)
      .map((p) =>
        p
          .slice(specDir.length + 1)
          .split(/[\\/]/)
          .join('/'),
      )
      .filter((p) => !p.startsWith('vectors/release/'));
    expect(now.filter((p) => !golden0.has(p))).toEqual([]);
  });
});

describe('spec 0.6.1: spec/release.ts', () => {
  it('constants', () => {
    expect(release.PACKAGE_IDS).toEqual([
      'runtime',
      'localdata',
      'glyphsift',
      'pagetriage',
      'control-plane',
    ]);
    expect(release.RELEASE_PUBLISHER).toBe('Airplane Mode Labs');
    expect(release.REHEARSAL_PUBLISHER).toBe(
      'Airplane Mode Labs REHEARSAL: signed with the published RFC 8032 test key; not a release',
    );
    expect(release.RELEASE_KEYS_SPEC).toBe('airplanemode.release-keys/0.1');
    expect(release.RELEASE_KEYS_MAX).toBe(8);
    expect(release.SHA256SUMS_NAME).toBe('SHA256SUMS');
    expect(release.RELEASE_MANIFEST_NAME).toBe('release-manifest.json');
    expect(release.RELEASE_REPORT_DIR).toBe('dist-release-report');
    expect(release.RELEASE_ID_PATTERN.flags).toBe('');
    expect(release.REHEARSAL_ID_PATTERN.flags).toBe('');
    expect(release.RELEASE_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,118}-release$');
    expect(release.REHEARSAL_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,116}-rehearsal$');
  });

  it('the reason lists are exactly the specified ones', () => {
    expect(release.RELEASE_REJECT_REASONS).toEqual([
      'manifest_missing',
      'sums_missing',
      'not_regular_file',
      'bad_release_keys',
      'no_trusted_key',
      'test_key_release_id',
      'publisher_mismatch',
      'artifact_missing',
      'artifact_extra',
      'artifact_size_mismatch',
      'artifact_hash_mismatch',
      'sums_mismatch',
    ]);
    expect(release.RELEASE_USAGE_REASONS).toEqual([
      'expect_id_required',
      'test_key_flag_misuse',
      'test_key_release_id',
      'bad_release_id',
      'bad_artifact_name',
      'not_regular_file',
      'publisher_mismatch',
      'already_signed',
      'bad_trust_source',
    ]);
    expect(release.RELEASE_EXIT).toEqual({ ok: 0, io: 1, usage: 2, refused: 3 });
    expect(release.RELEASE_USAGE_SYNTAX_TOKEN).toBe('bad_arguments');
    expect(release.RELEASE_USAGE_REASONS).not.toContain(release.RELEASE_USAGE_SYNTAX_TOKEN);
  });

  it('banners and the cp-sign refusal text are exact', () => {
    expect(release.TEST_KEY_SIGN_BANNER).toBe(
      'TEST KEY SIGNATURE (RFC 8032 TEST 1, published): rehearsal only, NOT A RELEASE',
    );
    expect(release.TEST_KEY_VERIFY_BANNER).toBe(
      'VERIFIED WITH THE PUBLISHED RFC 8032 TEST KEY: rehearsal only, not a release',
    );
    expect(release.TEST_KEY_RELEASE_ID_MESSAGE).toBe(
      'refusing to sign a release id with a published RFC 8032 test key',
    );
    expect(release.REHEARSAL_TEST_KEY_NAME).toBe('rfc8032-1');
  });

  it('media types by suffix: gzip, zip, and octet-stream for everything else', () => {
    const table = Object.fromEntries(release.RELEASE_MEDIA_TYPES);
    expect(table).toEqual({
      '.tar.gz': 'application/gzip',
      '.tgz': 'application/gzip',
      '.crate': 'application/gzip',
      '.whl': 'application/zip',
      '.zip': 'application/zip',
    });
    expect(release.RELEASE_DEFAULT_MEDIA_TYPE).toBe('application/octet-stream');
  });

  it('the largest SOURCE_DATE_EPOCH is 9999-12-31T23:59:59Z', () => {
    expect(release.RELEASE_SOURCE_DATE_EPOCH_MAX).toBe(253402300799);
    expect(new Date(release.RELEASE_SOURCE_DATE_EPOCH_MAX * 1000).toISOString()).toBe(
      '9999-12-31T23:59:59.000Z',
    );
  });
});

describe('spec 0.6.1: the id pattern table (vectors/release/ids.json, shared with control-plane)', () => {
  const rows = existsSync(resolve(releaseDir, 'ids.json'))
    ? readJson<{ id: string; release: boolean; rehearsal: boolean; manifestId: boolean }[]>(
        resolve(releaseDir, 'ids.json'),
      )
    : [];
  const MANIFEST_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;

  it('has at least 30 rows, with the hostile and the limit cases the spec names', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
    const ids = rows.map((r) => r.id);
    for (const must of [
      'x-release\n',
      'X-release',
      'a-releasex',
      '-release',
      'example-rehearsal',
      'example-release',
    ])
      expect(ids, JSON.stringify(must)).toContain(must);
    expect(ids.some((i) => i.length === 127 && i.endsWith('-release'))).toBe(true);
    expect(ids.some((i) => i.length === 128 && i.endsWith('-release'))).toBe(true);
    expect(ids.some((i) => i.length === 127 && i.endsWith('-rehearsal'))).toBe(true);
    expect(ids.some((i) => i.length === 128 && i.endsWith('-rehearsal'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every row equals what the two patterns and the manifest id grammar say', () => {
    for (const r of rows) {
      expect(release.RELEASE_ID_PATTERN.test(r.id), `release ${JSON.stringify(r.id)}`).toBe(
        r.release,
      );
      expect(release.REHEARSAL_ID_PATTERN.test(r.id), `rehearsal ${JSON.stringify(r.id)}`).toBe(
        r.rehearsal,
      );
      expect(MANIFEST_ID.test(r.id), `manifest ${JSON.stringify(r.id)}`).toBe(r.manifestId);
    }
  });

  it('a pattern never matches both, and a matching id is always a valid manifest id', () => {
    for (const r of rows) {
      expect(r.release && r.rehearsal, JSON.stringify(r.id)).toBe(false);
      if (r.release || r.rehearsal) expect(r.manifestId, JSON.stringify(r.id)).toBe(true);
    }
    for (const p of release.PACKAGE_IDS) {
      expect(release.RELEASE_ID_PATTERN.test(`${p}-release`), p).toBe(true);
      expect(release.REHEARSAL_ID_PATTERN.test(`${p}-rehearsal`), p).toBe(true);
    }
  });
});

describe('spec 0.6.1: manifest 0.1.4 (Release manifests, R1 to R5)', () => {
  const md = flat(text(resolve(specDir, 'MANIFEST.md')));
  const ts = flatTs(text(resolve(specDir, 'manifest.ts')));

  it('manifest.ts documents 0.1.4 and keeps the 0.1.3 text; the wire string is unchanged', () => {
    expect(ts).toContain('Manifest contract 0.1.4');
    expect(ts).toContain('Manifest contract 0.1.3');
    expect(ts).toContain('urn:airplanemode:spec:manifest:0.1.4');
    expect(ts).toContain("MANIFEST_SPEC = 'airplanemode.manifest/0.1'");
  });

  it('MANIFEST.md has the Manifest 0.1.4 section and the normative Release manifests section', () => {
    expect(md).toContain('## Manifest 0.1.4');
    expect(md).toContain('urn:airplanemode:spec:manifest:0.1.4');
    expect(md).toContain('The wire string stays `airplanemode.manifest/0.1`');
    expect(md).toContain('## Release manifests');
    for (const s of [
      'A release manifest is an ordinary manifest',
      '`<package>-release`',
      '`<package>-rehearsal`',
      'RELEASE_ID_PATTERN',
      'REHEARSAL_ID_PATTERN',
      'SHA256SUMS covers the artefacts only',
      'never the manifest itself',
      'It is authenticated only through the signed manifest',
      'SOURCE_DATE_EPOCH',
      'docs/release-keys.json',
      'airplanemode.release-keys/0.1',
      'at most 8 keys',
      'no_trusted_key',
      'bad_release_keys',
      '-text',
      'spec/tools/release-tool.mjs',
    ])
      expect(md, s).toContain(s);
  });

  it('R1 to R5 are stated, each by its rule', () => {
    for (const s of [
      'R1: an RFC 8032 test key never signs an id that matches RELEASE_ID_PATTERN',
      'test_key_release_id',
      'test_key_release_id: refusing to sign a release id with a published RFC 8032 test key',
      'whatever the key file is called and with or without --allow-test-key',
      'R2: a release verification never allows test keys, and --expect-id is mandatory',
      'expect_id_required',
      'test_key_flag_misuse',
      'R3: the allow flag exists only as a command-line flag',
      'never read from the environment, a manifest, a URL, a file or stored state',
      'R4: a release key signs only -release ids and is never placed in an application trust set',
      'always pass expectId',
      'a separate key from any bundle-signing key',
      'R5: release manifests carry no expiresAt',
      'cp-sign sign --no-expiry',
      'an expiring manifest would stop verifying in an archive',
    ])
      expect(md, s).toContain(s);
  });

  it('MANIFEST.md names every release verify reason and the exit codes', () => {
    for (const r of release.RELEASE_REJECT_REASONS) expect(md, r).toContain(r);
    for (const r of release.RELEASE_USAGE_REASONS) expect(md, r).toContain(r);
    expect(md).toContain('Exit codes');
    expect(md).toContain('an I/O error is exit 1 and never counts as a refusal');
    expect(md).toContain('lstat');
    expect(md).toContain('not_regular_file');
  });

  it('the conformance list gains vectors/release/', () => {
    expect(md).toContain('vectors/release/');
    expect(md).toMatch(/release\.json/);
  });
});

describe('spec 0.6.1: event 0.1.6', () => {
  it('event.ts documents duplicateRows and the duplicates fallback', () => {
    const f = flatTs(text(resolve(specDir, 'event.ts')));
    for (const s of [
      'Event contract 0.1.6',
      'duplicateRows',
      'live rows whose vector bytes equal those of an earlier live row',
      "fallback '' | 'absent' | 'stale' | 'filter' | 'metric' | 'short' | 'refused' | 'trap' | 'duplicates'",
      "is emitted when localdata's degenerate rule fires (TD-109 plan B, which is active",
      "reason 'magic' | 'version' | 'length' | 'dim' | 'ns' | 'generation' | 'bounds' | 'links' | 'crc' | 'params'",
      'urn:airplanemode:spec:event:0.1.6',
    ])
      expect(f, s).toContain(s);
    expect(f).not.toContain('nothing emits it');
    expect(f).not.toContain('reserved for TD-109');
  });

  it('the reserved storage names did not grow: still 11, storage.index.build last', () => {
    expect(eventSpec.STORAGE_EVENT_NAMES).toHaveLength(11);
    expect(eventSpec.STORAGE_EVENT_NAMES[10]).toBe('storage.index.build');
  });
});

describe('spec 0.6.1: storage API 0.4.1 (wording)', () => {
  const md = flat(text(resolve(specDir, 'storage-api.md')));
  const ts = flatTs(text(resolve(specDir, 'storage-api.ts')));

  it('storage-api.ts and storage-api.md say 0.4.1 and keep the constants', () => {
    expect(ts).toContain('Storage API contract 0.4.1');
    expect(text(resolve(specDir, 'storage-api.md')).startsWith('# Storage API 0.4.1')).toBe(true);
    expect(storageSpec.HNSW_MAX_GRAPHS).toBe(64);
    expect(storageSpec.ANN_NS_PREFIX).toBe('__ld_ann.');
  });

  it('the four wording markers, in prose and in the type file', () => {
    for (const body of [md, ts]) {
      expect(body).toContain(
        'releases the in-memory instance (never the stored bytes) of the least-recently-used idle graph',
      );
      expect(body).toContain('no operation running or queued, and not being built');
      expect(body).toContain('throws max_graphs only when every resident graph is busy');
      expect(body).toContain('dropIndex frees a slot only if the graph was resident');
      expect(body).toContain(
        "a graph refused for an older internal format (reason 'version') is rebuilt from the stored vectors at most once per generation",
      );
      expect(body).toContain('guarded by a persisted marker');
      expect(body).toContain(
        "a stored graph whose header params differ from the stored params record is refused (reason 'params') before any reservation",
      );
    }
  });
});

describe('spec 0.6.1: README, CHANGELOG and attributes', () => {
  const readme = flat(text(resolve(specDir, 'README.md')));
  const changelog = text(resolve(specDir, 'CHANGELOG.md'));
  const attrs = text(resolve(repoDir, '.gitattributes'));

  it('README describes release 0.6.1 and has no stale contract headings', () => {
    expect(readme).toContain('Spec release **0.6.1**');
    expect(readme).toContain('urn:airplanemode:spec:manifest:0.1.4');
    expect(readme).toContain('urn:airplanemode:spec:event:0.1.6');
    for (const h of [
      '## Capability profile 0.1.1',
      '## Event 0.1.6',
      '## Storage API 0.4.1',
      '## Backend adapter 0.5.0',
      '## Model descriptor 0.2.1',
    ])
      expect(readme, h).toContain(h);
    for (const stale of [
      '## Capability profile 0.1.0',
      '## Event 0.1.4',
      '## Storage API 0.3.0',
      '## Backend adapter 0.4.0',
    ])
      expect(readme, stale).not.toContain(stale);
    expect(readme).toContain('release.ts');
    expect(readme).toContain('vectors/release/');
    expect(readme).toContain('spec/tools/release-tool.mjs');
  });

  it('CHANGELOG has [0.6.1] - 2026-11-20 (untagged) with the four groups it needs', () => {
    expect(changelog).toContain('## [0.6.1] - 2026-11-20 (untagged)');
    const section = changelog.slice(
      changelog.indexOf('## [0.6.1]'),
      changelog.indexOf('## [0.6.0]'),
    );
    for (const s of ['### Added', '### Changed', 'TD-103', 'TD-121', 'S1-127', 'duplicateRows'])
      expect(section, s).toContain(s);
  });

  it('.gitattributes pins spec/vectors/** and spec/tools/** as -text', () => {
    expect(attrs).toMatch(/^spec\/vectors\/\*\*\s+-text\s*$/m);
    expect(attrs).toMatch(/^spec\/tools\/\*\*\s+-text\s*$/m);
  });
});

describe('spec 0.6.1: the release vectors (vectors/release/)', () => {
  const cases = existsSync(resolve(releaseDir, 'release.json'))
    ? readJson<
        {
          name: string;
          dir: string;
          level: 'manifest' | 'directory';
          command: 'verify' | 'sign';
          mutation: Record<string, unknown>;
          args: string[];
          expect: { exit: number; reason: string | null; testKey?: boolean };
          platform?: string;
        }[]
      >(resolve(releaseDir, 'release.json'))
    : [];

  it('the directory layout: five artefact directories, keys/, ids.json, release.json, README.md', () => {
    for (const d of ['base', 'release-id', 'vk-release', 'vk-publisher', 'tk-publisher'])
      for (const f of ['example-a.bin', 'example-b.txt', 'release-manifest.json', 'SHA256SUMS'])
        expect(existsSync(resolve(releaseDir, d, f)), `${d}/${f}`).toBe(true);
    for (const k of [
      'empty.json',
      'test-key.json',
      'weak.json',
      'vector-key.json',
      'duplicate-member.json',
      'keyid-mismatch.json',
      'duplicate-keyid.json',
      'too-many.json',
    ])
      expect(existsSync(resolve(releaseDir, 'keys', k)), `keys/${k}`).toBe(true);
    expect(existsSync(resolve(releaseDir, 'README.md'))).toBe(true);
  });

  it('the artefacts are synthetic and under 1 KB; no file in the directory is over 64 KB', () => {
    for (const f of walk(releaseDir)) expect(statSync(f).size, f).toBeLessThan(64 * 1024);
    for (const d of ['base', 'release-id', 'vk-release', 'vk-publisher', 'tk-publisher'])
      for (const f of ['example-a.bin', 'example-b.txt'])
        expect(statSync(resolve(releaseDir, d, f)).size, `${d}/${f}`).toBeLessThan(1024);
  });

  it('SHA256SUMS: ASCII, LF only, sorted by name, one line per artefact, never the manifest', () => {
    for (const d of ['base', 'release-id', 'vk-release', 'vk-publisher', 'tk-publisher']) {
      const bytes = readFileSync(resolve(releaseDir, d, 'SHA256SUMS'));
      const s = bytes.toString('latin1');
      expect(bytes.includes(0x0d), d).toBe(false);
      expect(s.endsWith('\n'), d).toBe(true);
      expect(/^[\x20-\x7e\n]*$/.test(s), `${d} is ASCII`).toBe(true);
      const lines = s.slice(0, -1).split('\n');
      expect(lines, d).toHaveLength(2);
      expect(lines.map((l) => l.slice(66))).toEqual(['example-a.bin', 'example-b.txt']);
      for (const l of lines) expect(l, d).toMatch(/^[0-9a-f]{64} {2}[a-z0-9._-]+$/);
      expect(s).not.toContain('release-manifest.json');
      for (const l of lines) {
        const name = l.slice(66);
        expect(l.slice(0, 64), `${d}/${name}`).toBe(
          sha(readFileSync(resolve(releaseDir, d, name))),
        );
      }
    }
  });

  it('the base manifest is a rehearsal signed with TEST 1 at 2026-11-20T00:00:00Z with no expiresAt (R5)', () => {
    const m = readJson<Record<string, unknown>>(resolve(releaseDir, 'base/release-manifest.json'));
    expect(m['id']).toBe('example-rehearsal');
    expect(m['publisher']).toBe(release.REHEARSAL_PUBLISHER);
    expect(m['createdAt']).toBe('2026-11-20T00:00:00Z');
    expect(m).not.toHaveProperty('expiresAt');
    const sigs = m['signatures'] as { keyId: string }[];
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.keyId).toBe('21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9');
    const raw = readFileSync(resolve(releaseDir, 'base/release-manifest.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).not.toContain('\r');
  });

  it('release-id is signed with TEST 1 under a release id; vk-release is signed with a key that is not a test key', () => {
    const rid = readJson<{ id: string; publisher: string; signatures: { keyId: string }[] }>(
      resolve(releaseDir, 'release-id/release-manifest.json'),
    );
    expect(rid.id).toBe('example-release');
    expect(rid.publisher).toBe(release.RELEASE_PUBLISHER);
    expect(rid.signatures[0]!.keyId).toBe(
      '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
    );
    const vk = readJson<{ id: string; publisher: string; signatures: { keyId: string }[] }>(
      resolve(releaseDir, 'vk-release/release-manifest.json'),
    );
    expect(vk.id).toBe('example-release');
    expect(vk.publisher).toBe(release.RELEASE_PUBLISHER);
    const vkp = readJson<{ id: string; publisher: string; signatures: { keyId: string }[] }>(
      resolve(releaseDir, 'vk-publisher/release-manifest.json'),
    );
    expect(vkp.id).toBe('example-release');
    expect(vkp.publisher).toBe(release.REHEARSAL_PUBLISHER);
    expect(vkp.signatures[0]!.keyId).toBe(vk.signatures[0]!.keyId);
    expect(vk.signatures[0]!.keyId).not.toBe(
      '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
    );
    const tkp = readJson<{ id: string; publisher: string }>(
      resolve(releaseDir, 'tk-publisher/release-manifest.json'),
    );
    expect(tkp.id).toBe('example-rehearsal');
    expect(tkp.publisher).toBe(release.RELEASE_PUBLISHER);
  });

  it('the vector key seed is not committed anywhere under spec/ or in the vectors', () => {
    const seed = sha('airplanemode release vector key 1');
    for (const f of walk(specDir)) {
      const body = readFileSync(f);
      expect(body.includes(seed), f).toBe(false);
    }
  });

  it('keys/: the public-key files are exactly the specified shapes', () => {
    const k = (n: string) =>
      readJson<{ spec: string; keys: unknown[] }>(resolve(releaseDir, 'keys', n));
    expect(k('empty.json')).toEqual({ spec: 'airplanemode.release-keys/0.1', keys: [] });
    expect(k('too-many.json').keys).toHaveLength(9);
    expect(k('test-key.json').keys).toHaveLength(1);
    expect(k('weak.json').keys).toHaveLength(1);
    expect(k('vector-key.json').keys).toHaveLength(1);
    expect(k('keyid-mismatch.json').keys).toHaveLength(1);
    expect(k('duplicate-keyid.json').keys).toHaveLength(2);
    // a repeated member name is invalid, so the file is not valid under the strict scan
    const dup = text(resolve(releaseDir, 'keys/duplicate-member.json'));
    expect(dup.match(/"spec"/g)).toHaveLength(2);
  });

  it('release.json: the specified cases are all there, with exit and reason', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const by = (n: string) => cases.find((c) => c.name === n);
    const expectCase = (n: string, exit: number, reason: string | null) => {
      const c = by(n);
      expect(c, n).toBeDefined();
      expect(c!.expect.exit, n).toBe(exit);
      expect(c!.expect.reason, n).toBe(reason);
    };
    expectCase('rehearsal-ok-with-flags', 0, null);
    expect(by('rehearsal-ok-with-flags')!.expect.testKey).toBe(true);
    expectCase('test-key-refused-without-flag', 3, 'test_key_refused');
    expectCase('trust-file-empty', 3, 'no_trusted_key');
    expectCase('trust-file-test-key', 3, 'test_key_refused');
    expectCase('trust-file-weak', 3, 'weak_key_refused');
    for (const n of [
      'trust-file-duplicate-member',
      'trust-file-keyid-mismatch',
      'trust-file-duplicate-keyid',
      'trust-file-too-many',
    ])
      expectCase(n, 3, 'bad_release_keys');
    expectCase('unexpected-id', 3, 'unexpected_id');
    expectCase('no-expect-id', 2, 'expect_id_required');
    expectCase('release-id-trust-test-key-allow', 2, 'test_key_flag_misuse');
    expectCase('release-id-trust-test-key-no-flag', 2, 'test_key_flag_misuse');
    expectCase('release-id-trust-file-test-key', 3, 'test_key_refused');
    expectCase('trust-file-with-allow-flag', 2, 'test_key_flag_misuse');
    expectCase('vk-release-ok', 0, null);
    expect(by('vk-release-ok')!.expect.testKey).toBe(false);
    expectCase('vk-publisher-mismatch', 3, 'publisher_mismatch');
    expectCase('tk-publisher-mismatch', 3, 'publisher_mismatch');
    expectCase('artifact-byte-flipped', 3, 'artifact_hash_mismatch');
    expectCase('artifact-truncated', 3, 'artifact_size_mismatch');
    expectCase('artifact-removed', 3, 'artifact_missing');
    expectCase('artifact-extra-file', 3, 'artifact_extra');
    expectCase('sums-line-changed', 3, 'sums_mismatch');
    expectCase('sums-crlf', 3, 'sums_mismatch');
    expectCase('sums-reordered', 3, 'sums_mismatch');
    expectCase('manifest-publisher-edited', 3, 'no_valid_signature');
    expectCase('symlinked-artifact', 3, 'not_regular_file');
    expectCase('symlinked-dir', 3, 'not_regular_file');
    expectCase('subdirectory', 3, 'not_regular_file');
    expectCase('junction-artifact', 3, 'not_regular_file');
    expect(by('junction-artifact')!.platform).toBe('win32');
    expectCase('sign-release-id', 2, 'test_key_release_id');
    expect(by('sign-release-id')!.command).toBe('sign');
  });

  it('every case has a level; the manifest-level cases are the ones control-plane can run', () => {
    for (const c of cases) expect(['manifest', 'directory'], c.name).toContain(c.level);
    const manifestLevel = cases.filter((c) => c.level === 'manifest').map((c) => c.name);
    for (const n of [
      'rehearsal-ok-with-flags',
      'test-key-refused-without-flag',
      'trust-file-test-key',
      'trust-file-weak',
      'unexpected-id',
      'release-id-trust-test-key-allow',
      'vk-release-ok',
      'vk-publisher-mismatch',
      'tk-publisher-mismatch',
      'manifest-publisher-edited',
      'sign-release-id',
    ])
      expect(manifestLevel, n).toContain(n);
  });

  describe('every case through the independent oracle (test/tools/lib.mjs, which never imports src/)', () => {
    for (const c of cases)
      it(`${c.name}: ${c.expect.exit} ${c.expect.reason ?? 'ok'}`, async () => {
        if (c.platform !== undefined && c.platform !== process.platform) return;
        const work = mkdtempSync(join(tmpRoot, 'case-'));
        const dir = join(work, 'dir');
        const arrange = await applyReleaseMutation(releaseDir, c.dir, dir, c.mutation, {
          work,
        });
        const got = await oracleReleaseVerify({
          command: c.command ?? 'verify',
          dir: arrange.dir,
          args: c.args,
          keysDir: resolve(releaseDir, 'keys'),
        });
        expect(got.exit).toBe(c.expect.exit);
        expect(got.reason ?? null).toBe(c.expect.reason);
        if (c.expect.testKey !== undefined) expect(got.testKey).toBe(c.expect.testKey);
      });
  });
});

describe('spec 0.6.1: make-release-vectors.mjs', () => {
  const tool = resolve(repoDir, 'test/tools/make-release-vectors.mjs');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [tool, ...args], { cwd: repoDir, encoding: 'utf8' });

  it('--check exits 0: the committed vectors are exactly what the generator writes', () => {
    const r = run('--check');
    expect(r.status, `${r.stderr}${r.stdout}`).toBe(0);
  });

  it('two runs into different directories give byte-identical files (and the same names)', () => {
    const a = join(tmpRoot, 'gen-a');
    const b = join(tmpRoot, 'gen-b');
    mkdirSync(a);
    mkdirSync(b);
    expect(run('--out', a).status).toBe(0);
    expect(run('--out', b).status).toBe(0);
    const fa = walk(a).map((p) => p.slice(a.length));
    const fb = walk(b).map((p) => p.slice(b.length));
    expect(fa).toEqual(fb);
    expect(fa.length).toBeGreaterThan(30);
    for (const rel of fa)
      expect(sha(readFileSync(join(a, rel)))).toBe(sha(readFileSync(join(b, rel))));
    // and the committed vectors are the same bytes
    for (const rel of fa)
      expect(sha(readFileSync(join(a, rel))), rel).toBe(sha(readFileSync(join(releaseDir, rel))));
  });

  it('the generator does not import src/ and holds no seed of the vector key outside lib.mjs', () => {
    const gen = text(tool);
    const code = gen
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    expect(code).not.toMatch(/from\s+['"][^'"]*\/src\//);
    expect(code).not.toContain('airplanemode release vector key 1');
    expect(text(resolve(repoDir, 'test/tools/lib.mjs'))).toContain(
      'airplanemode release vector key 1',
    );
  });
});
