import { describe, expect, it, vi } from 'vitest';
import { AdapterError, type AssetHandle, type AssetSource } from '../spec/backend-adapter';
import { MODEL_DESCRIPTOR_MAX_BYTES, MODEL_DESCRIPTOR_MEDIA_TYPE } from '../spec/model-descriptor';
import { loadDescriptor, parseDescriptor } from '../src/backends/descriptor';
import { AssetError } from '../src/errors';
import { descriptorJson, makeWorld, profileOf, type WorldOptions } from './backends-helpers';
import { makeEntry } from './helpers';

const ctxOf = (w: Awaited<ReturnType<typeof makeWorld>>, over: Record<string, unknown> = {}) => ({
  assets: w.mgr as AssetSource,
  profile: profileOf('wasm-simd'),
  adapterId: 'transformers-js',
  device: 'wasm' as const,
  held: [] as AssetHandle[],
  ...over,
});

async function expectCode(p: Promise<unknown>, code: string): Promise<AdapterError> {
  try {
    await p;
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe(code);
    return e as AdapterError;
  }
  throw new Error(`expected AdapterError ${code}`);
}

const acquireSpy = (w: Awaited<ReturnType<typeof makeWorld>>) => vi.spyOn(w.mgr, 'acquire');

describe('loadDescriptor: the happy path (R1)', () => {
  it('acquires the descriptor, reads it with getBlob(id, {rehash:true}), validates and resolves every file', async () => {
    const w = await makeWorld();
    const getBlob = vi.spyOn(w.mgr, 'getBlob');
    const ctx = ctxOf(w);
    const loaded = await loadDescriptor(w.descriptorEntry, ctx);
    expect(loaded.descriptor.id).toBe('m');
    expect(loaded.files.map((f) => f.path)).toEqual([
      'config.json',
      'generation_config.json',
      'onnx/model_q4.onnx',
      'runtime/ort-test.asyncify.wasm',
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
    expect(loaded.files.find((f) => f.path === 'onnx/model_q4.onnx')!.entry.id).toBe('m.onnx-q4');
    expect(getBlob).toHaveBeenCalledWith('m.descriptor', { rehash: true });
    // the descriptor handle is held by the caller until it releases
    expect(ctx.held).toHaveLength(1);
    expect((await w.mgr.list()).find((r) => r.entryId === 'm.descriptor')!.refcount).toBe(1);
    ctx.held[0]!.release();
  });
});

describe('loadDescriptor: refusals before any download', () => {
  it('refuses an entry that is not kind model with the descriptor media type, with zero acquire calls', async () => {
    for (const [over, label] of [
      [{ kind: 'data' as const }, 'kind'],
      [{ mediaType: 'application/json' }, 'mediaType'],
      [{}, 'no mediaType'],
    ] as const) {
      const w = await makeWorld({
        descriptorEntry: over,
        entries: (e) => {
          if (label === 'no mediaType') delete e['m.descriptor']!.mediaType;
        },
      });
      const spy = acquireSpy(w);
      await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'bad_descriptor');
      expect(spy, label).not.toHaveBeenCalled();
      expect(w.server.requests, label).toHaveLength(0);
    }
  });

  it('refuses a descriptor entry larger than 65536 bytes from the manifest entry, with zero acquire calls and no request', async () => {
    const w = await makeWorld({
      descriptorBytes: new Uint8Array(MODEL_DESCRIPTOR_MAX_BYTES + 1).fill(32),
    });
    expect(w.descriptorEntry.size).toBe(MODEL_DESCRIPTOR_MAX_BYTES + 1);
    const spy = acquireSpy(w);
    await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'bad_descriptor');
    expect(spy).not.toHaveBeenCalled();
    expect(w.server.requests).toHaveLength(0);
  });

  it('accepts a descriptor entry of exactly 65536 bytes at the size gate (then fails the parse, not the size)', async () => {
    const text = JSON.stringify(descriptorJson());
    const padded = text + ' '.repeat(MODEL_DESCRIPTOR_MAX_BYTES - text.length);
    const w = await makeWorld({ descriptorText: padded });
    expect(w.descriptorEntry.size).toBe(MODEL_DESCRIPTOR_MAX_BYTES);
    const loaded = await loadDescriptor(w.descriptorEntry, ctxOf(w));
    expect(loaded.descriptor.id).toBe('m');
  });

  it('refuses a descriptor entry whose minProfile the device does not satisfy (unsupported_profile), without downloading', async () => {
    const w = await makeWorld({ descriptorEntry: { minProfile: { gpu: 'webgpu' } } });
    const spy = acquireSpy(w);
    await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'unsupported_profile');
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an entry object that is not the one in this AssetManager's manifest (forged sha256)", async () => {
    const w = await makeWorld();
    const forged = { ...w.descriptorEntry, sha256: 'f'.repeat(64) };
    const spy = acquireSpy(w);
    await expectCode(loadDescriptor(forged, ctxOf(w)), 'bad_descriptor');
    expect(spy).not.toHaveBeenCalled();
    const stranger = makeEntry('not-in-this-manifest', {
      kind: 'model',
      mediaType: MODEL_DESCRIPTOR_MEDIA_TYPE,
    });
    await expectCode(loadDescriptor(stranger, ctxOf(w)), 'bad_descriptor');
  });

  it('an AssetSource without acquire() cannot hold files: unsupported_operation', async () => {
    const w = await makeWorld();
    const { acquire: _a, ...rest } = w.mgr as unknown as Record<string, unknown>;
    const noAcquire = {
      getEntry: (id: string) => w.mgr.getEntry(id),
      getBlob: (id: string, o?: { rehash?: boolean }) => w.mgr.getBlob(id, o),
    } as AssetSource;
    expect(rest).toBeDefined();
    await expectCode(
      loadDescriptor(w.descriptorEntry, ctxOf(w, { assets: noAcquire })),
      'unsupported_operation',
    );
  });
});

describe('loadDescriptor: parse and schema (after acquire)', () => {
  const bad: [string, WorldOptions][] = [
    ['not JSON', { descriptorText: '{ nope' }],
    [
      'a float contextLength spelled 8192.5',
      {
        descriptorText: JSON.stringify(descriptorJson()).replace(
          '"contextLength":2048',
          '"contextLength":2048.5',
        ),
      },
    ],
    [
      'a digit-leading key',
      { descriptorText: JSON.stringify(descriptorJson()).replace('"licence"', '"1licence"') },
    ],
    [
      'a lone surrogate',
      { descriptorText: JSON.stringify(descriptorJson()).replace('"Apache-2.0"', '"\\ud800"') },
    ],
    ['an unknown top-level key', { descriptor: (d) => (d['extra'] = 1) }],
    ['a ".." path', { descriptor: (d) => ((d['files'] as { path: string }[])[0]!.path = '../x') }],
    [
      'unsorted files',
      {
        descriptor: (d) => {
          const f = d['files'] as unknown[];
          f.reverse();
        },
      },
    ],
    [
      'duplicate paths',
      {
        descriptor: (d) => {
          const f = d['files'] as { path: string; entryId: string }[];
          f[1] = { ...f[1]!, path: f[0]!.path };
        },
      },
    ],
    ['transformers-js without runtimeWasm', { descriptor: (d) => delete d['runtimeWasm'] }],
    ['a bad spec string', { descriptor: (d) => (d['spec'] = 'airplanemode.model/0.2') }],
    ['invalid UTF-8', { descriptorBytes: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }],
  ];
  for (const [label, o] of bad) {
    it(`rejects ${label} with bad_descriptor and the held descriptor handle stays with the caller`, async () => {
      const w = await makeWorld(o);
      const ctx = ctxOf(w);
      await expectCode(loadDescriptor(w.descriptorEntry, ctx), 'bad_descriptor');
      for (const h of ctx.held) h.release();
    });
  }

  it('re-checks blob.size <= 65536 after acquire (an AssetSource that returns more than the entry promised)', async () => {
    const w = await makeWorld();
    const oversize = new Blob([new Uint8Array(MODEL_DESCRIPTOR_MAX_BYTES + 10)]);
    const lying = {
      getEntry: (id: string) => w.mgr.getEntry(id),
      getBlob: async () => oversize,
      acquire: async (id: string) => ({
        entryId: id,
        sha256: '0'.repeat(64),
        size: 1,
        held: true,
        release() {},
      }),
    } as AssetSource;
    await expectCode(
      loadDescriptor(w.descriptorEntry, ctxOf(w, { assets: lying })),
      'bad_descriptor',
    );
  });
});

describe('loadDescriptor: cross-checks bound to the manifest of this AssetManager (R1)', () => {
  it('a files[].entryId that is not in the manifest is bad_descriptor', async () => {
    const w = await makeWorld({
      descriptor: (d) => ((d['files'] as { entryId: string }[])[0]!.entryId = 'nobody'),
    });
    await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'bad_descriptor');
  });

  it('a files[].entryId that is itself a descriptor is bad_descriptor (no descriptor chains)', async () => {
    const w = await makeWorld({
      descriptor: (d) => ((d['files'] as { entryId: string }[])[0]!.entryId = 'm.descriptor'),
    });
    await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'bad_descriptor');
    const w2 = await makeWorld({
      entries: (e) => {
        e['m.other-descriptor'] = { ...e['m.descriptor']!, id: 'm.other-descriptor' };
      },
      descriptor: (d) => ((d['files'] as { entryId: string }[])[0]!.entryId = 'm.other-descriptor'),
    });
    await expectCode(loadDescriptor(w2.descriptorEntry, ctxOf(w2)), 'bad_descriptor');
  });

  it('runtimeWasm must name a path listed in files, and that entry must have kind wasm', async () => {
    const w = await makeWorld({ descriptor: (d) => (d['runtimeWasm'] = 'runtime/other.wasm') });
    await expectCode(loadDescriptor(w.descriptorEntry, ctxOf(w)), 'bad_descriptor');
    const w2 = await makeWorld({
      entries: (e) => (e['ort.wasm'] = { ...e['ort.wasm']!, kind: 'data' }),
    });
    await expectCode(loadDescriptor(w2.descriptorEntry, ctxOf(w2)), 'bad_descriptor');
  });

  it('descriptor.engine must equal the adapter id and descriptor.devices must include the adapter device', async () => {
    const w = await makeWorld();
    await expectCode(
      loadDescriptor(w.descriptorEntry, ctxOf(w, { adapterId: 'webllm' })),
      'bad_descriptor',
    );
    const w2 = await makeWorld({ descriptor: (d) => (d['devices'] = ['webgpu']) });
    await expectCode(loadDescriptor(w2.descriptorEntry, ctxOf(w2)), 'bad_descriptor');
    const ok = await loadDescriptor(
      w2.descriptorEntry,
      ctxOf(w2, { device: 'webgpu', profile: profileOf('webgpu-f32') }),
    );
    expect(ok.descriptor.devices).toEqual(['webgpu']);
  });

  it("every file entry's minProfile must hold too (unsupported_profile), checked before any file download", async () => {
    const w = await makeWorld({
      fileEntry: (id) => (id === 'm.onnx-q4' ? { minProfile: { gpu: 'webgpu' as const } } : {}),
    });
    const ctx = ctxOf(w);
    await expectCode(loadDescriptor(w.descriptorEntry, ctx), 'unsupported_profile');
    // only the descriptor itself was requested
    expect(w.server.requests.map((r) => r.url)).toEqual([w.descriptorEntry.url]);
  });
});

describe('loadDescriptor: tamper after verification', () => {
  it('one flipped byte in the stored descriptor makes getBlob(rehash) reject not_verified', async () => {
    const w = await makeWorld();
    const h = await w.mgr.ensure('m.descriptor');
    h.release();
    const sha = w.descriptorEntry.sha256;
    const blob = await w.store.readBlob(sha);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes[5] = bytes[5]! ^ 0x01;
    w.store.corruptBin(sha, bytes);
    try {
      await loadDescriptor(w.descriptorEntry, ctxOf(w));
      expect.unreachable('should have rejected');
    } catch (e) {
      expect(e).toBeInstanceOf(AssetError);
      expect(['not_verified', 'hash_mismatch']).toContain((e as AssetError).code);
    }
  });
});

describe('parseDescriptor', () => {
  it('returns the validated descriptor for canonical input', () => {
    const d = parseDescriptor(JSON.stringify(descriptorJson()));
    expect(d.engine).toBe('transformers-js');
    expect(d.generation?.chatTemplateKwargs).toEqual({ enable_thinking: false });
  });
});
