// D1-07: the panel's pure model and view. Hostile snapshots render as inert text. Written before the
// implementation.

import { describe, expect, it } from 'vitest';
import type { Event } from '../spec/event';
import { EventBus, newEvent } from '../src/events';
import { PhaseTimer, emitMemorySample } from '../src/observability';
import {
  EMPTY_MESSAGE,
  buildPanelModel,
  buildPanelView,
  mountView,
  type ViewNode,
} from '../devtools/src/render';
import { MAX_SNAPSHOT_CHARS, parseSnapshot } from '../devtools/src/validate';

const LOAD_A = '0123456789abcdef';
const LOAD_B = 'fedcba9876543210';

function loadEvents(loadId: string, opts: { memory?: boolean; fail?: boolean } = {}): Event[] {
  const bus = new EventBus();
  const timer = new PhaseTimer({
    sink: bus,
    loadId,
    adapter: 'transformers-js',
    device: 'wasm',
    model: 'smollm2-135m-instruct.descriptor',
    host: 'main',
  });
  if (opts.memory !== false) emitMemorySample(bus, loadId, 'page', 'before_load');
  timer.record('acquire', 101.5, 1000);
  timer.record('verify', 22, 1000);
  timer.record('handoff', 3, 900);
  timer.record('session', 400);
  if (opts.fail) {
    bus.emit(
      newEvent({
        source: 'runtime',
        kind: 'model-load',
        name: 'model.load.failed',
        level: 'error',
        attrs: {
          adapter: 'transformers-js',
          model: 'm',
          device: 'wasm',
          code: 'backend',
          loadId,
          host: 'main',
        },
      }),
    );
  } else {
    bus.emit(
      newEvent({
        source: 'runtime',
        kind: 'model-load',
        name: 'model.load',
        level: 'info',
        bytes: 1900,
        attrs: {
          adapter: 'transformers-js',
          model: 'm',
          device: 'wasm',
          dtype: 'q4',
          files: 6,
          tier: 'wasm',
          verified: true,
          loadId,
          host: 'main',
        },
      }),
    );
    if (opts.memory !== false) emitMemorySample(bus, loadId, 'page', 'after_session');
    timer.record('first_token', 12.25);
    if (opts.memory !== false) emitMemorySample(bus, loadId, 'page', 'after_first_token');
  }
  return bus.snapshot();
}

const snap = (events: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    spec: 'airplanemode.devtools/0.1',
    session: 'abc123',
    capturedAt: 1_700_000_000_000,
    events,
    dropped: 0,
    ...over,
  });

function textOf(n: ViewNode): string {
  return [n.text ?? '', ...(n.children ?? []).map(textOf)].join(' ');
}
function find(n: ViewNode, pred: (x: ViewNode) => boolean, out: ViewNode[] = []): ViewNode[] {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) find(c, pred, out);
  return out;
}
const cell = (n: ViewNode, name: string) =>
  find(n, (x) => x.attrs?.['data-cell'] === name).map((x) => x.text);

describe('buildPanelModel: a real load', () => {
  it('groups events by loadId, with five phase durations and the bytes of acquire, verify and handoff', () => {
    const m = buildPanelModel(snap([...loadEvents(LOAD_A), ...loadEvents(LOAD_B)]));
    expect(m.state).toBe('ok');
    expect(m.loads.map((l) => l.loadId).sort()).toEqual([LOAD_A, LOAD_B].sort());
    const a = m.loads.find((l) => l.loadId === LOAD_A)!;
    expect(a.adapter).toBe('transformers-js');
    expect(a.device).toBe('wasm');
    expect(a.model).toBe('smollm2-135m-instruct.descriptor');
    expect(a.host).toBe('main');
    expect(a.phases).toEqual({
      acquire: 101.5,
      verify: 22,
      handoff: 3,
      session: 400,
      first_token: 12.25,
    });
    expect(a.bytes).toEqual({ acquire: 1000, verify: 1000, handoff: 900 });
    expect(a.outcome).toBe('loaded');
    expect(m.invalid).toBe(0);
  });

  it('a failed load shows the phases that completed (null for the rest) and the failure code', () => {
    const m = buildPanelModel(snap(loadEvents(LOAD_A, { fail: true })));
    const a = m.loads[0]!;
    expect(a.outcome).toBe('failed');
    expect(a.failure).toBe('backend');
    expect(a.phases.first_token).toBeNull();
    expect(a.phases.session).toBe(400);
  });

  it('the memory table keeps the latest sample per scope and point, labelled with its api', () => {
    const e = loadEvents(LOAD_A);
    const m = buildPanelModel(snap(e));
    expect(m.memory.map((r) => `${r.scope}:${r.at}`)).toEqual([
      'page:before_load',
      'page:after_session',
      'page:after_first_token',
    ]);
    for (const r of m.memory) {
      expect(['performance.memory', 'none']).toContain(r.api);
      expect(r.loadId).toBe(LOAD_A);
    }
  });

  it('the latest sample wins when a point repeats', () => {
    const mk = (n: number): Event =>
      newEvent({
        source: 'runtime',
        kind: 'memory',
        name: 'memory.sample',
        level: 'info',
        attrs: {
          loadId: '',
          scope: 'page',
          at: 'on_demand',
          api: 'performance.memory',
          usedJsHeap: n,
          totalJsHeap: n,
          jsHeapLimit: 9,
          wasmMemory: null,
        },
      });
    const m = buildPanelModel(snap([mk(1), mk(2), mk(3)]));
    expect(m.memory).toHaveLength(1);
    expect(m.memory[0]!.usedJsHeap).toBe(3);
  });

  it('keeps the last 50 events, newest last', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      newEvent({
        source: 'runtime',
        kind: 'log',
        name: 'backend.select',
        level: 'info',
        attrs: { rung: 'wasm', adapter: 'a', model: `m${i}`, outcome: 'selected', reason: 'ok' },
      }),
    );
    const m = buildPanelModel(snap(many));
    expect(m.recent).toHaveLength(50);
    expect(m.recent[49]!.summary).toContain('m79');
    expect(m.recent[0]!.summary).toContain('m30');
  });

  it('an empty page (no hook: null) shows the instruction, and a snapshot with no events shows it too', () => {
    expect(buildPanelModel(null).state).toBe('empty');
    expect(buildPanelModel(null).message).toBe(EMPTY_MESSAGE);
    expect(EMPTY_MESSAGE).toBe(
      'No runtime events on this page. The page must call exposeDevtoolsHook().',
    );
    const m = buildPanelModel(snap([]));
    expect(m.state).toBe('empty');
    expect(m.message).toBe(EMPTY_MESSAGE);
  });
});

describe('buildPanelModel: a hostile snapshot is inert text or a counted rejection', () => {
  it('3 MB of text is rejected without parsing', () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const m = buildPanelModel(huge);
    expect(m.state).toBe('rejected');
    expect(huge.length).toBeGreaterThan(MAX_SNAPSHOT_CHARS);
    expect(parseSnapshot(huge)).toEqual({ ok: false, reason: 'too_large' });
    expect(textOf(buildPanelView(m))).not.toContain('xxxxxxxxxx');
  });

  it('a non-string, non-JSON, wrong spec or wrong shape is rejected', () => {
    expect(parseSnapshot(42)).toEqual({ ok: false, reason: 'not_string' });
    expect(parseSnapshot({ spec: 'airplanemode.devtools/0.1' })).toEqual({
      ok: false,
      reason: 'not_string',
    });
    expect(parseSnapshot('{nope')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseSnapshot(snap([], { spec: 'airplanemode.devtools/0.2' }))).toEqual({
      ok: false,
      reason: 'bad_spec',
    });
    expect(parseSnapshot(snap([], { events: 'x' }))).toEqual({ ok: false, reason: 'bad_shape' });
    expect(parseSnapshot('[]')).toEqual({ ok: false, reason: 'bad_shape' });
    expect(parseSnapshot('null')).toEqual({ ok: false, reason: 'bad_shape' });
    expect(parseSnapshot(snap([], { session: 5 }))).toEqual({ ok: false, reason: 'bad_shape' });
    expect(parseSnapshot(snap([], { capturedAt: 'now' }))).toEqual({
      ok: false,
      reason: 'bad_shape',
    });
    expect(parseSnapshot(snap([], { dropped: -1 }))).toEqual({ ok: false, reason: 'bad_shape' });
    for (const raw of [42, '{nope', snap([], { spec: 'x' }), '[]']) {
      const m = buildPanelModel(raw);
      expect(m.state).toBe('rejected');
      expect(m.loads).toEqual([]);
    }
  });

  it('malformed events are dropped and counted, valid ones survive', () => {
    const good = loadEvents(LOAD_A);
    const bad: unknown[] = [
      null,
      7,
      'x',
      [],
      {},
      { ...good[0], spec: 'airplanemode.event/9' },
      { ...good[0], id: 'not-a-uuid' },
      { ...good[0], extra: 1 },
      { ...good[0], attrs: { 'bad-key': 1 } },
      { ...good[0], attrs: { prompt: 'secret' } },
      { ...good[0], attrs: { a: { nested: true } } },
      { ...good[0], durationMs: -1 },
    ];
    const m = buildPanelModel(snap([...bad, ...good]));
    expect(m.invalid).toBe(bad.length);
    expect(m.loads).toHaveLength(1);
  });

  it('a phase event with a loadId that is not 16 hex is invalid, not a row', () => {
    const e = loadEvents(LOAD_A)
      .filter((x) => x.name === 'model.load.phase')
      .map((x) => ({ ...x, attrs: { ...x.attrs, loadId: '<img src=x onerror=alert(1)>' } }));
    const m = buildPanelModel(snap(e));
    expect(m.loads).toEqual([]);
    expect(m.invalid).toBe(e.length);
  });

  it('HTML in strings renders as text in a text node: the view has only whitelisted tags and the markup stays inert', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const events = loadEvents(LOAD_A).map((x) =>
      x.name === 'model.load.phase'
        ? { ...x, attrs: { ...x.attrs, model: evil, adapter: evil } }
        : x,
    );
    const m = buildPanelModel(snap(events));
    const view = buildPanelView(m);
    const TAGS = new Set([
      'main',
      'section',
      'h2',
      'h3',
      'p',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'div',
      'span',
      'code',
    ]);
    const walk = (n: ViewNode) => {
      expect(TAGS.has(n.tag), n.tag).toBe(true);
      for (const [k, v] of Object.entries(n.attrs ?? {})) {
        expect([
          'class',
          'data-role',
          'data-cell',
          'data-load-id',
          'data-state',
          'scope',
        ]).toContain(k);
        expect(v).not.toMatch(/[<>"'`]/);
      }
      n.children?.forEach(walk);
    };
    walk(view);
    expect(textOf(view)).toContain('<img src=x');
  });

  it('over-long strings are cut and control characters replaced', () => {
    const long = 'A'.repeat(5000) + '\u0007‮\n';
    const events = loadEvents(LOAD_A).map((x) =>
      x.name === 'model.load.phase' ? { ...x, attrs: { ...x.attrs, model: long } } : x,
    );
    const view = buildPanelView(buildPanelModel(snap(events)));
    const model = cell(view, 'model')[0]!;
    expect(model!.length).toBeLessThanOrEqual(121);
    expect(model).not.toMatch(/[\u0000-\u001f\u007f‮]/);
  });
});

describe('buildPanelView: what the user reads', () => {
  const view = () => buildPanelView(buildPanelModel(snap(loadEvents(LOAD_A))));

  it('has a Loads table with the five phase cells and the loadId, and a Memory table labelled with its api', () => {
    const v = view();
    expect(cell(v, 'loadId')).toEqual([LOAD_A]);
    for (const [phase, expected] of [
      ['acquire', '101.5'],
      ['verify', '22'],
      ['handoff', '3'],
      ['session', '400'],
      ['first_token', '12.25'],
    ] as const)
      expect(cell(v, phase), phase).toEqual([`${expected} ms`]);
    expect(textOf(v)).toContain('Loads');
    expect(textOf(v)).toContain('Memory');
    expect(textOf(v)).toContain('Recent events');
    const apis = cell(v, 'api');
    expect(apis.length).toBe(3);
    for (const a of apis) expect(['performance.memory', 'none']).toContain(a);
  });

  it('a figure that is null shows an em dash, not zero', () => {
    const v = view();
    for (const t of cell(v, 'wasmMemory')) expect(t).toBe('—');
  });

  it('mountView builds DOM with createElement, textContent and setAttribute only', () => {
    const calls: string[] = [];
    const doc = {
      createElement(tag: string) {
        calls.push(`create:${tag}`);
        const el = {
          tag,
          children: [] as unknown[],
          attrs: {} as Record<string, string>,
          _text: '',
          setAttribute(k: string, v: string) {
            calls.push(`attr:${k}`);
            this.attrs[k] = v;
          },
          append(...c: unknown[]) {
            this.children.push(...c);
          },
          set textContent(v: string) {
            calls.push('text');
            this._text = v;
          },
          get textContent() {
            return this._text;
          },
        };
        return el;
      },
    };
    const root = doc.createElement('div') as unknown as { children: unknown[] };
    mountView(doc as never, root as never, view());
    expect(calls.filter((c) => c.startsWith('create:'))).not.toHaveLength(0);
    for (const c of calls) expect(c).toMatch(/^(create:[a-z0-9]+|attr:[a-z-]+|text)$/);
  });
});

// ---- D1-08: Storage and Pipeline sections (Event 0.1.4) -------------------------------------------------

function appEvent(
  source: 'localdata' | 'dockit',
  name: string,
  attrs: Record<string, string | number | boolean | null>,
  durationMs?: number,
  extra: { kind?: Event['kind']; bytes?: number } = {},
): Event {
  return newEvent({
    source,
    kind: extra.kind ?? 'timing',
    name,
    level: 'info',
    attrs,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
  });
}

describe('the Storage section (source localdata, the ten STORAGE_EVENT_NAMES)', () => {
  const put = (outcome: string, ms: number, ns = 'dockit.d*') =>
    appEvent(
      'localdata',
      'storage.doc.put',
      { ns, driver: 'opfs', outcome, chunks: 12, replaced: false, rows: 12 },
      ms,
    );
  const query = (ms: number) =>
    appEvent(
      'localdata',
      'storage.doc.query',
      {
        ns: 'dockit.d*',
        driver: 'opfs',
        outcome: 'ok',
        k: 4,
        candidates: 12,
        metric: 'cosine',
        kernel: 'simd',
      },
      ms,
    );

  it('groups the events of source localdata by name: a count, the last duration and the outcomes', () => {
    const m = buildPanelModel(
      snap([put('ok', 10), put('ok', 12.5), put('quota_exceeded', 3), query(1.25), query(2)]),
    );
    expect(m.storage.map((g) => g.name)).toEqual(['storage.doc.put', 'storage.doc.query']);
    const p = m.storage.find((g) => g.name === 'storage.doc.put')!;
    expect(p.count).toBe(3);
    expect(p.lastDurationMs).toBe(3);
    expect(p.outcomes).toEqual({ ok: 2, quota_exceeded: 1 });
    expect(p.drivers).toEqual(['opfs']);
    expect(p.namespaces).toEqual(['dockit.d*']);
    const q = m.storage.find((g) => g.name === 'storage.doc.query')!;
    expect([q.count, q.lastDurationMs, q.outcomes]).toEqual([2, 2, { ok: 2 }]);
  });

  it('knows all ten names, in the order of the contract, and ignores a name it does not know', () => {
    const names = [
      'storage.set',
      'storage.get',
      'storage.delete',
      'storage.quota',
      'storage.query',
      'storage.index.open',
      'storage.index.write',
      'storage.doc.put',
      'storage.doc.delete',
      'storage.doc.query',
    ];
    const events = [...names]
      .reverse()
      .map((name) => appEvent('localdata', name, { ns: 'x', driver: 'memory', outcome: 'ok' }, 1));
    events.push(appEvent('localdata', 'storage.secret.dump', { ns: 'x' }, 1));
    const m = buildPanelModel(snap(events));
    expect(m.storage.map((g) => g.name)).toEqual(names);
  });

  it('an event with the name of another source is not grouped here (a dockit event named storage.set)', () => {
    const m = buildPanelModel(snap([appEvent('dockit', 'storage.set', { outcome: 'ok' }, 1)]));
    expect(m.storage).toEqual([]);
  });

  it('renders counts, durations and outcomes as text nodes; an undocumented attr never appears', () => {
    const e = put('ok', 7);
    (e.attrs as Record<string, unknown>)['docId'] = 'LEAK-DOC-ID';
    (e.attrs as Record<string, unknown>)['title'] = 'LEAK-TITLE';
    const m = buildPanelModel(snap([e]));
    const v = buildPanelView(m);
    expect(textOf(v)).toContain('Storage');
    expect(cell(v, 'storageName')).toEqual(['storage.doc.put']);
    expect(cell(v, 'storageCount')).toEqual(['1']);
    expect(cell(v, 'storageLast')).toEqual(['7 ms']);
    expect(cell(v, 'storageOutcomes')).toEqual(['ok 1']);
    expect(JSON.stringify(m)).not.toContain('LEAK');
    expect(textOf(v)).not.toContain('LEAK');
  });

  it('has no Storage section content when there is no localdata event', () => {
    const v = buildPanelView(buildPanelModel(snap(loadEvents(LOAD_A))));
    expect(textOf(v)).toContain('Storage');
    expect(textOf(v)).toContain('No storage event has been recorded yet.');
  });
});

describe('the Pipeline section (source dockit, DOCKIT_EVENT_NAMES)', () => {
  const stage = (stageName: string, outcome: string, ms: number, reason = '') =>
    appEvent(
      'dockit',
      'pipeline.stage',
      { stage: stageName, outcome, reason, pages: 3, chunks: 12, held: 1 },
      ms,
      { bytes: 1000 },
    );
  const answer = (outcome: string, ms: number, first: number | null) =>
    appEvent(
      'dockit',
      'pipeline.answer',
      {
        outcome,
        reason: '',
        k: 4,
        sources: 3,
        budget: 256,
        firstTokenMs: first,
        unknownCitations: 0,
      },
      ms,
    );
  const memory = (bytes: number) =>
    appEvent(
      'dockit',
      'pipeline.memory',
      { worker: 'analysis', stage: 'gate', measure: 'wasm-memory' },
      undefined,
      { kind: 'memory', bytes },
    );

  it('shows each stage in pipeline order with its count, last duration and outcomes (and the refusal reasons)', () => {
    const m = buildPanelModel(
      snap([
        stage('gate', 'ok', 20),
        stage('read', 'ok', 5),
        stage('extract', 'refused', 2, 'no_text_layer'),
        stage('read', 'ok', 6),
      ]),
    );
    expect(m.pipeline.map((g) => g.name)).toEqual([
      'pipeline.stage: read',
      'pipeline.stage: extract',
      'pipeline.stage: gate',
    ]);
    const read = m.pipeline[0]!;
    expect([read.count, read.lastDurationMs, read.outcomes]).toEqual([2, 6, { ok: 2 }]);
    expect(m.pipeline[1]!.outcomes).toEqual({ refused: 1 });
    expect(m.pipeline[1]!.reasons).toEqual(['no_text_layer']);
  });

  it('shows pipeline.answer outcomes and pipeline.memory as a wasm-memory figure under its own name', () => {
    const m = buildPanelModel(snap([answer('ok', 4200, 900), memory(123_456_789)]));
    const a = m.pipeline.find((g) => g.name === 'pipeline.answer')!;
    expect([a.count, a.lastDurationMs, a.outcomes]).toEqual([1, 4200, { ok: 1 }]);
    const mem = m.pipeline.find((g) => g.name === 'pipeline.memory')!;
    expect(mem.lastBytes).toBe(123_456_789);
    const v = buildPanelView(m);
    expect(cell(v, 'pipelineName')).toContain('pipeline.memory');
    expect(textOf(v)).toContain('123,456,789 B');
    expect(textOf(v)).toContain('wasm memory');
  });

  it('a reason that is not a PIPELINE_REASONS value and a stage that is not a PIPELINE_STAGES value are not shown', () => {
    const m = buildPanelModel(
      snap([stage('read', 'refused', 1, 'HOSTILE <b>reason</b>'), stage('exfiltrate', 'ok', 1)]),
    );
    expect(m.pipeline.map((g) => g.name)).toEqual(['pipeline.stage: read']);
    expect(m.pipeline[0]!.reasons).toEqual([]);
    // the section rows never carry them (the Recent events list shows its own fixed keys as printable text)
    expect(JSON.stringify(m.pipeline)).not.toContain('HOSTILE');
    expect(JSON.stringify(m.pipeline)).not.toContain('exfiltrate');
  });

  it('never carries a question, an answer, a file name or a document id even if an event does', () => {
    const e = answer('ok', 5, 1);
    (e.attrs as Record<string, unknown>)['question'] = 'LEAK-QUESTION';
    (e.attrs as Record<string, unknown>)['fileName'] = 'LEAK-FILE.pdf';
    const m = buildPanelModel(snap([e]));
    expect(JSON.stringify(m)).not.toMatch(/LEAK/);
    expect(textOf(buildPanelView(m))).not.toMatch(/LEAK/);
  });

  it('says so when there is no dockit event', () => {
    const v = buildPanelView(buildPanelModel(snap(loadEvents(LOAD_A))));
    expect(textOf(v)).toContain('Pipeline');
    expect(textOf(v)).toContain('No pipeline event has been recorded yet.');
  });

  it('the two sections use the same whitelisted view nodes: no new tag, text only', () => {
    const v = buildPanelView(buildPanelModel(snap([stage('read', 'ok', 5), put('ok', 1)])));
    const tags = new Set(find(v, () => true).map((x) => x.tag));
    for (const t of tags)
      expect([
        'main',
        'section',
        'h2',
        'p',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'div',
        'span',
        'code',
      ]).toContain(t);
  });
});

function put(outcome: string, ms: number): Event {
  return appEvent(
    'localdata',
    'storage.doc.put',
    { ns: 'dockit.d*', driver: 'opfs', outcome, chunks: 1, replaced: false, rows: 1 },
    ms,
  );
}
