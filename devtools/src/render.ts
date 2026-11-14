/**
 * The panel's model and view. buildPanelModel() is pure: a raw page answer in, a PanelModel out.
 * buildPanelView() turns a model into a tree of whitelisted nodes, and mountView() writes that tree
 * into the DOM with createElement, setAttribute and textContent only. Nothing here parses HTML or
 * assigns markup, so a hostile string in an event is shown as text.
 */

import { MODEL_LOAD_PHASES, type Event, type ModelLoadPhase } from '../../spec/event';
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
