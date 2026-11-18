// LOCAL ONLY (RUNTIME_MODEL_QWEN06=1), never CI, Pages or a demo: the two demo models of Sprint 5 through
// the worker host in installed Chrome behind an aborting network gate, on single-threaded WebAssembly.
//
//   node test/tools/fetch-model.mjs qwen3-0.6b-wasm-q8 && node test/tools/fetch-model.mjs multilingual-e5-small-wasm-q8
//   RUNTIME_MODEL_QWEN06=1 RUNTIME_QWEN06_OUT=<file.json> npm run test:model
//
// 1. Qwen3-0.6B q8 answers one prompt (TD-33). It records the load time, the time to the first token, the
//    worker's peak WebAssembly memory (model.memory), the main-thread JS heap and the Chrome process-tree RSS
//    peak (TD-49) and whether graphOptimizationLevel 'all' (the engine default) loads: if it does not, the run
//    is repeated with 'disabled' and says so.
// 2. multilingual-e5-small q8 embeds two texts through the worker host (R14): 384 dimensions, unit norm, two
//    runs bit-identical.
//
// Machine: Apple M5 Pro, 48 GB. NOT MEASURED ON 8 GB. The answer text is recorded verbatim; the figures are
// one run each, not a benchmark.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from 'playwright/test';
import { resultsDir } from './out-dir';
import { startRssSampler } from './rss';

test.skip(
  process.env['RUNTIME_MODEL_QWEN06'] !== '1',
  'set RUNTIME_MODEL_QWEN06=1 to run the demo-model smoke run',
);
test.describe.configure({ mode: 'serial' });

const OUT_FILE =
  process.env['RUNTIME_QWEN06_OUT'] !== undefined && process.env['RUNTIME_QWEN06_OUT'] !== ''
    ? resolve(process.env['RUNTIME_QWEN06_OUT'])
    : resolve(resultsDir('RUNTIME_MODEL_OUT'), 'model-qwen06.json');
const FORBIDDEN_HOSTS =
  /(^|\.)(huggingface\.co|hf\.co|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|github\.com|githubusercontent\.com|googleapis\.com|gstatic\.com)$/i;
const PROMPT = 'What is the capital of France? Answer in one word.';

const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  machine: 'Apple M5 Pro 48 GB (macOS); NOT MEASURED ON 8 GB',
  engine:
    'Transformers.js 4.3.1 + onnxruntime-web 1.31.1, single-threaded WebAssembly, worker host',
};
test.afterAll(() => {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2) + '\n');
});

interface HookEvent {
  name: string;
  attrs: Record<string, string | number | boolean | null>;
  bytes?: number;
  durationMs?: number;
}
interface Report {
  ok: boolean;
  userMessage?: string;
  code?: string | null;
  text?: string;
  finishReason?: string;
  loadMs?: number;
  bytesDownloaded?: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  timings?: {
    prefillMs?: number;
    decodeMs?: number;
    tokensPerSecond?: number;
    firstTokenMs?: number;
  };
  events?: HookEvent[];
  embed?: {
    dims: number;
    count: number;
    normalized: boolean;
    norms: number[];
    identical: boolean;
    truncated: boolean;
    totalMs: number[];
  };
}

async function session(
  which: 'qwen06' | 'e5',
  baseURL: string,
  extra: Record<string, unknown>,
  query = '',
): Promise<{
  report: Report;
  rss: { peakBytes: number; samples: number; processes: number };
  heapPeak: number;
  requests: string[];
  aborted: string[];
}> {
  const origin = new URL(baseURL).origin;
  const profile = mkdtempSync(join(tmpdir(), 'chrome-profile-qwen06-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: true,
      args: ['--enable-precise-memory-info'],
    });
    const requests: string[] = [];
    const aborted: string[] = [];
    await context.route('**/*', async (route) => {
      const u = route.request().url();
      let ok = false;
      try {
        ok = new URL(u).origin === origin || u.startsWith('blob:') || u.startsWith('data:');
      } catch {
        ok = false;
      }
      if (ok) return route.continue();
      aborted.push(u);
      return route.abort('blockedbyclient');
    });
    context.on('request', (r) => requests.push(r.url()));
    const page: Page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseURL}/models.html?models=${which}${query}`);
    await page.waitForFunction(
      () => 'run' in ((window as unknown as { __models?: object }).__models ?? {}),
    );
    const rss = startRssSampler(profile);
    let heapPeak = 0;
    const heapTimer = setInterval(async () => {
      try {
        const v = await page.evaluate(
          () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0,
        );
        if (v > heapPeak) heapPeak = v;
      } catch {
        // navigating
      }
    }, 500);
    const report = (await page.evaluate(
      (o) =>
        (window as unknown as { __models: { run: (x: unknown) => Promise<unknown> } }).__models.run(
          o,
        ),
      { forceRung: 'wasm', host: 'worker', ...extra },
    )) as Report;
    clearInterval(heapTimer);
    return { report, rss: await rss.stop(), heapPeak, requests, aborted };
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const peaks = (r: Report) =>
  (r.events ?? [])
    .filter((e) => e.name === 'model.memory')
    .map((e) => ({ phase: e.attrs['phase'], measure: e.attrs['measure'], bytes: e.bytes ?? null }));

test('Qwen3-0.6B q8 answers one prompt on single-threaded WebAssembly (graphOptimizationLevel all, else disabled)', async ({
  baseURL,
}) => {
  test.setTimeout(20 * 60_000);
  let level: 'all' | 'disabled' = 'all';
  let run = await session('qwen06', baseURL!, { prompt: PROMPT, maxTokens: 24, temperature: 0 });
  results['graphOptimizationLevelAllLoads'] = run.report.ok;
  if (!run.report.ok) {
    results['allFailure'] = { code: run.report.code, message: run.report.userMessage };
    level = 'disabled';
    run = await session(
      'qwen06',
      baseURL!,
      { prompt: PROMPT, maxTokens: 24, temperature: 0 },
      '&opt=disabled',
    );
  }
  const r = run.report;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect((r.text ?? '').trim().length).toBeGreaterThan(0);
  expect(run.aborted, 'no request left the origin').toEqual([]);
  for (const u of run.requests) {
    if (u.startsWith('blob:') || u.startsWith('data:')) continue;
    expect(FORBIDDEN_HOSTS.test(new URL(u).hostname), u).toBe(false);
  }
  const first = (r.events ?? []).find(
    (e) => e.name === 'model.load.phase' && e.attrs['phase'] === 'first_token',
  );
  results['qwen3-0.6b'] = {
    graphOptimizationLevelUsed: level,
    prompt: PROMPT,
    answer: r.text,
    finishReason: r.finishReason,
    usage: r.usage,
    loadMs: Math.round(r.loadMs ?? 0),
    bytesDownloaded: r.bytesDownloaded,
    firstTokenMs: Math.round(r.timings?.firstTokenMs ?? first?.durationMs ?? 0),
    tokensPerSecond: r.timings?.tokensPerSecond,
    workerWasmMemoryPeak: peaks(r),
    jsHeapPeakBytes: run.heapPeak,
    chromeProcessTreeRssPeakBytes: run.rss.peakBytes,
    rssSamples: run.rss.samples,
    chromeProcesses: run.rss.processes,
    requestsOutsideOrigin: run.aborted.length,
  };
});

test('multilingual-e5-small q8 embeds through the worker host: 384 dims, unit norm, two runs bit-identical (R14)', async ({
  baseURL,
}) => {
  test.setTimeout(10 * 60_000);
  const run = await session('e5', baseURL!, {
    embed: ['query: What is the grace period?', 'passage: The grace period is 45 days.'],
  });
  const r = run.report;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.embed).toBeDefined();
  expect(r.embed!.dims).toBe(384);
  expect(r.embed!.count).toBe(2);
  expect(r.embed!.normalized).toBe(true);
  for (const n of r.embed!.norms) expect(Math.abs(n - 1)).toBeLessThan(1e-3);
  expect(r.embed!.identical, 'two runs on the same input are bit-identical').toBe(true);
  expect(run.aborted).toEqual([]);
  results['multilingual-e5-small'] = {
    dims: r.embed!.dims,
    norms: r.embed!.norms,
    bitIdenticalTwoRuns: r.embed!.identical,
    embedMs: r.embed!.totalMs,
    loadMs: Math.round(r.loadMs ?? 0),
    workerWasmMemoryPeak: peaks(r),
    chromeProcessTreeRssPeakBytes: run.rss.peakBytes,
    requestsOutsideOrigin: run.aborted.length,
  };
});
