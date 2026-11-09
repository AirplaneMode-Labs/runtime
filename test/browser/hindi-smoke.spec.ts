// Browser proof of the PLANNED production model: Qwen3-1.7B (q4f16) loaded through the Transformers.js
// adapter on WebGPU in installed Chrome, answering five synthetic Hindi prompts. LOCAL ONLY: never in
// CI, never in the Pages build, never in a demo (RUNTIME_HINDI_SMOKE=1 is required, and the weights are
// the 1.43 GB file in the gitignored .cache/).
//
//   node test/tools/fetch-model.mjs qwen3-1.7b-webgpu-q4f16        # once; every file is sha256-pinned
//   RUNTIME_HINDI_SMOKE=1 RUNTIME_MODEL_OUT=<dir> npm run test:hindi-smoke
//
// The run records the load time, the peak JSHeapUsedSize, the tokens per second and the VERBATIM outputs
// to hindi-smoke.json. The outputs are unscored: this run proves the model loads and answers in a
// browser on this machine, not that its Hindi is good. The five prompts are invented (one is a made-up
// loan-statement sentence to summarise); there are no real names, accounts or documents. The default
// chain must select the webgpu rung (forceRung is not used) behind the same aborting network gate as
// model.spec.ts, and the descriptor sets enable_thinking false for the chat template.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';

test.skip(
  process.env['RUNTIME_HINDI_SMOKE'] !== '1',
  'set RUNTIME_HINDI_SMOKE=1 to run the Hindi smoke run',
);

const OUT_DIR = resolve(process.env['RUNTIME_MODEL_OUT'] ?? '../../test-results');
const FORBIDDEN_HOSTS =
  /(^|\.)(huggingface\.co|hf\.co|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|github\.com|githubusercontent\.com|googleapis\.com|gstatic\.com)$/i;

/** Invented prompts, in Hindi. #4 is BFSI-style: a made-up loan-statement sentence to summarise. */
const PROMPTS: { id: string; kind: string; text: string }[] = [
  { id: 'p1', kind: 'general knowledge', text: 'भारत की राजधानी क्या है? एक वाक्य में उत्तर दें।' },
  { id: 'p2', kind: 'arithmetic', text: '५ और ७ का योग कितना होता है? उत्तर हिंदी में लिखें।' },
  {
    id: 'p3',
    kind: 'advice',
    text: 'छोटे दुकानदार को बैंक से कर्ज़ लेने से पहले किन तीन बातों पर ध्यान देना चाहिए? संक्षेप में बताइए।',
  },
  {
    id: 'p4',
    kind: 'BFSI-style summary (invented statement)',
    text: "इस वाक्य का एक पंक्ति में सार लिखिए: 'ऋण खाता संख्या XXXX-0042 पर मूल राशि ₹४,००,००० है, ब्याज दर ८.५% वार्षिक है, मासिक किस्त ₹८,२०० है और अगली किस्त की तिथि १५ दिसंबर २०२६ है।'",
  },
  {
    id: 'p5',
    kind: 'translation into Hindi',
    text: "इस वाक्य का हिंदी में अनुवाद कीजिए: 'Please keep your documents ready before visiting the branch.'",
  },
];

test('Qwen3-1.7B q4f16 loads on WebGPU through the default chain and answers five synthetic Hindi prompts (unscored)', async ({
  browser,
  baseURL,
}) => {
  const base = baseURL!;
  const origin = new URL(base).origin;
  const manifestUrl = `${base}/models/hindi-smoke/manifest.json`;
  const manifest = (await (await fetch(manifestUrl)).json()) as {
    entries: { id: string; url: string; size: number }[];
  };
  const expectedIds = manifest.entries.map((e) => e.id).sort();
  const expectedBytes = manifest.entries.reduce((n, e) => n + e.size, 0);
  const allowed = new Set([
    manifestUrl,
    ...manifest.entries.map((e) => new URL(e.url, manifestUrl).href),
  ]);

  const context = await browser.newContext();
  const aborted: string[] = [];
  const requests: { url: string; method: string }[] = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    aborted.push(url);
    return route.abort('blockedbyclient');
  });
  context.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  const page = await context.newPage();
  let workers = 0;
  page.on('worker', () => workers++);
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  let peakHeap = 0;
  const sample = async () => {
    try {
      const { metrics } = (await cdp.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      peakHeap = Math.max(peakHeap, metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0);
    } catch {
      // navigating
    }
  };
  const timer = setInterval(() => void sample(), 100);
  try {
    await page.goto(`${base}/models.html?models=hindi`);
    await page.waitForFunction(
      () => 'run' in ((window as unknown as { __models?: object }).__models ?? {}),
    );
    const profile = (await page.evaluate(() =>
      (window as unknown as { __models: { profile: () => Promise<unknown> } }).__models.profile(),
    )) as { gpu: string; backendTier: string; ramGb: number };
    expect(profile.gpu, 'this run needs a WebGPU adapter').toBe('webgpu');
    const report = (await page.evaluate(
      (prompts) =>
        (window as unknown as { __models: { run: (o: unknown) => Promise<unknown> } }).__models.run(
          {
            prompt: prompts[0],
            prompts,
            maxTokens: 128,
            temperature: 0,
          },
        ),
      PROMPTS.map((p) => p.text),
    )) as {
      ok: boolean;
      rung?: string;
      executionProviders?: string[];
      dtype?: string;
      loadMs?: number;
      bytesDownloaded?: number;
      attempts?: unknown[];
      verifyOk?: string[];
      egressRefused?: number;
      userMessage?: string;
      generations?: {
        text: string;
        finishReason: string;
        usage: { promptTokens?: number; completionTokens?: number };
        timings: { prefillMs?: number; decodeMs?: number; tokensPerSecond?: number };
      }[];
    };
    clearInterval(timer);
    await sample();
    expect(report.ok, JSON.stringify(report)).toBe(true);
    // the default chain, not forceRung, selected WebGPU
    expect(report.rung).toBe('webgpu');
    expect(report.executionProviders).toContain('webgpu');
    expect(report.dtype).toBe('q4f16');
    expect(aborted, 'aborted non-origin requests').toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(workers).toBe(0);
    for (const r of requests) {
      expect(new URL(r.url).origin, r.url).toBe(origin);
      expect(FORBIDDEN_HOSTS.test(new URL(r.url).hostname), r.url).toBe(false);
      if (new URL(r.url).pathname.startsWith('/models/')) {
        expect(r.method).toBe('GET');
        expect(allowed.has(r.url), `unexpected /models request ${r.url}`).toBe(true);
      }
    }
    expect([...(report.verifyOk ?? [])].sort()).toEqual(expectedIds);
    expect(report.bytesDownloaded).toBe(expectedBytes);
    expect(report.egressRefused).toBe(0);
    expect(report.generations).toHaveLength(PROMPTS.length);
    for (const g of report.generations!) expect(g.text.trim().length).toBeGreaterThan(0);

    const tps = report.generations!.map((g) => g.timings.tokensPerSecond ?? 0);
    const evidence = {
      generatedAt: new Date().toISOString(),
      run: 'local Hindi smoke run, unscored; not CI, not Pages, not a demo',
      model:
        'onnx-community/Qwen3-1.7B-ONNX@3231b522c6e703b2f9b3cd8ea27426a1289a02f2 onnx/model_q4f16.onnx',
      descriptor: 'qwen3-1.7b.tjs-webgpu-q4f16 (enable_thinking false)',
      chain: {
        forceRung: null,
        selected: report.rung,
        executionProviders: report.executionProviders,
        attempts: report.attempts,
      },
      profile: { gpu: profile.gpu, backendTier: profile.backendTier, ramGb: profile.ramGb },
      loadMs: Math.round(report.loadMs ?? 0),
      bytesDownloaded: report.bytesDownloaded,
      peakJsHeapUsedSizeBytes: peakHeap,
      tokensPerSecondMean: tps.reduce((a, b) => a + b, 0) / tps.length,
      maxTokens: 128,
      temperature: 0,
      abortedRequests: aborted,
      workerTargets: workers,
      requestCount: requests.length,
      prompts: PROMPTS.map((p, i) => ({
        id: p.id,
        kind: p.kind,
        prompt: p.text,
        output: report.generations![i]!.text,
        finishReason: report.generations![i]!.finishReason,
        usage: report.generations![i]!.usage,
        timings: report.generations![i]!.timings,
      })),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'hindi-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    clearInterval(timer);
    await context.close();
  }
});
