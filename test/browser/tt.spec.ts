// Trusted Types on models.html (D1-09): with require-trusted-types-for 'script' and the single policy
// airplanemode-worker, a load and an answer on every rung shown produce no Trusted Types or CSP violation
// in the page or in the engine worker, and an injected el.innerHTML = '<b>x</b>' throws TypeError.
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:worker

import { chromium, expect, test } from 'playwright/test';
import { expectOnlyPageOrigin, gatedContext, runHook, PROMPT } from './worker-helpers';

test.skip(
  process.env['RUNTIME_MODEL'] !== '1',
  'set RUNTIME_MODEL=1 to run the Trusted Types proof',
);

const TT = /trusted ?types?|require-trusted-types|TrustedScript/i;

for (const rung of ['webgpu', 'wasm'] as const) {
  test(`${rung}: a load and an answer with Trusted Types required: 0 violations in the page and the worker, innerHTML throws`, async () => {
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const { context, page, gate } = await gatedContext(browser);
      const consoleLines: string[] = [];
      context.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
      await page.goto('http://127.0.0.1:8790/models.html');
      const csp = await page.evaluate(
        () =>
          document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute('content') ?? '',
      );
      expect(csp).toContain("require-trusted-types-for 'script'");
      expect(
        await page.evaluate(
          () => typeof (window as unknown as { trustedTypes?: unknown }).trustedTypes,
        ),
      ).toBe('object');
      const report = await runHook(page, {
        prompt: PROMPT,
        maxTokens: 16,
        host: 'worker',
        ...(rung === 'wasm' ? { forceRung: 'wasm' } : {}),
      });
      expect(report.ok, JSON.stringify(report)).toBe(true);
      if (rung === 'webgpu' && report.rung !== 'webgpu') {
        test.skip(process.env['RUNTIME_REQUIRE_WEBGPU'] !== '1', 'no usable WebGPU adapter here');
        throw new Error('WebGPU was required and is not available');
      }
      expect((report.text ?? '').toLowerCase()).toContain('paris');
      expect(
        report.events!.filter((e) => e.name === 'backend.worker').map((e) => e.attrs['state']),
      ).toEqual(['started', 'ready']);
      const violations = await page.evaluate(
        () => (window as unknown as { __csp: string[] }).__csp,
      );
      expect(violations, 'page CSP and Trusted Types violations').toEqual([]);
      expect(
        consoleLines.filter((l) => TT.test(l)),
        'Trusted Types console errors (page and worker)',
      ).toEqual([]);
      expect(
        consoleLines.filter((l) => /Content Security Policy|Refused to/i.test(l)),
        'CSP console errors',
      ).toEqual([]);
      const thrown = await page.evaluate(() => {
        try {
          const el = document.createElement('div');
          el.innerHTML = '<b>x</b>';
          return 'no throw';
        } catch (e) {
          return (e as Error).name;
        }
      });
      expect(thrown).toBe('TypeError');
      expectOnlyPageOrigin(gate, `tt ${rung}`);
    } finally {
      await browser.close();
    }
  });
}
