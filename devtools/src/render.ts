/**
 * The panel's model and view. buildPanelModel() is pure: a raw page answer in, a PanelModel out.
 * buildPanelView() turns a model into a tree of whitelisted nodes, and mountView() writes that tree
 * into the DOM with createElement, setAttribute and textContent only. Nothing here parses HTML or
 * assigns markup, so a hostile string in an event is shown as text.
 */

import {
  DOCKIT_EVENT_NAMES,
  MODEL_LOAD_PHASES,
  PIPELINE_REASONS,
  PIPELINE_STAGES,
  STORAGE_EVENT_NAMES,
  type Event,
  type ModelLoadPhase,
} from '../../spec/event';
import { parseSnapshot } from './validate';

export const EMPTY_MESSAGE =
  'No runtime events on this page. The page must call exposeDevtoolsHook().';

export type PanelState = 'empty' | 'ok' | 'rejected' | 'denied' | 'waiting' | 'error';

export interface LoadRow {
  loadId: string;
  adapter: string;
  device: string;
  model: string;
  host: string;
  phases: Record<ModelLoadPhase, number | null>;
  bytes: { acquire: number | null; verify: number | null; handoff: number | null };
  outcome: 'loading' | 'loaded' | 'failed';
  failure: string | null;
}

export interface MemoryRow {
  loadId: string;
  scope: string;
  at: string;
  api: string;
  usedJsHeap: number | null;
  totalJsHeap: number | null;
  jsHeapLimit: number | null;
  wasmMemory: number | null;
}

export interface RecentRow {
  time: string;
  name: string;
  level: string;
  summary: string;
}

/**
 * One line of the Storage or Pipeline section: events of one documented name (for the pipeline stage, of one
 * documented stage). Only documented attrs are read (outcome, driver, ns, reason, the wasm-memory bytes), each
 * checked against what the contract allows; nothing else of an event ever reaches the model.
 */
export interface GroupRow {
  name: string;
  count: number;
  lastDurationMs: number | null;
  outcomes: Record<string, number>;
  drivers: string[];
  namespaces: string[];
  reasons: string[];
  /** pipeline.memory only: the last wasm-memory figure, shown under its own name. */
  lastBytes: number | null;
}

export interface PanelModel {
  state: PanelState;
  message: string;
  session: string;
  capturedAt: number | null;
  /** Events the page itself left out of the snapshot (its cap). */
  pageDropped: number;
  /** Events dropped here because they failed validation. */
  invalid: number;
  loads: LoadRow[];
  memory: MemoryRow[];
  /** Source 'localdata': the ten STORAGE_EVENT_NAMES that were seen, in the order of the contract. */
  storage: GroupRow[];
  /** Source 'dockit': pipeline.stage per stage (in pipeline order), pipeline.answer, pipeline.memory. */
  pipeline: GroupRow[];
  recent: RecentRow[];
}

const LOAD_ID = /^[0-9a-f]{16}$/;
const MAX_TEXT = 120;
const MAX_RECENT = 50;
const AT_ORDER = ['before_load', 'after_session', 'after_first_token', 'on_demand'];

/** Text safe to show: control and bidi characters replaced, cut to a fixed length. */
function printable(v: unknown): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ');
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function statusModel(state: PanelState, message: string): PanelModel {
  return {
    state,
    message,
    session: '',
    capturedAt: null,
    pageDropped: 0,
    invalid: 0,
    loads: [],
    memory: [],
    storage: [],
    pipeline: [],
    recent: [],
  };
}

const REJECTION_TEXT: Record<string, string> = {
  not_string: 'The page returned something that is not text, so it was ignored.',
  too_large: 'The page returned more than 2 MiB, so it was ignored.',
  invalid_json: 'The page returned text that is not JSON, so it was ignored.',
  bad_spec: 'The page returned a snapshot of an unknown version, so it was ignored.',
  bad_shape: 'The page returned a snapshot of the wrong shape, so it was ignored.',
  page_threw: 'The page’s snapshot function threw, so nothing was read.',
};

const emptyPhases = (): Record<ModelLoadPhase, number | null> => ({
  acquire: null,
  verify: null,
  handoff: null,
  session: null,
  first_token: null,
});

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function summaryOf(e: Event): string {
  const a = e.attrs;
  const parts: string[] = [];
  const add = (k: string): void => {
    if (k in a && a[k] !== null && a[k] !== '') parts.push(`${k}=${printable(a[k])}`);
  };
  for (const k of [
    'phase',
    'at',
    'state',
    'rung',
    'adapter',
    'device',
    'model',
    'entryId',
    'outcome',
    'reason',
    'code',
    'loadId',
  ])
    add(k);
  if (e.durationMs !== undefined) parts.push(`${Math.round(e.durationMs * 100) / 100} ms`);
  return parts.slice(0, 7).join(' ');
}

const DRIVERS: ReadonlySet<string> = new Set(['opfs', 'indexeddb', 'memory', 'custom']);
const OUTCOME = /^[a-z][a-z_]{0,31}$/;
const NAMESPACE = /^[a-z0-9][a-z0-9._*-]{0,64}$/;
const STORAGE_NAMES: readonly string[] = STORAGE_EVENT_NAMES;
const DOCKIT_NAMES: readonly string[] = DOCKIT_EVENT_NAMES;
const STAGES: readonly string[] = PIPELINE_STAGES;
const REASONS: readonly string[] = PIPELINE_REASONS;

/**
 * The Storage (source localdata) and Pipeline (source dockit) sections: events of a documented name are counted
 * per name, with the last duration and the outcomes. A name the contract does not list, a stage that is not in
 * PIPELINE_STAGES and a reason that is not in PIPELINE_REASONS are ignored; an attr that is not documented for
 * the section is never read.
 */
function groupRows(events: Event[], source: 'localdata' | 'dockit'): GroupRow[] {
  const groups = new Map<string, GroupRow>();
  const order: string[] = [];
  const names = source === 'localdata' ? STORAGE_NAMES : DOCKIT_NAMES;
  for (const e of events) {
    if (e.source !== source || !names.includes(e.name)) continue;
    let key = e.name;
    if (e.name === 'pipeline.stage') {
      const stage = e.attrs['stage'];
      if (typeof stage !== 'string' || !STAGES.includes(stage)) continue;
      key = `pipeline.stage: ${stage}`;
    }
    let g = groups.get(key);
    if (!g) {
      g = {
        name: key,
        count: 0,
        lastDurationMs: null,
        outcomes: {},
        drivers: [],
        namespaces: [],
        reasons: [],
        lastBytes: null,
      };
      groups.set(key, g);
      order.push(key);
    }
    g.count++;
    g.lastDurationMs = num(e.durationMs);
    const outcome = e.attrs['outcome'];
    if (typeof outcome === 'string' && OUTCOME.test(outcome))
      g.outcomes[outcome] = (g.outcomes[outcome] ?? 0) + 1;
    if (source === 'localdata') {
      const driver = e.attrs['driver'];
      if (typeof driver === 'string' && DRIVERS.has(driver) && !g.drivers.includes(driver))
        g.drivers.push(driver);
      const ns = e.attrs['ns'];
      if (typeof ns === 'string' && NAMESPACE.test(ns) && !g.namespaces.includes(ns))
        g.namespaces.push(ns);
    } else {
      const reason = e.attrs['reason'];
      if (typeof reason === 'string' && REASONS.includes(reason) && !g.reasons.includes(reason))
        g.reasons.push(reason);
      if (e.name === 'pipeline.memory' && e.attrs['measure'] === 'wasm-memory')
        g.lastBytes = int(e.bytes);
    }
  }
  // storage: the order of the contract; pipeline: stages in pipeline order, then answer, then memory
  const rank = (name: string): number => {
    if (source === 'localdata') return STORAGE_NAMES.indexOf(name);
    if (name.startsWith('pipeline.stage: ')) return STAGES.indexOf(name.slice(16));
    return STAGES.length + DOCKIT_NAMES.indexOf(name);
  };
  return order.sort((a, b) => rank(a) - rank(b)).map((k) => groups.get(k)!);
}

/** Builds the model from the page's raw answer: null is the empty state. */
export function buildPanelModel(raw: unknown): PanelModel {
  if (raw === null || raw === undefined) return statusModel('empty', EMPTY_MESSAGE);
  if (raw === '!throw') return statusModel('rejected', REJECTION_TEXT['page_threw']!);
  if (raw === '!shape') return statusModel('rejected', REJECTION_TEXT['bad_shape']!);
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return statusModel('rejected', REJECTION_TEXT[parsed.reason]!);
  const s = parsed.snapshot;
  const model: PanelModel = {
    state: 'ok',
    message: '',
    session: printable(s.session),
    capturedAt: s.capturedAt,
    pageDropped: s.dropped,
    invalid: s.invalid,
    loads: [],
    memory: [],
    storage: [],
    pipeline: [],
    recent: [],
  };

  const loads = new Map<string, LoadRow>();
  const memory = new Map<string, MemoryRow>();
  const row = (loadId: string, a: Event['attrs']): LoadRow => {
    let r = loads.get(loadId);
    if (!r) {
      r = {
        loadId,
        adapter: printable(a['adapter']),
        device: printable(a['device']),
        model: printable(a['model']),
        host: printable(a['host']),
        phases: emptyPhases(),
        bytes: { acquire: null, verify: null, handoff: null },
        outcome: 'loading',
        failure: null,
      };
      loads.set(loadId, r);
    }
    return r;
  };

  let invalid = s.invalid;
  const accepted: Event[] = [];
  for (const e of s.events) {
    const loadId = e.attrs['loadId'];
    const needsLoadId =
      e.name === 'model.load.phase' || e.name === 'model.load' || e.name === 'model.load.failed';
    if (needsLoadId && (typeof loadId !== 'string' || !LOAD_ID.test(loadId))) {
      invalid++;
      continue;
    }
    if (e.name === 'model.load.phase') {
      const phase = e.attrs['phase'];
      const ms = num(e.durationMs);
      if (
        typeof phase !== 'string' ||
        !(MODEL_LOAD_PHASES as readonly string[]).includes(phase) ||
        ms === null
      ) {
        invalid++;
        continue;
      }
      const r = row(loadId as string, e.attrs);
      r.phases[phase as ModelLoadPhase] = ms;
      if (phase === 'acquire' || phase === 'verify' || phase === 'handoff')
        r.bytes[phase] = int(e.bytes);
    } else if (e.name === 'model.load') {
      row(loadId as string, e.attrs).outcome = 'loaded';
    } else if (e.name === 'model.load.failed') {
      const r = row(loadId as string, e.attrs);
      r.outcome = 'failed';
      r.failure = printable(e.attrs['code']);
    } else if (e.name === 'memory.sample') {
      const a = e.attrs;
      const at = printable(a['at']);
      const scope = printable(a['scope']);
      memory.set(`${scope}:${at}`, {
        loadId: typeof a['loadId'] === 'string' && LOAD_ID.test(a['loadId']) ? a['loadId'] : '',
        scope,
        at,
        api: printable(a['api']),
        usedJsHeap: int(a['usedJsHeap']),
        totalJsHeap: int(a['totalJsHeap']),
        jsHeapLimit: int(a['jsHeapLimit']),
        wasmMemory: int(a['wasmMemory']),
      });
    }
    accepted.push(e);
  }
  model.invalid = invalid;
  model.loads = [...loads.values()].reverse(); // newest load first
  model.memory = [...memory.values()].sort(
    (x, y) =>
      AT_ORDER.indexOf(x.at) - AT_ORDER.indexOf(y.at) ||
      (x.scope < y.scope ? -1 : x.scope > y.scope ? 1 : 0),
  );
  model.storage = groupRows(accepted, 'localdata');
  model.pipeline = groupRows(accepted, 'dockit');
  model.recent = accepted.slice(-MAX_RECENT).map((e) => ({
    time: clock(e.ts),
    name: printable(e.name),
    level: printable(e.level),
    summary: summaryOf(e),
  }));
  if (model.loads.length === 0 && model.memory.length === 0 && model.recent.length === 0) {
    model.state = 'empty';
    model.message = EMPTY_MESSAGE;
  }
  return model;
}

// ---- the view -------------------------------------------------------------------------------------

export interface ViewNode {
  tag:
    | 'main'
    | 'section'
    | 'h2'
    | 'p'
    | 'table'
    | 'thead'
    | 'tbody'
    | 'tr'
    | 'th'
    | 'td'
    | 'div'
    | 'span'
    | 'code';
  text?: string;
  attrs?: Record<string, string>;
  children?: ViewNode[];
}

const n = (
  tag: ViewNode['tag'],
  text?: string,
  attrs?: Record<string, string>,
  children?: ViewNode[],
): ViewNode => ({
  tag,
  ...(text !== undefined ? { text } : {}),
  ...(attrs ? { attrs } : {}),
  ...(children ? { children } : {}),
});

function ms(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100) / 100} ms`;
}
function bytes(v: number | null): string {
  if (v === null) return '—';
  return `${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;
}

const outcomesText = (o: Record<string, number>): string =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || '—';

function table(headers: string[], rows: ViewNode[][]): ViewNode {
  return n('div', undefined, { class: 'scroll' }, [
    n('table', undefined, undefined, [
      n('thead', undefined, undefined, [
        n(
          'tr',
          undefined,
          undefined,
          headers.map((h) => n('th', h, { scope: 'col' })),
        ),
      ]),
      n(
        'tbody',
        undefined,
        undefined,
        rows.map((cells) => n('tr', undefined, { 'data-role': 'row' }, cells)),
      ),
    ]),
  ]);
}
const cellOf = (name: string, text: string, cls?: string): ViewNode =>
  n('td', text, { 'data-cell': name, ...(cls ? { class: cls } : {}) });
const labelled = (label: string, name: string, text: string, cls?: string): ViewNode[] => [
  n('span', `${label} `, { class: 'muted' }),
  n('span', text, { 'data-cell': name, ...(cls ? { class: cls } : {}) }),
  n('span', '  '),
];

const PHASE_LABEL: Record<ModelLoadPhase, string> = {
  acquire: 'Acquire (download, 0 when cached)',
  verify: 'Verify (re-hash)',
  handoff: 'Hand-off to the engine',
  session: 'Session create',
  first_token: 'First token',
};

/** One load: a header line and a small phase table, so it reads in a narrow docked DevTools window. */
function loadView(l: LoadRow): ViewNode {
  const phaseBytes: Record<string, number | null> = {
    acquire: l.bytes.acquire,
    verify: l.bytes.verify,
    handoff: l.bytes.handoff,
  };
  return n('section', undefined, { 'data-role': 'load' }, [
    n('p', undefined, undefined, [
      ...labelled('Load', 'loadId', l.loadId, 'mono'),
      ...labelled('Adapter', 'adapter', l.adapter),
      ...labelled('Device', 'device', l.device),
      ...labelled('Host', 'host', l.host),
      ...labelled('Model', 'model', l.model),
      ...labelled(
        'Outcome',
        'outcome',
        l.outcome === 'failed' ? `failed (${l.failure ?? '?'})` : l.outcome,
      ),
    ]),
    table(
      ['Phase', 'Duration', 'Bytes'],
      MODEL_LOAD_PHASES.map((phase) => [
        n('td', PHASE_LABEL[phase]),
        cellOf(phase === 'handoff' ? 'handoff' : phase, ms(l.phases[phase]), 'num'),
        cellOf(
          `${phase}Bytes`,
          phase in phaseBytes ? bytes(phaseBytes[phase] ?? null) : '—',
          'num',
        ),
      ]),
    ),
  ]);
}

export function buildPanelView(m: PanelModel): ViewNode {
  const root = n('main', undefined, { 'data-state': m.state }, []);
  const add = (c: ViewNode): void => void root.children!.push(c);
  if (m.state !== 'ok') {
    add(
      n('p', m.message, {
        class: m.state === 'empty' ? 'muted' : 'state-warn',
        'data-role': 'status',
      }),
    );
    return root;
  }
  const when = m.capturedAt === null ? '' : `, read at ${clock(m.capturedAt)} UTC`;
  add(
    n(
      'p',
      `Session ${m.session}${when}. Events the page left out: ${m.pageDropped}. Events dropped here as invalid: ${m.invalid}.`,
      { class: 'muted', 'data-role': 'status' },
    ),
  );
  add(n('h2', 'Loads'));
  if (m.loads.length === 0) add(n('p', 'No model load has been recorded yet.', { class: 'muted' }));
  else for (const l of m.loads) add(loadView(l));
  add(n('h2', 'Memory'));
  add(
    m.memory.length === 0
      ? n('p', 'No memory sample has been recorded yet.', { class: 'muted' })
      : table(
          [
            'Scope',
            'Point',
            'Source (api)',
            'JS heap used',
            'JS heap total',
            'JS heap limit',
            'Wasm memory',
          ],
          m.memory.map((r) => [
            cellOf('scope', r.scope),
            cellOf('at', r.at),
            cellOf('api', r.api),
            cellOf('usedJsHeap', bytes(r.usedJsHeap), 'num'),
            cellOf('totalJsHeap', bytes(r.totalJsHeap), 'num'),
            cellOf('jsHeapLimit', bytes(r.jsHeapLimit), 'num'),
            cellOf('wasmMemory', bytes(r.wasmMemory), 'num'),
          ]),
        ),
  );
  add(
    n(
      'p',
      'Memory figures are read from the browser, never estimated. Chrome’s performance.memory is coarse, Chrome-only and absent in workers; a dash means the browser did not expose it.',
      { class: 'muted' },
    ),
  );
  add(n('h2', 'Storage'));
  add(
    m.storage.length === 0
      ? n('p', 'No storage event has been recorded yet.', { class: 'muted' })
      : table(
          ['Event', 'Count', 'Last duration', 'Outcomes', 'Driver', 'Namespace'],
          m.storage.map((g) => [
            cellOf('storageName', g.name),
            cellOf('storageCount', String(g.count), 'num'),
            cellOf('storageLast', ms(g.lastDurationMs), 'num'),
            cellOf('storageOutcomes', outcomesText(g.outcomes)),
            cellOf('storageDriver', g.drivers.join(', ') || '—'),
            cellOf('storageNamespace', g.namespaces.join(', ') || '—'),
          ]),
        ),
  );
  add(n('h2', 'Pipeline'));
  add(
    m.pipeline.length === 0
      ? n('p', 'No pipeline event has been recorded yet.', { class: 'muted' })
      : table(
          ['Event', 'Count', 'Last duration', 'Outcomes', 'Reasons', 'Peak wasm memory'],
          m.pipeline.map((g) => [
            cellOf('pipelineName', g.name),
            cellOf('pipelineCount', String(g.count), 'num'),
            cellOf('pipelineLast', ms(g.lastDurationMs), 'num'),
            cellOf('pipelineOutcomes', outcomesText(g.outcomes)),
            cellOf('pipelineReasons', g.reasons.join(', ') || '—'),
            cellOf(
              'pipelineBytes',
              g.name === 'pipeline.memory' ? `${bytes(g.lastBytes)} (wasm memory)` : '—',
              'num',
            ),
          ]),
        ),
  );
  add(
    n(
      'p',
      'Counts, durations and outcomes only. No file name, document id, title, text, question or answer is ever carried by these events.',
      { class: 'muted' },
    ),
  );
  add(n('h2', 'Recent events'));
  add(
    table(
      ['Time (UTC)', 'Event', 'Level', 'Details'],
      m.recent.map((e) => [
        cellOf('time', e.time, 'mono'),
        cellOf('name', e.name),
        cellOf('level', e.level),
        cellOf('summary', e.summary),
      ]),
    ),
  );
  return root;
}

// ---- the DOM writer ---------------------------------------------------------------------------------

const ATTRS = new Set(['class', 'data-role', 'data-cell', 'data-load-id', 'data-state', 'scope']);

interface DomLike {
  createElement(tag: string): {
    setAttribute(k: string, v: string): void;
    append(...c: unknown[]): void;
    textContent: string | null;
  };
}
interface NodeLike {
  replaceChildren?(...c: unknown[]): void;
  append(...c: unknown[]): void;
}

function build(doc: DomLike, node: ViewNode): unknown {
  const el = doc.createElement(node.tag);
  for (const [k, v] of Object.entries(node.attrs ?? {})) if (ATTRS.has(k)) el.setAttribute(k, v);
  if (node.text !== undefined) el.textContent = node.text;
  for (const c of node.children ?? []) el.append(build(doc, c));
  return el;
}

/** Replaces the children of `parent` with the view. createElement, setAttribute and textContent only. */
export function mountView(doc: DomLike, parent: NodeLike, view: ViewNode): void {
  const child = build(doc, view);
  if (typeof parent.replaceChildren === 'function') parent.replaceChildren(child);
  else parent.append(child);
}
