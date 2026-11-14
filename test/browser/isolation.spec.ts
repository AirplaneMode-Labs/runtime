// Per-rung engine isolation (D1-04, T1-S2-01 rest): a WebGPU rung that fails after its worker started
// (a correctly signed manifest whose WebGPU descriptor names a malformed ONNX file) is followed by a
// WebAssembly answer in the SAME page, with no reload and no reload sentence, and two
// backend.worker started/terminated pairs.
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:worker

import { chromium, expect, test } from 'playwright/test';
import {
  expectOnlyPageOrigin,
  gatedContext,
  runHook,
  PROMPT,
  type HookEvent,
} from './worker-helpers';

test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the isolation proof');

test('a WebGPU failure after session creation started does not poison WebAssembly in the same page', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { page, gate } = await gatedContext(browser);
    await page.goto('http://127.0.0.1:8790/models.html?models=isolation');
    const report = await runHook(page, { prompt: PROMPT, maxTokens: 16, host: 'worker' });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    const webgpuAttempts = report.attempts!.filter((a) => a.rung === 'webgpu');
    if (webgpuAttempts.every((a) => a.outcome === 'skipped')) {
      test.skip(process.env['RUNTIME_REQUIRE_WEBGPU'] !== '1', 'no usable WebGPU adapter here');
      throw new Error('WebGPU was required and is not available');
    }
    expect(report.rung).toBe('wasm');
    expect(report.attempts!.some((a) => a.rung === 'webgpu' && a.outcome === 'failed')).toBe(true);
    expect((report.text ?? '').toLowerCase()).toContain('paris');
    expect(report.userMessage).toBeUndefined();
    const reloadSentence = 'Reload the page and choose WebAssembly to try again.';
    expect(JSON.stringify(report)).not.toContain(reloadSentence);

    await page.evaluate(() =>
      (window as unknown as { __models: { unload(): Promise<void> } }).__models.unload(),
    );
    const snapshot = JSON.parse(
      await page.evaluate(() =>
        (
          globalThis as unknown as { __airplanemodeDevtools: { snapshot(): string } }
        ).__airplanemodeDevtools.snapshot(),
      ),
    ) as { events: HookEvent[] };
    const w = snapshot.events.filter((e) => e.name === 'backend.worker');
    expect(w.filter((e) => e.attrs['state'] === 'started')).toHaveLength(2);
    expect(w.filter((e) => e.attrs['state'] === 'terminated')).toHaveLength(2);
    expect(
      w.some(
        (e) =>
          e.attrs['state'] === 'terminated' &&
          e.attrs['device'] === 'webgpu' &&
          e.attrs['reason'] === 'load_failed',
      ),
    ).toBe(true);
    expect(w.some((e) => e.attrs['state'] === 'crashed')).toBe(false);
    expectOnlyPageOrigin(gate, 'isolation');
  } finally {
    await browser.close();
  }
});
