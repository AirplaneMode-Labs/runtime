// D1-07: polling only while the panel is shown, one request at a time, the constant page expression
// that never invokes a page getter, and the devtools page that never polls. Written before the
// implementation.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_EXPRESSION } from '../devtools/src/page-expr';
import { createController, installPanel } from '../devtools/src/controller';
import { registerPanel } from '../devtools/src/devtools';
import { repoDir } from './helpers';

const MAX = 2097152;

// ---- the page expression, evaluated in a separate realm like the page ----------------------------

function run(setup: string, counters: Record<string, number> = {}): unknown {
  const ctx = vm.createContext({ counters });
  vm.runInContext(setup, ctx);
  return vm.runInContext(PAGE_EXPRESSION, ctx);
}
const GOOD = `Object.defineProperty(globalThis, '__airplanemodeDevtools', { value: Object.freeze({ version: 1, snapshot() { return '{"ok":true}'; } }), enumerable: false, writable: false, configurable: true });`;

describe('PAGE_EXPRESSION', () => {
  it('returns the snapshot string of a hook that is a data property with a snapshot function', () => {
    expect(run(GOOD)).toBe('{"ok":true}');
  });

  it('returns null when there is no hook', () => {
    expect(run('')).toBeNull();
    expect(run(`globalThis.__airplanemodeDevtools = undefined;`)).toBeNull();
    expect(run(`globalThis.__airplanemodeDevtools = 5;`)).toBeNull();
    expect(run(`globalThis.__airplanemodeDevtools = {};`)).toBeNull();
    expect(run(`globalThis.__airplanemodeDevtools = { snapshot: 7 };`)).toBeNull();
  });

  it('never invokes a getter on the global: a page getter is not called (counter 0) and the answer is null', () => {
    const counters = { getter: 0 };
    const out = run(
      `Object.defineProperty(globalThis, '__airplanemodeDevtools', { get() { counters.getter++; return { snapshot() { return '{}'; } }; }, configurable: true });`,
      counters,
    );
    expect(out).toBeNull();
    expect(counters.getter).toBe(0);
  });

  it('never invokes a getter for snapshot: an accessor property is refused (counter 0)', () => {
    const counters = { getter: 0 };
    const out = run(
      `globalThis.__airplanemodeDevtools = Object.defineProperty({ version: 1 }, 'snapshot', { get() { counters.getter++; return () => '{}'; }, enumerable: true });`,
      counters,
    );
    expect(out).toBeNull();
    expect(counters.getter).toBe(0);
  });

  it('a Proxy hook: its get trap is never called (counter 0)', () => {
    const counters = { get: 0, other: 0 };
    run(
      `globalThis.__airplanemodeDevtools = new Proxy({ snapshot() { return '{}'; } }, { get(t, k, r) { counters.get++; return Reflect.get(t, k, r); }, has() { counters.other++; return true; } });`,
      counters,
    );
    expect(counters.get).toBe(0);
  });

  it('a snapshot that throws is a sentinel string, not an exception', () => {
    expect(
      run(
        `globalThis.__airplanemodeDevtools = Object.freeze({ version: 1, snapshot() { throw new Error('boom ' + 'SECRET'); } });`,
      ),
    ).toBe('!throw');
  });

  it('a non-string result, or a string over 2 MiB, is the size sentinel; exactly 2 MiB passes', () => {
    const mk = (body: string) =>
      `globalThis.__airplanemodeDevtools = Object.freeze({ version: 1, snapshot() { return ${body}; } });`;
    expect(run(mk('42'))).toBe('!shape');
    expect(run(mk('({ a: 1 })'))).toBe('!shape');
    expect(run(mk(`'x'.repeat(${MAX + 1})`))).toBe('!shape');
    expect((run(mk(`'x'.repeat(${MAX})`)) as string).length).toBe(MAX);
  });

  it('is a constant string: no template, no interpolation, no use of user data', () => {
    expect(typeof PAGE_EXPRESSION).toBe('string');
    expect(PAGE_EXPRESSION).toContain('getOwnPropertyDescriptor');
    expect(PAGE_EXPRESSION).toContain('2097152');
    const src = readFileSync(resolve(repoDir, 'devtools/src/page-expr.ts'), 'utf8');
    expect(src).not.toMatch(/\$\{/);
  });
});

// ---- the controller ----------------------------------------------------------------------------------

function rig(opts: { respond?: boolean } = {}) {
  let t = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const evals: { expr: string; cb: (r: unknown, e: unknown) => void }[] = [];
  const renders: unknown[] = [];
  const c = createController({
    evalInPage: (expr, cb) => {
      evals.push({ expr, cb });
      if (opts.respond !== false) {
        /* the test answers by hand */
      }
    },
    render: (m) => renders.push(m),
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id as number);
    },
    now: () => t,
  });
  return {
    c,
    evals,
    renders,
    timers,
    advance(ms: number) {
      t += ms;
      for (const x of [...timers.values()]) x.fn();
    },
    answer(i: number, result: unknown, exc: unknown = undefined) {
      evals[i]!.cb(result, exc);
    },
  };
}

describe('createController: polling only while shown', () => {
  it('does nothing until shown(); shown() reads once at once and then every 1000 ms; hidden() stops it', () => {
    const r = rig();
    expect(r.evals).toHaveLength(0);
    expect(r.timers.size).toBe(0);
    r.c.shown();
    expect(r.evals).toHaveLength(1);
    expect([...r.timers.values()].map((x) => x.ms)).toEqual([1000]);
    r.answer(0, null);
    r.advance(1000);
    expect(r.evals).toHaveLength(2);
    r.answer(1, null);
    r.c.hidden();
    expect(r.timers.size).toBe(0);
    r.advance(5000);
    expect(r.evals).toHaveLength(2);
    r.c.shown();
    expect(r.evals).toHaveLength(3);
    expect(r.timers.size).toBe(1);
  });

  it('shown() twice does not start a second timer', () => {
    const r = rig();
    r.c.shown();
    r.c.shown();
    expect(r.timers.size).toBe(1);
  });

  it('at most one outstanding call: a tick while the previous read has not returned does nothing', () => {
    const r = rig();
    r.c.shown();
    r.advance(1000);
    r.advance(1000);
    expect(r.evals).toHaveLength(1);
    r.answer(0, null);
    r.advance(1000);
    expect(r.evals).toHaveLength(2);
  });

  it('every call uses the one constant expression', () => {
    const r = rig();
    r.c.shown();
    r.answer(0, null);
    r.advance(1000);
    expect(new Set(r.evals.map((e) => e.expr))).toEqual(new Set([PAGE_EXPRESSION]));
  });

  it('a snapshot that never returns shows a waiting state after 5 seconds and stays one call', () => {
    const r = rig();
    r.c.shown();
    r.advance(1000);
    r.advance(1000);
    r.advance(1000);
    r.advance(1000);
    r.advance(1000);
    r.advance(1000);
    expect(r.evals).toHaveLength(1);
    expect(r.renders.some((m) => (m as { state: string }).state === 'waiting')).toBe(true);
  });
});

describe('createController: what a reply becomes', () => {
  const states = (r: ReturnType<typeof rig>) =>
    r.renders.map((m) => (m as { state: string }).state);

  it('null is the empty state; a valid snapshot string is ok', () => {
    const r = rig();
    r.c.shown();
    r.answer(0, null);
    expect(states(r).at(-1)).toBe('empty');
    r.advance(1000);
    r.answer(
      1,
      JSON.stringify({
        spec: 'airplanemode.devtools/0.1',
        session: 's',
        capturedAt: 1,
        events: [],
        dropped: 0,
      }),
    );
    expect(states(r).at(-1)).toBe('empty'); // no events
  });

  it('rejects anything that is not a string of at most 2 MiB again in the extension, before JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const r = rig();
    r.c.shown();
    r.answer(0, { not: 'a string' });
    expect(states(r).at(-1)).toBe('rejected');
    r.advance(1000);
    r.answer(1, 'x'.repeat(MAX + 1));
    expect(states(r).at(-1)).toBe('rejected');
    r.advance(1000);
    r.answer(2, '!throw');
    expect(states(r).at(-1)).toBe('rejected');
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('an isException result is ignored: nothing is rendered from it and polling goes on', () => {
    const r = rig();
    r.c.shown();
    const before = r.renders.length;
    r.answer(0, undefined, { isException: true, value: 'SECRET page text' });
    expect(r.renders.length).toBe(before);
    r.advance(1000);
    expect(r.evals).toHaveLength(2);
  });

  it('a DevTools error (Permission denied) is a denied state with fixed text; other errors are a generic state; neither echoes Chrome text', () => {
    const r = rig();
    r.c.shown();
    r.answer(0, undefined, { isError: true, code: 'E_FAILED', details: ['Permission denied'] });
    const denied = r.renders.at(-1) as { state: string; message: string };
    expect(denied.state).toBe('denied');
    expect(denied.message).not.toContain('E_FAILED');
    r.advance(1000);
    r.answer(1, undefined, { isError: true, code: 'E_FAILED', details: ['SENTINEL <b>x</b>'] });
    const other = r.renders.at(-1) as { state: string; message: string };
    expect(other.state).toBe('error');
    expect(JSON.stringify(other)).not.toContain('SENTINEL');
  });
});

// ---- the devtools page and the panel page ---------------------------------------------------------------

type Listener = (w?: unknown) => void;
function emitter() {
  const ls: Listener[] = [];
  return {
    addListener: (l: Listener) => ls.push(l),
    fire: (w?: unknown) => ls.forEach((l) => l(w)),
  };
}

describe('devtools.ts', () => {
  it('calls panels.create once with Airplane Mode, no icon and panel.html, and forwards shown and hidden to the panel window', () => {
    const onShown = emitter();
    const onHidden = emitter();
    const create = vi.fn((_t: string, _i: string, _p: string, cb: (panel: unknown) => void) =>
      cb({ onShown, onHidden }),
    );
    registerPanel({ devtools: { panels: { create } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]!.slice(0, 3)).toEqual(['Airplane Mode', '', 'panel.html']);
    const visible = vi.fn();
    const win = { __airplanemodePanelVisible: visible };
    onShown.fire(win);
    expect(visible).toHaveBeenLastCalledWith(true);
    onHidden.fire();
    expect(visible).toHaveBeenLastCalledWith(false);
    onShown.fire({}); // a panel window without the hook is tolerated
  });

  it('never polls and never reads the page: no timers, no eval', () => {
    const src = readFileSync(resolve(repoDir, 'devtools/src/devtools.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).not.toMatch(
      /setInterval|setTimeout|requestAnimationFrame|\.eval\b|inspectedWindow/,
    );
    const timers = vi.spyOn(globalThis, 'setInterval');
    registerPanel({
      devtools: {
        panels: { create: (_a, _b, _c, cb) => cb({ onShown: emitter(), onHidden: emitter() }) },
      },
    });
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });
});

describe('installPanel', () => {
  const doc = () => ({ createElement: () => ({}) });

  it('exposes __airplanemodePanelRender only when chrome.devtools is undefined', () => {
    const noDevtools: Record<string, unknown> = {};
    installPanel({
      window: noDevtools,
      chrome: undefined,
      document: doc() as never,
      render: () => {},
    });
    expect(typeof noDevtools['__airplanemodePanelRender']).toBe('function');
    const withChrome: Record<string, unknown> = {};
    installPanel({
      window: withChrome,
      chrome: { devtools: { inspectedWindow: { eval: () => {} } } },
      document: doc() as never,
      render: () => {},
    });
    expect('__airplanemodePanelRender' in withChrome).toBe(false);
    expect(typeof withChrome['__airplanemodePanelVisible']).toBe('function');
    const chromeNoDevtools: Record<string, unknown> = {};
    installPanel({
      window: chromeNoDevtools,
      chrome: {},
      document: doc() as never,
      render: () => {},
    });
    expect(typeof chromeNoDevtools['__airplanemodePanelRender']).toBe('function');
  });

  it('__airplanemodePanelRender(json) builds the model from the string and renders it', () => {
    const w: Record<string, unknown> = {};
    const rendered: { state: string }[] = [];
    installPanel({
      window: w,
      chrome: undefined,
      document: doc() as never,
      render: (m) => rendered.push(m),
    });
    (w['__airplanemodePanelRender'] as (j: unknown) => void)('{nope');
    (w['__airplanemodePanelRender'] as (j: unknown) => void)(null);
    expect(rendered.map((m) => m.state)).toEqual(['rejected', 'empty']);
  });

  it('with chrome.devtools, __airplanemodePanelVisible(true) starts polling the inspected window and (false) stops it', () => {
    const w: Record<string, unknown> = {};
    const evals: string[] = [];
    const timers: { fn: () => void }[] = [];
    const spyInterval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
    ) => {
      timers.push({ fn });
      return timers.length as unknown as ReturnType<typeof setInterval>;
    }) as never);
    const spyClear = vi.spyOn(globalThis, 'clearInterval').mockImplementation((() => {
      timers.length = 0;
    }) as never);
    installPanel({
      window: w,
      chrome: { devtools: { inspectedWindow: { eval: (e: string) => evals.push(e) } } },
      document: doc() as never,
      render: () => {},
    });
    const visible = w['__airplanemodePanelVisible'] as (v: boolean) => void;
    visible(true);
    expect(evals).toEqual([PAGE_EXPRESSION]);
    expect(timers).toHaveLength(1);
    visible(false);
    expect(timers).toHaveLength(0);
    spyInterval.mockRestore();
    spyClear.mockRestore();
  });
});
