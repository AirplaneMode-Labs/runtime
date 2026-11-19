import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_DEFAULTS, neutraliseEngineDefaults } from '../demo/engine-defaults';
import { checkSessionOptions, memorySessionOptions } from '../src/backends/tjs-core';
import { installLocation } from './backends-helpers';
import { LoopbackWorker, unloadAllRigs, workerRig } from './worker-rig';

// T1-S2-08 (a): the demo build rewrites the engine's endpoint defaults so a built demo contains no
// endpoint of Hugging Face or a CDN, and fails when a library update moves one of them.
const ENGINE_ID = '/work/node_modules/@huggingface/transformers/dist/transformers.web.js';
const DOLLAR_BRACE = '${';
const GOOD = [
  'const env = { remoteHost: "https://huggingface.co/" };',
  `const wasmPaths = \`https://cdn.jsdelivr.net/npm/onnxruntime-web@${DOLLAR_BRACE}version}/dist/\`;`,
  'const isHFURL = isValidUrl(urlOrPath, ["http:", "https:"], ["huggingface.co", "hf.co"]);',
].join('\n');

const run = (code: string, id = ENGINE_ID) =>
  (neutraliseEngineDefaults.transform as (c: string, i: string) => { code: string } | null)(
    code,
    id,
  );

describe('neutraliseEngineDefaults', () => {
  it('rewrites the remote host, the CDN prefix and the Hugging Face host allow-list', () => {
    const out = run(GOOD)!.code;
    expect(out).not.toContain('huggingface.co');
    expect(out).not.toContain('hf.co');
    expect(out).not.toContain('jsdelivr');
    expect(out).toContain('remoteHost: "https://invalid.invalid/"');
    expect(out).toContain('["http:", "https:"], ["invalid.invalid"]');
  });

  it('has three rewrites, and each one fails the build when its literal is missing', () => {
    expect(ENGINE_DEFAULTS).toHaveLength(3);
    for (const [from] of ENGINE_DEFAULTS) {
      const without = GOOD.split(from).join('');
      expect(() => run(without), from).toThrow(/no longer contains/);
    }
  });

  it('leaves every other module alone', () => {
    expect(run(GOOD, '/work/src/index.ts')).toBeNull();
    expect(run(GOOD, '/work/node_modules/other/dist/transformers.web.js')).toBeNull();
  });
});

// ---- Sprint 6, D1-04 (B1, backend adapter R17): engine memory options ---------------------------------------
// Written before the code existed; the red run is evidence/sprint-6/D1/red/D1-04-session-options.log. The
// worker host creates sessions on device 'wasm' with enableCpuMemArena false and enableMemPattern false. The
// options reach ONNX Runtime through Transformers.js 4.3.1 (session_options is spread into
// InferenceSession.create); that the engine then behaves identically is the model leg
// (test/browser/model.spec.ts), and the finding about their effect is runtime/docs/memory-options.md.

describe('R17: the worker host passes the engine memory options on the wasm device', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installLocation();
  });
  afterEach(async () => {
    await unloadAllRigs();
    restore();
  });
  const sessionOptionsOf = (w: unknown): unknown =>
    (w as LoopbackWorker).mock.pipelineCalls[0]!.options['session_options'];

  it('memorySessionOptions is exactly the two options for wasm and nothing for webgpu', () => {
    expect(memorySessionOptions('wasm')).toEqual({
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    expect(memorySessionOptions('webgpu')).toBeUndefined();
    // a fresh object each call: nothing shared can be mutated
    expect(memorySessionOptions('wasm')).not.toBe(memorySessionOptions('wasm'));
  });

  it('pipeline() receives session_options { enableCpuMemArena: false, enableMemPattern: false } on wasm', async () => {
    const r = await workerRig({ device: 'wasm' });
    await r.load();
    expect(sessionOptionsOf(r.workers[0])).toEqual({
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
  });

  it('it keeps the descriptor graphOptimizationLevel next to them', async () => {
    const r = await workerRig({
      device: 'wasm',
      world: {
        descriptor: (d) => {
          d['spec'] = 'airplanemode.model/0.2';
          d['sessionOptions'] = { graphOptimizationLevel: 'disabled' };
        },
      },
    });
    await r.load();
    expect(sessionOptionsOf(r.workers[0])).toEqual({
      graphOptimizationLevel: 'disabled',
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
  });

  it('webgpu gets no memory options (ONNX Runtime already forces memory-pattern planning off there)', async () => {
    const r = await workerRig({
      device: 'webgpu',
      world: {
        descriptor: (d) => {
          d['devices'] = ['webgpu'];
        },
      },
    });
    await r.load();
    expect(sessionOptionsOf(r.workers[0])).toBeUndefined();
  });

  it('the application-facing allow-list stays at one key: neither option can be set by sessionOptions', () => {
    expect(checkSessionOptions({ graphOptimizationLevel: 'disabled' })).toEqual({
      graphOptimizationLevel: 'disabled',
    });
    for (const key of ['enableCpuMemArena', 'enableMemPattern'])
      expect(() => checkSessionOptions({ [key]: true })).toThrow(/not allowed/);
  });
});
