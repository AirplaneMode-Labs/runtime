// Browser proof of the Airplane Mode DevTools panel (D1-07), in installed Chrome with a temporary
// profile (never the owner's).
//
//   (a) renderer: after a real model load and answer on models.html, the page's snapshot is fed to
//       chrome-extension://<id>/panel.html through __airplanemodePanelRender. This proves the renderer
//       (and that hostile snapshots stay inert text); it does NOT prove the DevTools transport.
//   (b) transport, the done-when: headed, gated by RUNTIME_DEVTOOLS_HEADED=1. DevTools opens beside a
//       real load and answer; the front-end is told to show the 'Airplane Mode' panel; the panel's own
//       page is read for the five phase durations, a memory figure and the load id, which must equal
//       the page snapshot's. A screenshot of the DevTools front-end goes to devtools-window.png and
//       the figures to devtools-figures.json (RUNTIME_DEVTOOLS_OUT, default runtime/test-results/, git-ignored).
//
//   RUNTIME_MODEL=1 npm run test:devtools                       (a)
//   RUNTIME_MODEL=1 RUNTIME_DEVTOOLS_HEADED=1 npm run test:devtools   (a) and (b)
//
// The extension is loaded with the CDP method Extensions.loadUnpacked, which Chrome allows only with
// the flag below. That flag is for this test file only: it appears in no README step, script, demo or
// source file, and a unit test checks that.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { attach, connectCdp, evaluate, listTargets, type CdpClient } from './cdp-flat';
import { resultsDir } from './out-dir';

const OUT_DIR = resultsDir('RUNTIME_DEVTOOLS_OUT');
const EXTENSION = resolve('devtools/dist');
const PROMPT = 'What is the capital of France? Answer in one word.';
const HEADED = process.env['RUNTIME_DEVTOOLS_HEADED'] === '1';

test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the DevTools proof');
test.describe.configure({ mode: 'serial' });

interface Launched {
  ctx: BrowserContext;
  cdp: CdpClient;
  extensionId: string;
  port: number;
  chromeVersion: string;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function launch(opts: { headed: boolean; autoOpenDevtools: boolean }): Promise<Launched> {
  const port = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'airplanemode-devtools-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: !opts.headed,
    viewport: null,
    args: [
      '--enable-unsafe-extension-debugging',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      ...(opts.autoOpenDevtools ? ['--auto-open-devtools-for-tabs'] : []),
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const cdp = await connectCdp(port);
  const loaded = await cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: EXTENSION });
  const version = await cdp.send<{ product: string }>('Browser.getVersion');
  return { ctx, cdp, extensionId: loaded.id, port, chromeVersion: version.product };
}

interface Snapshot {
  spec: string;
  session: string;
  events: {
    name: string;
    kind: string;
    attrs: Record<string, string | number | boolean | null>;
    durationMs?: number;
    bytes?: number;
  }[];
  dropped: number;
}

/** Opens models.html as the only page, does a real load and one answer on the WebAssembly rung. */
async function loadAndAnswer(
  ctx: BrowserContext,
  closeOthers: boolean,
): Promise<{ page: Page; snapshot: Snapshot; text: string }> {
  const page = await ctx.newPage();
  if (closeOthers) for (const p of ctx.pages()) if (p !== page) await p.close();
  await page.goto('http://127.0.0.1:8790/models.html');
  await page.waitForFunction(() => '__models' in window);
  const report = await page.evaluate(
    async (prompt) =>
      (
        window as unknown as {
          __models: {
            run(o: object): Promise<{ ok: boolean; text?: string; userMessage?: string }>;
          };
        }
      ).__models.run({ prompt, maxTokens: 8, forceRung: 'wasm', host: 'worker' }),
    PROMPT,
  );
  expect(report.ok, JSON.stringify(report)).toBe(true);
  const raw = await page.evaluate(() =>
    (
      globalThis as unknown as { __airplanemodeDevtools: { snapshot(): string } }
    ).__airplanemodeDevtools.snapshot(),
  );
  return { page, snapshot: JSON.parse(raw) as Snapshot, text: report.text ?? '' };
}

const PHASES = ['acquire', 'verify', 'handoff', 'session', 'first_token'] as const;

function lastLoad(snapshot: Snapshot): { loadId: string; phases: Record<string, number> } {
  const phaseEvents = snapshot.events.filter((e) => e.name === 'model.load.phase');
  const loadId = String(phaseEvents[phaseEvents.length - 1]!.attrs['loadId']);
  const phases: Record<string, number> = {};
  for (const e of phaseEvents)
    if (e.attrs['loadId'] === loadId) phases[String(e.attrs['phase'])] = e.durationMs ?? Number.NaN;
  return { loadId, phases };
}

test('(a) renderer: a real load and answer, the page snapshot rendered by the extension panel page', async () => {
  test.setTimeout(10 * 60_000);
  const { ctx, cdp, extensionId, chromeVersion } = await launch({
    headed: false,
    autoOpenDevtools: false,
  });
  try {
    const { snapshot, text } = await loadAndAnswer(ctx, false);
    expect(text.toLowerCase()).toContain('paris');
    expect(snapshot.spec).toBe('airplanemode.devtools/0.1');
    const { loadId, phases } = lastLoad(snapshot);
    for (const p of PHASES) expect(phases[p], p).toBeGreaterThanOrEqual(0);

    const panel = await ctx.newPage();
    const external: string[] = [];
    panel.on('request', (r) => {
      if (!r.url().startsWith(`chrome-extension://${extensionId}/`)) external.push(r.url());
    });
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForFunction(
      () =>
        typeof (window as unknown as Record<string, unknown>)['__airplanemodePanelRender'] ===
        'function',
    );
    // before any snapshot the panel waits; the empty state is the instruction
    await panel.evaluate(
      (j) =>
        (
          window as unknown as { __airplanemodePanelRender(j: unknown): void }
        ).__airplanemodePanelRender(j),
      null,
    );
    await expect(panel.locator('[data-role="status"]')).toContainText('exposeDevtoolsHook()');
    await panel.evaluate(
      (j) =>
        (
          window as unknown as { __airplanemodePanelRender(j: string): void }
        ).__airplanemodePanelRender(j),
      JSON.stringify(snapshot),
    );

    await expect(panel.locator('[data-cell="loadId"]').first()).toHaveText(loadId);
    const cells: Record<string, string> = {};
    for (const p of PHASES) {
      const t =
        (await panel.locator(`[data-role="row"] [data-cell="${p}"]`).first().textContent()) ?? '';
      expect(t, p).toMatch(/^\d+(\.\d+)? ms$/);
      cells[p] = t;
    }
    const apis = await panel.locator('[data-cell="api"]').allTextContents();
    expect(apis.length).toBeGreaterThanOrEqual(2);
    for (const a of apis) expect(['performance.memory', 'none']).toContain(a);
    expect(apis).toContain('performance.memory'); // Chrome exposes it on the page
    const heap = await panel.locator('[data-cell="usedJsHeap"]').allTextContents();
    expect(heap.some((h) => /^[\d,]+ B$/.test(h))).toBe(true);

    // hostile snapshots stay inert text and no script runs in the extension
    const hostile = {
      ...snapshot,
      events: snapshot.events.map((e) =>
        e.name === 'model.load.phase'
          ? {
              ...e,
              attrs: {
                ...e.attrs,
                model: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
              },
            }
          : e,
      ),
    };
    await panel.evaluate(
      (j) =>
        (
          window as unknown as { __airplanemodePanelRender(j: string): void }
        ).__airplanemodePanelRender(j),
      JSON.stringify(hostile),
    );
    expect(await panel.locator('img, script[src="x"], iframe, object, embed').count()).toBe(0);
    expect(
      await panel.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned),
    ).toBeUndefined();
    expect(await panel.locator('[data-cell="model"]').first().textContent()).toContain(
      '<img src=x',
    );
    await panel.evaluate(
      (j) =>
        (
          window as unknown as { __airplanemodePanelRender(j: string): void }
        ).__airplanemodePanelRender(j),
      'x'.repeat(3 * 1024 * 1024),
    );
    await expect(panel.locator('[data-role="status"]')).toContainText('more than 2 MiB');
    await panel.evaluate(
      (j) =>
        (
          window as unknown as { __airplanemodePanelRender(j: string): void }
        ).__airplanemodePanelRender(j),
      JSON.stringify({ ...snapshot, spec: 'x' }),
    );
    await expect(panel.locator('[data-role="status"]')).toContainText('unknown version');
    expect(external, 'the extension page made no request outside itself').toEqual([]);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'devtools-renderer.json'),
      JSON.stringify(
        {
          proves: 'the renderer only, not the DevTools transport',
          chrome: chromeVersion,
          extensionId,
          loadId,
          panelPhases: cells,
          panelMemoryApis: apis,
          panelUsedJsHeap: heap,
        },
        null,
        2,
      ),
    );
  } finally {
    cdp.close();
    await ctx.close();
  }
});

test('(b) DevTools transport: the real Airplane Mode tab in an open DevTools window shows the load', async () => {
  test.skip(!HEADED, 'set RUNTIME_DEVTOOLS_HEADED=1 to run the headed DevTools transport proof');
  test.setTimeout(10 * 60_000);
  const { ctx, cdp, extensionId, chromeVersion } = await launch({
    headed: true,
    autoOpenDevtools: true,
  });
  const record: Record<string, unknown> = { chrome: chromeVersion, extensionId, failure: null };
  const write = (): void => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'devtools-figures.json'), JSON.stringify(record, null, 2));
  };
  try {
    // exactly one page, so exactly one DevTools window, and it inspects the model page
    const { snapshot } = await loadAndAnswer(ctx, true);
    const { loadId: pageLoadId, phases: pagePhases } = lastLoad(snapshot);
    record['pageSnapshotLoadId'] = pageLoadId;
    record['pagePhases'] = pagePhases;

    const targets = await listTargets(cdp);
    const frontends = targets.filter(
      (t) => t.type === 'page' && t.url.startsWith('devtools://devtools/bundled/'),
    );
    record['devtoolsFrontendTargets'] = frontends.length;
    expect(frontends.length, 'one DevTools window').toBe(1);
    const feSession = await attach(cdp, frontends[0]!.targetId);

    // bring the extension panel forward with the front-end's own call (recorded); its tab id is the
    // extension origin plus the panel title without spaces
    const panelId = `chrome-extension://${extensionId}AirplaneMode`;
    record['panelSelection'] = `InspectorFrontendAPI.showPanel('${panelId}')`;
    await evaluate(
      cdp,
      feSession,
      `InspectorFrontendAPI.showPanel(${JSON.stringify(panelId)}), 'ok'`,
    );

    let panelTarget: string | undefined;
    for (let i = 0; i < 60 && !panelTarget; i++) {
      panelTarget = (await listTargets(cdp)).find((t) =>
        t.url.startsWith(`chrome-extension://${extensionId}/panel.html`),
      )?.targetId;
      if (!panelTarget) await new Promise((r) => setTimeout(r, 250));
    }
    expect(panelTarget, 'the panel page target appeared').toBeDefined();
    const panelSession = await attach(cdp, panelTarget!);

    // the panel polls every second while it is shown: wait for the load id to appear in its own text
    const read = async () =>
      evaluate<{
        status: string;
        loadId: string | null;
        phases: Record<string, string>;
        memory: { at: string; api: string; used: string }[];
        text: string;
      }>(
        cdp,
        panelSession,
        `(() => {
          const t = (sel) => document.querySelector(sel)?.textContent ?? null;
          const phases = {};
          for (const p of ${JSON.stringify(PHASES)}) phases[p] = t('[data-role="row"] [data-cell="' + p + '"]');
          const memory = [...document.querySelectorAll('[data-cell="api"]')].map((a) => {
            const tr = a.closest('tr');
            return { at: tr.querySelector('[data-cell="at"]').textContent, api: a.textContent, used: tr.querySelector('[data-cell="usedJsHeap"]').textContent };
          });
          return { status: t('[data-role="status"]') ?? '', loadId: t('[data-cell="loadId"]'), phases, memory, text: document.body.innerText.slice(0, 4000) };
        })()`,
      );
    let seen = await read();
    for (let i = 0; i < 40 && seen.loadId !== pageLoadId; i++) {
      await new Promise((r) => setTimeout(r, 500));
      seen = await read();
    }
    record['panelText'] = seen.text;
    record['panelLoadId'] = seen.loadId;
    expect(seen.loadId, 'the panel shows the load id of the page snapshot').toBe(pageLoadId);
    const durations: Record<string, number> = {};
    for (const p of PHASES) {
      const m = /^(\d+(?:\.\d+)?) ms$/.exec(seen.phases[p] ?? '');
      expect(m, `${p}: ${seen.phases[p]}`).not.toBeNull();
      durations[p] = Number(m![1]);
    }
    record['panelPhaseDurationsMs'] = durations;
    const figures = seen.memory.filter((r) => /^[\d,]+ B$/.test(r.used));
    record['panelMemory'] = seen.memory;
    expect(figures.length, 'at least one non-null memory figure').toBeGreaterThanOrEqual(1);
    for (const r of seen.memory) expect(['performance.memory', 'none']).toContain(r.api);

    // the screenshot of the DevTools front-end (the window the user sees), Airplane Mode tab forward
    const shot = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      feSession,
    );
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'devtools-window.png'), Buffer.from(shot.data, 'base64'));
    record['screenshot'] = 'devtools-window.png';
    record['result'] =
      'the real Airplane Mode tab inside an open Chrome DevTools window showed the load';
    write();
  } catch (e) {
    record['failure'] = String(e instanceof Error ? e.message : e).slice(0, 2000);
    write();
    throw e;
  } finally {
    cdp.close();
    await ctx.close();
  }
});
