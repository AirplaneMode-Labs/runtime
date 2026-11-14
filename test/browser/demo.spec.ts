// The refreshed backend demo (D1-11), built exactly as pages.yml builds it (DEMO_MODELS=1 npm run
// demo:build) and served under /runtime/ by a server that 404s every other path, in installed Chrome:
// 0 console and page errors, same-origin requests only, the strict CSP meta, the build id, no request to
// models/ before the click, and every engine picker choice that is shown answers the same prompt, with
// the worker line and the load timing and memory read-out.
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:demo
//
// Results go to demo-run.json (RUNTIME_DEMO_OUT, default runtime/test-results/, git-ignored).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, test } from 'playwright/test';
import { resultsDir } from './out-dir';

const BASE = 'http://127.0.0.1:8791/runtime/';
const OUT_DIR = resultsDir('RUNTIME_DEMO_OUT');
test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the demo proof');
test.describe.configure({ mode: 'serial' });

const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), base: BASE };
test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'demo-run.json'), JSON.stringify(results, null, 2));
});

for (const choice of ['auto', 'webgpu', 'wasm'] as const) {
  test(`the picker choice ${choice} answers the prompt from the hosted path /runtime/, with the worker line and the read-out`, async () => {
    test.setTimeout(10 * 60_000);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      const requests: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      context.on('request', (r) => requests.push(r.url()));
      await page.goto(`${BASE}models.html`);
      await page.waitForFunction(() => document.getElementById('plan-list')?.children.length === 3);
      // the page state before the click
      expect(await page.locator('#build-id').textContent()).toMatch(/^([0-9a-f]{12}|local)$/);
      const csp = await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
      expect(csp).toContain("require-trusted-types-for 'script'");
      expect(
        requests.filter((u) => new URL(u).pathname.startsWith('/runtime/models/')),
        'no models/ request before the click',
      ).toEqual([]);
      await expect(page.locator('#not-yet')).toContainText('WebLLM rung: not yet');
      await expect(page.locator('#sel-engine option')).toHaveText([
        'Auto (WebGPU first, then WebAssembly)',
        'Transformers.js WebGPU',
        'Transformers.js WebAssembly',
      ]);
      await page.locator('#sel-engine').selectOption(choice);
      const beforeClick = requests.length;

      await expect(page.locator('#btn-download')).toBeEnabled();
      await page.locator('#btn-download').click();
      const refusal = page.locator('#refusal');
      const ok = page.locator('#result:not(.hidden)');
      await Promise.race([
        ok.waitFor({ timeout: 8 * 60_000 }),
        refusal.locator('visible=true').waitFor({ timeout: 8 * 60_000 }),
      ]);
      if (await refusal.isVisible()) {
        const text = (await refusal.textContent()) ?? '';
        if (choice === 'webgpu' && /not available|device/i.test(text)) {
          test.skip(process.env['RUNTIME_REQUIRE_WEBGPU'] !== '1', 'no usable WebGPU adapter here');
        }
        throw new Error(`the load was refused: ${text}`);
      }
      const rung = (await page.locator('#r-rung').textContent()) ?? '';
      expect(rung).toBe(choice === 'wasm' ? 'WebAssembly' : 'WebGPU');
      await expect(page.locator('#worker-line')).toContainText('The engine runs in a worker');
      await expect(page.locator('#btn-run')).toBeEnabled();
      await page.locator('#btn-run').click();
      await expect(page.locator('#out-timing')).toContainText('Finish:', { timeout: 120_000 });
      const answer = (await page.locator('#out-answer').textContent()) ?? '';
      expect(answer.toLowerCase()).toContain('paris');

      // the read-out: five phase durations under one load id, and the page heap
      const readout = page.locator('#readout-body');
      const loadId = (await readout.locator('[data-cell="loadId"]').first().textContent()) ?? '';
      expect(loadId).toMatch(/^[0-9a-f]{16}$/);
      const phases: Record<string, string> = {};
      for (const p of ['acquire', 'verify', 'handoff', 'session', 'first_token']) {
        const t =
          (await readout.locator(`[data-role="row"] [data-cell="${p}"]`).first().textContent()) ??
          '';
        expect(t, p).toMatch(/^\d+(\.\d+)? ms$/);
        phases[p] = t;
      }
      const heap = await readout.locator('[data-cell="usedJsHeap"]').allTextContents();
      expect(
        heap.some((h) => /^[\d,]+ B$/.test(h)),
        'a page heap figure',
      ).toBe(true);

      // errors and egress
      expect(errors, 'console and page errors').toEqual([]);
      const origin = new URL(BASE).origin;
      for (const u of requests) {
        const parsed = new URL(u);
        if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') continue;
        expect(parsed.origin, u).toBe(origin);
        expect(parsed.pathname.startsWith('/runtime/'), u).toBe(true);
      }
      const modelRequests = requests
        .slice(beforeClick)
        .filter((u) => new URL(u).pathname.startsWith('/runtime/models/'));
      expect(modelRequests.length, 'models/ is requested after the click').toBeGreaterThan(0);
      results[choice] = {
        rung,
        answer,
        loadId,
        phases,
        heap: heap.slice(0, 3),
        requests: requests.length,
        modelRequestsAfterClick: modelRequests.length,
      };
    } finally {
      await browser.close();
    }
  });
}
