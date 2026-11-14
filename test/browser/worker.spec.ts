// Browser proof of the engine worker (D1-04): SmolLM2-135M on forced WebAssembly in a dedicated module
// worker, in installed Chrome behind an aborting network gate.
//
//   RUNTIME_MODEL=1 npm run test:worker
//
// - the answer arrives, phases and memory come from the worker host, one worker is started;
// - the longest main-thread long task during a 32-token answer is under 200 ms;
// - a timer abort resolves 'abort' within 500 ms in 5 of 5 runs and the holds are released after terminate;
// - probes evaluated INSIDE the worker are all refused (fetch, XHR, WebSocket, EventSource, WebTransport,
//   Worker, Cache.add and addAll); dynamic import() and FontFace are blocked by the inherited CSP;
// - nothing but the page origin is requested, from the page or the worker, and the verified prefix is
//   never requested.
// Results go to worker-run.json (RUNTIME_WORKER_OUT, default runtime/test-results/, git-ignored).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { chromium } from 'playwright/test';
import { expectOnlyPageOrigin, gatedContext, phaseEvents, runHook, PROMPT } from './worker-helpers';
import { resultsDir } from './out-dir';

const OUT_DIR = resultsDir('RUNTIME_WORKER_OUT');
test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the worker proof');
test.describe.configure({ mode: 'serial' });

const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), prompt: PROMPT };
test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'worker-run.json'), JSON.stringify(results, null, 2));
});

test('the engine answers from a worker on forced WebAssembly, observability comes from the worker host, probes in the worker are refused', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { page, gate } = await gatedContext(browser);
    await page.goto('http://127.0.0.1:8790/models.html');
    const report = await runHook(page, {
      prompt: PROMPT,
      maxTokens: 16,
      forceRung: 'wasm',
      host: 'worker',
    });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.rung).toBe('wasm');
    expect((report.text ?? '').toLowerCase()).toContain('paris');
    const events = report.events ?? [];
    const phases = phaseEvents(events);
    expect(phases.map((e) => e.attrs['phase'])).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
      'first_token',
    ]);
    expect(new Set(phases.map((e) => e.attrs['loadId'])).size).toBe(1);
    for (const p of phases) expect(p.attrs['host']).toBe('worker');
    const lifecycle = events
      .filter((e) => e.name === 'backend.worker')
      .map((e) => e.attrs['state']);
    expect(lifecycle).toEqual(['started', 'ready']);
    const workerMem = events.filter(
      (e) => e.name === 'memory.sample' && e.attrs['scope'] === 'worker',
    );
    expect(workerMem.length).toBeGreaterThanOrEqual(2);
    const pageMem = events.filter((e) => e.name === 'memory.sample' && e.attrs['scope'] === 'page');
    expect(
      pageMem.some(
        (e) => e.attrs['api'] === 'performance.memory' && e.attrs['usedJsHeap'] !== null,
      ),
    ).toBe(true);
    expect(gate.workers, 'one engine worker').toBe(1);

    // probes inside the worker
    const worker = page.workers()[0]!;
    expect(worker).toBeDefined();
    const probes = await worker.evaluate(async () => {
      const g = globalThis as unknown as Record<string, unknown> & { __csp?: string[] };
      g.__csp = [];
      self.addEventListener('securitypolicyviolation', (e) =>
        g.__csp!.push(
          `${(e as SecurityPolicyViolationEvent).violatedDirective} ${(e as SecurityPolicyViolationEvent).blockedURI}`,
        ),
      );
      const out: Record<string, string> = {};
      const attempt = async (name: string, fn: () => unknown) => {
        try {
          await fn();
          out[name] = 'ALLOWED';
        } catch (e) {
          out[name] =
            `refused:${(e as { code?: string; name?: string }).code ?? (e as Error).name}`;
        }
      };
      const target = 'https://example.invalid/x';
      await attempt('fetch', () => fetch(target));
      await attempt('xhr', () => new XMLHttpRequest());
      await attempt('websocket', () => new WebSocket('wss://example.invalid/'));
      await attempt('eventsource', () => new EventSource(target));
      await attempt(
        'webtransport',
        () => new (g['WebTransport'] as new (u: string) => unknown)(target),
      );
      await attempt('worker', () => new Worker(target));
      await attempt('sharedworker', () =>
        g['SharedWorker']
          ? new (g['SharedWorker'] as new (u: string) => unknown)(target)
          : (() => {
              throw new Error('SharedWorker undefined here');
            })(),
      );
      const cache = await caches.open('airplanemode-probe');
      await attempt('cache.add', () => cache.add(target));
      await attempt('cache.addAll', () => cache.addAll([target]));
      await caches.delete('airplanemode-probe');
      await attempt('fontface', () => new FontFace('x', 'url(https://example.invalid/f)').load());
      let owner: object | null = self;
      let d: PropertyDescriptor | undefined;
      while (owner && !(d = Object.getOwnPropertyDescriptor(owner, 'fetch')))
        owner = Object.getPrototypeOf(owner);
      out['fetchLocked'] = String(d?.writable === false && d?.configurable === false);
      // S1-072: self owns a locked fetch, so a shadowing defineProperty throws and the shim still refuses
      let ownFetch: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(self, 'fetch');
      out['ownFetchLocked'] = String(
        ownFetch?.writable === false && ownFetch?.configurable === false,
      );
      try {
        Object.defineProperty(self, 'fetch', { value: () => 'shadowed', configurable: true });
        out['defineFetch'] = 'ALLOWED';
      } catch (e) {
        out['defineFetch'] = `refused:${(e as Error).name}`;
      }
      ownFetch = undefined;
      await attempt('fetchAfterDefine', () => fetch(target));
      out['sentinel'] = String(
        (self as unknown as Record<symbol, unknown>)[Symbol.for('airplanemode.egressGuard.v1')],
      );
      await new Promise((r) => setTimeout(r, 300));
      out['csp'] = JSON.stringify(g.__csp);
      return out;
    });
    // import() cannot be replaced from JavaScript: only the inherited CSP stands in its way. The probe is
    // a string expression, evaluated by DevTools in the worker, so no eval of the worker's is involved.
    probes['import'] = await worker.evaluate(
      "import('https://example.invalid/x.js').then(() => 'ALLOWED', (e) => 'refused:' + e.name)",
    );
    probes['csp'] = JSON.stringify(
      JSON.parse(probes['csp']!).concat(
        JSON.parse(await worker.evaluate('JSON.stringify(self.__csp ?? [])')),
      ),
    );
    results['probes'] = probes;
    for (const name of [
      'fetch',
      'xhr',
      'websocket',
      'eventsource',
      'webtransport',
      'worker',
      'cache.add',
      'cache.addAll',
    ])
      expect(probes[name], name).toMatch(/^refused:/);
    expect(probes['fetch']).toBe('refused:egress_refused');
    expect(probes['fetchLocked']).toBe('true');
    expect(probes['ownFetchLocked']).toBe('true');
    expect(probes['defineFetch']).toBe('refused:TypeError');
    expect(probes['fetchAfterDefine']).toBe('refused:egress_refused');
    expect(probes['sentinel']).toBe('true');
    // import() and FontFace cannot be guarded in JS: the inherited CSP refuses them, or this fails and
    // the documented fallback (same-origin worker URL, no blob: in worker-src) and an S1 finding apply
    for (const name of ['import', 'fontface']) expect(probes[name], name).toMatch(/^refused:/);
    expect(
      JSON.parse(probes['csp']!).length,
      `CSP violations seen in the worker: ${probes['csp']}`,
    ).toBeGreaterThanOrEqual(1);
    results['cspInheritedByBlobWorker'] = true;

    // after the probes: nothing but the page origin was requested (the probes never reached the network)
    const cspBlocked = (JSON.parse(probes['csp']!) as string[]).map((v) =>
      v.split(' ').slice(1).join(' '),
    );
    results['cspBlockedByTheWorkerProbes'] = cspBlocked;
    expectOnlyPageOrigin(gate, 'worker answer', cspBlocked);
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(csp).toEqual([]);
    results['answer'] = {
      text: report.text,
      phases: phases.map((p) => [p.attrs['phase'], p.attrs['host']]),
      lifecycle,
    };
  } finally {
    await browser.close();
  }
});

test('the longest main-thread long task during a 32-token WebAssembly answer is under 200 ms', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { page, gate } = await gatedContext(browser);
    await page.goto('http://127.0.0.1:8790/models.html');
    const report = await runHook(page, {
      prompt: 'Tell me about Paris in two sentences.',
      maxTokens: 32,
      forceRung: 'wasm',
      host: 'worker',
      temperature: 0,
    });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    const longest = Math.max(0, ...(report.longTasksMs ?? []));
    results['longTaskDuringAnswer'] = { longestMs: longest, all: report.longTasksMs };
    expect(longest).toBeLessThan(200);
    expectOnlyPageOrigin(gate, 'long task');
  } finally {
    await browser.close();
  }
});

test('abort from a timer resolves abort within 500 ms in 5 of 5 runs, and the holds are released after terminate', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { page, gate } = await gatedContext(browser);
    await page.goto('http://127.0.0.1:8790/models.html');
    const runs: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const report = await runHook(page, {
        prompt: 'Write a long story about a river.',
        maxTokens: 64,
        forceRung: 'wasm',
        host: 'worker',
        temperature: 0,
        abortAfterMs: 1200,
      });
      expect(report.ok, JSON.stringify(report)).toBe(true);
      const a = report.timerAbort!;
      runs.push(a);
      expect(a.finishReason, `run ${i}`).toBe('abort');
      expect(a.latencyMs, `run ${i}`).toBeLessThan(500);
      if (!a.loaded)
        expect(
          a.refcounts.every((n) => n === 0),
          `run ${i}: holds released`,
        ).toBe(true);
    }
    results['abortRuns'] = runs;
    expectOnlyPageOrigin(gate, 'abort');
    await page.evaluate(() =>
      (window as unknown as { __models: { unload(): Promise<void> } }).__models.unload(),
    );
  } finally {
    await browser.close();
  }
});
