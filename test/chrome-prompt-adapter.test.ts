import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, type AssetSource } from '../spec/backend-adapter';
import {
  BUILTIN_MODEL_ENTRY,
  createChromePromptAdapter,
  type LanguageModelLike,
} from '../src/backends/chrome-prompt';
import { EventBus } from '../src/events';
import { eventsNamed, profileOf } from './backends-helpers';

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

function fakeLanguageModel(
  availability: Availability,
  over: Partial<{
    promptReply: string;
    chunks: string[];
    createError: Error;
    promptError: Error;
  }> = {},
) {
  const calls = {
    availability: 0,
    create: 0,
    prompt: [] as unknown[],
    streaming: [] as unknown[],
    destroyed: 0,
    createOptions: [] as unknown[],
  };
  const session = {
    prompt: vi.fn(async (input: unknown, opts?: { signal?: AbortSignal }) => {
      calls.prompt.push({ input, signal: opts?.signal });
      if (over.promptError) throw over.promptError;
      return over.promptReply ?? 'Paris';
    }),
    promptStreaming: vi.fn((input: unknown, opts?: { signal?: AbortSignal }) => {
      calls.streaming.push({ input, signal: opts?.signal });
      const chunks = over.chunks ?? ['Pa', 'ris'];
      return new ReadableStream<string>({
        start(c) {
          for (const x of chunks) c.enqueue(x);
          c.close();
        },
      });
    }),
    destroy: vi.fn(() => {
      calls.destroyed++;
    }),
  };
  const lm: LanguageModelLike = {
    availability: async () => {
      calls.availability++;
      return availability;
    },
    create: async (options?: unknown) => {
      calls.create++;
      calls.createOptions.push(options);
      if (over.createError) throw over.createError;
      return session;
    },
  };
  return { lm, calls, session };
}

const profile = profileOf('none');
const assets: AssetSource = {
  getEntry: () => {
    throw new Error('the built-in model never reads the manifest');
  },
  getBlob: async () => {
    throw new Error('the built-in model never reads a blob');
  },
  acquire: vi.fn(async () => {
    throw new Error('the built-in model never acquires');
  }),
};

afterEach(() => vi.unstubAllGlobals());

describe('ChromePromptAdapter: identity and available()', () => {
  it('is id chrome-prompt-api on device builtin with tier none', () => {
    const a = createChromePromptAdapter({ languageModel: fakeLanguageModel('available').lm });
    expect([a.id, a.device, a.tier]).toEqual(['chrome-prompt-api', 'builtin', 'none']);
    expect(a.capabilities()).toEqual({ generate: true, embed: false, streaming: true });
  });

  it('available() is true only when LanguageModel exists and availability() === "available"', async () => {
    for (const [state, expected] of [
      ['available', true],
      ['downloadable', false],
      ['downloading', false],
      ['unavailable', false],
    ] as const) {
      const f = fakeLanguageModel(state);
      const a = createChromePromptAdapter({ languageModel: f.lm });
      expect(await a.available(profile), state).toBe(expected);
      expect(f.calls.create, state).toBe(0);
    }
    const missing = createChromePromptAdapter({});
    expect(await missing.available(profile)).toBe(false);
  });

  it('reads the global LanguageModel at call time when none is injected', async () => {
    const f = fakeLanguageModel('available');
    vi.stubGlobal('LanguageModel', f.lm);
    const a = createChromePromptAdapter();
    expect(await a.available(profile)).toBe(true);
    vi.unstubAllGlobals();
    expect(await a.available(profile)).toBe(false);
  });

  it('a throwing availability() is simply unavailable', async () => {
    const lm: LanguageModelLike = {
      availability: async () => {
        throw new Error('nope');
      },
      create: async () => {
        throw new Error('never');
      },
    };
    expect(await createChromePromptAdapter({ languageModel: lm }).available(profile)).toBe(false);
  });
});

describe('ChromePromptAdapter: load (R6)', () => {
  for (const state of ['downloadable', 'downloading', 'unavailable'] as const) {
    it(`never calls create() when availability() is "${state}": rejects unavailable and emits model.load.failed`, async () => {
      const f = fakeLanguageModel(state);
      const events = new EventBus();
      const a = createChromePromptAdapter({ languageModel: f.lm });
      await expect(a.load(BUILTIN_MODEL_ENTRY, { assets, profile, events })).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(f.calls.create).toBe(0);
      const [failed] = eventsNamed(events, 'model.load.failed');
      expect(failed!.attrs).toEqual({
        adapter: 'chrome-prompt-api',
        model: 'browser-builtin',
        device: 'builtin',
        code: 'unavailable',
      });
    });
  }

  it('rejects unavailable when there is no LanguageModel at all', async () => {
    const a = createChromePromptAdapter({});
    await expect(a.load(BUILTIN_MODEL_ENTRY, { assets, profile })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('calls create() exactly once when available, acquires nothing and emits model.load with verified:false', async () => {
    const f = fakeLanguageModel('available');
    const events = new EventBus();
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile, events });
    expect(f.calls.create).toBe(1);
    expect(f.calls.availability).toBe(1);
    expect(assets.acquire).not.toHaveBeenCalled();
    const [e] = eventsNamed(events, 'model.load');
    expect(e!.kind).toBe('model-load');
    expect(e!.attrs).toEqual({
      adapter: 'chrome-prompt-api',
      model: 'browser-builtin',
      device: 'builtin',
      dtype: '',
      files: 0,
      tier: 'none',
      verified: false,
    });
    expect(e!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores whatever entry it is handed (descriptors are not read)', async () => {
    const f = fakeLanguageModel('available');
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(
      { ...BUILTIN_MODEL_ENTRY, id: 'anything', mediaType: 'application/x' },
      { assets, profile },
    );
    expect(f.calls.create).toBe(1);
  });

  it('a create() failure is backend with the message only in cause', async () => {
    const boom = new Error('SENTINEL-ENGINE-TEXT from the browser');
    const f = fakeLanguageModel('available', { createError: boom });
    const events = new EventBus();
    const a = createChromePromptAdapter({ languageModel: f.lm });
    let error: unknown;
    try {
      await a.load(BUILTIN_MODEL_ENTRY, { assets, profile, events });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe('backend');
    expect((error as AdapterError).message).not.toContain('SENTINEL');
    expect((error as AdapterError).cause).toBe(boom);
    expect(JSON.stringify(events.snapshot())).not.toContain('SENTINEL');
  });

  it('honours an aborted signal without touching the browser', async () => {
    const f = fakeLanguageModel('available');
    const a = createChromePromptAdapter({ languageModel: f.lm });
    const ac = new AbortController();
    ac.abort();
    await expect(
      a.load(BUILTIN_MODEL_ENTRY, { assets, profile, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls.availability).toBe(0);
    expect(f.calls.create).toBe(0);
  });
});

describe('ChromePromptAdapter: generate, embed, unload', () => {
  it('generate before load is not_loaded; embed is unsupported_operation', async () => {
    const a = createChromePromptAdapter({ languageModel: fakeLanguageModel('available').lm });
    await expect(a.generate('hi')).rejects.toMatchObject({ code: 'not_loaded' });
    await expect(a.embed(['x'])).rejects.toMatchObject({ code: 'unsupported_operation' });
  });

  it('prompts with the signal and returns the text, finishReason stop', async () => {
    const f = fakeLanguageModel('available', { promptReply: 'Paris' });
    const events = new EventBus();
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile, events });
    const ac = new AbortController();
    const res = await a.generate('capital of France?', { signal: ac.signal, temperature: 0 });
    expect(res.text).toBe('Paris');
    expect(res.finishReason).toBe('stop');
    expect((f.calls.prompt[0] as { signal: AbortSignal }).signal).toBe(ac.signal);
    const [g] = eventsNamed(events, 'model.generate');
    expect(g!.attrs).toMatchObject({
      adapter: 'chrome-prompt-api',
      device: 'builtin',
      finishReason: 'stop',
    });
    expect(JSON.stringify(g)).not.toContain('Paris');
    expect(JSON.stringify(g)).not.toContain('capital');
  });

  it('streams through onToken with promptStreaming', async () => {
    const f = fakeLanguageModel('available', { chunks: ['Pa', 'ris'] });
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile });
    const pieces: string[] = [];
    const res = await a.generate('hi', { onToken: (t) => pieces.push(t) });
    expect(pieces).toEqual(['Pa', 'ris']);
    expect(res.text).toBe('Paris');
    expect(f.calls.streaming).toHaveLength(1);
    expect(f.calls.prompt).toHaveLength(0);
  });

  it('a chat message list: system messages go to create() as initial prompts, the last user turn is prompted', async () => {
    const f = fakeLanguageModel('available');
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile });
    await a.generate([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect((f.calls.prompt[0] as { input: unknown }).input).toBe('hi');
  });

  it('an abort signal that fires gives finishReason abort', async () => {
    const f = fakeLanguageModel('available', {
      promptError: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    });
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile });
    const ac = new AbortController();
    ac.abort();
    const res = await a.generate('hi', { signal: ac.signal });
    expect(res.finishReason).toBe('abort');
    expect(f.calls.prompt).toHaveLength(0);
  });

  it('an engine error is backend with the text only in cause', async () => {
    const boom = new Error('SENTINEL-PROMPT-7f3a leaked by the browser');
    const f = fakeLanguageModel('available', { promptError: boom });
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile });
    let error: unknown;
    try {
      await a.generate('SENTINEL-PROMPT-7f3a');
    } catch (e) {
      error = e;
    }
    expect((error as AdapterError).code).toBe('backend');
    expect((error as AdapterError).message).not.toContain('SENTINEL');
    expect((error as AdapterError).cause).toBe(boom);
  });

  it('unload() destroys the session and generate is not_loaded again', async () => {
    const f = fakeLanguageModel('available');
    const a = createChromePromptAdapter({ languageModel: f.lm });
    await a.load(BUILTIN_MODEL_ENTRY, { assets, profile });
    await a.unload();
    expect(f.calls.destroyed).toBe(1);
    await a.unload();
    expect(f.calls.destroyed).toBe(1);
    await expect(a.generate('x')).rejects.toMatchObject({ code: 'not_loaded' });
  });
});
