// Spec release 0.5.0 (Sprint 5, D1-03): manifest 0.1.2 (published, additive patch, wire unchanged), event
// 0.1.4, storage API 0.3.0 (documents), backend adapter 0.4.0 (embed, R4b, R14, R15) and the new vectors
// expect-id/ and state-ids/. Written before any spec file changed; the red run is
// evidence/sprint-5/D1/red/D1-03.log.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as eventSpec from '../spec/event';
import * as spec from '../spec/index';
import { MANIFEST_REJECT_PRECEDENCE } from '../spec/manifest';
import {
  CHUNK_GATE_KEYS_MAX,
  CHUNK_TEXT_UTF8_MAX,
  DOC_CHUNKS_MAX,
  DOC_ID_PATTERN,
  DOC_META_KEYS_MAX,
  DOC_QUERY_K_MAX,
  DOC_TITLE_MAX,
  type StorageApi,
} from '../spec/storage-api';
import { EMBED_MAX_TEXTS, EMBED_TEXT_MAX, type AdapterErrorCode } from '../spec/backend-adapter';
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

describe('spec 0.5.0: release, versions, status, wire strings, schema ids', () => {
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

  it('a patch moves only the $id: manifest 0.1.4, event 0.1.6 and capability profile 0.1.1 (release 0.6.1); the descriptor keeps its own', () => {
    expect(SCHEMAS.manifest.$id).toBe('urn:airplanemode:spec:manifest:0.1.4');
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.6');
    expect(SCHEMAS.capabilityProfile.$id).toBe('urn:airplanemode:spec:capability-profile:0.1.1');
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.2.1');
    for (const f of ['manifest.schema.json', 'event.schema.json'])
      expect(readJson<{ $schema: string }>(resolve(specDir, f)).$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
  });
});

describe('spec 0.5.0: files that must not change are byte-identical to release 0.4.0', () => {
  const golden = text(resolve(repoDir, 'test/fixtures/spec-0.4.0.sha256.txt'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l)!;
      return [m[2]!, m[1]!] as const;
    });

  it('the golden list has the 0.4.0 vectors (5 positives, 32 negatives, 15 tamper, 3 asset-tamper, 20 descriptor)', () => {
    const names = golden.map(([p]) => p);
    expect(names.filter((n) => /^vectors\/0\d-.*\.json$/.test(n))).toHaveLength(5);
    expect(names.filter((n) => /^vectors\/neg-.*\.json$/.test(n))).toHaveLength(32);
    expect(names.filter((n) => /^vectors\/tamper\/tamper-\d\d-/.test(n))).toHaveLength(15);
    expect(names.filter((n) => /^vectors\/tamper-assets\/.*\.bin$/.test(n))).toHaveLength(3);
    expect(names.filter((n) => /^vectors\/descriptor\/(pos|neg)-.*\.json$/.test(n))).toHaveLength(
      23,
    ); // 3 positives + 20 negatives
  });

  it('every file in the golden list hashes to its 0.4.0 value', () => {
    expect(golden.length).toBeGreaterThan(100);
    const bad = golden
      // the two schemas are checked below with their $id swapped back
      .filter(([p]) => p !== 'manifest.schema.json' && p !== 'event.schema.json')
      // capability profile 0.1.1 (release 0.6.0) changed these two files; test/spec-0.6.test.ts pins the change
      .filter(([p]) => p !== 'capability-profile.schema.json' && p !== 'capability-profile.ts')
      .filter(
        ([p, h]) =>
          !existsSync(resolve(specDir, p)) || sha(readFileSync(resolve(specDir, p))) !== h,
      )
      .map(([p]) => p);
    expect(bad).toEqual([]);
  });

  it('manifest.schema.json and event.schema.json differ from their 0.4.0 text only in $id', () => {
    const want = new Map(golden);
    const m = text(resolve(specDir, 'manifest.schema.json')).replace(
      'urn:airplanemode:spec:manifest:0.1.4',
      'urn:airplanemode:spec:manifest:0.1.1',
    );
    const e = text(resolve(specDir, 'event.schema.json')).replace(
      'urn:airplanemode:spec:event:0.1.6',
      'urn:airplanemode:spec:event:0.1.3',
    );
    expect(sha(m)).toBe(want.get('manifest.schema.json'));
    expect(sha(e)).toBe(want.get('event.schema.json'));
  });
});

describe('spec 0.5.0: manifest 0.1.2', () => {
  const md = flat(text(resolve(specDir, 'MANIFEST.md')));
  const ts = flatTs(text(resolve(specDir, 'manifest.ts')));

  it('MANIFEST_REJECT_PRECEDENCE puts unexpected_id after no_valid_signature and before downgrade and state', () => {
    expect(MANIFEST_REJECT_PRECEDENCE).toEqual([
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
    expect(ts).toContain("| 'unexpected_id'");
  });

  it('MANIFEST.md specifies expectId: the exact TypeError message, the stage and that state is untouched', () => {
    expect(md).toContain('## Manifest 0.1.2');
    expect(md).toContain('expectId');
    expect(md).toContain("throws a TypeError with the exact message 'invalid expectId'");
    expect(md).toContain("rejected with the reason 'unexpected_id' (stage 'verify')");
    expect(md).toContain('BEFORE the downgrade state is read');
    expect(md).toContain('neither read nor written');
    expect(md).toContain('expectManifestId');
    expect(md).toContain('cp-manifest takes `verify --expect-id <id>`');
  });

  it('MANIFEST.md carries the S1-097 sentence, the shared-origin note and the S1-102 sentence verbatim', () => {
    expect(md).toContain(
      "A consumer MUST resolve every entry url against the manifest URL and re-check the resolved URL's scheme (https, or http to a loopback host in tests) and origin against its allowed origins before any request; a network-path reference (//host/...) or a backslash form that the WHATWG URL parser treats as one can leave the manifest's origin.",
    );
    expect(md).toContain(
      'on a shared origin, a consumer SHOULD also require each resolved pathname to start with its own model directory',
    );
    expect(md).toContain(
      "Implementations MUST key the downgrade state so that no id (for example constructor or prototype) collides with an inherited member of the host language's map or object type.",
    );
  });

  it('MANIFEST.md has the normative Demo bundles rules', () => {
    expect(md).toContain('## Demo bundles');
    for (const s of [
      'dev.airplanemode.dockit-models',
      'dev.airplanemode.runtime-demo-models',
      "version is the consumer's package.json version",
      "publisher is 'AirplaneMode-Labs demo build'",
      'no expiresAt',
      'pin: true',
      'generated in memory per build',
      'never exported',
      'trust-root.ts exports exactly one',
    ])
      expect(md, s).toContain(s);
  });

  it('manifest.ts documents 0.1.2 (still named in the header) and the wire is unchanged', () => {
    expect(ts).toContain('0.1.2 (spec release 0.5.0) is an additive patch of 0.1.1');
    expect(ts).toContain("MANIFEST_SPEC = 'airplanemode.manifest/0.1'");
  });
});

describe('spec 0.5.0: event 0.1.4', () => {
  it('RUNTIME_EVENT_NAMES gains model.embed and model.memory, and keeps every earlier name', () => {
    const names: readonly string[] = eventSpec.RUNTIME_EVENT_NAMES;
    expect(names).toContain('model.embed');
    expect(names).toContain('model.memory');
    for (const old of [
      'asset.download.start',
      'manifest.verify.failed',
      'backend.egress.refused',
      'model.load.phase',
      'memory.sample',
      'backend.worker',
    ])
      expect(names).toContain(old);
    expect(new Set(names).size).toBe(names.length);
  });

  it('STORAGE_EVENT_NAMES grew from 7 to 10 with storage.doc.put, .delete and .query (11 since 0.1.5)', () => {
    expect(eventSpec.STORAGE_EVENT_NAMES).toHaveLength(11);
    expect(eventSpec.STORAGE_EVENT_NAMES.slice(7, 10)).toEqual([
      'storage.doc.put',
      'storage.doc.delete',
      'storage.doc.query',
    ]);
  });

  it('DOCKIT_EVENT_NAMES, PIPELINE_STAGES and PIPELINE_REASONS are exact', () => {
    expect(eventSpec.DOCKIT_EVENT_NAMES).toEqual([
      'pipeline.stage',
      'pipeline.answer',
      'pipeline.memory',
    ]);
    expect(eventSpec.PIPELINE_STAGES).toEqual([
      'read',
      'triage',
      'extract',
      'gate',
      'chunk',
      'embed',
      'index',
      'retrieve',
      'generate',
    ]);
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
      // Event 0.1.5 appended two reasons (test/spec-0.6.test.ts)
      'stream_limit',
      'out_of_memory',
    ]);
  });

  it('the index re-exports the dockit names, stages and reasons', () => {
    expect(spec.DOCKIT_EVENT_NAMES).toBe(eventSpec.DOCKIT_EVENT_NAMES);
    expect(spec.PIPELINE_STAGES).toBe(eventSpec.PIPELINE_STAGES);
    expect(spec.PIPELINE_REASONS).toBe(eventSpec.PIPELINE_REASONS);
  });

  it('event.ts documents each new name with its attrs, the budget attr and the unexpected_id reason', () => {
    const f = flatTs(text(resolve(specDir, 'event.ts')));
    for (const s of [
      '0.1.4 (wire-compatible, spec release 0.5.0)',
      "attrs: adapter, model, device, host 'worker' | 'main', loadId, inputs",
      "measure 'wasm-memory' | 'unavailable'",
      'peak WebAssembly.Memory buffer.byteLength sampled every 50 ms inside the worker',
      'budget (integer',
      "finishReason may be 'abort'",
      "'unexpected_id'",
      "redactNamespacePrefix(prefix) is emitted as prefix+'*'",
      "localdata SDK replaces any ns starting 'dockit.d' with the literal 'dockit.d*'",
      "outcome 'ok' | 'refused' | 'error' | 'skipped'",
      'No event ever carries a file name, document id, title, page text, question, prompt or answer',
      "host 'worker'",
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.5.0: storage API 0.3.0 (documents)', () => {
  it('constants', () => {
    expect(DOC_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9_-]{0,63}$');
    expect([
      DOC_TITLE_MAX,
      DOC_META_KEYS_MAX,
      CHUNK_TEXT_UTF8_MAX,
      DOC_CHUNKS_MAX,
      CHUNK_GATE_KEYS_MAX,
      DOC_QUERY_K_MAX,
    ]).toEqual([256, 16, 16384, 20000, 8, 1000]);
  });

  it('StorageApi has the six new methods (type level: this file does not compile otherwise)', () => {
    const keys: (keyof StorageApi)[] = [
      'putDocument',
      'getDocument',
      'listDocuments',
      'deleteDocument',
      'queryChunks',
      'redactNamespacePrefix',
    ];
    expect(keys).toHaveLength(6);
  });

  it('storage-api.md has the Documents (0.3.0) section with the normative sentences', () => {
    const f = flat(text(resolve(specDir, 'storage-api.md')));
    for (const s of [
      '## Documents (0.3.0)',
      "'__ld_doc.' + ns",
      'ALL-OR-NOTHING',
      'deleteDocument hides the chunks from every query; their bytes may remain in the driver until clear(ns) (no compaction). clear(ns) MUST physically remove every file or record of the document namespace.',
      'score descending, then docId ascending by UTF-8 bytes, then ordinal ascending',
      '`query(ns)` never returns chunks, and `list(ns)` never lists documents',
      "Only `__proto__`, constructor and prototype are refused, with reason 'reserved_key'",
      'toString, valueOf, hasOwnProperty',
      "'duplicate_ordinal'",
      "'dim' or 'k'",
      'null-prototype',
      'Web Lock',
      'redactNamespacePrefix(prefix)',
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.5.0: backend adapter 0.4.0', () => {
  it('embed limits and the context_overflow code', () => {
    expect(EMBED_MAX_TEXTS).toBe(64);
    expect(EMBED_TEXT_MAX).toBe(8192);
    const code: AdapterErrorCode = 'context_overflow';
    expect(code).toBe('context_overflow');
  });

  it('backend-adapter.ts documents EmbedOptions, EmbedResult.truncated and GenerateResult.budget', () => {
    const f = flatTs(text(resolve(specDir, 'backend-adapter.ts')));
    for (const s of [
      '0.4.0 (minor, spec release 0.5.0)',
      'export interface EmbedOptions',
      "pooling?: 'mean' | 'cls'",
      'normalize?: boolean',
      'truncated?: boolean',
      'budget?: number',
      "'context_overflow'",
      'embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>',
    ])
      expect(f, s).toContain(s);
  });

  it('backend-adapter.md has R4b, R14 and R15 with the normative rules', () => {
    const f = flat(text(resolve(specDir, 'backend-adapter.md')));
    for (const s of [
      '## R4b Token budget',
      'budget = min(opts.maxTokens ?? descriptor.generation.maxNewTokens ?? 256, contextLength - promptTokens)',
      "rejects 'context_overflow' before decode",
      "finishReason 'length'",
      'maxTokens must be an integer 1..32768',
      "finishReason 'abort' and the partial text",
      "rejects 'aborted'",
      '## R14 Embeddings through the worker host',
      "descriptor task is 'feature-extraction'",
      "rejects 'unsupported_operation'",
      "rejects 'backend'",
      'bit-identical',
      '## R15 In-worker integrity',
      'blob.size === entry.size',
      'crypto.subtle',
      'every file the engine can read',
      'No kind is exempt',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'chat_template.jinja',
      'generation_config.json',
      "rejects 'integrity' and the engine receives 0 bytes",
      'The bytes served to the engine are exactly the bytes hashed',
      'main-thread load-time re-hash is removed from the load path',
      '## Worker support exports',
      'installEgressGuard({ allowPathPrefixes })',
      'startModuleWorker(url, { policyName })',
    ])
      expect(f, s).toContain(s);
  });
});

describe('spec 0.5.0: new vectors', () => {
  const eiDir = resolve(vectorsDir, 'expect-id');
  const siDir = resolve(vectorsDir, 'state-ids');
  type Row = {
    file: string;
    trust: string[];
    allowTestKeys: boolean;
    now: string;
    state: { version: string; createdAt: string } | null;
    requiresState: boolean;
    expectId: string;
    expect: { valid: boolean; stage?: string; reason?: string; throws?: string; message?: string };
  };
  const expectId = (): Row[] => readJson<Row[]>(resolve(eiDir, 'expect-id.json'));
  const stateIds = (): Row[] => readJson<Row[]>(resolve(siDir, 'state-ids.json'));

  it('expect-id.json has the eight rows of the contract, in order', () => {
    const rows = expectId();
    expect(rows).toHaveLength(8);
    const s = { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' };
    const summary = rows.map((r) => [
      r.file,
      r.expectId,
      r.expect.valid,
      r.expect.stage ?? null,
      r.expect.reason ?? null,
      r.expect.throws ?? null,
      r.expect.message ?? null,
      r.requiresState,
      r.state,
    ]);
    expect(summary).toEqual([
      ['tamper/tamper-base.json', 'tamper-base', true, null, null, null, null, false, null],
      [
        'tamper/tamper-base.json',
        'other-product',
        false,
        'verify',
        'unexpected_id',
        null,
        null,
        false,
        null,
      ],
      [
        'tamper/tamper-03-sig-bitflip.json',
        'other-product',
        false,
        'verify',
        'no_valid_signature',
        null,
        null,
        false,
        null,
      ],
      [
        'tamper/tamper-10-expired.json',
        'other-product',
        false,
        'verify',
        'expired',
        null,
        null,
        false,
        null,
      ],
      [
        'tamper/tamper-08-rollback.json',
        'other-product',
        false,
        'verify',
        'unexpected_id',
        null,
        null,
        true,
        s,
      ],
      [
        'tamper/tamper-08-rollback.json',
        'tamper-base',
        false,
        'verify',
        'downgrade',
        null,
        null,
        true,
        s,
      ],
      [
        'tamper/tamper-base.json',
        'BAD ID',
        false,
        null,
        null,
        'TypeError',
        'invalid expectId',
        false,
        null,
      ],
      [
        'tamper/tamper-base.json',
        '',
        false,
        null,
        null,
        'TypeError',
        'invalid expectId',
        false,
        null,
      ],
    ]);
    for (const r of rows) {
      expect(r.trust).toEqual(['rfc8032-1']);
      expect(r.allowTestKeys).toBe(true);
      expect(r.now).toBe('2026-11-14T00:00:00Z');
      expect(existsSync(resolve(vectorsDir, r.file)), r.file).toBe(true);
    }
  });

  it('tamper-base.json is the signed base the tamper vectors start from (id tamper-base, version 1.1.0)', () => {
    const base = readJson<{ id: string; version: string; signatures: unknown[] }>(
      resolve(vectorsDir, 'tamper/tamper-base.json'),
    );
    expect(base.id).toBe('tamper-base');
    expect(base.version).toBe('1.1.0');
    expect(base.signatures).toHaveLength(1);
  });

  it('state-ids has three validly signed manifests and four rows', () => {
    const files = readdirSync(siDir).sort();
    expect(files).toEqual([
      'constructor-1.0.0.json',
      'constructor-1.1.0.json',
      'prototype-1.1.0.json',
      'state-ids.json',
    ]);
    const ids = ['constructor-1.0.0', 'constructor-1.1.0', 'prototype-1.1.0'].map((n) => {
      const m = readJson<{ id: string; version: string; createdAt: string; signatures: unknown[] }>(
        resolve(siDir, `${n}.json`),
      );
      expect(m.createdAt).toBe('2026-11-01T00:00:00Z');
      expect(m.signatures).toHaveLength(1);
      return [m.id, m.version];
    });
    expect(ids).toEqual([
      ['constructor', '1.0.0'],
      ['constructor', '1.1.0'],
      ['prototype', '1.1.0'],
    ]);
    const rows = stateIds();
    expect(
      rows.map((r) => [r.file, r.state, r.requiresState, r.expect.valid, r.expect.reason ?? null]),
    ).toEqual([
      ['constructor-1.1.0.json', null, true, true, null],
      [
        'constructor-1.1.0.json',
        { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' },
        true,
        true,
        null,
      ],
      [
        'constructor-1.0.0.json',
        { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' },
        true,
        false,
        'downgrade',
      ],
      ['prototype-1.1.0.json', null, true, true, null],
    ]);
  });

  it('vectors/README.md names expect-id/ and state-ids/ and the skip rule', () => {
    const f = flat(text(resolve(vectorsDir, 'README.md')));
    expect(f).toContain('expect-id/');
    expect(f).toContain('state-ids/');
    expect(f).toContain('no state store in cp-manifest');
  });

  it('make-vectors --check and make-tamper-vectors --check exit 0 (generators are deterministic)', () => {
    for (const g of ['make-vectors.mjs', 'make-tamper-vectors.mjs']) {
      const r = spawnSync(process.execPath, [resolve(repoDir, 'test/tools', g), '--check'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(r.status, `${g}: ${r.stderr}${r.stdout}`).toBe(0);
    }
  });
});

describe('spec 0.5.0: README, CHANGELOG and the index', () => {
  it('README lists the 0.5.0 release and versions; CHANGELOG has the [0.5.0] section', () => {
    const readme = flat(text(resolve(specDir, 'README.md')));
    // the README now describes release 0.6.1 (test/spec-0.6.1.test.ts); the 0.5.0 history stays in its text
    expect(readme).toContain('Spec release **0.6.1**');
    expect(readme).toContain('manifest 0.1.4: published; other contracts: draft');
    expect(readme).toContain('urn:airplanemode:spec:manifest:0.1.4');
    expect(readme).toContain('urn:airplanemode:spec:event:0.1.6');
    expect(readme).toContain('Release 0.5.0 bumps the minor again');
    const log = flat(text(resolve(specDir, 'CHANGELOG.md')));
    expect(log).toContain('## [0.5.0] - 2026-11-18 (untagged)');
    for (const s of [
      'manifest 0.1.2',
      'expectId',
      'unexpected_id',
      'storage API 0.3.0',
      'backend adapter 0.4.0',
      'event 0.1.4',
      'R14',
      'R15',
      'S1-097',
      'S1-102',
      'The published manifest 0.1.1 wire format is unchanged',
    ])
      expect(log, s).toContain(s);
  });

  it('index.ts header names release 0.5.0 and every contract version', () => {
    const f = flatTs(text(resolve(specDir, 'index.ts')));
    expect(f).toContain('spec release 0.6.1');
    for (const v of ['manifest 0.1.4', 'event 0.1.6', 'storage API 0.4.1', 'backend adapter 0.5.0'])
      expect(f, v).toContain(v);
  });

  it('every file under spec/ is listed in the files the package ships or excluded on purpose', () => {
    const files = walk(specDir).map((p) => relPosix(specDir, p));
    expect(files.some((f) => f.startsWith('vectors/expect-id/'))).toBe(true);
    expect(files.some((f) => f.startsWith('vectors/state-ids/'))).toBe(true);
  });
});
