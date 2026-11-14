// Guard ordering in the Vite production build of the demo (D1-04, R3w): the worker chunk installs the
// egress guard before it can load any engine module, in the file and at run time, and the replaced
// globals cannot be reassigned or redefined.
//
//   RUNTIME_MODEL=1 npm run test:worker

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, test } from 'playwright/test';

test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the guard-order proof');

const dist = resolve('demo/dist');
const workerFiles = () =>
  readdirSync(resolve(dist, 'app')).filter((f) => /^engine-host-.*\.js$/.test(f));

test('the built worker installs the egress guard before the engine host and before any dynamic import', () => {
  const files = workerFiles();
  expect(files, 'one built worker entry').toHaveLength(1);
  const code = readFileSync(resolve(dist, 'app', files[0]!), 'utf8');
  const sentinel = code.indexOf('airplanemode.egressGuard.v1');
  expect(sentinel).toBeGreaterThanOrEqual(0);
  // the install call: Object.defineProperty on the scope with the sentinel symbol, then the host's onmessage
  const dynamicImports = [...code.matchAll(/\bimport\(/g)].map((m) => m.index!);
  const onmessage = code.search(/\.onmessage\s*=/);
  expect(onmessage).toBeGreaterThan(sentinel);
  // the guard's lock() of the sentinel happens in a function that the module-level call runs first
  const installCall = code.search(
    /\)\s*;?\s*\n?\s*(?:const|let|var)\s+\w+\s*=\s*new \w+\(\{\s*post:/,
  );
  expect(installCall === -1 || installCall > sentinel).toBe(true);
  for (const at of dynamicImports)
    expect(at, 'a dynamic import before the guard').toBeGreaterThan(sentinel);
  // no static import of an engine package or chunk at the top of the entry
  const staticImports = [...code.matchAll(/^import\s[^;]*from\s*["']([^"']+)["']/gm)].map(
    (m) => m[1]!,
  );
  for (const s of staticImports)
    expect(s, 'static import of an engine module').not.toMatch(/transformers|onnxruntime|web-llm/i);
});

test('the built worker, started as a module worker, has the guard installed and its globals locked', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // index.html has no Trusted Types requirement, so the built worker can be started directly from its
    // same-origin URL (models.html forbids that on purpose: only the library's policy may start workers)
    await page.goto('http://127.0.0.1:8790/index.html');
    const file = workerFiles()[0]!;
    const result = await page.evaluate(async (src) => {
      const w = new Worker(src, { type: 'module' });
      const answer = await new Promise<string>((resolve) => {
        w.onmessage = (e) => resolve(JSON.stringify(e.data));
        w.postMessage({ v: 1, type: 'nonsense' });
        setTimeout(() => resolve('silent'), 1500);
      });
      w.terminate();
      return answer;
    }, `./app/${file}`);
    expect(result).toBe('silent'); // an unknown message is ignored, nothing is posted
    // the same worker script again, asked about itself through Playwright's worker handle
    const [worker] = await Promise.all([
      page.waitForEvent('worker'),
      page.evaluate(
        (src) =>
          void ((window as unknown as { __w?: Worker }).__w = new Worker(src, { type: 'module' })),
        `./app/${file}`,
      ),
    ]);
    const probe = await worker.evaluate(() => {
      // fetch is owned by a prototype in a Chrome worker: walk the chain to its owner
      let owner: object | null = self;
      let d: PropertyDescriptor | undefined;
      while (owner && !(d = Object.getOwnPropertyDescriptor(owner, 'fetch')))
        owner = Object.getPrototypeOf(owner);
      const sentinel = (self as unknown as Record<symbol, unknown>)[
        Symbol.for('airplanemode.egressGuard.v1')
      ];
      let reassigned = 'no throw';
      try {
        ('use strict');
        (owner as unknown as Record<string, unknown>)['fetch'] = () => 'x';
      } catch (e) {
        reassigned = (e as Error).name;
      }
      let redefined = 'no throw';
      try {
        Object.defineProperty(owner!, 'fetch', { value: () => 'x' });
      } catch (e) {
        redefined = (e as Error).name;
      }
      return {
        sentinel,
        writable: d?.writable,
        configurable: d?.configurable,
        reassigned,
        redefined,
      };
    });
    expect(probe.sentinel).toBe(true);
    expect(probe.writable).toBe(false);
    expect(probe.configurable).toBe(false);
    expect(probe.redefined).toBe('TypeError');
    await page.evaluate(() => (window as unknown as { __w?: Worker }).__w?.terminate());
  } finally {
    await browser.close();
  }
});
