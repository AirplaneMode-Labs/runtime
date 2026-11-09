// Browser proof of the backend adapters (runtime sprint 2 done-when): the same prompt answered with
// the test model SmolLM2-135M-Instruct (q4) on the WebGPU path and on a forced WebAssembly path, in
// installed Chrome, behind an aborting network gate.
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:model
//   RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model     (the CI leg)
//
// Gate (every leg, every test): page.route('**/*') ABORTS every request whose origin is not the page
// origin and records it; context.on('request') records every request the context makes, and a
// securitypolicyviolation listener records CSP violations. The test fails on any aborted request or
// violation, on any worker target (the engine runs on one thread with proxy off) and on any request
// to a Hugging Face, CDN, GitHub or Google font/API host.
//
// Fix round 1 (T1-S2-01, T1-S2-02), same gate: a WebGPU device that cannot be created is skipped as
// unavailable and the default chain answers on wasm; a WebGPU failure after session creation started
// refuses with the reload sentence (the engine module cannot create another session) and a fresh page
// with forceRung 'wasm' answers; an abort from onToken on the wasm rung ends generation within a few
// tokens and a second generate works.
//
// Leg A: the default chain selects the webgpu rung (executionProviders include webgpu).
//        RUNTIME_REQUIRE_WEBGPU=1 makes a missing adapter a failure instead of a skip.
// Leg B: forceRung 'wasm' selects the wasm rung (executionProviders ['wasm']).
// Prompt: 'What is the capital of France? Answer in one word.', maxTokens 16, temperature 0.
// Each leg runs in a fresh browser context (own OPFS), so each downloads and verifies all seven
// manifest entries. Results go to model-run.json (RUNTIME_MODEL_OUT, default test-results/).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright/test';

const PROMPT = 'What is the capital of France? Answer in one word.';
const REQUIRE_WEBGPU = process.env['RUNTIME_REQUIRE_WEBGPU'] === '1';
const LEGS = (process.env['RUNTIME_MODEL_LEGS'] ?? 'webgpu,wasm').split(',');
const OUT_DIR = resolve(process.env['RUNTIME_MODEL_OUT'] ?? '../../test-results');
const FORBIDDEN_HOSTS =
  /(^|\.)(huggingface\.co|hf\.co|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|github\.com|githubusercontent\.com|googleapis\.com|gstatic\.com)$/i;

test.skip(process.env['RUNTIME_MODEL'] !== '1', 'set RUNTIME_MODEL=1 to run the model proof');
test.describe.configure({ mode: 'serial' });

interface HookReport {
  ok: boolean;
  rung?: string;
  adapter?: string;
  model?: string | null;
  executionProviders?: string[];
  dtype?: string;
  attempts?: {
    rung: string;
    adapter: string;
    model: string | null;
    outcome: string;
    reason: string;
  }[];
  loadMs?: number;
  bytesDownloaded?: number;
  text?: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  timings?: { prefillMs?: number; decodeMs?: number; tokensPerSecond?: number };
  verifyOk?: string[];
  egressRefused?: number;
  probe?: string | null;
  beforeDownload?: { rung: string; model: string; bytes: number }[];
  events?: {
    name: string;
    kind: string;
    level: string;
    attrs: Record<string, unknown>;
    bytes?: number;
  }[];
  userMessage?: string;
  errorName?: string;
  code?: string | null;
  abortCheck?: {
    first: {
      text: string;
      finishReason: string;
      usage: { completionTokens?: number };
      tokensSeen: number;
    };
    second: { text: string; finishReason: string; usage: { completionTokens?: number } };
  };
}

interface Gate {
  aborted: string[];
  requests: { url: string; method: string; resourceType: string }[];
  violations: string[];
  workers: number;
}

const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  prompt: PROMPT,
  maxTokens: 16,
  temperature: 0,
  model:
    'HuggingFaceTB/SmolLM2-135M-Instruct@12fd25f77366fa6b3b4b768ec3050bf629380bac onnx/model_q4.onnx',
};

async function gated(
  browser: Browser,
  base: string,
  opts: {
    removeGpu?: boolean;
    /** every GPUAdapter.requestDevice() rejects (a device that cannot be created) */
    rejectAllDevices?: boolean;
    /**
     * only a requestDevice() called with a descriptor rejects. The adapter's own probe calls it with
     * no argument and passes; ONNX Runtime Web always passes a descriptor, so its session creation
     * fails: a failure after session creation started.
     */
    rejectOrtDevice?: boolean;
  } = {},
): Promise<{ context: BrowserContext; page: Page; gate: Gate; cdp: CDPSession }> {
  const context = await browser.newContext();
  const origin = new URL(base).origin;
  const gate: Gate = { aborted: [], requests: [], violations: [], workers: 0 };
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    let ok = false;
    try {
      ok = new URL(url).origin === origin;
    } catch {
      ok = false;
    }
    if (ok) return route.continue();
    gate.aborted.push(url);
    return route.abort('blockedbyclient');
  });
  context.on('request', (r) =>
    gate.requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType() }),
  );
  const page = await context.newPage();
  page.on('worker', () => gate.workers++);
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  if (opts.removeGpu) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        get: () => undefined,
        configurable: true,
      });
    });
  }
  if (opts.rejectAllDevices || opts.rejectOrtDevice) {
    await page.addInitScript((onlyWithDescriptor: boolean) => {
      const proto = (
        globalThis as unknown as {
          GPUAdapter?: { prototype: { requestDevice: (...a: unknown[]) => Promise<unknown> } };
        }
      ).GPUAdapter?.prototype;
      if (!proto) return;
      const original = proto.requestDevice;
      proto.requestDevice = function (this: unknown, ...args: unknown[]) {
        if (onlyWithDescriptor && args[0] === undefined) return original.apply(this, args);
        return Promise.reject(new Error('injected device failure'));
      };
    }, opts.rejectOrtDevice === true);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { context, page, gate, cdp };
}

async function sampleHeap(cdp: CDPSession): Promise<{ stop: () => number }> {
  let peak = 0;
  const read = async () => {
    try {
      const { metrics } = (await cdp.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      const v = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
      if (v > peak) peak = v;
    } catch {
      // the page may be navigating
    }
  };
  const timer = setInterval(() => void read(), 100);
  await read();
  return {
    stop: () => {
      clearInterval(timer);
      return peak;
    },
  };
}

async function runHook(page: Page, options: Record<string, unknown>): Promise<HookReport> {
  await page.waitForFunction(
    () => 'run' in ((window as unknown as { __models?: object }).__models ?? {}),
  );
  return (await page.evaluate(
    (o) =>
      (window as unknown as { __models: { run: (x: unknown) => Promise<unknown> } }).__models.run(
        o,
      ),
    options,
  )) as HookReport;
}

async function expectedEntries(
  base: string,
): Promise<{ ids: string[]; urls: string[]; total: number }> {
  const manifestUrl = `${base}/models/test-models/manifest.json`;
  const m = (await (await fetch(manifestUrl)).json()) as {
    entries: { id: string; url: string; size: number }[];
  };
  return {
    ids: m.entries.map((e) => e.id).sort(),
    urls: m.entries.map((e) => new URL(e.url, manifestUrl).href),
    total: m.entries.reduce((n, e) => n + e.size, 0),
  };
}

async function assertGate(
  gate: Gate,
  page: Page,
  base: string,
  expected: { urls: string[] },
  label: string,
): Promise<{ modelRequests: string[]; ortFiles: string[] }> {
  const origin = new URL(base).origin;
  expect(gate.aborted, `${label}: aborted non-origin requests`).toEqual([]);
  const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect(csp, `${label}: CSP violations`).toEqual([]);
  expect(gate.workers, `${label}: worker targets`).toBe(0);
  const targets = (await page.context().browser()?.contexts()) ?? [];
  expect(targets.length).toBeGreaterThan(0);
  for (const r of gate.requests) {
    const u = new URL(r.url);
    expect(u.origin, `${label}: ${r.url}`).toBe(origin);
    expect(FORBIDDEN_HOSTS.test(u.hostname), `${label}: ${r.url}`).toBe(false);
  }
  const modelRequests = gate.requests.filter((r) => new URL(r.url).pathname.startsWith('/models/'));
  const allowed = new Set([`${origin}/models/test-models/manifest.json`, ...expected.urls]);
  for (const r of modelRequests) {
    expect(r.method, `${label}: ${r.url}`).toBe('GET');
    expect(allowed.has(r.url), `${label}: unexpected /models request ${r.url}`).toBe(true);
  }
  const ortFiles = [
    ...new Set(
      gate.requests
        .map((r) => new URL(r.url).pathname.split('/').pop() ?? '')
        .filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f)),
    ),
  ].sort();
  return { modelRequests: modelRequests.map((r) => r.url), ortFiles };
}

test.beforeAll(async ({ baseURL }) => {
  // the page under test must exist and the manifest must have been signed by the web server command
  const res = await fetch(`${baseURL}/models/test-models/manifest.json`);
  expect(res.status, 'run node test/tools/fetch-model.mjs smollm2-135m-instruct first').toBe(200);
});

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'model-run.json'), JSON.stringify(results, null, 2) + '\n');
});

async function leg(browser: Browser, base: string, name: 'webgpu' | 'wasm'): Promise<void> {
  const expected = await expectedEntries(base);
  const { context, page, gate, cdp } = await gated(browser, base);
  try {
    await page.goto(`${base}/models.html?models=test`);
    const profile = (await page.evaluate(() =>
      (
        window as unknown as {
          __models: { profile: () => Promise<{ gpu: string; backendTier: string }> };
        }
      ).__models.profile(),
    )) as { gpu: string; backendTier: string };
    if (name === 'webgpu' && profile.gpu !== 'webgpu') {
      if (REQUIRE_WEBGPU)
        throw new Error('RUNTIME_REQUIRE_WEBGPU=1 but this Chrome has no WebGPU adapter');
      results['webgpu'] = { skipped: 'no WebGPU adapter in this browser', profile };
      test.skip(true, 'no WebGPU adapter in this browser');
    }
    const heap = await sampleHeap(cdp);
    const report = await runHook(page, {
      prompt: PROMPT,
      maxTokens: 16,
      temperature: 0,
      ...(name === 'wasm' ? { forceRung: 'wasm' } : {}),
    });
    const peakHeap = heap.stop();
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.rung).toBe(name);
    expect(report.adapter).toBe('transformers-js');
    if (name === 'webgpu') expect(report.executionProviders).toContain('webgpu');
    else expect(report.executionProviders).toEqual(['wasm']);
    expect((report.text ?? '').trim().length, 'the model answered with text').toBeGreaterThan(0);
    // asset.verify.ok for every manifest entry, and every byte downloaded
    expect([...(report.verifyOk ?? [])].sort()).toEqual(expected.ids);
    expect(report.bytesDownloaded).toBe(expected.total);
    expect(report.egressRefused, 'backend.egress.refused events').toBe(0);
    const models = report.events?.filter((e) => e.name === 'model.load') ?? [];
    expect(models).toHaveLength(1);
    expect(models[0]!.attrs).toMatchObject({
      adapter: 'transformers-js',
      device: name,
      dtype: 'q4',
      verified: true,
    });
    const seen = await assertGate(gate, page, base, expected, name);
    // the consent was asked once, with the whole download
    expect(report.beforeDownload?.map((b) => b.rung)).toEqual(
      name === 'wasm' ? ['wasm'] : ['webgpu'],
    );

    const soft = /paris/i.test(report.text ?? '');
    results[name] = {
      rung: report.rung,
      executionProviders: report.executionProviders,
      dtype: report.dtype,
      attempts: report.attempts,
      loadMs: Math.round(report.loadMs ?? 0),
      prefillMs: Math.round(report.timings?.prefillMs ?? 0),
      decodeMs: Math.round(report.timings?.decodeMs ?? 0),
      tokensPerSecond: report.timings?.tokensPerSecond,
      usage: report.usage,
      finishReason: report.finishReason,
      bytesDownloaded: report.bytesDownloaded,
      peakJsHeapUsedSizeBytes: peakHeap,
      outputText: report.text,
      parisSoftCheck: { containsParis: soft, gating: false },
      ortFilesRequested: seen.ortFiles,
      verifyOk: report.verifyOk,
      requests: gate.requests.map((r) => `${r.method} ${r.url}`),
      abortedRequests: gate.aborted,
      cspViolations: [],
      workerTargets: gate.workers,
      profile,
    };
  } finally {
    await context.close();
  }
}

test('leg A: the default chain answers the prompt on the WebGPU path', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('webgpu'), 'RUNTIME_MODEL_LEGS excludes webgpu');
  await leg(browser, baseURL!, 'webgpu');
});

test('leg B: forceRung wasm answers the same prompt on the WebAssembly path', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'RUNTIME_MODEL_LEGS excludes wasm');
  await leg(browser, baseURL!, 'wasm');
});

test('the wasm leg uses the ORT binary the descriptor pins (ort-pins.ts) and no other engine file', async () => {
  test.skip(!LEGS.includes('wasm'), 'RUNTIME_MODEL_LEGS excludes wasm');
  const wasm = results['wasm'] as { ortFilesRequested: string[] } | undefined;
  expect(wasm, 'leg B must have run').toBeDefined();
  const pins = await import('../../src/backends/ort-pins');
  expect(wasm!.ortFilesRequested).toEqual([pins.ORT_FACTORY_FILE, pins.ORT_WASM_FILE].sort());
  const gpu = results['webgpu'] as { ortFilesRequested?: string[] } | undefined;
  if (gpu?.ortFilesRequested)
    expect(gpu.ortFilesRequested, 'WebGPU and WASM load the same ORT variant').toEqual(
      wasm!.ortFilesRequested,
    );
});

test('an injected probe to https://huggingface.co/x is refused with egress_refused and one origin-only event, and reaches no network', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'the probe rides the wasm leg');
  const base = baseURL!;
  const expected = await expectedEntries(base);
  const { context, page, gate } = await gated(browser, base);
  try {
    await page.goto(`${base}/models.html?models=test`);
    const report = await runHook(page, {
      prompt: PROMPT,
      forceRung: 'wasm',
      probeUrl: 'https://huggingface.co/x',
    });
    expect(report.ok).toBe(true);
    expect(report.probe).toBe('egress_refused');
    expect(report.egressRefused).toBe(1);
    const refused = report.events?.filter((e) => e.name === 'backend.egress.refused') ?? [];
    expect(refused).toHaveLength(1);
    expect(refused[0]!.attrs).toEqual({
      adapter: 'transformers-js',
      origin: 'https://huggingface.co',
    });
    // refused inside the shim: the gate never saw it
    expect(gate.aborted).toEqual([]);
    await assertGate(gate, page, base, expected, 'probe');
    results['egressProbe'] = { probe: report.probe, events: refused.map((e) => e.attrs) };
  } finally {
    await context.close();
  }
});

test('with navigator.gpu undefined the chain selects the wasm rung and still answers', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'needs the wasm leg');
  const base = baseURL!;
  const expected = await expectedEntries(base);
  const { context, page, gate } = await gated(browser, base, { removeGpu: true });
  try {
    await page.goto(`${base}/models.html?models=test`);
    expect(await page.evaluate(() => typeof (navigator as unknown as { gpu?: unknown }).gpu)).toBe(
      'undefined',
    );
    const report = await runHook(page, { prompt: PROMPT, maxTokens: 16, temperature: 0 });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.rung).toBe('wasm');
    expect(report.attempts?.[0]).toMatchObject({
      rung: 'webgpu',
      outcome: 'skipped',
      reason: 'no_webgpu',
    });
    expect((report.text ?? '').length).toBeGreaterThan(0);
    await assertGate(gate, page, base, expected, 'no-gpu');
    results['noGpu'] = { rung: report.rung, attempts: report.attempts, outputText: report.text };
  } finally {
    await context.close();
  }
});

test('with WebGPU and WebAssembly both disabled (Chrome --js-flags=--jitless hides WebAssembly) the refusal is plain language naming all three rungs', async ({
  baseURL,
}) => {
  const base = baseURL!;
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--js-flags=--jitless'],
  });
  try {
    const { context, page, gate } = await gated(browser, base, { removeGpu: true });
    try {
      await page.goto(`${base}/models.html?models=test`);
      expect(await page.evaluate(() => typeof WebAssembly)).toBe('undefined');
      const report = await runHook(page, { prompt: PROMPT, maxTokens: 16, temperature: 0 });
      expect(report.ok).toBe(false);
      const message = report.userMessage ?? '';
      for (const name of ['WebGPU', 'WebAssembly', 'Chrome built-in model'])
        expect(message).toContain(name);
      expect(message).toContain('Chrome built-in model: not enabled');
      expect(message).not.toMatch(/Error:|\n\s+at /);
      // the plan on the page says the same, as text
      await expect(page.locator('#plan-list li')).toHaveCount(3);
      expect(gate.aborted).toEqual([]);
      const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(csp).toEqual([]);
      results['bothDisabled'] = { userMessage: message, attempts: report.attempts };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

const RELOAD = 'Reload the page and choose WebAssembly to try again.';

test('T1-S2-01: a WebGPU device that cannot be created is skipped as unavailable before any session exists, and the default chain answers on wasm', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'needs the wasm leg');
  const base = baseURL!;
  const expected = await expectedEntries(base);
  const { context, page, gate } = await gated(browser, base, { rejectAllDevices: true });
  try {
    await page.goto(`${base}/models.html?models=test`);
    const profile = (await page.evaluate(() =>
      (
        window as unknown as { __models: { profile: () => Promise<{ gpu: string }> } }
      ).__models.profile(),
    )) as { gpu: string };
    test.skip(profile.gpu !== 'webgpu', 'no WebGPU adapter in this browser: the injection is moot');
    const report = await runHook(page, { prompt: PROMPT, maxTokens: 16, temperature: 0 });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.rung).toBe('wasm');
    expect(report.attempts?.[0]).toMatchObject({
      rung: 'webgpu',
      outcome: 'skipped',
      reason: 'unavailable',
    });
    expect((report.text ?? '').trim().length).toBeGreaterThan(0);
    // no session was ever created on the GPU: no failed load is recorded
    expect(report.events?.filter((e) => e.name === 'model.load.failed')).toHaveLength(0);
    await assertGate(gate, page, base, expected, 'device-unavailable');
    results['deviceUnavailable'] = {
      rung: report.rung,
      attempts: report.attempts,
      outputText: report.text,
    };
  } finally {
    await context.close();
  }
});

test('T1-S2-01: a WebGPU failure after session creation started refuses with the reload sentence in that page, and a fresh page with forceRung wasm answers', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'needs the wasm leg');
  const base = baseURL!;
  const expected = await expectedEntries(base);
  const { context, page, gate } = await gated(browser, base, { rejectOrtDevice: true });
  try {
    await page.goto(`${base}/models.html?models=test`);
    const profile = (await page.evaluate(() =>
      (
        window as unknown as { __models: { profile: () => Promise<{ gpu: string }> } }
      ).__models.profile(),
    )) as { gpu: string };
    test.skip(profile.gpu !== 'webgpu', 'no WebGPU adapter in this browser: the injection is moot');

    // 1. the default chain: WebGPU fails inside the engine, WebAssembly cannot start in this page
    const first = await runHook(page, { prompt: PROMPT, maxTokens: 16, temperature: 0 });
    expect(first.ok, JSON.stringify(first)).toBe(false);
    const message = first.userMessage ?? '';
    for (const name of ['WebGPU', 'WebAssembly']) expect(message).toContain(name);
    expect(message).toContain(RELOAD);
    expect(message).not.toMatch(/Error:|\n\s+at |bad_alloc|injected/);
    expect(first.attempts?.map((a) => `${a.rung}:${a.outcome}:${a.reason}`)).toEqual([
      'webgpu:failed:load_failed',
      'wasm:failed:load_failed',
      'builtin:skipped:not_allowed',
    ]);

    // 2. the demo's retry with Force WASM in the same page must not fail silently: same sentence
    const retry = await runHook(page, {
      prompt: PROMPT,
      maxTokens: 16,
      temperature: 0,
      forceRung: 'wasm',
    });
    expect(retry.ok).toBe(false);
    expect(retry.userMessage ?? '').toContain(RELOAD);

    // 3. a fresh page (the reload the sentence asks for) with forceRung wasm answers
    const fresh = await context.newPage();
    await fresh.goto(`${base}/models.html?models=test`);
    const answer = await runHook(fresh, {
      prompt: PROMPT,
      maxTokens: 16,
      temperature: 0,
      forceRung: 'wasm',
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(answer.rung).toBe('wasm');
    expect((answer.text ?? '').trim().length).toBeGreaterThan(0);

    await assertGate(gate, page, base, expected, 'poisoned-engine');
    results['poisonedEngine'] = {
      firstUserMessage: message,
      firstAttempts: first.attempts,
      retryUserMessage: retry.userMessage,
      freshPage: { rung: answer.rung, outputText: answer.text },
    };
  } finally {
    await context.close();
  }
});

test('T1-S2-02: abort from onToken on the wasm rung ends generation within a few tokens, and a second generate works', async ({
  browser,
  baseURL,
}) => {
  test.skip(!LEGS.includes('wasm'), 'needs the wasm leg');
  const base = baseURL!;
  const expected = await expectedEntries(base);
  const { context, page, gate } = await gated(browser, base);
  try {
    await page.goto(`${base}/models.html?models=test`);
    const report = await runHook(page, {
      prompt: 'Count from one to one hundred, in words, separated by commas.',
      maxTokens: 64,
      temperature: 0,
      forceRung: 'wasm',
      abortAfterTokens: 3,
    });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.rung).toBe('wasm');
    const check = report.abortCheck!;
    expect(check.first.finishReason).toBe('abort');
    expect(check.first.tokensSeen).toBeGreaterThanOrEqual(3);
    // the listener fires once per decoded text piece, a few tokens each; far below maxTokens 64
    expect(check.first.usage.completionTokens ?? 0).toBeLessThanOrEqual(12);
    expect(check.second.finishReason).not.toBe('abort');
    expect(check.second.text.trim().length).toBeGreaterThan(0);
    await assertGate(gate, page, base, expected, 'abort-on-token');
    results['abortOnToken'] = check;
  } finally {
    await context.close();
  }
});
