// Spec release 0.3.0 (draft): event 0.1.2, backend adapter 0.3.0, model descriptor 0.2.0.
// Written before the spec files changed (D1-01); the red run is logged in
// evidence/sprint-3/D1/red-D1-01.log. Spec release 0.4.0 supersedes the version numbers (event 0.1.3,
// storage API 0.2.0, backend adapter 0.3.1, model descriptor 0.2.1): the assertions below were moved
// to those numbers and everything else about 0.3.0 is still asserted (test/spec-0.4.test.ts pins 0.4.0).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  type AcquireOptions,
  type AdapterErrorCode,
  type BackendAdapter,
  type GenerateResult,
  type LoadOptions,
} from '../spec/backend-adapter';
import {
  EVENT_FORBIDDEN_KEY_PATTERN,
  MEMORY_SAMPLE_POINTS,
  MODEL_LOAD_PHASES,
  RUNTIME_EVENT_NAMES,
  STORAGE_EVENT_NAMES,
  type ModelLoadPhase,
} from '../spec/event';
import { SPEC_VERSIONS, SPEC_WIRE } from '../spec/index';
import {
  MODEL_DESCRIPTOR_SPEC,
  MODEL_DESCRIPTOR_SPECS_ACCEPTED,
  type ModelDescriptor,
} from '../spec/model-descriptor';
import { newEvent } from '../src/events';
import { SCHEMAS, validateModelDescriptor, validateSchema } from '../src/schema';
import { readJson, readText, repoDir, specDir } from './helpers';

const flat = (s: string) => s.replace(/\s+/g, ' ');
const flatTs = (s: string) => flat(s.replace(/\n\s*\*/g, ' '));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('spec 0.3.0: versions and wire strings', () => {
  it('SPEC_VERSIONS and SPEC_WIRE carry the current (0.6.0) release values; the wire strings did not move', () => {
    expect(SPEC_VERSIONS).toEqual({
      manifest: '0.1.3',
      capabilityProfile: '0.1.1',
      event: '0.1.5',
      storageApi: '0.4.0',
      backendAdapter: '0.5.0',
      modelDescriptor: '0.2.1',
    });
    expect(SPEC_WIRE).toEqual({
      manifest: 'airplanemode.manifest/0.1',
      capabilityProfile: 'airplanemode.capability/0.1',
      event: 'airplanemode.event/0.1',
      modelDescriptor: 'airplanemode.model/0.2',
    });
    expect(MODEL_DESCRIPTOR_SPEC).toBe('airplanemode.model/0.2');
    expect([...MODEL_DESCRIPTOR_SPECS_ACCEPTED]).toEqual([
      'airplanemode.model/0.1',
      'airplanemode.model/0.2',
    ]);
  });

  it('the event schema keeps its body and changes only its $id; the descriptor schema is 0.2.1', () => {
    const raw = readText(resolve(specDir, 'event.schema.json'));
    expect(SCHEMAS.event.$id).toBe('urn:airplanemode:spec:event:0.1.5');
    const asBefore = raw.replace(
      'urn:airplanemode:spec:event:0.1.5',
      'urn:airplanemode:spec:event:0.1.1',
    );
    // sha256 of the Sprint 2 file (spec release 0.2.0)
    expect(sha(asBefore)).toBe('9137506437d487cd6347739c03f0458fedbbad139fb259bdd2c68b94f4a1ee17');
    expect(SCHEMAS.modelDescriptor.$id).toBe('urn:airplanemode:spec:model-descriptor:0.2.1');
    expect(
      (SCHEMAS.event as { properties: { spec: { const: string } } }).properties.spec.const,
    ).toBe('airplanemode.event/0.1');
  });

  it('the capability profile files, the examples, the 5 positive vectors and the 13 Sprint 3 negatives are byte-identical to spec release 0.3.0', () => {
    const golden = readText(resolve(repoDir, 'test/fixtures/spec-unchanged-since-0.3.0.sha256.txt'))
      .trim()
      .split('\n')
      .map((l) => l.split(/\s+/) as [string, string]);
    expect(golden.length).toBeGreaterThanOrEqual(53);
    // capability profile 0.1.1 (spec release 0.6.0) changed the ramGb member and the header of the two
    // capability files; test/spec-0.6.test.ts pins that change against the 0.5.0 sha256 list
    const changedIn060 = new Set(['capability-profile.schema.json', 'capability-profile.ts']);
    for (const [hash, file] of golden) {
      if (changedIn060.has(file)) continue;
      expect(sha(readFileSync(resolve(specDir, file))), file).toBe(hash);
    }
    // release 0.4.0 added four manifest negatives and the TD-26 amendment six more, and the TD-29 fix round nine more (32 in all); the five positives did not move
    const top = readdirSync(resolve(specDir, 'vectors'), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    expect(top.filter((f) => f.startsWith('neg-') && f !== 'negative.json')).toHaveLength(32);
    expect(top.filter((f) => /^0\d-.*\.json$/.test(f))).toHaveLength(5);
  });
});

describe('spec 0.3.0: event 0.1.2 (now 0.1.3)', () => {
  const eventTs = readText(resolve(specDir, 'event.ts'));

  it('reserves the four new runtime names and keeps the earlier ones', () => {
    for (const n of ['asset.hold.unknown', 'model.load.phase', 'memory.sample', 'backend.worker'])
      expect(RUNTIME_EVENT_NAMES as readonly string[], n).toContain(n);
    for (const n of ['asset.quota', 'backend.select', 'model.load', 'model.generate'])
      expect(RUNTIME_EVENT_NAMES as readonly string[], n).toContain(n);
  });

  it('exports STORAGE_EVENT_NAMES, MODEL_LOAD_PHASES and MEMORY_SAMPLE_POINTS', () => {
    // the four names of 0.1.2 keep their place; Event 0.1.3 appended three (test/spec-0.4.test.ts)
    expect([...STORAGE_EVENT_NAMES].slice(0, 4)).toEqual([
      'storage.set',
      'storage.get',
      'storage.delete',
      'storage.quota',
    ]);
    // ten since Event 0.1.4: the first seven are unchanged (storage.doc.* are asserted in spec-0.5.test.ts)
    expect(STORAGE_EVENT_NAMES.slice(0, 7)).toHaveLength(7);
    expect([...MODEL_LOAD_PHASES]).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
      'first_token',
    ]);
    expect([...MEMORY_SAMPLE_POINTS]).toEqual([
      'before_load',
      'after_session',
      'after_first_token',
      'on_demand',
    ]);
    const phase: ModelLoadPhase = 'handoff';
    expect(MODEL_LOAD_PHASES).toContain(phase);
    for (const n of STORAGE_EVENT_NAMES)
      expect(RUNTIME_EVENT_NAMES as readonly string[], n).not.toContain(n);
  });

  const documented: Record<
    string,
    {
      kind: Parameters<typeof newEvent>[0]['kind'];
      level: 'info' | 'warn' | 'error' | 'debug';
      durationMs?: number;
      bytes?: number;
      source?: string;
      attrs: Record<string, string | number | boolean | null>;
    }[]
  > = {
    'asset.hold.unknown': [
      { kind: 'asset', level: 'warn', attrs: { reason: 'lock_state_unavailable' } },
    ],
    'model.load.phase': MODEL_LOAD_PHASES.map((phase) => ({
      kind: 'timing' as const,
      level: 'info' as const,
      durationMs: 12.5,
      ...(phase === 'session' || phase === 'first_token' ? {} : { bytes: 1024 }),
      attrs: {
        loadId: '0123456789abcdef',
        adapter: 'transformers-js',
        device: 'wasm',
        model: 'smollm2-135m-instruct.descriptor',
        phase,
        host: 'main',
      },
    })),
    'memory.sample': [
      {
        kind: 'memory',
        level: 'info',
        bytes: 1000,
        attrs: {
          loadId: '0123456789abcdef',
          scope: 'page',
          at: 'after_session',
          api: 'performance.memory',
          usedJsHeap: 1000,
          totalJsHeap: 2000,
          jsHeapLimit: 4000,
          wasmMemory: null,
        },
      },
      {
        kind: 'memory',
        level: 'info',
        attrs: {
          loadId: '',
          scope: 'worker',
          at: 'on_demand',
          api: 'none',
          usedJsHeap: null,
          totalJsHeap: null,
          jsHeapLimit: null,
          wasmMemory: null,
        },
      },
    ],
    'backend.worker': ['started', 'ready', 'terminated', 'crashed'].map((state) => ({
      kind: 'log' as const,
      level: state === 'crashed' ? ('warn' as const) : ('info' as const),
      ...(state === 'ready' ? { durationMs: 80 } : {}),
      attrs: {
        adapter: 'transformers-js',
        device: 'wasm',
        state,
        reason: state === 'crashed' ? 'error' : 'load',
      },
    })),
    'model.load': [
      {
        kind: 'model-load',
        level: 'info',
        bytes: 5000,
        durationMs: 100,
        attrs: {
          adapter: 'transformers-js',
          model: 'm',
          device: 'wasm',
          dtype: 'q4',
          files: 6,
          tier: 'wasm',
          verified: true,
          loadId: '0123456789abcdef',
          host: 'worker',
        },
      },
    ],
    'model.load.failed': [
      {
        kind: 'model-load',
        level: 'error',
        attrs: {
          adapter: 'transformers-js',
          model: 'm',
          device: 'webgpu',
          code: 'integrity',
          loadId: '0123456789abcdef',
          host: 'main',
        },
      },
      {
        kind: 'model-load',
        level: 'error',
        attrs: {
          adapter: 'webllm',
          model: 'm',
          device: 'webgpu',
          code: 'not_cached',
          loadId: '0123456789abcdef',
          host: 'worker',
        },
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
          firstTokenMs: 100,
          host: 'main',
        },
      },
      {
        kind: 'timing',
        level: 'info',
        attrs: {
          adapter: 'webllm',
          device: 'webgpu',
          finishReason: 'abort',
          inTokens: 0,
          outTokens: 0,
          tokensPerSecond: 0,
          prefillMs: 0,
          decodeMs: 0,
          firstTokenMs: null,
          host: 'worker',
        },
      },
    ],
    'backend.select': [
      {
        kind: 'log',
        level: 'warn',
        attrs: {
          rung: 'wasm',
          adapter: 'transformers-js',
          model: 'm',
          outcome: 'failed',
          reason: 'integrity',
        },
      },
      {
        kind: 'log',
        level: 'info',
        attrs: { rung: 'webgpu', adapter: 'webllm', model: 'm', outcome: 'selected', reason: 'ok' },
      },
    ],
    'storage.set': [
      {
        kind: 'timing',
        level: 'debug',
        source: 'localdata',
        bytes: 10,
        durationMs: 1,
        attrs: { ns: 'docs', driver: 'opfs', outcome: 'ok' },
      },
      {
        kind: 'timing',
        level: 'debug',
        source: 'localdata',
        durationMs: 1,
        attrs: { ns: 'docs', driver: 'memory', outcome: 'quota_exceeded' },
      },
    ],
    'storage.get': ['hit', 'miss', 'expired', 'io'].map((outcome) => ({
      kind: 'timing' as const,
      level: 'debug' as const,
      source: 'localdata',
      durationMs: 1,
      ...(outcome === 'hit' ? { bytes: 10 } : {}),
      attrs: { ns: 'docs', driver: 'indexeddb', outcome },
    })),
    'storage.delete': ['removed', 'absent', 'closed'].map((outcome) => ({
      kind: 'timing' as const,
      level: 'debug' as const,
      source: 'localdata',
      durationMs: 1,
      attrs: { ns: 'docs', driver: 'opfs', outcome },
    })),
    'storage.quota': [
      {
        kind: 'log',
        level: 'warn',
        source: 'localdata',
        attrs: { driver: 'opfs', ns: 'docs', usage: 10, quota: 100, needed: 50 },
      },
      {
        kind: 'log',
        level: 'debug',
        source: 'localdata',
        attrs: { driver: 'indexeddb', ns: '', usage: 10, quota: null, needed: 0 },
      },
    ],
  };

  for (const [name, variants] of Object.entries(documented)) {
    it(`newEvent accepts every documented attr set of ${name} and the result validates against event.schema.json`, () => {
      for (const v of variants) {
        const e = newEvent({
          source: v.source ?? 'runtime',
          kind: v.kind,
          name,
          level: v.level,
          attrs: v.attrs,
          ...(v.durationMs !== undefined ? { durationMs: v.durationMs } : {}),
          ...(v.bytes !== undefined ? { bytes: v.bytes } : {}),
        });
        expect(e.attrs).toEqual(v.attrs);
        expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
        for (const key of Object.keys(v.attrs))
          expect(EVENT_FORBIDDEN_KEY_PATTERN.test(key), `${name}.${key}`).toBe(false);
      }
    });
  }

  it('event.ts documents every attr key of the new and changed names', () => {
    for (const variants of Object.values(documented))
      for (const v of variants)
        for (const key of Object.keys(v.attrs)) expect(eventTs, key).toContain(key);
    for (const word of [
      'lock_state_unavailable',
      'integrity',
      'loadId',
      'firstTokenMs',
      'first_token',
      'handoff',
      'before_load',
      'after_first_token',
      'measureUserAgentSpecificMemory',
      'performance.memory',
      'crashed',
      'STORAGE_EVENT_NAMES',
    ])
      expect(eventTs, word).toContain(word);
  });

  it('event.ts header carries the 0.1.5 version (and still names 0.1.4) and the namespace-and-model privacy note', () => {
    expect(flatTs(eventTs)).toContain('Event contract 0.1.5');
    expect(flatTs(eventTs)).toContain('0.1.4 (wire-compatible, spec release 0.5.0)');
    expect(flatTs(eventTs).toLowerCase()).toContain(
      "the namespace (attr 'ns') and the descriptor entry id (attr 'model') do appear in events and in the devtools snapshot",
    );
    expect(flatTs(eventTs)).toContain(
      'Applications must not encode personal data or document identifiers in namespace names or entry ids',
    );
  });

  it('storage-api.md carries the same note', () => {
    const md = flat(readText(resolve(specDir, 'storage-api.md')));
    expect(md).toContain("the namespace (attr 'ns')");
    expect(md).toContain(
      'Applications must not encode personal data or document identifiers in namespace names',
    );
  });
});

describe('spec 0.3.0: backend adapter 0.3.0 (type level)', () => {
  it('AcquireOptions and LoadOptions carry cacheOnly; the codes, firstTokenMs and host exist', () => {
    const a: AcquireOptions = { cacheOnly: true };
    const l: Pick<LoadOptions, 'cacheOnly'> = { cacheOnly: false };
    const codes: AdapterErrorCode[] = ['integrity', 'not_cached'];
    const t: GenerateResult['timings'] = { firstTokenMs: 12 };
    const host: BackendAdapter['host'] = 'worker';
    expect(a.cacheOnly).toBe(true);
    expect(l.cacheOnly).toBe(false);
    expect(new AdapterError('integrity', 'x').code).toBe('integrity');
    expect(new AdapterError('not_cached', 'x').code).toBe('not_cached');
    expect(codes).toHaveLength(2);
    expect(t.firstTokenMs).toBe(12);
    expect(host).toBe('worker');
  });

  it('backend-adapter.ts documents the additions in its source', () => {
    const ts = readText(resolve(specDir, 'backend-adapter.ts'));
    expect(ts).toContain('Backend adapter contract 0.5.0');
    expect(ts).toContain('0.4.0 (minor, spec release 0.5.0)');
    expect(ts).toMatch(/cacheOnly\?: boolean/);
    expect(ts).toContain("| 'integrity'");
    expect(ts).toContain("| 'not_cached'");
    expect(ts).toContain('firstTokenMs?: number');
    expect(ts).toMatch(/host\?: 'main' \| 'worker'/);
  });
});

describe('spec 0.3.0: backend-adapter.md rules', () => {
  const md = readText(resolve(specDir, 'backend-adapter.md'));
  const f = flat(md);

  it('has a heading for R2w, R3w and R7 to R13', () => {
    for (const h of [
      '## R2w',
      '## R3w',
      '## R7',
      '## R8',
      '## R9',
      '## R10',
      '## R11',
      '## R12',
      '## R13',
    ])
      expect(md, h).toContain(h);
    expect(md.startsWith('# Backend adapter 0.5.0')).toBe(true);
  });

  it('states cacheOnly at acquire, the .part rule, the error mapping and the integrity reason', () => {
    expect(f).toContain(
      'A `.part` file, complete or partial, is never read, committed, resumed or reconciled under cacheOnly',
    );
    expect(f).toContain(
      "rejects with code 'not_cached', before any request, with no Range header and no asset.download.* event",
    );
    expect(f).toContain('hash_mismatch` -> `integrity`');
    expect(f).toContain('NotFoundError');
    expect(f).toContain('NotReadableError');
    expect(f).toContain('a downloaded file failed its integrity check');
    expect(f).toContain("never says 'could not be started'");
  });

  it('R2w and R3w: worker hand-off, non-hierarchical self.location, guarded list, prototype-chain fetch, CSP-only import() and FontFace, bootstrap', () => {
    expect(f).toContain('verifiedPrefix');
    expect(f).toContain("ending in '__airplanemode/verified/'");
    expect(f).toContain('non-hierarchical');
    expect(f).toContain('every object in its prototype chain that owns a `fetch` property');
    for (const g of [
      'XMLHttpRequest',
      'WebSocket',
      'WebSocketStream',
      'WebTransport',
      'EventSource',
      'importScripts',
      'SharedWorker',
      'navigator.serviceWorker.register',
      'Cache.prototype.add',
    ])
      expect(f, g).toContain(g);
    expect(f).toContain(
      'Dynamic `import()` and FontFace URL loads CANNOT be guarded in JavaScript',
    );
    expect(f).toContain('always an S1 finding');
    expect(f).toContain("'import ' + JSON.stringify(abs) + ';'");
    expect(f).toContain("'airplanemode-worker'");
  });

  it('R7 to R13: isolation, abort and crash, chain integrity, chain cacheOnly, WebLLM staging, observability, untrusted messages', () => {
    expect(f).toContain("named 'airplanemode-engine-<adapter>-<device>'");
    expect(f).toContain('terminate if there is no `done` within 250 ms');
    expect(f).toContain('never acquired again in that call');
    expect(f).toContain('A rung whose plan counts 0 bytes loads with cacheOnly:true');
    expect(f).toContain('airplanemode-webllm-stage-<loadId>');
    expect(f).toContain('navigator.storage.estimate()');
    expect(f).toContain("'webllm/config', 'webllm/model' and 'webllm/wasm'");
    expect(f).toContain('model.load.phase');
    expect(f).toContain('Every worker message is untrusted');
    // S1-074 (0.3.1): the worker's origin text is discarded, not validated into an event
    expect(f).toContain('the host never forwards worker text');
    expect(f).toContain("origin 'worker-reported'");
  });

  it('rewrites the Known limitation paragraph for 0.3.0 and no longer promises the move as future work', () => {
    expect(f).toContain('Known limitation (0.3.0 draft)');
    expect(f).not.toContain('Known limitation (0.2.0 draft)');
    expect(f).not.toContain('Moving the engine off the main thread is planned for Sprint 3');
  });
});

describe('spec 0.3.0: README and CHANGELOG', () => {
  it('spec/README.md table lists the current versions (release 0.6.0)', () => {
    const readme = readText(resolve(specDir, 'README.md'));
    expect(readme).toContain('Spec release **0.6.0**');
    expect(flat(readme)).toMatch(/\| Event\s+\| `event.schema.json`, `event.ts`\s+\| 0\.1\.5/);
    expect(flat(readme)).toMatch(/\| Backend adapter\s+\|[^|]*\|\s*0\.5\.0/);
    expect(flat(readme)).toMatch(/\| Model descriptor\s+\|[^|]*\|\s*0\.2\.1/);
    expect(readme).toContain('airplanemode.model/0.2');
    expect(readme).toContain('urn:airplanemode:spec:event:0.1.5');
  });

  it('spec/CHANGELOG.md has a 0.3.0 draft section citing every finding id', () => {
    const log = readText(resolve(specDir, 'CHANGELOG.md'));
    expect(log).toContain('## [0.3.0] - 2026-11-14 (draft)');
    const section = flat(log.slice(log.indexOf('## [0.3.0]'), log.indexOf('## [0.2.0]')));
    for (const id of ['S1-053', 'S1-066', 'T1-S2-07', 'T1-S2-01', 'T1-S2-02', 'sessionOptions'])
      expect(section, id).toContain(id);
    expect(log.indexOf('## [0.3.0]')).toBeLessThan(log.indexOf('## [0.2.0]'));
  });
});

describe('spec 0.3.0: model descriptor 0.2.0 examples', () => {
  const ex = (f: string) => readJson<Record<string, unknown>>(resolve(specDir, 'examples', f));

  it('the example is 0.2 and validates; the webllm example validates', () => {
    const d = ex('model-descriptor.example.json');
    expect(d['spec']).toBe('airplanemode.model/0.2');
    expect(validateModelDescriptor(d).errors).toEqual([]);
    const w = ex('model-descriptor.webllm.example.json');
    expect(w['engine']).toBe('webllm');
    expect(w['devices']).toEqual(['webgpu']);
    expect(typeof w['modelLib']).toBe('string');
    expect(w['runtimeWasm']).toBeUndefined();
    expect(validateModelDescriptor(w).errors).toEqual([]);
  });

  it('sessionOptions is accepted for transformers-js 0.2 and refused for webllm and for 0.1', () => {
    const base = ex('model-descriptor.example.json');
    const withSession = {
      ...structuredClone(base),
      sessionOptions: { graphOptimizationLevel: 'disabled' },
    };
    expect(validateModelDescriptor(withSession).errors).toEqual([]);
    const v1 = { ...structuredClone(withSession), spec: 'airplanemode.model/0.1' };
    expect(validateModelDescriptor(v1).ok).toBe(false);
    const w = {
      ...structuredClone(ex('model-descriptor.webllm.example.json')),
      sessionOptions: { graphOptimizationLevel: 'all' },
    };
    expect(validateModelDescriptor(w).ok).toBe(false);
    for (const level of ['disabled', 'basic', 'extended', 'layout', 'all'])
      expect(
        validateModelDescriptor({
          ...structuredClone(base),
          sessionOptions: { graphOptimizationLevel: level },
        }).errors,
      ).toEqual([]);
    const typed: ModelDescriptor = withSession as unknown as ModelDescriptor;
    expect(typed.sessionOptions?.graphOptimizationLevel).toBe('disabled');
  });

  it('the schema has the three anyOf branches (A, B, C) with type-null presence bans', () => {
    const s = SCHEMAS.modelDescriptor as {
      anyOf: {
        properties: Record<string, { const?: unknown; type?: string }>;
        required: string[];
      }[];
    };
    expect(s.anyOf).toHaveLength(3);
    const [a, b, c] = s.anyOf as [(typeof s.anyOf)[0], (typeof s.anyOf)[0], (typeof s.anyOf)[0]];
    expect(a.properties['spec']!.const).toBe('airplanemode.model/0.2');
    expect(a.properties['modelLib']!.type).toBe('null');
    expect(a.required).toEqual(['runtimeWasm']);
    expect(b.properties['spec']!.const).toBe('airplanemode.model/0.1');
    expect(b.properties['modelLib']!.type).toBe('null');
    expect(b.properties['sessionOptions']!.type).toBe('null');
    expect(c.properties['engine']!.const).toBe('webllm');
    expect(c.properties['devices']!.const).toEqual(['webgpu']);
    expect(c.properties['runtimeWasm']!.type).toBe('null');
    expect(c.properties['sessionOptions']!.type).toBe('null');
    expect(c.required).toEqual(['modelLib']);
  });
});
