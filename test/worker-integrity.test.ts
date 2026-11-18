// D1-05 (backend adapter 0.4.0, R15, S1-070): the re-hash of every file the engine can read moves into the
// worker. A one-byte change in any of the eight file kinds is 'integrity' inside the worker and the engine
// receives 0 bytes; the bytes served are exactly the bytes hashed; the main thread no longer re-hashes on the
// load path; the verify phase event comes from the worker host. Written before the move (red run:
// evidence/sprint-5/D1/red/D1-05.log).

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '../spec/model-descriptor';
import { createVerifiedFetch, verifiedRegistrySize } from '../src/backends/verified-files';
import { EGRESS_GUARD_SENTINEL } from '../src/worker/egress-guard';
import type { InitMessage } from '../src/worker/protocol';
import { TjsEngine } from '../src/worker/tjs-engine';
import {
  ORT_FACTORY_URL,
  PAGE_ORIGIN,
  PREFIX,
  eventsNamed,
  installLocation,
  mockEngine,
  makeWorld,
  descriptorJson,
} from './backends-helpers';
import { pseudoRandomBytes } from './helpers';
import { unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
  vi.restoreAllMocks();
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The eight kinds of file an engine can read (R15), one entry each. */
const KINDS: { path: string; entryId: string; kind: string }[] = [
  { path: 'onnx/model_quantized.onnx', entryId: 'k.onnx', kind: 'onnx' },
  { path: 'runtime/ort-test.asyncify.wasm', entryId: 'k.ort-wasm', kind: 'ort wasm' },
  { path: 'tokenizer.json', entryId: 'k.tokenizer', kind: 'tokenizer.json' },
  { path: 'tokenizer_config.json', entryId: 'k.tokenizer-config', kind: 'tokenizer_config.json' },
  { path: 'config.json', entryId: 'k.config', kind: 'config.json' },
  {
    path: 'generation_config.json',
    entryId: 'k.generation-config',
    kind: 'generation_config.json',
  },
  { path: 'chat_template.jinja', entryId: 'k.chat-template', kind: 'chat_template.jinja' },
  { path: 'special_tokens_map.json', entryId: 'k.special-tokens', kind: 'special_tokens_map.json' },
];

function bytesOf(i: number): Uint8Array {
  return pseudoRandomBytes(200 + i * 13, i + 11);
}

function initMessage(
  tamper?: { index: number; mode: 'flip' | 'size' },
  blobFor?: (i: number, bytes: Uint8Array) => Blob,
): InitMessage {
  const descriptor = descriptorJson((d) => {
    d['spec'] = 'airplanemode.model/0.1';
  }) as unknown as ModelDescriptor;
  return {
    v: 1,
    type: 'init',
    adapter: 'transformers-js',
    device: 'wasm',
    loadId: 'a'.repeat(16),
    verifiedPrefix: `${PAGE_ORIGIN}${PREFIX}`,
    ortFactoryUrl: ORT_FACTORY_URL,
    descriptorEntryId: 'm',
    descriptor,
    runtimeWasm: 'runtime/ort-test.asyncify.wasm',
    files: KINDS.map((k, i) => {
      const bytes = bytesOf(i);
      let served = bytes;
      if (tamper?.index === i && tamper.mode === 'flip') {
        served = bytes.slice();
        served[7] = served[7]! ^ 1;
      }
      if (tamper?.index === i && tamper.mode === 'size') served = bytes.slice(0, bytes.length - 1);
      return {
        path: k.path,
        entryId: k.entryId,
        sha256: sha(bytes),
        size: bytes.length,
        blob: blobFor ? blobFor(i, served) : new Blob([served as BlobPart]),
      };
    }),
  };
}

function engineRig(readFiles: string[] = []) {
  const mock = mockEngine({ readFiles });
  const posted: Record<string, unknown>[] = [];
  let loadCalls = 0;
  const engine = new TjsEngine({
    post: (m) => posted.push(m),
    loadEngine: async () => {
      loadCalls++;
      return mock.module as never;
    },
    selfOrigin: PAGE_ORIGIN,
    scope: { [EGRESS_GUARD_SENTINEL]: true },
  });
  return { engine, mock, posted, loadCalls: () => loadCalls };
}

describe('R15: every one of the eight file kinds is hashed in the worker', () => {
  it('the control: untouched files load, the verify phase carries host-side bytes equal to the total hashed, before handoff', async () => {
    const { engine, posted, mock } = engineRig();
    await engine.handle(initMessage());
    const types = posted.map((m) => m['type']);
    expect(types).toContain('ready');
    const phases = posted.filter((m) => m['type'] === 'phase').map((m) => m['phase']);
    expect(phases.slice(0, 3)).toEqual(['verify', 'handoff', 'session']);
    const total = KINDS.reduce((n, _k, i) => n + bytesOf(i).length, 0);
    const verify = posted.find((m) => m['type'] === 'phase' && m['phase'] === 'verify')!;
    expect(verify['bytes']).toBe(total);
    expect(mock.pipelineCalls).toHaveLength(1);
    await engine.unload();
  });

  for (const [i, k] of KINDS.entries()) {
    it(`a one-byte change in ${k.kind} is 'integrity' in the worker and the engine receives 0 bytes`, async () => {
      const { engine, posted, mock, loadCalls } = engineRig();
      const before = verifiedRegistrySize();
      await engine.handle(initMessage({ index: i, mode: 'flip' }));
      expect(posted.filter((m) => m['type'] === 'error')).toEqual([
        { v: 1, type: 'error', code: 'integrity' },
      ]);
      expect(posted.some((m) => m['type'] === 'ready')).toBe(false);
      // the engine never got a byte: not imported, no pipeline, no file read, nothing registered
      expect(loadCalls()).toBe(0);
      expect(mock.pipelineCalls).toHaveLength(0);
      expect(mock.filesRead).toHaveLength(0);
      expect(verifiedRegistrySize()).toBe(before);
    });
  }

  it('a size mismatch is refused before any hashing', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const { engine, posted, loadCalls } = engineRig();
    await engine.handle(initMessage({ index: 4, mode: 'size' }));
    expect(posted.filter((m) => m['type'] === 'error')).toEqual([
      { v: 1, type: 'error', code: 'integrity' },
    ]);
    expect(digest).not.toHaveBeenCalled();
    expect(loadCalls()).toBe(0);
  });

  it('an unreadable Blob (NotReadableError) is integrity', async () => {
    class Flaky extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw Object.assign(new Error('snapshot changed'), { name: 'NotReadableError' });
      }
    }
    const { engine, posted, loadCalls } = engineRig();
    await engine.handle(
      initMessage(undefined, (i, bytes) =>
        i === 2 ? new Flaky([bytes as BlobPart]) : new Blob([bytes as BlobPart]),
      ),
    );
    expect(posted.filter((m) => m['type'] === 'error')).toEqual([
      { v: 1, type: 'error', code: 'integrity' },
    ]);
    expect(loadCalls()).toBe(0);
  });

  it('method (ii): the engine reads the very snapshot that was hashed; a snapshot written after the hash is integrity before the engine receives a byte', async () => {
    // an OPFS File that is modified after the snapshot was taken: hashing read it, later reads fail
    class Snapshot extends Blob {
      override slice(): Blob {
        const failing = new Blob([]);
        failing.arrayBuffer = async () => {
          throw Object.assign(new Error('the file changed'), { name: 'NotReadableError' });
        };
        return failing;
      }
    }
    const { engine, posted, mock } = engineRig(['config.json', 'tokenizer.json']);
    await engine.handle(
      initMessage(undefined, (i, bytes) =>
        i === 4 ? new Snapshot([bytes as BlobPart]) : new Blob([bytes as BlobPart]),
      ),
    );
    expect(posted.filter((m) => m['type'] === 'error')).toEqual([
      { v: 1, type: 'error', code: 'integrity' },
    ]);
    expect(posted.some((m) => m['type'] === 'ready')).toBe(false);
    // the engine asked for config.json first (the changed one): it got no byte and read no other file
    expect(mock.filesRead).toEqual([]);
  });

  it('an unchanged snapshot is served as it is: the engine reads exactly the hashed bytes of every file', async () => {
    const { engine, posted, mock } = engineRig(['config.json', 'tokenizer.json']);
    await engine.handle(initMessage());
    expect(posted.some((m) => m['type'] === 'ready')).toBe(true);
    expect(mock.filesRead.map((f) => [f.path, f.size, f.status])).toEqual([
      ['config.json', bytesOf(4).length, 200],
      ['tokenizer.json', bytesOf(2).length, 200],
    ]);
    const fetched = createVerifiedFetch({ adapterId: 'transformers-js' });
    const res = await fetched(`${PAGE_ORIGIN}${PREFIX}m/config.json`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytesOf(4)))).toBe(true);
    await engine.unload();
  });
});

describe('R15: the main thread no longer re-hashes on the load path', () => {
  it('load() never calls getBlob with rehash true; the verify phase is emitted once, by the worker host', async () => {
    const r = await workerRig();
    const spy = vi.spyOn(r.w.mgr, 'getBlob');
    await r.load();
    expect(
      spy.mock.calls.filter((c) => (c[1] as { rehash?: boolean } | undefined)?.rehash === true),
    ).toEqual([]);
    const phases = eventsNamed(r.events, 'model.load.phase');
    expect(phases.map((e) => e.attrs['phase'])).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
    ]);
    const verify = phases.find((e) => e.attrs['phase'] === 'verify')!;
    expect(verify.attrs['host']).toBe('worker');
    // bytes: every file the worker re-hashed (the descriptor is read and hashed by the manager, not posted)
    const files = r.w.fileIds.reduce((n, id) => n + r.w.entries[id]!.size, 0);
    expect(verify.bytes).toBe(files);
    expect(verify.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a file corrupted on disk after the download is caught by the worker: load rejects integrity and the engine is never created', async () => {
    const r = await workerRig();
    const onnx = r.w.entries['m.onnx-q4']!;
    const bad = pseudoRandomBytes(onnx.size, 99); // same size, other bytes
    // the manager downloads and verifies on acquire(); corrupt the committed file afterwards
    const bytes = r.w.store;
    await r.w.mgr.ensure('m.onnx-q4');
    bytes.corruptBin(onnx.sha256, bad);
    await expect(r.load()).rejects.toMatchObject({ code: 'integrity' });
    expect(
      (r.workers[0] as unknown as { mock: { pipelineCalls: unknown[] } }).mock.pipelineCalls,
    ).toHaveLength(0);
    const failed = eventsNamed(r.events, 'model.load.failed');
    expect(failed[0]!.attrs['code']).toBe('integrity');
  });
});

void makeWorld;
