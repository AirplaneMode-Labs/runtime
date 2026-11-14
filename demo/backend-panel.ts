// Backend demo page (models.html). Hosted at https://airplanemode-labs.github.io/runtime/models.html
// and served locally by the range test server (test/browser).
//
// What it does: detects the device tier, shows the plan of the fallback chain before any download,
// and, only after the user clicks the download button, creates an AssetManager, loads the signed
// model manifest from this site, loads the test model through loadWithFallback() and answers a
// prompt. The click is the consent for the download.
//
// Egress: the CSP of models.html is connect-src 'self'; this page never fetches a URL the user typed,
// and no request to models/ is made before the click. The AssetManager gets allowedOrigins
// [location.origin] explicitly. Engines get model bytes only through the verified-file shim.
//
// Every string shown is set with textContent; the prompt is never persisted or logged.
//
// Test hooks: `window.__models` exists only when location.hostname is 127.0.0.1 or localhost. It
// loads a manifest the range test server serves under /models/ (?models=test or ?models=hindi),
// signed with the public RFC 8032 test key, and is the only place allowTestKeys is true.

import {
  AssetError,
  AssetManager,
  RFC8032_TEST_KEY_ID,
  detectCapabilities,
  type CapabilityProfile,
  type Event,
  type TrustSet,
} from '../src/index.ts';
import {
  BackendRefusedError,
  createDefaultAdapters,
  loadWithFallback,
  type Attempt,
  type EngineStateProbe,
  type LoadWithFallbackResult,
  type Rung,
} from '../src/backends/index.ts';
import { ORT_FACTORY_FILE } from '../src/backends/ort-pins.ts';
// The engine worker, bundled by Vite as an ES-module worker; the URL is resolved against the page.
import engineWorkerUrl from '../src/worker/engine-host.ts?worker&url';
import { maxTokensFor } from './limits.ts';
import { AdapterError } from '../spec/backend-adapter.ts';
import { EventBus } from '../src/events.ts';
import { exposeDevtoolsHook } from '../src/devtools-hook.ts';
import { buildPanelModel, buildPanelView, mountView } from '../devtools/src/render.ts';
import type { TransformersAdapter } from '../src/backends/transformers.ts';

const MiB = 1024 * 1024;
const params = new URLSearchParams(location.search);
const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

interface ModelsMeta {
  bundled: boolean;
  keyId?: string;
  publicKeyHex?: string;
  manifestPath?: string;
  descriptorEntryId?: string;
  totalBytes?: number;
  modelName?: string;
}
const meta = JSON.parse(__DEMO_MODELS__) as ModelsMeta;

// RFC 8032 section 7.1 test vector 1 public key: public, non-secret test data, trusted only by the
// loopback hook below (allowTestKeys), never by the hosted click path.
const RFC8032_TEST_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};
const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
const fmtBytes = (n: number): string => (n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : `${n} B`);
const rungLabel: Record<Rung, string> = {
  webgpu: 'WebGPU',
  wasm: 'WebAssembly',
  builtin: 'Chrome built-in model',
};

$('build-id').textContent = __DEMO_BUILD__;

// The page opts in to the Airplane Mode DevTools panel (runtime/devtools): the hook exposes the
// event bus of the current model session as globalThis.__airplanemodeDevtools. Only this demo calls
// exposeDevtoolsHook(); the library never does.
let disposeDevtoolsHook: (() => void) | undefined;
function publishToDevtools(bus: EventBus): void {
  disposeDevtoolsHook?.();
  disposeDevtoolsHook = exposeDevtoolsHook(bus);
}

/** Message shown for a failure, built from codes only (never from engine or network text). */
function describeFailure(e: unknown): string {
  if (e instanceof BackendRefusedError) return e.userMessage;
  if (e instanceof AdapterError) return `The model could not be loaded (${e.code}).`;
  if (e instanceof AssetError)
    return e.code === 'hash_mismatch' || e.code === 'not_verified'
      ? `A downloaded file did not match its signed hash (${e.code}); it was discarded.`
      : e.code === 'policy'
        ? 'A download was blocked by the origin policy.'
        : `The model could not be downloaded (${e.code}).`;
  if (e !== null && typeof e === 'object' && typeof (e as { reason?: unknown }).reason === 'string')
    return `The model manifest was rejected (${(e as { reason: string }).reason}).`;
  return 'The model could not be loaded.';
}

// --- the plan and the device ----------------------------------------------------------------------

const ortFactoryUrl = new URL(`./app/ort/${ORT_FACTORY_FILE}`, location.href).href;
/** Where the engine runs: the page uses a worker; the loopback test hook can still ask for the main thread. */
type EngineHost = 'main' | 'worker';
const adaptersFor = (
  host: EngineHost,
  extra: { sessionOptions?: { graphOptimizationLevel: 'disabled' } } = {},
) =>
  createDefaultAdapters({
    ortFactoryUrl,
    ...(host === 'worker' ? { workerUrl: engineWorkerUrl } : {}),
    ...extra,
  });
let profile: CapabilityProfile | undefined;

function planText(
  rung: Rung,
  ok: boolean,
  forced: boolean,
  allowBuiltin: boolean,
  blocked: boolean,
): string {
  if (forced && rung === 'webgpu') return 'skipped: you chose Transformers.js WebAssembly';
  if (rung === 'builtin')
    return allowBuiltin
      ? "will be tried last, and only if the browser says its model is already available (this site never starts the browser's own download)"
      : 'off: tick "Allow Chrome built-in model" to try it. Its availability is not even checked while it is off';
  if (!ok)
    return rung === 'webgpu'
      ? 'skipped: this device has no usable WebGPU adapter'
      : 'skipped: this device cannot run WebAssembly inference';
  if (blocked)
    return 'cannot start in this page: an earlier attempt failed inside the engine. Reload the page and choose WebAssembly to try again';
  return rung === 'webgpu'
    ? 'will be tried first (the model runs on your GPU)'
    : 'will be tried when WebGPU is unavailable or fails (the model runs on the CPU)';
}

async function renderPlan(): Promise<void> {
  const p = (profile ??= await detectCapabilities());
  $('out-tier').textContent =
    `Capability tier: ${p.backendTier}\n` +
    `GPU: ${p.gpu}   cores: ${p.cores}   memory tier: ${p.ramGb === 0 ? 'unknown' : `${p.ramGb} GB`}   ` +
    `free storage: ${p.storageFreeGb} GB\n` +
    `WebAssembly SIMD: ${p.features.wasmSimd ? 'yes' : 'no'}   threads: ${p.features.wasmThreads ? 'yes' : 'no (no COOP/COEP)'}   ` +
    `shader-f16: ${p.features.shaderF16 ? 'yes' : 'no'}`;
  const adapters = adaptersFor('worker');
  const forced = $<HTMLSelectElement>('sel-engine').value === 'wasm';
  const allow = $<HTMLInputElement>('chk-builtin').checked;
  const list = $('plan-list');
  list.replaceChildren();
  for (const rung of ['webgpu', 'wasm', 'builtin'] as const) {
    const adapter = adapters.find((a) => a.device === rung);
    // availability() of the built-in model is never asked while the rung is off (R6)
    const ok = rung === 'builtin' || !adapter ? false : await adapter.available(p);
    const blocked =
      adapter !== undefined && (adapter as Partial<EngineStateProbe>).engineBlocked?.() === true;
    const li = document.createElement('li');
    li.textContent = `${rungLabel[rung]}: ${planText(rung, ok, forced, allow, blocked)}`;
    list.append(li);
  }
}

// --- model source ----------------------------------------------------------------------------------

interface Source {
  manifestUrl: string;
  /** Descriptor entry ids in preference order (the isolation fixture lists two). */
  descriptorEntryIds: string[];
  trust: TrustSet;
}

/** The bundled, per-build-signed model (hosted path): the only manifest the click handler loads. */
function bundledSource(): Source | undefined {
  if (
    !meta.bundled ||
    !meta.publicKeyHex ||
    !meta.keyId ||
    !meta.manifestPath ||
    !meta.descriptorEntryId
  )
    return undefined;
  return {
    manifestUrl: new URL(meta.manifestPath, location.href).href,
    descriptorEntryIds: [meta.descriptorEntryId],
    trust: new Map([[meta.keyId, hexToBytes(meta.publicKeyHex)]]),
  };
}

// --- the load itself ---------------------------------------------------------------------------------

interface Session {
  mgr: AssetManager;
  events: EventBus;
  adapters: ReturnType<typeof createDefaultAdapters>;
}
interface LoadReport {
  result: LoadWithFallbackResult;
  loadMs: number;
  bytesDownloaded: number;
  executionProviders: string[];
  dtype: string;
}
let current: { session: Session; result: LoadWithFallbackResult } | undefined;

async function loadModel(
  session: Session,
  source: Source,
  options: {
    forceRung?: Rung;
    allowBuiltin: boolean;
    consent: (info: { rung: Rung; model: string; bytes: number }) => Promise<boolean>;
    onProgress?: (p: { entryId: string; received: number; total: number }) => void;
  },
): Promise<LoadReport> {
  const p = (profile ??= await detectCapabilities());
  await current?.result.adapter.unload();
  current = undefined;
  const t0 = performance.now();
  await session.mgr.loadManifest(source.manifestUrl, source.trust);
  const result = await loadWithFallback({
    profile: p,
    assets: session.mgr,
    models: source.descriptorEntryIds,
    adapters: session.adapters,
    ...(options.forceRung ? { forceRung: options.forceRung } : {}),
    allowBuiltin: options.allowBuiltin,
    beforeDownload: options.consent,
    events: session.events,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const loadMs = performance.now() - t0;
  current = { session, result };
  let bytesDownloaded = 0;
  for (const e of session.events.snapshot())
    if (e.name === 'asset.download.complete') bytesDownloaded += e.bytes ?? 0;
  const diag =
    result.adapter.id === 'transformers-js'
      ? (result.adapter as unknown as TransformersAdapter).diagnostics()
      : { executionProviders: ['builtin'], dtype: '' };
  return {
    result,
    loadMs,
    bytesDownloaded,
    executionProviders: diag.executionProviders,
    dtype: diag.dtype,
  };
}

// --- the UI (hosted path) ------------------------------------------------------------------------

const btnDownload = $<HTMLButtonElement>('btn-download');
const btnRun = $<HTMLButtonElement>('btn-run');
const inPrompt = $<HTMLTextAreaElement>('in-prompt');
const selEngine = $<HTMLSelectElement>('sel-engine');
const chkBuiltin = $<HTMLInputElement>('chk-builtin');

function showResult(r: LoadReport): void {
  $('result').classList.remove('hidden');
  $('r-rung').textContent = rungLabel[r.result.rung];
  $('r-adapter').textContent = r.result.adapter.id;
  $('r-eps').textContent = r.executionProviders.join(', ');
  $('r-load').textContent = `${Math.round(r.loadMs)} ms`;
  $('r-bytes').textContent = fmtBytes(r.bytesDownloaded);
}

/** The 'Engine runs in a worker' line, driven by backend.worker events (shown only when a worker became ready). */
function showWorkerLine(events: EventBus): void {
  const line = $('worker-line');
  const ready = events
    .snapshot()
    .filter((e) => e.name === 'backend.worker' && e.attrs['state'] === 'ready')
    .pop();
  if (!ready) {
    line.classList.add('hidden');
    return;
  }
  const ms = ready.durationMs === undefined ? '' : ` (ready in ${Math.round(ready.durationMs)} ms)`;
  line.textContent = `The engine runs in a worker${ms}: the page stays responsive while the model answers.`;
  line.classList.remove('hidden');
}

/** The load timing and memory read-out: the DevTools panel's own model and view, fed by the hook. */
function renderReadout(): void {
  const hook = (globalThis as { __airplanemodeDevtools?: { snapshot(): string } })
    .__airplanemodeDevtools;
  const raw = hook ? hook.snapshot() : null;
  $('readout-empty').classList.add('hidden');
  mountView(document, $('readout-body'), buildPanelView(buildPanelModel(raw)));
}

async function onDownloadClick(): Promise<void> {
  const source = bundledSource();
  if (!source) return;
  btnDownload.disabled = true;
  btnRun.disabled = true;
  $('refusal').classList.add('hidden');
  $('progress').textContent = 'Loading the signed manifest…';
  // The second AssetManager of the demo (index.html has the first): created only here, after the
  // click. allowedOrigins is explicit and test keys are never trusted on this path.
  const events = new EventBus(5000);
  publishToDevtools(events);
  const mgr = new AssetManager({
    store: 'auto',
    allowedOrigins: [location.origin],
    allowTestKeys: false,
    events,
  });
  // The picker: auto starts at WebGPU and falls back to WebAssembly; 'webgpu' offers only the WebGPU
  // adapter (no fallback, so a device that cannot run it is reported instead of hidden); 'wasm' skips
  // the WebGPU rung. The engine of every choice runs in a worker.
  const engine = selEngine.value;
  const allAdapters = adaptersFor('worker');
  const session: Session = {
    mgr,
    events,
    adapters: engine === 'webgpu' ? allAdapters.filter((a) => a.device === 'webgpu') : allAdapters,
  };
  let asked = 0;
  try {
    const report = await loadModel(session, source, {
      ...(engine === 'wasm' ? { forceRung: 'wasm' as const } : {}),
      allowBuiltin: chkBuiltin.checked,
      consent: async ({ rung, bytes }) => {
        // The click was the consent for the first question; any later rung asks again.
        asked++;
        if (asked === 1) {
          $('progress').textContent =
            `Downloading ${fmtBytes(bytes)} from this site for ${rungLabel[rung]}…`;
          return true;
        }
        return window.confirm(`Download ${fmtBytes(bytes)} more for ${rungLabel[rung]}?`);
      },
      onProgress: (pr) => {
        $('progress').textContent =
          `Downloading ${pr.entryId}: ${fmtBytes(pr.received)} of ${fmtBytes(pr.total)}`;
      },
    });
    $('progress').textContent =
      'Model loaded and verified. Every file was hashed against the signed manifest.';
    showResult(report);
    showWorkerLine(events);
    renderReadout();
    btnRun.disabled = false;
    inPrompt.disabled = false;
  } catch (e) {
    $('progress').textContent = '';
    showWorkerLine(events);
    renderReadout();
    const refusal = $('refusal');
    refusal.textContent = describeFailure(e);
    refusal.classList.remove('hidden');
    btnDownload.disabled = false;
    void renderPlan(); // an engine that failed in this page is shown as blocked in the plan
  }
}

async function onRunClick(): Promise<void> {
  if (!current) return;
  btnRun.disabled = true;
  $('out-answer').textContent = '';
  $('out-timing').textContent = 'Generating…';
  try {
    const res = await current.result.adapter.generate(inPrompt.value, {
      // a short answer on WebAssembly keeps the demo quick; the engine runs in a worker, so the page stays responsive
      maxTokens: maxTokensFor(current.result.rung),
      temperature: 0,
      onToken: (t) => {
        $('out-answer').textContent = ($('out-answer').textContent ?? '') + t;
      },
    });
    $('out-answer').textContent = res.text;
    const t = res.timings;
    $('out-timing').textContent =
      `Finish: ${res.finishReason}. Prompt tokens ${res.usage.promptTokens ?? '?'}, generated ${res.usage.completionTokens ?? '?'}. ` +
      `Prefill ${Math.round(t.prefillMs ?? 0)} ms, decode ${Math.round(t.decodeMs ?? 0)} ms` +
      (t.tokensPerSecond ? `, ${t.tokensPerSecond.toFixed(1)} tokens per second.` : '.');
    renderReadout();
  } catch (e) {
    $('out-timing').textContent = describeFailure(e);
  } finally {
    btnRun.disabled = false;
  }
}

function initModelSection(): void {
  const src = bundledSource();
  if (src && meta.totalBytes) {
    $('model-status').textContent =
      `This build bundles ${meta.modelName ?? 'a test model'} (${fmtBytes(meta.totalBytes)} in total, signed per build). ` +
      'Nothing is downloaded until you click the button.';
    $('download-note').textContent =
      `about ${fmtBytes(meta.totalBytes)} from this site, stored in your browser`;
    btnDownload.disabled = false;
    btnDownload.addEventListener('click', () => void onDownloadClick());
    btnRun.addEventListener('click', () => void onRunClick());
  } else {
    $('model-status').textContent = 'test model not bundled in this build';
    btnDownload.disabled = true;
    btnDownload.addEventListener('click', () => undefined);
  }
}

selEngine.addEventListener('change', () => void renderPlan());
chkBuiltin.addEventListener('change', () => void renderPlan());
initModelSection();
void renderPlan();

/** Collects the durations of main-thread long tasks (over 50 ms) until stop(). */
function observeLongTasks(): { stop(): number[] } {
  const seen: number[] = [];
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) seen.push(e.duration);
    });
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    observer = undefined; // long-task entries are not available in this browser
  }
  return {
    stop(): number[] {
      for (const e of observer?.takeRecords() ?? []) seen.push(e.duration);
      observer?.disconnect();
      return seen;
    },
  };
}

// --- loopback test hooks (never on a hosted page) -----------------------------------------------------

interface RunOptions {
  prompt: string;
  /** Several prompts answered one after another by the one loaded model (the Hindi smoke run). */
  prompts?: string[];
  maxTokens?: number;
  temperature?: number;
  forceRung?: Rung;
  allowBuiltin?: boolean;
  /** Injects a probe: a request the adapter's own engine must not be able to make. */
  probeUrl?: string;
  /**
   * Aborts the first generation from inside onToken after this many tokens, then runs a second
   * generation (T1-S2-02): abort from onToken works on WebAssembly, and the adapter stays usable.
   */
  abortAfterTokens?: number;
  /**
   * Aborts a generation from a timer, this many milliseconds after it started (R8: the worker host must
   * land the abort promptly even when the engine is busy), then reports how long the abort took.
   */
  abortAfterMs?: number;
  /** Where the engine runs for this run: 'main' (default, the Sprint 1 and 2 specs) or 'worker'. */
  host?: EngineHost;
}

interface Generation {
  text: string;
  finishReason: string;
  usage: { promptTokens?: number; completionTokens?: number };
  timings: { prefillMs?: number; decodeMs?: number; tokensPerSecond?: number };
}

type HookReport =
  | {
      ok: true;
      rung: Rung;
      adapter: string;
      model: string | null;
      executionProviders: string[];
      dtype: string;
      attempts: Attempt[];
      loadMs: number;
      bytesDownloaded: number;
      text: string;
      finishReason: string;
      usage: { promptTokens?: number; completionTokens?: number };
      timings: { prefillMs?: number; decodeMs?: number; tokensPerSecond?: number };
      generations: Generation[];
      abortCheck?: {
        first: Generation & { tokensSeen: number };
        second: Generation;
      };
      /** Durations of the main-thread long tasks (over 50 ms) that ran while the prompts were answered. */
      longTasksMs: number[];
      /** abortAfterMs: the timer abort, its latency in ms, how it ended and what the asset holds were after. */
      timerAbort?: {
        latencyMs: number;
        finishReason: string;
        refcounts: number[];
        loaded: boolean;
      };
      verifyOk: string[];
      egressRefused: number;
      probe: string | null;
      beforeDownload: { rung: Rung; model: string; bytes: number }[];
      events: {
        name: string;
        kind: string;
        level: string;
        attrs: Event['attrs'];
        bytes?: number;
      }[];
    }
  | { ok: false; userMessage: string; attempts: Attempt[]; errorName: string; code: string | null };

if (isLocal) {
  const which = params.get('models');
  const manifestPath =
    which === 'hindi'
      ? '/models/hindi-smoke/manifest.json'
      : which === 'isolation'
        ? '/models/isolation/manifest.json'
        : '/models/test-models/manifest.json';
  const descriptorEntryIds =
    which === 'hindi'
      ? ['qwen3-1.7b.tjs-webgpu-q4f16']
      : which === 'isolation'
        ? // the first descriptor's WebGPU weights are garbage: the rung fails after its worker started
          ['smollm2-135m-instruct.bad-webgpu.descriptor', 'smollm2-135m-instruct.wasm.descriptor']
        : ['smollm2-135m-instruct.descriptor'];

  // Qwen3-1.7B q4f16 (one 1.43 GB file) runs out of the 4 GB WebAssembly heap while ONNX Runtime
  // optimises the graph (std::bad_alloc) unless the optimisation level is 'disabled'; the small test
  // model needs no option. Descriptor 0.1.0 has no field for it, so the local hook passes it.
  const hookSessionOptions =
    which === 'hindi' ? { sessionOptions: { graphOptimizationLevel: 'disabled' as const } } : {};

  const hook = {
    version: 1,
    async profile(): Promise<CapabilityProfile> {
      return (profile ??= await detectCapabilities());
    },
    async run(options: RunOptions): Promise<HookReport> {
      const events = new EventBus(5000);
      publishToDevtools(events);
      const mgr = new AssetManager({
        store: 'auto',
        allowedOrigins: [location.origin],
        // Loopback test hook only: the manifest is signed with the public RFC 8032 test key.
        allowTestKeys: true,
        events,
      });
      const session: Session = {
        mgr,
        events,
        adapters: adaptersFor(options.host ?? 'main', hookSessionOptions),
      };
      const beforeDownload: { rung: Rung; model: string; bytes: number }[] = [];
      const trust: TrustSet = new Map([[RFC8032_TEST_KEY_ID, hexToBytes(RFC8032_TEST_PUBLIC_HEX)]]);
      try {
        const report = await loadModel(
          session,
          { manifestUrl: new URL(manifestPath, location.href).href, descriptorEntryIds, trust },
          {
            ...(options.forceRung ? { forceRung: options.forceRung } : {}),
            allowBuiltin: options.allowBuiltin === true,
            consent: async (info) => {
              beforeDownload.push(info);
              return true;
            },
          },
        );
        let probe: string | null = null;
        if (options.probeUrl) {
          // a request the engine's own network function would make: the shim must refuse it. The
          // dynamic import returns the module instance the adapter configured.
          const engine = (await import('@huggingface/transformers')) as unknown as {
            env: { fetch: (u: string) => Promise<Response> };
          };
          try {
            await engine.env.fetch(options.probeUrl);
            probe = 'served';
          } catch (e) {
            probe = e instanceof AdapterError ? e.code : 'error';
          }
        }
        const generations: Generation[] = [];
        const longTasks = observeLongTasks();
        for (const prompt of options.prompts ?? [options.prompt]) {
          const g = await report.result.adapter.generate(prompt, {
            maxTokens: options.maxTokens ?? 16,
            temperature: options.temperature ?? 0,
          });
          generations.push({
            text: g.text,
            finishReason: g.finishReason,
            usage: g.usage,
            timings: g.timings,
          });
        }
        const longTasksMs = longTasks.stop();
        let timerAbort: NonNullable<Extract<HookReport, { ok: true }>['timerAbort']> | undefined;
        if (options.abortAfterMs !== undefined) {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), options.abortAfterMs);
          let abortedAt = 0;
          ctl.signal.addEventListener('abort', () => (abortedAt = performance.now()), {
            once: true,
          });
          const g = await report.result.adapter.generate(options.prompt, {
            maxTokens: options.maxTokens ?? 64,
            temperature: 0,
            signal: ctl.signal,
          });
          clearTimeout(timer);
          const settled = performance.now();
          timerAbort = {
            latencyMs: abortedAt === 0 ? 0 : settled - abortedAt,
            finishReason: g.finishReason,
            refcounts: (await mgr.list()).map((r) => r.refcount),
            loaded: await report.result.adapter
              .generate('', { maxTokens: 1 })
              .then(() => true)
              .catch((e: unknown) => !(e instanceof AdapterError && e.code === 'not_loaded')),
          };
        }
        let abortCheck:
          { first: Generation & { tokensSeen: number }; second: Generation } | undefined;
        if (options.abortAfterTokens !== undefined) {
          const ctl = new AbortController();
          let tokensSeen = 0;
          const f = await report.result.adapter.generate(options.prompt, {
            maxTokens: options.maxTokens ?? 64,
            temperature: options.temperature ?? 0,
            signal: ctl.signal,
            onToken: () => {
              tokensSeen++;
              if (tokensSeen >= options.abortAfterTokens!) ctl.abort();
            },
          });
          const g = await report.result.adapter.generate(options.prompt, {
            maxTokens: 8,
            temperature: 0,
          });
          abortCheck = {
            first: {
              text: f.text,
              finishReason: f.finishReason,
              usage: f.usage,
              timings: f.timings,
              tokensSeen,
            },
            second: {
              text: g.text,
              finishReason: g.finishReason,
              usage: g.usage,
              timings: g.timings,
            },
          };
        }
        const gen = generations[0]!;
        const all = events.snapshot();
        return {
          ok: true,
          rung: report.result.rung,
          adapter: report.result.adapter.id,
          model: report.result.model,
          executionProviders: report.executionProviders,
          dtype: report.dtype,
          attempts: report.result.attempts,
          loadMs: report.loadMs,
          bytesDownloaded: report.bytesDownloaded,
          text: gen.text,
          finishReason: gen.finishReason,
          usage: gen.usage,
          timings: gen.timings,
          generations,
          ...(abortCheck ? { abortCheck } : {}),
          longTasksMs,
          ...(timerAbort ? { timerAbort } : {}),
          verifyOk: all
            .filter((e) => e.name === 'asset.verify.ok')
            .map((e) => String(e.attrs['entryId'])),
          egressRefused: all.filter((e) => e.name === 'backend.egress.refused').length,
          probe,
          beforeDownload,
          events: all
            .filter((e) => /^(backend|model|memory)\./.test(e.name) || e.name === 'asset.verify.ok')
            .map((e) => ({
              name: e.name,
              kind: e.kind,
              level: e.level,
              attrs: e.attrs,
              ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
            })),
        };
      } catch (e) {
        return {
          ok: false,
          userMessage: describeFailure(e),
          attempts: e instanceof BackendRefusedError ? [...e.attempts] : [],
          errorName: e instanceof Error ? e.name : 'Error',
          code: e instanceof AdapterError || e instanceof AssetError ? String(e.code) : null,
        };
      }
    },
    /**
     * Loopback diagnosis: loads straight through one adapter (no chain, no consent prompt) and returns
     * the failure including the engine's own message. The message is only here, on the local hook:
     * hosted pages and every event keep engine text out (R5).
     */
    async diagnose(
      device: 'webgpu' | 'wasm',
      host: EngineHost = 'main',
    ): Promise<{ ok: boolean; code?: string; cause?: string }> {
      const events = new EventBus(5000);
      const mgr = new AssetManager({
        store: 'auto',
        allowedOrigins: [location.origin],
        allowTestKeys: true,
        events,
      });
      const p = (profile ??= await detectCapabilities());
      const trust: TrustSet = new Map([[RFC8032_TEST_KEY_ID, hexToBytes(RFC8032_TEST_PUBLIC_HEX)]]);
      await mgr.loadManifest(new URL(manifestPath, location.href).href, trust);
      const descriptorEntryId = descriptorEntryIds[0]!;
      const adapter = adaptersFor(host, hookSessionOptions).find((a) => a.device === device);
      if (!adapter) return { ok: false, code: 'no_adapter' };
      try {
        await adapter.load(mgr.getEntry(descriptorEntryId), { assets: mgr, profile: p, events });
        await adapter.unload();
        return { ok: true };
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        return {
          ok: false,
          code: e instanceof AdapterError || e instanceof AssetError ? String(e.code) : 'error',
          cause:
            cause instanceof Error
              ? `${cause.name}: ${cause.message}`.slice(0, 600)
              : String(cause ?? '').slice(0, 600),
        };
      }
    },
    async unload(): Promise<void> {
      await current?.result.adapter.unload();
      current = undefined;
    },
  };
  (window as unknown as { __models: typeof hook }).__models = hook;
}
