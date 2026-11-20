// Spec release 0.6.0 (Sprint 6, D1-02): manifest 0.1.3 (S1-113 weak trust keys, TD-54 pinned entries, TD-57
// ramGb wording), capability profile 0.1.1, event 0.1.5, storage API 0.4.0 (HNSW index kind), backend adapter
// 0.5.0 (out_of_memory, R16 to R20). Written before any spec file changed; the red run is
// evidence/sprint-6/D1/red/D1-02.log.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as eventSpec from '../spec/event';
import * as spec from '../spec/index';
import * as manifestSpec from '../spec/manifest';
import * as storageSpec from '../spec/storage-api';
import type {
  AnnIndexInfo,
  BuildIndexOptions,
  BuildIndexResult,
  StorageApi,
  UsageResult,
  VectorIndexInfo,
  VectorIndexKind,
  QueryOptions,
} from '../spec/storage-api';
import type { AdapterErrorCode } from '../spec/backend-adapter';
import { SCHEMAS } from '../src/schema';
import { readJson, readText, relPosix, repoDir, specDir } from './helpers';

const flat = (s: string) => s.replace(/\s+/g, ' ');
const flatTs = (s: string) => flat(s.replace(/\n\s*\*/g, ' '));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const vectorsDir = resolve(specDir, 'vectors');
const text = (p: string): string => (existsSync(p) ? readText(p) : '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('spec 0.6.0: release, versions, status, wire strings, schema ids', () => {
  it('SPEC_RELEASE and SPEC_VERSIONS carry the current (0.6.1) values; test/spec-0.6.1.test.ts pins them as release 0.6.1', () => {
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

  it('status: manifest published, every other contract draft; the wire strings did not move', () => {
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

  it('the schema $ids move with their contract version; the model descriptor keeps 0.2.1', () => {
    expect(SCHEMAS.manifest.$id).toBe('urn:airplanemode:spec:manifest:0.1.4');
    expect(SCHEMAS.capabilityProfile.$id).toBe('urn:airplanemode:spec:capability-profile:0.1.1');
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.6');
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.2.1');
    for (const f of ['manifest.schema.json', 'capability-profile.schema.json', 'event.schema.json'])
      expect(readJson<{ $schema: string }>(resolve(specDir, f)).$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
  });
});

describe('spec 0.6.0: everything that must not change is byte-identical to release 0.5.0', () => {
  const golden = text(resolve(repoDir, 'test/fixtures/spec-0.5.0.sha256.txt'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l)!;
      return [m[2]!, m[1]!] as const;
    });
  const SCHEMA_FILES = new Set([
    'manifest.schema.json',
    'event.schema.json',
    'capability-profile.schema.json',
  ]);

  it('the golden list carries the 0.5.0 vectors and examples (5, 32, 15, 3 and 23 descriptor, expect-id, state-ids)', () => {
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
    expect(golden.length).toBeGreaterThan(100);
  });

  it('every vector, example and unchanged file hashes to its 0.5.0 value (sha256 list)', () => {
    const bad = golden
      .filter(([p]) => !SCHEMA_FILES.has(p))
      .filter(
        ([p, h]) =>
          !existsSync(resolve(specDir, p)) || sha(readFileSync(resolve(specDir, p))) !== h,
      )
      .map(([p]) => p);
    expect(bad).toEqual([]);
  });

  it('manifest.schema.json and event.schema.json differ from their 0.5.0 text only in $id (the bodies are byte-identical)', () => {
    const want = new Map(golden);
    const m = text(resolve(specDir, 'manifest.schema.json')).replace(
      'urn:airplanemode:spec:manifest:0.1.4',
      'urn:airplanemode:spec:manifest:0.1.2',
    );
    const e = text(resolve(specDir, 'event.schema.json')).replace(
      'urn:airplanemode:spec:event:0.1.6',
      'urn:airplanemode:spec:event:0.1.4',
    );
    expect(sha(m)).toBe(want.get('manifest.schema.json'));
    expect(sha(e)).toBe(want.get('event.schema.json'));
  });

  it('capability-profile.schema.json differs from its 0.5.0 text only in $id and the ramGb member (maximum 8, new wording)', () => {
    const want = new Map(golden);
    const now = text(resolve(specDir, 'capability-profile.schema.json'));
    const schema = readJson<{
      properties: {
        ramGb: { type: string; minimum: number; maximum: number; description: string };
      };
    }>(resolve(specDir, 'capability-profile.schema.json'));
    expect(schema.properties.ramGb.maximum).toBe(8);
    expect(schema.properties.ramGb.minimum).toBe(0);
    expect(schema.properties.ramGb.type).toBe('number');
    const d = flat(schema.properties.ramGb.description);
    expect(d).toContain('navigator.deviceMemory as the browser reports it');
    expect(d).toContain('coarse power of two');
    expect(d).toContain('0.25 to 8');
    expect(d).toContain('clamped by the runtime to at most 8');
    expect(d).toContain('0 when not exposed');
    expect(d).toContain('not below a memory line');
    const old = now
      .replace(
        'urn:airplanemode:spec:capability-profile:0.1.1',
        'urn:airplanemode:spec:capability-profile:0.1.0',
      )
      .replace(
        /"ramGb": \{[^}]*\}/,
        '"ramGb": {\n      "type": "number",\n      "minimum": 0,\n      "description": "navigator.deviceMemory in GiB (browsers cap it at 8). 0 = unknown."\n    }',
      );
    expect(sha(old)).toBe(want.get('capability-profile.schema.json'));
  });
});

describe('spec 0.6.0: manifest 0.1.3 (weak keys, pinned entries, ramGb)', () => {
  const md = flat(text(resolve(specDir, 'MANIFEST.md')));
  const ts = flatTs(text(resolve(specDir, 'manifest.ts')));

  it('ManifestRejectReason gains weak_key_refused and WEAK_KEY_REFUSED_MESSAGE is exact', () => {
    expect(manifestSpec.WEAK_KEY_REFUSED_MESSAGE).toBe(
      'trust set contains a weak Ed25519 public key (not the canonical encoding of a prime-order point other than the identity)',
    );
    expect(ts).toContain("| 'weak_key_refused'");
    expect(ts).toContain('Manifest contract 0.1.3');
    expect(ts).toContain("MANIFEST_SPEC = 'airplanemode.manifest/0.1'");
  });

  it('weak_key_refused is raised like test_key_refused: it is not listed in MANIFEST_REJECT_PRECEDENCE', () => {
    expect(manifestSpec.MANIFEST_REJECT_PRECEDENCE.flat()).not.toContain('weak_key_refused');
    expect(manifestSpec.MANIFEST_REJECT_PRECEDENCE.flat()).not.toContain('test_key_refused');
    expect(manifestSpec.MANIFEST_REJECT_PRECEDENCE).toHaveLength(10);
  });

  it('MANIFEST.md has the Manifest 0.1.3 section with the unchanged wire and the ramGb sentence', () => {
    expect(md).toContain('## Manifest 0.1.3');
    expect(md).toContain('urn:airplanemode:spec:manifest:0.1.3');
    expect(md).toContain('The wire string stays `airplanemode.manifest/0.1`');
    expect(md).toContain(
      'capability profile 0.1.1 clamps ramGb to at most 8, so a minProfile.ramGb above 8 is schema-valid but can never be satisfied; producers MUST NOT emit it, and the reference bundler refuses it',
    );
  });

  it('MANIFEST.md has the normative Weak keys section, points (a) to (e)', () => {
    expect(md).toContain('## Weak keys');
    for (const s of [
      '(a) The predicate takes only the 32 raw key bytes, never the keyId, so a weak key filed under any keyId (including 64 zero characters) is refused before key_mismatch is evaluated',
      '(b) A key made by RFC 8032 key generation is always in the prime-order subgroup, so the rule cannot refuse a correctly generated key',
      '(c) The rule does not replace S < L or verify_strict; both stay',
      '(d) The check is a pure function of the bytes: no cache keyed by keyId, and no result stored on the trust-set object',
      '(e) Manifest 0.1.3 has no document-level marker and the check lives in the verifier, so no 0.1.2 document can downgrade it',
      'decode per RFC 8032 section 5.1.3',
      'canonical y (y < p)',
      'x = 0 with the sign bit set',
      '[8]P must not be the identity',
      '[L]P must be the identity',
      'There is no option to skip the check',
    ])
      expect(md, s).toContain(s);
    // the informative "configuration error" bullet it replaces is gone
    expect(md).not.toContain('Small-order public keys in a trust set are a configuration error');
  });

  it('MANIFEST.md Verification order has steps 1a (test keys) and 1b (weak keys), and step 5 repeats the weak check', () => {
    expect(md).toContain('1a. Test keys');
    expect(md).toContain('1b. Weak keys');
    expect(md).toContain('weak_key_refused');
    expect(md).toMatch(/a trusted key that is weak[^.]*weak_key_refused/);
    expect(md).toContain('A key that is not 32 bytes keeps its 0.1.2 outcome');
  });

  it('MANIFEST.md has the informative Pinned entries note (TD-54)', () => {
    expect(md).toContain('### Pinned entries');
    for (const s of [
      'pin is a storage hint',
      'evictToFit skips pinned rows',
      'runtime evict() refuses a pinned row unless { force: true }',
      'pin is not a security property',
    ])
      expect(md, s).toContain(s);
  });

  it('the conformance list gains weak-keys/', () => {
    expect(md).toContain('vectors/weak-keys/');
    expect(md).toMatch(/weak-keys\.json/);
  });

  it('the weak-keys vectors directory exists and make-weak-key-vectors --check is up to date', () => {
    expect(existsSync(resolve(vectorsDir, 'weak-keys/weak-keys.json'))).toBe(true);
    const r = spawnSync(
      process.execPath,
      [resolve(repoDir, 'test/tools/make-weak-key-vectors.mjs'), '--check'],
      { cwd: repoDir, encoding: 'utf8' },
    );
    expect(r.status, `${r.stderr}${r.stdout}`).toBe(0);
  });

  it('make-vectors --check and make-tamper-vectors --check still exit 0', () => {
    for (const g of ['make-vectors.mjs', 'make-tamper-vectors.mjs']) {
      const r = spawnSync(process.execPath, [resolve(repoDir, 'test/tools', g), '--check'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(r.status, `${g}: ${r.stderr}${r.stdout}`).toBe(0);
    }
  });
});

describe('spec 0.6.0: capability profile 0.1.1', () => {
  it('capability-profile.ts documents 0.1.1 and the TD-57 ramGb wording', () => {
    const f = flatTs(text(resolve(specDir, 'capability-profile.ts')));
    for (const s of [
      'Capability profile contract 0.1.1',
      'navigator.deviceMemory as the browser reports it',
      'clamped by the runtime to at most 8',
      'a page cannot read free memory',
      'TD-84',
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.6.0: event 0.1.5', () => {
  const names: readonly string[] = eventSpec.RUNTIME_EVENT_NAMES;

  it('RUNTIME_EVENT_NAMES gains model.unload at the end and keeps every earlier name', () => {
    expect(names).toContain('model.unload');
    expect(names[names.length - 1]).toBe('model.unload');
    expect(names).toHaveLength(27);
    for (const old of ['model.embed', 'model.memory', 'model.generate', 'backend.worker'])
      expect(names).toContain(old);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every event name (runtime, storage, dockit) matches EVENT_NAME_PATTERN', () => {
    for (const n of [
      ...eventSpec.RUNTIME_EVENT_NAMES,
      ...eventSpec.STORAGE_EVENT_NAMES,
      ...eventSpec.DOCKIT_EVENT_NAMES,
    ])
      expect(eventSpec.EVENT_NAME_PATTERN.test(n), n).toBe(true);
  });

  it('STORAGE_EVENT_NAMES grows from 10 to 11 with storage.index.build', () => {
    expect(eventSpec.STORAGE_EVENT_NAMES).toHaveLength(11);
    expect(eventSpec.STORAGE_EVENT_NAMES.slice(10)).toEqual(['storage.index.build']);
  });

  it('PIPELINE_REASONS gains stream_limit and out_of_memory; the earlier eighteen keep their order', () => {
    expect(eventSpec.PIPELINE_REASONS).toEqual([
      'not_pdf',
      'too_large',
      'too_many_pages',
      'encrypted',
      'corrupt',
      'no_text_layer',
      'timeout',
      'model_not_cached',
      'manifest_refused',
      'integrity',
      'unsupported_profile',
      'context_overflow',
      'no_index',
      'ocr_not_yet',
      'legacy_encoding',
      'not_analysed',
      'held_low_score',
      'framed',
      'stream_limit',
      'out_of_memory',
    ]);
    expect(spec.PIPELINE_REASONS).toBe(eventSpec.PIPELINE_REASONS);
  });

  it('pipeline.answer outcome is one of ok, refused, error, aborted', () => {
    expect(eventSpec.PIPELINE_ANSWER_OUTCOMES).toEqual(['ok', 'refused', 'error', 'aborted']);
  });

  it('event.ts documents each new attr, enum and rule', () => {
    const f = flatTs(text(resolve(specDir, 'event.ts')));
    for (const s of [
      'Event contract 0.1.5',
      // model.unload
      "kind model-load; level info (warn for reason 'error' and 'out_of_memory')",
      "attrs: adapter, model, device, host 'worker' | 'main', loadId, reason 'unload' | 'abort' | 'error' | 'out_of_memory'",
      "durationMs runs from the unload() call to the worker's terminate() returning",
      // model.generate
      "finishReason 'abort' (a Stop after the first token)",
      'outTokens and a numeric firstTokenMs',
      "when finishReason is 'error' it gains an optional attr code, an AdapterErrorCode",
      // out_of_memory
      "model.load.failed code and model.embed outcome may be 'out_of_memory'",
      // storage.index.build
      "kind timing; attrs: ns, kind 'hnsw', reason 'build' | 'rebuild' | 'replace', outcome 'ok' or a StorageErrorCode, rows, liveRows, dim, m, efConstruction",
      'bytes = graph bytes written',
      // storage.query
      "requested 'flat' | 'hnsw', index 'flat' | 'hnsw' (the index that answered)",
      "fallback '' | 'absent' | 'stale' | 'filter' | 'metric' | 'short' | 'refused' | 'trap'",
      'ef (integer or null)',
      // storage.index.open
      "kind 'flat' | 'hnsw'",
      "reason 'magic' | 'version' | 'length' | 'dim' | 'ns' | 'generation' | 'bounds' | 'links' | 'crc'",
      // pipeline
      "'stream_limit'",
      "'out_of_memory'",
      "outcome 'ok' | 'refused' | 'error' | 'aborted'",
      'No event carries text, keys, vectors, worker or engine strings, or pagetriage notes',
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.6.0: storage API 0.4.0 (HNSW index kind)', () => {
  it('constants and the ANN namespace prefix', () => {
    expect(storageSpec.HNSW_M_MIN).toBe(4);
    expect(storageSpec.HNSW_M_MAX).toBe(64);
    expect(storageSpec.HNSW_M_DEFAULT).toBe(16);
    expect(storageSpec.HNSW_EF_CONSTRUCTION_DEFAULT).toBe(200);
    expect(storageSpec.HNSW_EF_CONSTRUCTION_MAX).toBe(1000);
    expect(storageSpec.HNSW_EF_MAX).toBe(1000);
    expect(storageSpec.HNSW_EF_DEFAULT_MIN).toBe(64);
    expect(storageSpec.HNSW_MAX_LEVEL).toBe(16);
    expect(storageSpec.HNSW_MAX_GRAPHS).toBe(64);
    expect(storageSpec.ANN_NS_PREFIX).toBe('__ld_ann.');
    expect(storageSpec.ANN_NS_PREFIX.startsWith('__ld_')).toBe(true);
  });

  it('the new types and methods exist (type level: this file does not compile otherwise)', () => {
    const kind: VectorIndexKind = 'hnsw';
    const build: BuildIndexOptions = {
      kind: 'hnsw',
      metric: 'dot',
      m: 16,
      efConstruction: 200,
      seed: 1,
    };
    const result: BuildIndexResult = {
      kind: 'hnsw',
      rows: 1,
      liveRows: 1,
      bytes: 1,
      generation: 1,
      replaced: false,
    };
    const info: AnnIndexInfo = {
      kind: 'hnsw',
      metric: 'cosine',
      m: 16,
      efConstruction: 200,
      seed: 1,
      nodes: 1,
      liveNodes: 1,
      bytes: 1,
      generation: 1,
      current: true,
    };
    const q: QueryOptions = { index: 'hnsw', ef: 64 };
    const vi: Pick<VectorIndexInfo, 'ann'> = { ann: info };
    const u: Pick<UsageResult, 'annBytes'> = { annBytes: 1 };
    const methods: (keyof StorageApi)[] = ['buildIndex', 'dropIndex'];
    expect([
      kind,
      build.kind,
      result.kind,
      q.index,
      vi.ann?.kind,
      u.annBytes,
      methods.length,
    ]).toEqual(['hnsw', 'hnsw', 'hnsw', 'hnsw', 'hnsw', 1, 2]);
  });

  it('storage-api.ts header names 0.4.0 (and 0.4.1) and the generation rule', () => {
    const f = flatTs(text(resolve(specDir, 'storage-api.ts')));
    for (const s of [
      'Storage API contract 0.4.1',
      '0.4.0 (minor, spec release 0.6.0)',
      'buildIndex()',
      'dropIndex()',
      "VectorIndexKind = 'flat' | 'hnsw'",
      "ANN_NS_PREFIX = '__ld_ann.'",
      'Nothing of 0.3.0 changes',
    ])
      expect(f, s).toContain(s);
  });

  it('storage-api.md has the Approximate index (0.4.0) section with the normative sentences', () => {
    const f = flat(text(resolve(specDir, 'storage-api.md')));
    for (const s of [
      '# Storage API 0.4.1',
      '## Approximate index (0.4.0)',
      'Flat is the default and the fallback',
      'answers with the flat scan, giving the same results as flat, and reports the fallback in the event',
      "no graph exists ('absent')",
      "the graph generation is behind the HEAD ('stale')",
      "filterPrefix is set ('filter')",
      "the metric differs ('metric')",
      "including a graph generation AHEAD of HEAD ('refused')",
      "the kernel trapped ('trap')",
      'A graph is current only when its generation EQUALS HEAD',
      "Liveness and the row-ordinal-to-key map come from the flat store HEAD at query time, never from the graph's deleted flags",
      'so a deleted key is never returned, even from a stale or forged graph',
      're-scored with the exact flat scoring function',
      'A crafted graph can only lower recall',
      'deterministically for (rows, order, metric, m, efConstruction, seed)',
      'replaces an existing graph in one commit, under the writer lock',
      "quota_exceeded (reason 'quota' | 'max_index_bytes' | 'wasm_memory' | 'max_graphs') before writing",
      'is allowed on an empty namespace',
      "a replaced row's old node is marked deleted",
      'Graph bytes count toward the pre-write quota check',
      'Flat-only quota behaviour is unchanged',
      "If a graph write fails after the flat commit, the graph stays at the old generation and becomes 'stale'",
      "ANN_NS_PREFIX + ns, where ANN_NS_PREFIX = '__ld_ann.'",
      "a 'graph' record and a separate 'params' record",
      "Every path that removes a namespace's vectors",
      'clear, deleting the last row, dropNamespace or destroy',
      'At most one rebuild runs per (ns, HEAD generation) per open store',
      'There is no rebuild loop',
      'A WebAssembly.RuntimeError from the kernel discards and re-instantiates the module',
      'The flat scan never runs on a trapped instance',
      'opfs, indexeddb and memory drivers',
      'queryChunks (documents API) stays flat in 0.4.0',
      "(invalid_value with details.reason 'kind' | 'm' | 'efConstruction' | 'seed' | 'ef' | 'metric')",
      'The on-disk format is localdata-internal (docs/hnsw-format.md)',
      'It binds the namespace by UTF-8 length plus bytes (at most 64), not by a CRC',
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.6.0: backend adapter 0.5.0', () => {
  it('AdapterErrorCode gains out_of_memory (type level)', () => {
    const code: AdapterErrorCode = 'out_of_memory';
    expect(code).toBe('out_of_memory');
    const f = flatTs(text(resolve(specDir, 'backend-adapter.ts')));
    expect(f).toContain("| 'out_of_memory'");
    expect(f).toContain('Backend adapter contract 0.5.0');
  });

  it('backend-adapter.md has R16 to R20 with the normative rules', () => {
    const f = flat(text(resolve(specDir, 'backend-adapter.md')));
    for (const s of [
      '# Backend adapter 0.5.0',
      '## R16 Unload',
      "for host 'worker', unload() resolves only after the worker is terminated and every AssetHandle is released, and it emits model.unload",
      'WebAssembly memory is returned only by ending the worker, never by an in-worker dispose',
      '## R17 Engine memory options (informative)',
      'enableCpuMemArena false and enableMemPattern false',
      '## R18 Out of memory',
      'a RangeError from WebAssembly.Memory.grow, or an engine allocation error',
      "classified inside the worker into the code enum only and reported as AdapterError('out_of_memory')",
      'there is no retry, no part or cache entry changes, and no worker string reaches an event',
      '## R19 Re-load',
      'a load() after unload() is a first load',
      'a cache miss is a refusal, never a network fetch',
      "No 'already verified' cache keyed by URL, entry id, sha256 or model name may skip any of these",
      '## R20 Snapshot',
      'the engine consumes exactly the bytes the R15 re-hash covered',
      'A File may be re-taken only BEFORE hashing',
      "Any size or hash mismatch takes the 'integrity' path, which is never retried",
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.6.0: README, CHANGELOG and the index', () => {
  it('README lists the 0.6.0 release, the versions and the release-numbering line', () => {
    const readme = flat(text(resolve(specDir, 'README.md')));
    // the README now describes release 0.6.1 (test/spec-0.6.1.test.ts); the 0.6.0 history stays in its text
    expect(readme).toContain('Spec release **0.6.1**');
    expect(readme).toContain('urn:airplanemode:spec:manifest:0.1.4');
    expect(readme).toContain('urn:airplanemode:spec:capability-profile:0.1.1');
    expect(readme).toContain('urn:airplanemode:spec:event:0.1.6');
    expect(readme).toContain(
      'the minor rises because storage API 0.4.0 and backend adapter 0.5.0 are minor changes',
    );
  });

  it('CHANGELOG has the [0.6.0] section with every contract change and id', () => {
    const log = flat(text(resolve(specDir, 'CHANGELOG.md')));
    expect(log).toContain('## [0.6.0] - 2026-11-19 (untagged)');
    for (const s of [
      'manifest 0.1.3',
      'weak_key_refused',
      'S1-113',
      'TD-54',
      'TD-57',
      'TD-68',
      'TD-82',
      'capability profile 0.1.1',
      'event 0.1.5',
      'model.unload',
      'storage.index.build',
      'storage API 0.4.0',
      'buildIndex',
      'backend adapter 0.5.0',
      'out_of_memory',
      'R16',
      'R20',
      'S1-119',
      'The published manifest 0.1.2 wire format is unchanged',
    ])
      expect(log, s).toContain(s);
  });

  it('index.ts header names release 0.6.1 and every contract version', () => {
    const f = flatTs(text(resolve(specDir, 'index.ts')));
    expect(f).toContain('spec release 0.6.1');
    for (const v of [
      'manifest 0.1.4',
      'capability profile 0.1.1',
      'event 0.1.6',
      'storage API 0.4.1',
      'backend adapter 0.5.0',
    ])
      expect(f, v).toContain(v);
  });

  it('the weak-keys vectors are under spec/vectors and listed beside the other vector sets', () => {
    const files = walk(specDir).map((p) => relPosix(specDir, p));
    expect(files.some((f) => f.startsWith('vectors/weak-keys/'))).toBe(true);
    const readme = flat(text(resolve(vectorsDir, 'README.md')));
    expect(readme).toContain('weak-keys/');
  });
});
