// D1-04: the Stop button of models.html in installed Chrome with the real test model on the worker host.
// The page is the demo built as pages.yml builds it (DEMO_MODELS=1), served under /runtime/ on
// 127.0.0.1:8791 with ?maxTokens=400 (a loopback-only test
// parameter that lengthens the answer so Stop can be pressed while it runs). The button states must read
// disabled, enabled, disabled; the abort must settle within 1000 ms; the read-out says 'Stopped' with the
// time to stop; the engine stays usable afterwards or the page says plainly what to do.
// Written before the page had a Stop button (red run: evidence/sprint-4/D1/red-D1-04.log).
//
//   RUNTIME_MODEL=1 npm run test:demo -- stop.spec.ts
//
// Results go to stop-run.json (RUNTIME_STOP_OUT, default runtime/test-results/, git-ignored).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, test } from 'playwright/test';
import { resultsDir } from './out-dir';

const OUT_DIR = resultsDir('RUNTIME_STOP_OUT');
test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the Stop proof');

const results: Record<string, unknown> = { generatedAt: new Date().toISOString() };
test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'stop-run.json'), JSON.stringify(results, null, 2));
});

test('Stop is enabled only while the model answers, lands within 1000 ms and says Stopped', async () => {
  test.setTimeout(8 * 60_000);
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('http://127.0.0.1:8791/runtime/models.html?maxTokens=400');

    const run = page.locator('#btn-run');
    const stop = page.locator('#btn-stop');
    // before a model is loaded: Stop exists and is disabled
    await expect(stop).toBeDisabled();
    await page.locator('#sel-engine').selectOption('wasm');
    await expect(page.locator('#btn-download')).toBeEnabled();
    await page.locator('#btn-download').click();
    await expect(page.locator('#result:not(.hidden)')).toBeVisible({ timeout: 6 * 60_000 });
    await expect(run).toBeEnabled();
    await expect(stop).toBeDisabled();

    const states: string[] = [];
    const sample = async (label: string) =>
      states.push(
        `${label}: run ${(await run.isDisabled()) ? 'disabled' : 'enabled'}, stop ${
          (await stop.isDisabled()) ? 'disabled' : 'enabled'
        }`,
      );
    await sample('idle');
    // a prompt that asks for a long answer (the default prompt is answered in 8 tokens)
    await page
      .locator('#in-prompt')
      .fill('Write a very long story about a river and the people who live beside it.');
    await run.click();
    // wait for the first streamed token: the answer is running
    await expect(page.locator('#out-answer')).not.toHaveText('', { timeout: 120_000 });
    await expect(stop).toBeEnabled();
    await expect(run).toBeDisabled();
    await sample('answering');
    const t0 = Date.now();
    await stop.click();
    await expect(page.locator('#out-timing')).toContainText('Stopped', { timeout: 1000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    await expect(stop).toBeDisabled();
    await expect(run).toBeEnabled();
    await sample('stopped');
    const timing = (await page.locator('#out-timing').textContent()) ?? '';
    expect(timing).toMatch(/Time to stop: \d+ ms/);
    const ms = Number(/Time to stop: (\d+) ms/.exec(timing)![1]);
    expect(ms).toBeLessThan(1000);
    const partial = (await page.locator('#out-answer').textContent()) ?? '';
    expect(partial.length).toBeGreaterThan(0);

    // T1-S4-02: after a Stop the reload is always on offer. Stop may have terminated the worker (the 250 ms
    // backstop), and the page tells the visitor to click "Download test model and load" again, so that
    // button must be enabled, and one click must reach the 'loaded idle' state with nothing downloaded.
    const download = page.locator('#btn-download');
    await expect(download).toBeEnabled();
    const stopStatus = (await page.locator('#progress').textContent()) ?? '';
    expect(stopStatus).toContain('Download test model and load');
    expect(stopStatus).toContain('nothing is downloaded');
    results['progressAfterStop'] = stopStatus;

    // the page is usable afterwards: either the engine answers again, or the page says how to reload it
    await run.click();
    await expect(page.locator('#out-timing')).not.toHaveText('Generating…', { timeout: 120_000 });
    const after = (await page.locator('#out-timing').textContent()) ?? '';
    expect(errors, 'console and page errors').toEqual([]);

    // one click reloads from the stored files: 'loaded idle' = the verified message, Run enabled, Stop disabled
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await download.click();
    await expect(page.locator('#progress')).toContainText('Model loaded and verified', {
      timeout: 3 * 60_000,
    });
    await expect(run).toBeEnabled();
    await expect(stop).toBeDisabled();
    await expect(page.locator('#result:not(.hidden)')).toBeVisible();
    await expect(page.locator('#r-bytes')).toHaveText('0 B'); // the load report: nothing was downloaded
    expect(
      requests.filter((u) => u.includes('/models/smollm2-135m-instruct/')),
      'no model file is requested again: the verified files come from the store',
    ).toEqual([]);
    results['reloadedIdle'] = true;
    results['requestsAfterReload'] = requests.length;
    // and the reloaded engine answers
    await page.locator('#in-prompt').fill('Say hello.');
    await run.click();
    await expect(page.locator('#out-timing')).toContainText('Finish:', { timeout: 120_000 });
    expect(errors, 'console and page errors after the reload').toEqual([]);

    results['states'] = states;
    results['elapsedMs'] = elapsed;
    results['timeToStopMs'] = ms;
    results['timing'] = timing;
    results['partialAnswerChars'] = partial.length;
    results['afterStop'] = after;
  } finally {
    await browser.close();
  }
});
