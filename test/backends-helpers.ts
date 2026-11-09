// Shared fixtures for the backend adapter tests: a real AssetManager over a memory store and the
// fake HTTP origin serving a tiny signed test manifest (descriptor + files), a mocked Transformers.js
// module (never the real package), capability profiles and event helpers.

import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { CapabilityProfile, BackendTier } from '../spec/capability-profile';
import type { Event } from '../spec/event';
import type { Manifest, ManifestEntry } from '../spec/manifest';
import { MODEL_DESCRIPTOR_MEDIA_TYPE, type ModelDescriptor } from '../spec/model-descriptor';
import { AssetManager } from '../src/asset-manager';
import { EventBus } from '../src/events';
import { MemoryAssetStore } from '../src/store/memory';
import { FakeServer } from './fake-fetch';
import { makeEntry, makeManifest, pseudoRandomBytes, signManifest, testTrust } from './helpers';

export const ORIGIN = 'https://assets.test';
export const PAGE_ORIGIN = 'https://app.test';
export const PAGE_HREF = `${PAGE_ORIGIN}/app/models.html`;
export const PREFIX = '/app/__airplanemode/verified/';
export const ORT_FACTORY_URL = `${PAGE_ORIGIN}/app/app/ort/ort-test.asyncify.mjs`;

const enc = new TextEncoder();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function profileOf(
  tier: BackendTier,
  over: Partial<CapabilityProfile> = {},
): CapabilityProfile {
  const gpu = tier === 'webgpu-f16' || tier === 'webgpu-f32';
  return {
    spec: 'airplanemode.capability/0.1',
    gpu: gpu ? 'webgpu' : 'none',
    ramGb: 16,
    storageFreeGb: 50,
    cores: 8,
    backendTier: tier,
    features: {
      webgpu: gpu,
      shaderF16: tier === 'webgpu-f16',
      wasmSimd: tier !== 'none' && tier !== 'wasm',
      wasmThreads: false,
      opfs: true,
      indexedDb: true,
      persistentStorage: false,
    },
    measuredAt: '2026-11-09T00:00:00Z',
    ...over,
  };
}

export const WASM_BYTES = enc.encode('FAKE-ORT-WASM-BINARY-0123456789');
export const ONNX_BYTES = pseudoRandomBytes(3000, 7);

export function pinsFor(wasm: Uint8Array = WASM_BYTES) {
  const p = {
    wasmFile: 'ort-test.asyncify.wasm',
    wasmSha256: sha256(wasm),
    factoryFile: 'ort-test.asyncify.mjs',
    factorySha256: '0'.repeat(64),
  };
  return { wasm: p, webgpu: p } as const;
}

export interface WorldOptions {
  descriptor?: (d: Record<string, unknown>) => void;
  /** Override or add manifest entries after the default ones are built. */
  entries?: (entries: Record<string, ManifestEntry>) => void;
  wasmBytes?: Uint8Array;
  /** Do not serve these asset names (404). */
  skipServing?: string[];
  descriptorText?: string;
  descriptorBytes?: Uint8Array;
  descriptorEntry?: Partial<ManifestEntry>;
  fileEntry?: (id: string) => Partial<ManifestEntry>;
  descriptorEntryId?: string;
}

export interface World {
  mgr: AssetManager;
  store: MemoryAssetStore;
  server: FakeServer;
  events: EventBus;
  manifest: Manifest;
  descriptorEntry: ManifestEntry;
  descriptor: ModelDescriptor;
  entries: Record<string, ManifestEntry>;
  /** ids of every entry except the descriptor, in manifest order */
  fileIds: string[];
  totalBytes: number;
}

export const FILE_DEFS: {
  path: string;
  id: string;
  bytes: Uint8Array;
  kind: ManifestEntry['kind'];
}[] = [
  {
    path: 'config.json',
    id: 'm.config',
    bytes: enc.encode('{"hidden_size":4}'),
    kind: 'tokenizer',
  },
  {
    path: 'generation_config.json',
    id: 'm.generation-config',
    bytes: enc.encode('{"max_new_tokens":8}'),
    kind: 'other',
  },
  { path: 'onnx/model_q4.onnx', id: 'm.onnx-q4', bytes: ONNX_BYTES, kind: 'model' },
  { path: 'runtime/ort-test.asyncify.wasm', id: 'ort.wasm', bytes: WASM_BYTES, kind: 'wasm' },
  {
    path: 'tokenizer.json',
    id: 'm.tokenizer',
    bytes: enc.encode('{"model":{}}'),
    kind: 'tokenizer',
  },
  {
    path: 'tokenizer_config.json',
    id: 'm.tokenizer-config',
    bytes: enc.encode('{"bos_token":null}'),
    kind: 'tokenizer',
  },
];

export function descriptorJson(
  over: (d: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const d: Record<string, unknown> = {
    spec: 'airplanemode.model/0.1',
    id: 'm',
    engine: 'transformers-js',
    task: 'text-generation',
    devices: ['wasm', 'webgpu'],
    dtype: 'q4',
    files: FILE_DEFS.map((f) => ({ path: f.path, entryId: f.id })).sort((a, b) =>
      a.path < b.path ? -1 : 1,
    ),
    runtimeWasm: 'runtime/ort-test.asyncify.wasm',
    contextLength: 2048,
    generation: { maxNewTokens: 16, chatTemplateKwargs: { enable_thinking: false } },
    source: { repo: 'acme/tiny', revision: 'a'.repeat(40) },
    licence: 'Apache-2.0',
  };
  over(d);
  return d;
}

export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const server = new FakeServer({ origin: ORIGIN });
  const wasm = o.wasmBytes ?? WASM_BYTES;
  const entries: Record<string, ManifestEntry> = {};
  const descId = o.descriptorEntryId ?? 'm.descriptor';
  for (const f of FILE_DEFS) {
    const bytes = f.id === 'ort.wasm' ? wasm : f.bytes;
    if (!(o.skipServing ?? []).includes(f.id)) server.addAsset(f.id, bytes);
    entries[f.id] = makeEntry(f.id, {
      kind: f.kind,
      url: `${ORIGIN}/assets/${f.id}`,
      sha256: sha256(bytes),
      size: bytes.length,
      chunkSize: 1048576,
      licence: f.id === 'ort.wasm' ? 'MIT' : 'Apache-2.0',
      ...o.fileEntry?.(f.id),
    });
  }
  const dj = descriptorJson(o.descriptor);
  const dBytes = o.descriptorBytes ?? enc.encode(o.descriptorText ?? JSON.stringify(dj));
  server.addAsset(descId, dBytes);
  const descriptorEntry = makeEntry(descId, {
    kind: 'model',
    mediaType: MODEL_DESCRIPTOR_MEDIA_TYPE,
    url: `${ORIGIN}/assets/${descId}`,
    sha256: sha256(dBytes),
    size: dBytes.length,
    chunkSize: 1048576,
    ...o.descriptorEntry,
  });
  entries[descId] = descriptorEntry;
  o.entries?.(entries);
  const sorted = Object.values(entries).sort((a, b) => (a.id < b.id ? -1 : 1));
  const manifest = signManifest(makeManifest({ entries: sorted }));
  const store = new MemoryAssetStore();
  const events = new EventBus(5000);
  const mgr = new AssetManager({
    store,
    fetch: server.fetch,
    events,
    allowTestKeys: true,
    allowedOrigins: [ORIGIN],
    headroomBytes: 0,
    progressIntervalMs: 0,
  });
  await mgr.loadManifest(manifest, testTrust());
  return {
    mgr,
    store,
    server,
    events,
    manifest,
    descriptorEntry,
    descriptor: dj as unknown as ModelDescriptor,
    entries,
    fileIds: sorted.filter((e) => e.id !== descId).map((e) => e.id),
    totalBytes: sorted.reduce((n, e) => n + e.size, 0),
  };
}

export const names = (events: EventBus): string[] => events.snapshot().map((e) => e.name);
export const eventsNamed = (events: { snapshot(): Event[] }, name: string): Event[] =>
  events.snapshot().filter((e) => e.name === name);

// ---------------------------------------------------------------------------------------------
// A mocked Transformers.js module. Its env starts with the library's real defaults (everything
// pointing at the network and the caches switched on) so the tests prove configureEnv() overrides
// them. pipeline() records the env it saw and can exercise env.fetch like the engine does.

export interface PipelineCall {
  task: string;
  model: string;
  options: Record<string, unknown>;
  envSnapshot: Record<string, unknown>;
}

export interface MockEngineOptions {
  /** What the generator returns for a chat prompt. */
  reply?: string | ((messages: { role: string; content: string }[]) => string);
  /** Files the pipeline() call asks the shim for (relative to env.localModelPath + model + '/'). */
  readFiles?: string[];
  /** Throw this from pipeline(). */
  pipelineError?: Error;
  /** Throw this from the generator call. */
  generateError?: Error;
  /** Called inside pipeline() with the env, to simulate a rogue engine. */
  inPipeline?: (env: MockEnv, model: string) => Promise<void> | void;
  /** Number of generated tokens the fake streamer reports. */
  tokens?: number;
  promptTokens?: number;
}

export interface MockEnv {
  backends: { onnx: { wasm: Record<string, unknown> } };
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  useBrowserCache: boolean;
  useFSCache: boolean;
  useFS: boolean;
  useCustomCache: boolean;
  useWasmCache: boolean;
  experimental_useCrossOriginStorage: boolean;
  remoteHost: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  [k: string]: unknown;
}

export function mockEngine(o: MockEngineOptions = {}) {
  const env: MockEnv = {
    backends: {
      onnx: {
        wasm: {
          wasmPaths: {
            mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev/dist/ort-wasm-simd-threaded.asyncify.mjs',
            wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev/dist/ort-wasm-simd-threaded.asyncify.wasm',
          },
          numThreads: 4,
          proxy: true,
        },
      },
    },
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '/models/',
    useBrowserCache: true,
    useFSCache: false,
    useFS: false,
    useCustomCache: true,
    useWasmCache: true,
    experimental_useCrossOriginStorage: true,
    remoteHost: 'https://huggingface.co/',
    fetch: async () => {
      throw new Error('the library default fetch must never be reachable');
    },
  };
  const pipelineCalls: PipelineCall[] = [];
  const generateCalls: { input: unknown; options: Record<string, unknown> }[] = [];
  const filesRead: { path: string; size: number; status: number }[] = [];
  const disposed = { count: 0 };

  const pipeline = vi.fn(async (task: string, model: string, options: Record<string, unknown>) => {
    pipelineCalls.push({
      task,
      model,
      options,
      envSnapshot: JSON.parse(
        JSON.stringify({
          ...env,
          fetch: undefined,
          backends: { onnx: { wasm: { ...env.backends.onnx.wasm, wasmBinary: undefined } } },
        }),
      ) as Record<string, unknown>,
    });
    if (o.pipelineError) throw o.pipelineError;
    await o.inPipeline?.(env, model);
    for (const file of o.readFiles ?? []) {
      const res = await env.fetch(`${env.localModelPath}${model}/${file}`, {
        headers: new Headers(),
      });
      filesRead.push({
        path: file,
        size: res.status === 200 ? (await res.arrayBuffer()).byteLength : 0,
        status: res.status,
      });
    }
    const tokenizer = {
      apply_chat_template: (_m: unknown, _opts: Record<string, unknown>) =>
        Array.from({ length: o.promptTokens ?? 5 }, (_, i) => i),
    };
    const generator = async (input: unknown, genOptions: Record<string, unknown>) => {
      if (task === 'feature-extraction') {
        const texts = input as string[];
        generateCalls.push({ input, options: genOptions });
        return {
          dims: [texts.length, 3],
          data: Float32Array.from(texts.flatMap((_, i) => [0.6, 0.8, 0 * i])),
        };
      }
      generateCalls.push({ input, options: genOptions });
      if (o.generateError) throw o.generateError;
      const streamer = genOptions['streamer'] as
        { put(v: bigint[][]): void; end(): void } | undefined;
      const messages = input as { role: string; content: string }[];
      const text = typeof o.reply === 'function' ? o.reply(messages) : (o.reply ?? 'Paris');
      streamer?.put([Array.from({ length: o.promptTokens ?? 5 }, (_, i) => BigInt(i))]);
      for (let i = 0; i < (o.tokens ?? 2); i++) streamer?.put([[BigInt(100 + i)]]);
      streamer?.end();
      return [{ generated_text: [...messages, { role: 'assistant', content: text }] }];
    };
    return Object.assign(generator, {
      tokenizer,
      dispose: async () => {
        disposed.count++;
      },
    });
  });

  class TextStreamer {
    constructor(
      readonly tokenizer: unknown,
      readonly opts: { callback_function?: (t: string) => void },
    ) {}
    put(value: bigint[][]) {
      // the first put() is the prompt (skipped by skip_prompt); later ones are tokens
      this.n = (this.n ?? 0) + 1;
      if (this.n > 1) this.opts.callback_function?.(`t${value[0]![0]} `);
    }
    end() {}
    private n: number | undefined;
  }
  class InterruptableStoppingCriteria {
    interrupted = false;
    interrupt() {
      this.interrupted = true;
    }
    reset() {
      this.interrupted = false;
    }
  }

  return {
    module: { env, pipeline, TextStreamer, InterruptableStoppingCriteria },
    env,
    pipeline,
    pipelineCalls,
    generateCalls,
    filesRead,
    disposed,
  };
}

export type MockEngine = ReturnType<typeof mockEngine>;

/** Sets a minimal window.location for the shim; returns a restore function. */
export function installLocation(href = PAGE_HREF): () => void {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  const u = new URL(href);
  g.location = { href: u.href, origin: u.origin, pathname: u.pathname };
  return () => {
    if (prev === undefined) delete g.location;
    else g.location = prev;
  };
}
