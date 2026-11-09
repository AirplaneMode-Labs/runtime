import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest, ManifestEntry } from '../spec/manifest';
import { AssetManager } from '../src/asset-manager';
import { AssetError } from '../src/errors';
import { EventBus } from '../src/events';
import { ManifestError } from '../src/manifest';
import { IndexedDbAssetStore } from '../src/store/indexeddb';
import { InProcessLockProvider, WebLocksProvider, type LockManagerLike } from '../src/store/locks';
import { MemoryAssetStore } from '../src/store/memory';
import type { AssetStore, StoreListing } from '../src/store/types';
import { FakeIdbFactory, installFakeKeyRange } from './fake-idb';
import { FakeServer, type FakeServerOptions } from './fake-fetch';
import {
  makeEntry,
  makeManifest,
  pseudoRandomBytes,
  sha256HexNode,
  signManifest,
  testTrust,
} from './helpers';

const KiB = 1024;
const MiB = 1048576;
const ORIGIN = 'https://assets.test';

interface SetupOptions {
  assets: Record<string, Uint8Array>;
  server?: FakeServerOptions;
  manager?: Partial<ConstructorParameters<typeof AssetManager>[0]>;
  entry?: (name: string) => Partial<ManifestEntry>;
  store?: MemoryAssetStore;
  skipLoad?: boolean;
  manifest?: Partial<Manifest>;
}

async function setup(o: SetupOptions) {
  const server = new FakeServer({ origin: ORIGIN, ...o.server });
  const names = Object.keys(o.assets).sort();
  const entries = names.map((name) => {
    const bytes = o.assets[name]!;
    server.addAsset(name, bytes);
    return makeEntry(name, {
      url: `${ORIGIN}/assets/${name}`,
      sha256: sha256HexNode(bytes),
      size: bytes.length,
      chunkSize: MiB,
      ...o.entry?.(name),
    });
  });
  const manifest = signManifest(makeManifest({ entries, ...o.manifest }));
  server.manifestText = JSON.stringify(manifest);
  const store = o.store ?? new MemoryAssetStore();
  const events = new EventBus(5000);
  const mgr = new AssetManager({
    store,
    fetch: server.fetch,
    events,
    allowTestKeys: true,
    allowedOrigins: [ORIGIN],
    headroomBytes: 0,
    progressIntervalMs: 0,
    ...o.manager,
  });
  if (!o.skipLoad) await mgr.loadManifest(manifest, testTrust());
  return { server, manifest, store, events, mgr, names };
}

const names = (events: EventBus) => events.snapshot().map((e) => e.name);
const find = (events: EventBus, name: string) => events.snapshot().filter((e) => e.name === name);

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/** Byte-exact comparison; expect().toEqual on multi-MiB typed arrays takes seconds. */
function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

async function assertConsistent(store: AssetStore) {
  const { bins, parts, partStates } = await store.list();
  const index = await store.readIndex();
  expect(new Set(bins)).toEqual(new Set(Object.keys(index.rows)));
  for (const sha of parts) expect(partStates, `part ${sha} has a state file`).toContain(sha);
  return { bins, parts, partStates, index };
}

async function rejectsWith(p: Promise<unknown>, code: string, reason?: string) {
  try {
    await p;
    expect.unreachable(`expected AssetError ${code}`);
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(AssetError);
    expect((e as AssetError).code).toBe(code);
    if (reason) expect((e as AssetError).reason).toBe(reason);
    return e as AssetError;
  }
  return undefined;
}

const A = pseudoRandomBytes(2 * MiB + 512 * KiB, 1); // 2.5 MiB, three chunks of 1 MiB
const SMALL = pseudoRandomBytes(300 * KiB, 2);

describe('AssetManager: download and verify', () => {
  it('downloads, hashes, commits, and exposes the blob; one plain GET without Range', async () => {
    const { mgr, server, events, store } = await setup({ assets: { a: A } });
    const h = await mgr.ensure('a');
    expect(h).toMatchObject({ entryId: 'a', size: A.length, held: false });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.range).toBeUndefined();
    expect(await mgr.has('a')).toBe(true);
    const rows = await mgr.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: 'a',
      sha256: sha256HexNode(A),
      size: A.length,
      pinned: false,
      refcount: 0,
    });
    expect(rows[0]!.verifiedAt).toBeGreaterThan(0);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    const n = names(events);
    expect(n.indexOf('asset.download.start')).toBeGreaterThanOrEqual(0);
    expect(n.indexOf('asset.download.complete')).toBeGreaterThan(n.indexOf('asset.download.start'));
    expect(n.indexOf('asset.verify.ok')).toBeGreaterThan(n.indexOf('asset.download.complete'));
    const { parts } = await assertConsistent(store);
    expect(parts).toEqual([]);
  });

  it('fetch is called with exactly the hardened options', async () => {
    const { mgr, server } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    const init = server.requests[0]!.init;
    expect(init).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('a second ensure() is a cache hit with no fetch and touches lastAccess', async () => {
    const { mgr, server } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    const before = (await mgr.list())[0]!.lastAccess;
    await new Promise((r) => setTimeout(r, 5));
    await mgr.ensure('a');
    expect(server.calls).toBe(1);
    expect((await mgr.list())[0]!.lastAccess).toBeGreaterThanOrEqual(before);
  });

  it('emits progress events with entryId/received/total/resumedFrom and calls onProgress', async () => {
    const { mgr, events } = await setup({ assets: { a: A } });
    const seen: number[] = [];
    await mgr.ensure('a', { onProgress: (p) => seen.push(p.received) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(A.length);
    const progress = find(events, 'asset.download.progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]!.attrs).toMatchObject({
      entryId: 'a',
      received: A.length,
      total: A.length,
      resumedFrom: 0,
    });
  });

  it('a zero-byte asset downloads and verifies', async () => {
    const { mgr } = await setup({ assets: { z: new Uint8Array(0) } });
    await mgr.ensure('z');
    expect((await mgr.getBlob('z')).size).toBe(0);
  });

  it('getEntry throws for unknown ids and ensure() before loadManifest throws', async () => {
    const { mgr } = await setup({ assets: { a: SMALL } });
    expect(() => mgr.getEntry('nope')).toThrow();
    await expect(mgr.ensure('nope')).rejects.toThrow();
    const fresh = new AssetManager({ store: 'memory', fetch: fetch, allowedOrigins: [ORIGIN] });
    await expect(fresh.ensure('a')).rejects.toThrow();
  });
});

describe('AssetManager: resume', () => {
  it('after a mid-stream failure the partial is kept; the resume sends one Range from bytesWritten with If-Range = strong ETag', async () => {
    const { mgr, server, store, events, manifest } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 300 * KiB },
    });
    const sha = manifest.entries[0]!.sha256;
    await rejectsWith(mgr.ensure('a'), 'network', 'aborted-stream');
    const part = await store.partState(sha);
    expect(part?.bytesWritten).toBe(MiB); // whole chunks only
    expect(await store.partLength(sha)).toBe(MiB);
    expect(await mgr.has('a')).toBe(false);

    server.options.failAfterBytes = undefined;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.range).toBe(`bytes=${MiB}-`);
    expect(req.ifRange).toBe(`"a-${A.length}"`);
    expect(req.status).toBe(206);
    expect(req.bytesSent).toBe(A.length - MiB);
    expect(find(events, 'asset.download.resumed')[0]!.attrs).toMatchObject({
      entryId: 'a',
      resumedFrom: MiB,
    });
    expect(find(events, 'asset.download.progress').pop()!.attrs['resumedFrom']).toBe(MiB);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    expect(await store.partState(sha)).toBeUndefined();
    await assertConsistent(store);
  });

  it('weak ETag => no If-Range header, resume anyway', async () => {
    const { mgr, server } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1, etag: 'weak' },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests[0]!.range).toBe(`bytes=${MiB}-`);
    expect(server.requests[0]!.ifRange).toBeUndefined();
    expect(server.requests[0]!.status).toBe(206);
  });

  it('no ETag but Last-Modified => If-Range carries Last-Modified', async () => {
    const { mgr, server } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1, etag: 'none' },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests[0]!.ifRange).toBe('Mon, 09 Nov 2026 00:00:00 GMT');
  });

  it('neither ETag nor Last-Modified => no If-Range, still resumes', async () => {
    const { mgr, server } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1, etag: 'none', lastModified: false },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests[0]!.ifRange).toBeUndefined();
    expect(server.requests[0]!.range).toBe(`bytes=${MiB}-`);
  });

  it('server answers 200 to a Range request => restart from zero (reason status-200) and still verify', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1 },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.options.ignoreRange = true;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests[0]!.status).toBe(200);
    expect(server.requests[0]!.bytesSent).toBe(A.length);
    expect(find(events, 'asset.download.restarted')[0]!.attrs).toMatchObject({
      entryId: 'a',
      reason: 'status-200',
    });
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('a complete part (bytesWritten == size) => verify and commit without any request', async () => {
    const { mgr, server, store, manifest, events } = await setup({ assets: { a: A } });
    const sha = manifest.entries[0]!.sha256;
    // Simulate a crash after the last append but before verification.
    await store.appendPart(sha, A);
    await store.writePartState(sha, {
      sha256: sha,
      size: A.length,
      url: `${ORIGIN}/assets/a`,
      chunkSize: MiB,
      bytesWritten: A.length,
      etag: `"a-${A.length}"`,
      updatedAt: Date.now(),
    });
    await mgr.ensure('a');
    // A complete part goes straight to verify and commit; no Range request, no 416 round trip.
    expect(server.requests).toHaveLength(0);
    expect(find(events, 'asset.download.start')).toEqual([]);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    expect(await store.partState(sha)).toBeUndefined();
    expect((await store.list()).parts).toEqual([]);
  });

  it('416 when the part is incomplete => restart (reason content-range) and complete', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1 },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.options.statusOnce = 416;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests.map((r) => r.status)).toEqual([416, 200]);
    expect(server.requests[1]!.range).toBeUndefined();
    expect(find(events, 'asset.download.restarted')[0]!.attrs['reason']).toBe('content-range');
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('Content-Range start mismatch => restart', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1 },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.options.contentRangeStart = 7;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests.map((r) => r.status)).toEqual([206, 200]);
    expect(find(events, 'asset.download.restarted')[0]!.attrs['reason']).toBe('content-range');
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('Content-Range total != entry.size => restart', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1 },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.options.contentRangeTotal = A.length + 1;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests.map((r) => r.status)).toEqual([206, 200]);
    expect(find(events, 'asset.download.restarted')[0]!.attrs['reason']).toBe('content-range');
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('part file longer than part.json.bytesWritten => truncate and continue from bytesWritten', async () => {
    const { mgr, server, store, manifest } = await setup({ assets: { a: A } });
    const sha = manifest.entries[0]!.sha256;
    await store.appendPart(sha, A.subarray(0, MiB));
    await store.appendPart(sha, A.subarray(MiB, MiB + 1000));
    await store.writePartState(sha, {
      sha256: sha,
      size: A.length,
      url: `${ORIGIN}/assets/a`,
      chunkSize: MiB,
      bytesWritten: MiB,
      etag: `"a-${A.length}"`,
      updatedAt: Date.now(),
    });
    await mgr.ensure('a');
    expect(server.requests[0]!.range).toBe(`bytes=${MiB}-`);
    expect(server.requests[0]!.bytesSent).toBe(A.length - MiB);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('part file shorter than part.json.bytesWritten => restart (reason part-short)', async () => {
    const { mgr, server, store, manifest, events } = await setup({ assets: { a: A } });
    const sha = manifest.entries[0]!.sha256;
    await store.appendPart(sha, A.subarray(0, 1000));
    await store.writePartState(sha, {
      sha256: sha,
      size: A.length,
      url: `${ORIGIN}/assets/a`,
      chunkSize: MiB,
      bytesWritten: MiB,
      updatedAt: Date.now(),
    });
    await mgr.ensure('a');
    expect(server.requests[0]!.range).toBeUndefined();
    expect(find(events, 'asset.download.restarted')[0]!.attrs['reason']).toBe('part-short');
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('part.json drift (sha256/size/url/chunkSize) => restart (reason part-mismatch)', async () => {
    for (const drift of [
      { size: A.length + 1 },
      { url: `${ORIGIN}/assets/other` },
      { chunkSize: 2 * MiB },
      { sha256: '1'.repeat(64) },
    ]) {
      const { mgr, server, store, manifest, events } = await setup({ assets: { a: A } });
      const sha = manifest.entries[0]!.sha256;
      await store.appendPart(sha, A.subarray(0, MiB));
      await store.writePartState(sha, {
        sha256: sha,
        size: A.length,
        url: `${ORIGIN}/assets/a`,
        chunkSize: MiB,
        bytesWritten: MiB,
        updatedAt: Date.now(),
        ...drift,
      });
      await mgr.ensure('a');
      expect(server.requests[0]!.range, JSON.stringify(drift)).toBeUndefined();
      expect(find(events, 'asset.download.restarted')[0]!.attrs['reason']).toBe('part-mismatch');
      expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    }
  });

  it('abort via signal => AssetError aborted, partial kept for resume', async () => {
    const { mgr, server, store, manifest } = await setup({
      assets: { a: A },
      server: { pieceSize: 64 * KiB },
    });
    const sha = manifest.entries[0]!.sha256;
    const ac = new AbortController();
    const p = mgr.ensure('a', {
      signal: ac.signal,
      onProgress: ({ received }) => {
        if (received > 1.5 * MiB) ac.abort(); // after the first 1 MiB chunk was flushed
      },
    });
    await rejectsWith(p, 'aborted');
    const part = await store.partState(sha);
    expect(part).toBeDefined();
    expect(part!.bytesWritten).toBe(MiB); // whole chunks only; the buffered remainder is dropped
    expect(part!.bytesWritten).toBeLessThan(A.length);
    const before = server.calls;
    await mgr.ensure('a');
    // Locate the resume request by predicate (issued after the abort, carrying a Range header)
    // rather than by index, so request bookkeeping cannot make this order-dependent.
    const after = server.requests.slice(before);
    const ranged = after.filter((r) => r.range !== undefined);
    expect(ranged, JSON.stringify(after.map((r) => [r.range, r.status]))).toHaveLength(1);
    expect(ranged[0]!.range).toBe(`bytes=${part!.bytesWritten}-`);
    expect(ranged[0]!.status).toBe(206);
    expect(ranged[0]!.bytesSent).toBe(A.length - part!.bytesWritten);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    await assertConsistent(store);
  });

  it('abort before the first whole chunk => no part state, the retry downloads from zero', async () => {
    const { mgr, server, store, manifest } = await setup({
      assets: { a: A },
      server: { pieceSize: 64 * KiB },
    });
    const sha = manifest.entries[0]!.sha256;
    const ac = new AbortController();
    const p = mgr.ensure('a', {
      signal: ac.signal,
      onProgress: ({ received }) => {
        if (received > 300 * KiB) ac.abort();
      },
    });
    await rejectsWith(p, 'aborted');
    const part = await store.partState(sha);
    expect(part?.bytesWritten ?? 0).toBe(0);
    server.reset();
    await mgr.ensure('a');
    expect(server.requests.filter((r) => r.range !== undefined)).toHaveLength(0);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });

  it('corrupt part state on disk (S1-017) => restart with reason part-mismatch and complete', async () => {
    const bad: Record<string, unknown>[] = [
      { bytesWritten: 'abc' },
      { bytesWritten: -1 },
      { bytesWritten: NaN },
      { bytesWritten: A.length + 1 },
      { bytesWritten: 1000 }, // not a multiple of chunkSize and not the final size
      { bytesWritten: 1.5 },
      { size: 'big' },
      { chunkSize: 0 },
      { updatedAt: Infinity },
      { url: 42 },
      { etag: 7 },
      { sha256: 'xyz' },
    ];
    for (const drift of bad) {
      const { mgr, server, store, manifest, events } = await setup({ assets: { a: A } });
      const sha = manifest.entries[0]!.sha256;
      await store.appendPart(sha, A.subarray(0, MiB));
      await store.writePartState(sha, {
        sha256: sha,
        size: A.length,
        url: `${ORIGIN}/assets/a`,
        chunkSize: MiB,
        bytesWritten: MiB,
        updatedAt: Date.now(),
        ...drift,
      } as never);
      await mgr.ensure('a');
      const label = JSON.stringify(drift);
      expect(server.requests[0]!.range, label).toBeUndefined();
      expect(find(events, 'asset.download.restarted')[0]!.attrs['reason'], label).toBe(
        'part-mismatch',
      );
      expectBytes(await blobBytes(await mgr.getBlob('a')), A);
      expect(await store.partState(sha), label).toBeUndefined();
    }
  });

  it('a stored part state with bytesWritten == size that is not a chunk multiple is still valid', async () => {
    const { mgr, server, store, manifest } = await setup({ assets: { a: A } });
    const sha = manifest.entries[0]!.sha256;
    await store.appendPart(sha, A);
    await store.writePartState(sha, {
      sha256: sha,
      size: A.length,
      url: `${ORIGIN}/assets/a`,
      chunkSize: MiB,
      bytesWritten: A.length,
      updatedAt: Date.now(),
    });
    await mgr.ensure('a');
    expect(server.calls).toBe(0);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
  });
});

describe('AssetManager: hostile host and validation', () => {
  it('200 with Content-Length != size => network error (content-length), no .bin, index consistent', async () => {
    const { mgr, store, events } = await setup({
      assets: { a: SMALL },
      server: { contentLengthOverride: SMALL.length + 5 },
    });
    await rejectsWith(mgr.ensure('a'), 'network', 'content-length');
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(find(events, 'asset.verify.ok')).toEqual([]);
  });

  it('body longer than size => network error (oversize), no .bin, index consistent', async () => {
    const { mgr, store, server } = await setup({
      assets: { a: SMALL },
      server: { extraBytes: 10 * KiB, omitContentLength: true },
    });
    await rejectsWith(mgr.ensure('a'), 'network', 'oversize');
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(server.requests[0]!.bytesSent).toBeLessThanOrEqual(SMALL.length + 10 * KiB);
    expect(await mgr.has('a')).toBe(false);
  });

  it('200 without Content-Length and an endless body terminates within one chunk over budget', async () => {
    const { mgr, store, server } = await setup({ assets: { a: A }, server: { endless: true } });
    await rejectsWith(mgr.ensure('a'), 'network', 'oversize');
    expect(server.requests[0]!.bytesSent).toBeLessThanOrEqual(A.length + MiB + 64 * KiB);
    const { bins, parts } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(parts).toEqual([]);
  });

  it('a 206 whose body overruns the requested range (oversize on resume) terminates with network', async () => {
    const { mgr, server, store } = await setup({
      assets: { a: A },
      server: { failAfterBytes: MiB + 1 },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    server.options.failAfterBytes = undefined;
    server.options.extraBytes = 5 * KiB;
    server.options.omitContentLength = true;
    server.reset();
    await rejectsWith(mgr.ensure('a'), 'network', 'oversize');
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
  });

  it('hash mismatch => AssetError hash_mismatch, no .bin, no row, asset.verify.failed, getBlob not_verified', async () => {
    const { mgr, store, events } = await setup({
      assets: { a: SMALL },
      server: { corruptAssets: true },
    });
    await rejectsWith(mgr.ensure('a'), 'hash_mismatch');
    const { bins, parts, index } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(parts).toEqual([]);
    expect(Object.keys(index.rows)).toEqual([]);
    expect(find(events, 'asset.verify.failed')[0]!.attrs).toMatchObject({
      entryId: 'a',
      reason: 'hash_mismatch',
    });
    await rejectsWith(mgr.getBlob('a'), 'not_verified');
  });

  it('redirect responses are refused: fetch is called with redirect error and the result is a network error', async () => {
    const { mgr, server, store } = await setup({
      assets: { a: SMALL },
      server: { redirect: true },
    });
    await rejectsWith(mgr.ensure('a'), 'network');
    expect(server.requests[0]!.init.redirect).toBe('error');
    await assertConsistent(store);
  });

  it('an unexpected status (404) is a network error with reason status', async () => {
    const { mgr } = await setup({ assets: { a: SMALL } });
    (mgr as unknown as { manifest: Manifest }).manifest.entries[0]!.url =
      `${ORIGIN}/assets/missing`;
    await rejectsWith(mgr.ensure('a'), 'network', 'status');
  });
});

describe('AssetManager: eviction, quota, pins and refcounts', () => {
  const big = pseudoRandomBytes(700 * KiB, 11);
  const mid = pseudoRandomBytes(400 * KiB, 12);
  const half = pseudoRandomBytes(500 * KiB, 13);

  it('700 + 400, touch A, then 500 with a 1500 KiB quota evicts exactly B with reason quota', async () => {
    const { mgr, events, store } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a'); // touch A: B becomes the LRU candidate
    await mgr.ensure('c');
    const evicts = find(events, 'asset.evict');
    expect(evicts).toHaveLength(1);
    expect(evicts[0]!.attrs).toMatchObject({
      entryId: 'b',
      sha256: sha256HexNode(mid),
      bytes: mid.length,
      reason: 'quota',
    });
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    const { parts } = await assertConsistent(store);
    expect(parts).toEqual([]);
    expect(find(events, 'asset.quota')).toHaveLength(1);
  });

  it('LRU order: without touching A, A (the oldest) is evicted', async () => {
    const { mgr, events } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['a']);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['b', 'c']);
  });

  it('pinned assets are never evicted; the next LRU goes instead', async () => {
    const { mgr, events } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await mgr.pin('a');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    expect((await mgr.list()).find((r) => r.entryId === 'a')!.pinned).toBe(true);
    await mgr.unpin('a');
    expect((await mgr.list()).find((r) => r.entryId === 'a')!.pinned).toBe(false);
  });

  it('a held asset (refcount > 0) is never evicted even as the LRU candidate; evictToFit throws quota', async () => {
    const { mgr, events } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1500 * KiB },
    });
    const ha = await mgr.acquire('a');
    expect(ha.held).toBe(true);
    await new Promise((r) => setTimeout(r, 3));
    const hb = await mgr.acquire('b');
    expect((await mgr.list()).map((r) => r.refcount)).toEqual([1, 1]);
    await rejectsWith(mgr.ensure('c'), 'quota');
    await rejectsWith(mgr.evictToFit(500 * KiB), 'quota');
    expect(find(events, 'asset.evict')).toEqual([]);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'b']);
    hb.release();
    hb.release(); // idempotent
    expect((await mgr.list()).find((r) => r.entryId === 'b')!.refcount).toBe(0);
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    ha.release();
  });

  it('QuotaExceededError on append => evict one LRU and retry; the download completes', async () => {
    class FlakyStore extends MemoryAssetStore {
      failures = 1;
      override async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
        if (this.failures > 0) {
          this.failures--;
          throw new DOMException('quota', 'QuotaExceededError');
        }
        return super.appendPart(sha, bytes);
      }
    }
    const store = new FlakyStore();
    const { mgr, events } = await setup({ assets: { a: big, b: mid }, store });
    store.failures = 0;
    await mgr.ensure('a');
    store.failures = 1;
    await mgr.ensure('b');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['a']);
    expect((await mgr.list()).map((r) => r.entryId)).toEqual(['b']);
    expectBytes(await blobBytes(await mgr.getBlob('b')), mid);
    await assertConsistent(store);
  });

  it('persistent QuotaExceededError with nothing evictable => AssetError quota after retries', async () => {
    class DeadStore extends MemoryAssetStore {
      override async appendPart(): Promise<void> {
        throw new DOMException('quota', 'QuotaExceededError');
      }
    }
    const store = new DeadStore();
    const { mgr } = await setup({ assets: { a: SMALL }, store });
    await rejectsWith(mgr.ensure('a'), 'quota');
    await assertConsistent(store);
  });

  /** Memory store whose commit() throws the platform QuotaExceededError the first n times. */
  class CommitQuotaStore extends MemoryAssetStore {
    commitFailures = 0;
    commitCalls = 0;
    override async commit(sha: string): Promise<void> {
      this.commitCalls++;
      if (this.commitFailures > 0) {
        this.commitFailures--;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return super.commit(sha);
    }
  }

  it('QuotaExceededError on commit => asset.quota, evict one LRU with reason quota, retry, verified (T1-B1)', async () => {
    const store = new CommitQuotaStore();
    const { mgr, events } = await setup({ assets: { a: big, b: mid }, store });
    await mgr.ensure('a');
    store.commitFailures = 1;
    await mgr.ensure('b');
    expect(store.commitCalls).toBe(3); // a, b (failed), b (retry)
    expect(find(events, 'asset.quota')).toHaveLength(1);
    expect(find(events, 'asset.evict').map((e) => e.attrs)).toEqual([
      expect.objectContaining({ entryId: 'a', reason: 'quota' }),
    ]);
    expect((await mgr.list()).map((r) => r.entryId)).toEqual(['b']);
    expect(await mgr.has('b')).toBe(true);
    expectBytes(await blobBytes(await mgr.getBlob('b')), mid);
    const { parts, partStates } = await assertConsistent(store);
    expect(parts).toEqual([]);
    expect(partStates).toEqual([]);
  });

  it('persistent QuotaExceededError on commit with nothing evictable => AssetError quota (not store), no orphan, no part, no stuck state', async () => {
    const store = new CommitQuotaStore();
    store.commitFailures = Number.POSITIVE_INFINITY;
    const { mgr, server, events, manifest } = await setup({ assets: { a: SMALL }, store });
    const sha = manifest.entries[0]!.sha256;
    const err = await rejectsWith(mgr.ensure('a'), 'quota');
    expect(err!.message).toMatch(/commit/);
    const { bins, parts, partStates, index } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(parts).toEqual([]);
    expect(partStates).toEqual([]);
    expect(index.rows).toEqual({});
    expect(await store.fileSize(sha)).toBeUndefined();
    expect(find(events, 'asset.verify.ok')).toEqual([]);
    expect(await mgr.has('a')).toBe(false);
    await rejectsWith(mgr.getBlob('a'), 'not_verified');
    // No stuck-416 state: the next ensure() downloads from zero rather than resuming a dead part.
    store.commitFailures = 0;
    server.reset();
    await mgr.ensure('a');
    expect(server.requests.map((r) => r.range)).toEqual([undefined]);
    expectBytes(await blobBytes(await mgr.getBlob('a')), SMALL);
  });

  it('a non-quota commit failure => AssetError store, and the half-written file and part are removed', async () => {
    class BrokenCommit extends MemoryAssetStore {
      override async commit(sha: string): Promise<void> {
        await super.appendPart(sha, new Uint8Array(1)); // leave debris behind, like a torn write
        throw new Error('disk on fire');
      }
    }
    const store = new BrokenCommit();
    const { mgr } = await setup({ assets: { a: SMALL }, store });
    await rejectsWith(mgr.ensure('a'), 'store');
    const { bins, parts, partStates } = await assertConsistent(store);
    expect(bins).toEqual([]);
    expect(parts).toEqual([]);
    expect(partStates).toEqual([]);
  });

  it('QuotaExceededError from writePartState maps to AssetError quota (S1-019), nothing from the store surfaces raw', async () => {
    class PartStateQuota extends MemoryAssetStore {
      override async writePartState(): Promise<void> {
        throw new DOMException('quota', 'QuotaExceededError');
      }
    }
    const store = new PartStateQuota();
    const { mgr } = await setup({ assets: { a: SMALL }, store });
    await rejectsWith(mgr.ensure('a'), 'quota');
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
  });

  it('a non-quota failure from writeIndex maps to AssetError store (S1-019)', async () => {
    class IndexBroken extends MemoryAssetStore {
      fail = false;
      override async writeIndex(index: Parameters<MemoryAssetStore['writeIndex']>[0]) {
        if (this.fail) throw new Error('EIO');
        return super.writeIndex(index);
      }
    }
    const store = new IndexBroken();
    const { mgr } = await setup({ assets: { a: SMALL }, store });
    store.fail = true;
    await rejectsWith(mgr.ensure('a'), 'store');
  });

  /**
   * A memory store that enforces a byte quota the way Chrome's OPFS does: appends fail when the
   * part would not fit, and commit() needs a transient of one chunk (the largest chunk of the part)
   * on top of the part itself. estimate() reports usage and the quota unless `blindEstimate`.
   */
  class EnforcingStore extends MemoryAssetStore {
    commitQuotaThrows = 0;
    constructor(
      private readonly limit: number,
      private readonly blindEstimate = false,
      private readonly estimateRatio = 1,
    ) {
      super({ quota: limit });
    }
    private async usage(): Promise<number> {
      return (await super.estimate()).usage;
    }
    override async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
      if ((await this.usage()) + bytes.length > this.limit)
        throw new DOMException('quota', 'QuotaExceededError');
      return super.appendPart(sha, bytes);
    }
    override async commit(sha: string): Promise<void> {
      let largest = 0;
      for await (const c of this.readPart(sha)) largest = Math.max(largest, c.length);
      if ((await this.usage()) + largest > this.limit) {
        this.commitQuotaThrows++;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return super.commit(sha);
    }
    override async estimate() {
      const e = await super.estimate();
      const usage = Math.floor(e.usage * this.estimateRatio);
      return this.blindEstimate ? { usage } : { ...e, usage };
    }
    override commitReserve(size: number, chunkSize: number): number {
      return Math.min(size, chunkSize); // like OPFS: one chunk of swap-file transient
    }
  }

  it('KiB-scaled 700/400, touch A, 500 with headroom 0 where commit (not append) is the pinch: the commit reservation evicts exactly B first (T1-B1)', async () => {
    // Quota 1700 KiB: a + b + c = 1600 KiB fits the appends, but committing c needs one more chunk
    // (500 KiB) of transient space, so without the reservation commit would hit the quota.
    const store = new EnforcingStore(1700 * KiB);
    const { mgr, events } = await setup({ assets: { a: big, b: mid, c: half }, store });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    expect(store.commitQuotaThrows).toBe(0); // the reservation made room before commit
    expect(find(events, 'asset.evict').map((e) => e.attrs)).toEqual([
      expect.objectContaining({ entryId: 'b', reason: 'quota', bytes: mid.length }),
    ]);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    for (const id of ['a', 'c']) expect(await mgr.has(id), id).toBe(true);
    const { parts, partStates } = await assertConsistent(store);
    expect(parts).toEqual([]);
    expect(partStates).toEqual([]);
    expectBytes(await blobBytes(await mgr.getBlob('c')), half);
  });

  it('the same scenario with an estimate that reports no quota (reactive path): commit throws once, B is evicted, retry succeeds', async () => {
    const store = new EnforcingStore(1700 * KiB, true);
    const { mgr, events } = await setup({ assets: { a: big, b: mid, c: half }, store });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    expect(store.commitQuotaThrows).toBe(1);
    expect(find(events, 'asset.quota')).toHaveLength(1);
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    const { parts } = await assertConsistent(store);
    expect(parts).toEqual([]);
  });

  /**
   * Memory store whose estimate() reports a fixed fraction of the stored bytes and no quota, the way
   * Chrome's navigator.storage.estimate() behaves for IndexedDB Blob chunks (T1 measured 0.627 of
   * the stored bytes; a 1.5 GiB CDP override never fired). A ratio of 0 is an estimate that reports
   * nothing at all.
   */
  class UnderReportingStore extends MemoryAssetStore {
    constructor(private readonly ratio: number) {
      super();
    }
    override async estimate() {
      const e = await super.estimate();
      return { usage: Math.floor(e.usage * this.ratio) };
    }
  }

  it('T1R-01: estimate at 0.627 of the stored bytes (Chrome IndexedDB) with quotaBytes 1500 KiB: 700 + 400, getBlob A, 500 still evicts exactly B; usage is floored by the index rows', async () => {
    const store = new UnderReportingStore(0.627);
    const { mgr, events } = await setup({
      assets: { a: big, b: mid, c: half },
      store,
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    const evicts = find(events, 'asset.evict');
    expect(evicts).toHaveLength(1);
    expect(evicts[0]!.attrs).toMatchObject({
      entryId: 'b',
      sha256: sha256HexNode(mid),
      bytes: mid.length,
      reason: 'quota',
    });
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    for (const id of ['a', 'c']) expect(await mgr.has(id), id).toBe(true);
    const { parts, partStates } = await assertConsistent(store);
    expect(parts).toEqual([]);
    expect(partStates).toEqual([]);
    // asset.quota carries the floored usage, the quota the manager planned against and the source.
    const quota = find(events, 'asset.quota');
    expect(quota).toHaveLength(1);
    expect(quota[0]!.attrs).toEqual({
      usage: 1100 * KiB,
      quota: 1500 * KiB,
      needed: 100 * KiB,
      usageSource: 'accounted',
    });
    expectBytes(await blobBytes(await mgr.getBlob('c')), half);
  });

  it('T1R-01: bytes already written to an in-flight part count towards usage even when estimate() reports nothing', async () => {
    // quota 4 MiB, headroom 0. a (1.5 MiB) is verified; b (2.5 MiB) fails mid-stream leaving a
    // 2 MiB part; c (1 MiB) then needs 1.5 + 2 + 1 = 4.5 MiB > 4 MiB, so a is evicted (the part is
    // not an index row and is never an eviction candidate). An estimate()-only manager sees 0.
    const store = new UnderReportingStore(0);
    const aBytes = pseudoRandomBytes(MiB + 512 * KiB, 21);
    const cBytes = pseudoRandomBytes(MiB, 23);
    const { mgr, events, server, manifest } = await setup({
      assets: { a: aBytes, b: A, c: cBytes },
      store,
      server: { failAfterBytes: 2 * MiB + 300 * KiB },
      manager: { quotaBytes: 4 * MiB },
    });
    const shaB = manifest.entries.find((e) => e.id === 'b')!.sha256;
    await mgr.ensure('a');
    await rejectsWith(mgr.ensure('b'), 'network', 'aborted-stream');
    expect(await store.partLength(shaB)).toBe(2 * MiB);
    expect(find(events, 'asset.quota')).toEqual([]);
    server.options.failAfterBytes = undefined;
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs)).toEqual([
      expect.objectContaining({ entryId: 'a', reason: 'quota', bytes: aBytes.length }),
    ]);
    expect(find(events, 'asset.quota').map((e) => e.attrs)).toEqual([
      {
        usage: MiB + 512 * KiB + 2 * MiB,
        quota: 4 * MiB,
        needed: 512 * KiB,
        usageSource: 'accounted',
      },
    ]);
    expect((await mgr.list()).map((r) => r.entryId)).toEqual(['c']);
    expect(await store.partLength(shaB)).toBe(2 * MiB); // eviction never touches parts
    await assertConsistent(store);
    // The part still resumes and verifies: one Range request from the 2 MiB boundary.
    server.reset();
    await mgr.ensure('b');
    expect(server.requests.map((r) => r.range)).toEqual([`bytes=${2 * MiB}-`]);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['b', 'c']);
  });

  it('T1R-01: with an accurate estimate (the OPFS path) nothing changes: usage comes from the estimate and the outcome is identical', async () => {
    const { mgr, events, store } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    expect(find(events, 'asset.quota').map((e) => e.attrs)).toEqual([
      { usage: 1100 * KiB, quota: 1500 * KiB, needed: 100 * KiB, usageSource: 'estimate' },
    ]);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    const { parts } = await assertConsistent(store);
    expect(parts).toEqual([]);
  });

  it('T1R-01: an estimate above the accounted bytes (OPFS metadata overhead, other data in the origin) wins: usage is the estimate', async () => {
    const store = new UnderReportingStore(1.01);
    const { mgr, events } = await setup({
      assets: { a: big, b: mid, c: half },
      store,
      manager: { quotaBytes: 1500 * KiB },
    });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    const usage = Math.floor(1100 * KiB * 1.01);
    expect(find(events, 'asset.quota').map((e) => e.attrs)).toEqual([
      { usage, quota: 1500 * KiB, needed: usage + 500 * KiB - 1500 * KiB, usageSource: 'estimate' },
    ]);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
  });

  it('T1R-01: the reactive path (QuotaExceededError on commit) reports the floored usage too', async () => {
    // No quota in the estimate (so no proactive plan) and usage at 0.627: commit throws once, the
    // asset.quota event carries a + b + the complete part of c as usage, source accounted.
    const store = new EnforcingStore(1700 * KiB, true, 0.627);
    const { mgr, events } = await setup({ assets: { a: big, b: mid, c: half }, store });
    await mgr.ensure('a');
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.getBlob('a');
    await mgr.ensure('c');
    expect(store.commitQuotaThrows).toBe(1);
    expect(find(events, 'asset.quota').map((e) => e.attrs)).toEqual([
      { usage: 1600 * KiB, quota: -1, needed: 500 * KiB, usageSource: 'accounted' },
    ]);
    expect(find(events, 'asset.evict').map((e) => e.attrs['entryId'])).toEqual(['b']);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['a', 'c']);
    const { parts } = await assertConsistent(store);
    expect(parts).toEqual([]);
  });

  it('an asset larger than the quota is refused before any fetch with asset.quota emitted', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: big },
      manager: { quotaBytes: 100 * KiB },
    });
    await rejectsWith(mgr.ensure('a'), 'quota');
    expect(server.calls).toBe(0);
    expect(find(events, 'asset.quota')[0]!.attrs).toMatchObject({ quota: 100 * KiB });
  });

  it('headroomBytes counts against the quota', async () => {
    const { mgr } = await setup({
      assets: { a: big },
      manager: { quotaBytes: 750 * KiB, headroomBytes: 100 * KiB },
    });
    await rejectsWith(mgr.ensure('a'), 'quota');
  });

  it('explicit evict() removes row and file, emits reason explicit, has() false; evicting unknown returns false', async () => {
    const { mgr, events, store } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    expect(await mgr.evict('a')).toBe(true);
    expect(await mgr.has('a')).toBe(false);
    expect(find(events, 'asset.evict')[0]!.attrs).toMatchObject({
      entryId: 'a',
      reason: 'explicit',
    });
    expect(await mgr.evict('a')).toBe(false);
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
  });

  it('evict() refuses a held asset (refcount > 0) unless force (S1-020)', async () => {
    const { mgr, events, store } = await setup({ assets: { a: SMALL } });
    const h = await mgr.acquire('a');
    const err = await rejectsWith(mgr.evict('a'), 'store');
    expect(err!.message).toBe('asset is held or downloading');
    expect(await mgr.has('a')).toBe(true);
    expect(find(events, 'asset.evict')).toEqual([]);
    expect(await mgr.evict('a', { force: true })).toBe(true);
    expect(await mgr.has('a')).toBe(false);
    expect(find(events, 'asset.evict').map((e) => e.attrs['reason'])).toEqual(['explicit']);
    h.release();
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
  });

  it('evict() refuses an asset whose download is in flight (S1-020)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    class SlowStore extends MemoryAssetStore {
      override async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
        if (!gated) {
          gated = true;
          await gate;
        }
        return super.appendPart(sha, bytes);
      }
    }
    const store = new SlowStore();
    const { mgr, events } = await setup({ assets: { a: A } });
    const { mgr: slow } = await setup({ assets: { a: A }, store, manager: { events } });
    void mgr; // the first setup only warms helpers; the gated manager is `slow`
    const p = slow.ensure('a');
    while (!gated) await new Promise((r) => setTimeout(r, 1));
    const err = await rejectsWith(slow.evict('a'), 'store');
    expect(err!.message).toBe('asset is held or downloading');
    release();
    await p;
    expect(await slow.has('a')).toBe(true);
    expect(find(events, 'asset.evict')).toEqual([]);
    expect(await slow.evict('a')).toBe(true);
  });

  it('evictToFit(bytes) frees LRU rows first and returns the bytes freed', async () => {
    const { mgr } = await setup({
      assets: { a: big, b: mid, c: half },
      manager: { quotaBytes: 1700 * KiB },
    });
    await mgr.ensure('a');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('b');
    await new Promise((r) => setTimeout(r, 3));
    await mgr.ensure('c');
    // usage 1600 KiB of 1700 KiB; fitting 200 KiB more needs 100 KiB freed => evict A (700 KiB).
    const freed = await mgr.evictToFit(200 * KiB);
    expect(freed).toBe(big.length);
    expect((await mgr.list()).map((r) => r.entryId).sort()).toEqual(['b', 'c']);
    expect(await mgr.evictToFit(0)).toBe(0);
  });

  it('eviction removes the index row before the file (no row ever points at a missing file)', async () => {
    const removed: string[] = [];
    class Tracing extends MemoryAssetStore {
      override async remove(sha: string): Promise<void> {
        const index = await this.readIndex();
        expect(index.rows[sha], 'row must be gone before the file is removed').toBeUndefined();
        removed.push(sha);
        return super.remove(sha);
      }
    }
    const store = new Tracing();
    const { mgr } = await setup({ assets: { a: SMALL }, store });
    await mgr.ensure('a');
    await mgr.evict('a');
    expect(removed).toHaveLength(1);
  });
});

describe('AssetManager: concurrency and locking', () => {
  it('two managers sharing one store and one lock provider download the same sha once', async () => {
    const store = new MemoryAssetStore();
    const locks = new InProcessLockProvider();
    const s1 = await setup({ assets: { a: A }, store, manager: { locks } });
    const s2 = await setup({ assets: { a: A }, store, manager: { locks, fetch: s1.server.fetch } });
    await Promise.all([s1.mgr.ensure('a'), s2.mgr.ensure('a')]);
    expect(s1.server.calls).toBe(1);
    const { bins, index } = await assertConsistent(store);
    expect(bins).toHaveLength(1);
    expect(Object.keys(index.rows)).toHaveLength(1);
    expectBytes(await blobBytes(await s2.mgr.getBlob('a')), A);
  });

  it('concurrent ensure() calls on one manager share a single download', async () => {
    const { mgr, server } = await setup({ assets: { a: A } });
    await Promise.all([mgr.ensure('a'), mgr.ensure('a'), mgr.ensure('a')]);
    expect(server.calls).toBe(1);
  });

  it('different assets download concurrently without corrupting each other', async () => {
    const b = pseudoRandomBytes(MiB + 77, 5);
    const { mgr } = await setup({ assets: { a: A, b } });
    await Promise.all([mgr.ensure('a'), mgr.ensure('b')]);
    expectBytes(await blobBytes(await mgr.getBlob('a')), A);
    expectBytes(await blobBytes(await mgr.getBlob('b')), b);
  });
});

describe('AssetManager: getBlob and verify-before-use', () => {
  it('getBlob for an entry never downloaded rejects not_verified', async () => {
    const { mgr } = await setup({ assets: { a: SMALL } });
    await rejectsWith(mgr.getBlob('a'), 'not_verified');
  });

  it('getBlob when the stored size differs from the row => not_verified, row and file removed, size_changed event', async () => {
    const { mgr, store, events, manifest } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    const sha = manifest.entries[0]!.sha256;
    store.corruptBin(sha, SMALL.subarray(0, SMALL.length - 1));
    await rejectsWith(mgr.getBlob('a'), 'not_verified');
    expect(find(events, 'asset.verify.failed')[0]!.attrs).toMatchObject({
      entryId: 'a',
      reason: 'size_changed',
    });
    expect(await mgr.has('a')).toBe(false);
    const { bins } = await assertConsistent(store);
    expect(bins).toEqual([]);
  });

  it('getBlob with rehash:true accepts intact bytes and rejects same-size corruption', async () => {
    const { mgr, store, events, manifest } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    expectBytes(await blobBytes(await mgr.getBlob('a', { rehash: true })), SMALL);
    const sha = manifest.entries[0]!.sha256;
    const flipped = SMALL.slice();
    flipped[10]! ^= 1;
    store.corruptBin(sha, flipped);
    await expect(mgr.getBlob('a')).resolves.toBeInstanceOf(Blob); // size check alone passes
    await rejectsWith(mgr.getBlob('a', { rehash: true }), 'not_verified');
    expect(find(events, 'asset.verify.failed').pop()!.attrs['reason']).toBe('hash_mismatch');
    expect(await mgr.has('a')).toBe(false);
  });

  it('a row without verifiedAt is never served', async () => {
    const { mgr, store, manifest } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    const sha = manifest.entries[0]!.sha256;
    const index = await store.readIndex();
    delete (index.rows[sha] as { verifiedAt?: number }).verifiedAt;
    await store.writeIndex(index);
    await rejectsWith(mgr.getBlob('a'), 'not_verified');
  });

  it('ensure() handles are not held; acquire() handles are, and list() shows the refcount', async () => {
    const { mgr } = await setup({ assets: { a: SMALL } });
    const h1 = await mgr.ensure('a');
    expect(h1.held).toBe(false);
    h1.release();
    const h2 = await mgr.acquire('a');
    const h3 = await mgr.acquire('a');
    expect((await mgr.list())[0]!.refcount).toBe(2);
    h2.release();
    h2.release();
    expect((await mgr.list())[0]!.refcount).toBe(1);
    h3.release();
    expect((await mgr.list())[0]!.refcount).toBe(0);
  });
});

describe('AssetManager: policy', () => {
  it('an entry URL outside allowedOrigins is blocked before any fetch (policy + asset.download.blocked)', async () => {
    const { mgr, server, events } = await setup({
      assets: { a: SMALL },
      entry: () => ({ url: 'https://evil.example/assets/a' }),
    });
    await rejectsWith(mgr.ensure('a'), 'policy');
    expect(server.calls).toBe(0);
    expect(find(events, 'asset.download.blocked')[0]!.attrs).toMatchObject({
      entryId: 'a',
      origin: 'https://evil.example',
      reason: 'policy',
    });
  });

  it('loadManifest with a manifest object but no URL and no allowedOrigins => policy', async () => {
    const server = new FakeServer({ origin: ORIGIN });
    const manifest = signManifest(makeManifest());
    const mgr = new AssetManager({ store: 'memory', fetch: server.fetch, allowTestKeys: true });
    await rejectsWith(mgr.loadManifest(manifest, testTrust()), 'policy');
  });

  it('loadManifest(url) fetches with hardened options, defaults allowedOrigins to the manifest origin and resolves relative urls', async () => {
    const { server, store } = await setup({
      assets: { a: SMALL },
      entry: (n) => ({ url: `assets/${n}` }),
      skipLoad: true,
    });
    const mgr = new AssetManager({
      store,
      fetch: server.fetch,
      allowTestKeys: true,
      headroomBytes: 0,
    });
    const m = await mgr.loadManifest(`${ORIGIN}/manifest.json`, testTrust());
    expect(m.entries[0]!.url).toBe('assets/a');
    expect(server.requests[0]!.init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
    });
    await mgr.ensure('a');
    expect(server.requests[1]!.url).toBe(`${ORIGIN}/assets/a`);
    expectBytes(await blobBytes(await mgr.getBlob('a')), SMALL);
  });

  it('loadManifest(url) caps the manifest body at 4 MiB: an endless JSON body => network/oversize (S1-016)', async () => {
    let sent = 0;
    const endless: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            sent += 65536;
            c.enqueue(new Uint8Array(65536).fill(0x20));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const mgr = new AssetManager({ store: 'memory', fetch: endless, allowTestKeys: true });
    const err = await rejectsWith(
      mgr.loadManifest(`${ORIGIN}/manifest.json`, testTrust()),
      'network',
      'oversize',
    );
    expect(err!.details).toMatchObject({ limit: 4 * MiB });
    expect(sent).toBeLessThanOrEqual(4 * MiB + 2 * 65536);
    expect(mgr.manifest).toBeUndefined();
  });

  it('loadManifest(url) rejects a Content-Length above the cap before reading the body', async () => {
    let pulled = 0;
    const big: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(1024));
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(5 * MiB) },
        },
      );
    const mgr = new AssetManager({ store: 'memory', fetch: big, allowTestKeys: true });
    await rejectsWith(
      mgr.loadManifest(`${ORIGIN}/manifest.json`, testTrust()),
      'network',
      'oversize',
    );
    expect(pulled).toBeLessThanOrEqual(1); // the stream primes one pull on construction; nothing was read
  });

  it('loadManifest(url) honours an AbortSignal', async () => {
    const { server } = await setup({ assets: { a: SMALL }, skipLoad: true });
    const mgr = new AssetManager({ store: 'memory', fetch: server.fetch, allowTestKeys: true });
    const ac = new AbortController();
    ac.abort();
    await rejectsWith(
      mgr.loadManifest(`${ORIGIN}/manifest.json`, testTrust(), { signal: ac.signal }),
      'aborted',
    );
    const slow: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const mgr2 = new AssetManager({ store: 'memory', fetch: slow, allowTestKeys: true });
    const ac2 = new AbortController();
    const p = mgr2.loadManifest(`${ORIGIN}/manifest.json`, testTrust(), { signal: ac2.signal });
    ac2.abort();
    await rejectsWith(p, 'aborted');
  });

  it('loadManifest accepts [unknown-alg, valid ed25519] and rejects [unknown-alg only] with no_valid_signature (S1-011)', async () => {
    const { mgr, manifest } = await setup({ assets: { a: SMALL }, skipLoad: true });
    const good = manifest.signatures[0]!;
    const weird = { ...good, alg: 'ml-dsa-65' };
    await expect(
      mgr.loadManifest({ ...manifest, signatures: [weird, good] }, testTrust()),
    ).resolves.toBeDefined();
    const { mgr: mgr2 } = await setup({ assets: { a: SMALL }, skipLoad: true });
    await expect(
      mgr2.loadManifest({ ...manifest, signatures: [weird] }, testTrust()),
    ).rejects.toMatchObject({ reason: 'no_valid_signature' });
    const { mgr: mgr3 } = await setup({ assets: { a: SMALL }, skipLoad: true });
    await expect(
      mgr3.loadManifest({ ...manifest, signatures: [{ ...good, alg: 'none' }] }, testTrust()),
    ).rejects.toMatchObject({ reason: 'no_valid_signature' });
  });

  it('loadManifest fails closed with reason state when the index cannot be read for the downgrade rule (S1-013)', async () => {
    class NoIndex extends MemoryAssetStore {
      fail = false;
      override async readIndex() {
        if (this.fail) throw new Error('EIO');
        return super.readIndex();
      }
    }
    const store = new NoIndex();
    const { mgr, manifest, events } = await setup({ assets: { a: SMALL }, store, skipLoad: true });
    await mgr.ready();
    store.fail = true;
    await expect(mgr.loadManifest(manifest, testTrust())).rejects.toMatchObject({
      reason: 'state',
    });
    expect(find(events, 'manifest.verify.failed').pop()!.attrs['reason']).toBe('state_unavailable');
    store.fail = false;
    await expect(mgr.loadManifest(manifest, testTrust())).resolves.toBeDefined();
  });

  it('loadManifest(url) refuses http:// manifest URLs to non-loopback hosts and non-http schemes', async () => {
    const server = new FakeServer({ origin: 'http://cdn.example' });
    const mgr = new AssetManager({ store: 'memory', fetch: server.fetch, allowTestKeys: true });
    await rejectsWith(mgr.loadManifest('http://cdn.example/manifest.json', testTrust()), 'policy');
    await rejectsWith(mgr.loadManifest('data:application/json,{}', testTrust()), 'policy');
    expect(server.calls).toBe(0);
  });

  it('loadManifest(url) accepts loopback http', async () => {
    const { server, store } = await setup({
      assets: { a: SMALL },
      server: { origin: 'http://127.0.0.1:8080' },
      entry: (n) => ({ url: `assets/${n}` }),
      skipLoad: true,
    });
    const mgr = new AssetManager({
      store,
      fetch: server.fetch,
      allowTestKeys: true,
      headroomBytes: 0,
    });
    await mgr.loadManifest('http://127.0.0.1:8080/manifest.json', testTrust());
    await mgr.ensure('a');
    expect(await mgr.has('a')).toBe(true);
  });

  it('a manifest that fails verification is not loaded', async () => {
    const { mgr, manifest } = await setup({ assets: { a: SMALL }, skipLoad: true });
    const tampered = { ...manifest, publisher: 'someone else' };
    await expect(mgr.loadManifest(tampered, testTrust())).rejects.toBeInstanceOf(ManifestError);
    expect(mgr.manifest).toBeUndefined();
    await expect(mgr.ensure('a')).rejects.toThrow();
  });

  it('the RFC 8032 test key is refused unless allowTestKeys', async () => {
    const { server, manifest } = await setup({ assets: { a: SMALL }, skipLoad: true });
    const mgr = new AssetManager({
      store: 'memory',
      fetch: server.fetch,
      allowedOrigins: [ORIGIN],
    });
    await expect(mgr.loadManifest(manifest, testTrust())).rejects.toMatchObject({
      reason: 'test_key_refused',
    });
  });

  it('downgrade state persists in the store index across manager instances', async () => {
    const store = new MemoryAssetStore();
    const s1 = await setup({ assets: { a: SMALL }, store, manifest: { version: '1.2.0' } });
    expect(s1.mgr.manifest?.version).toBe('1.2.0');
    const older = signManifest(makeManifest({ entries: s1.manifest.entries, version: '1.1.9' }));
    await expect(s1.mgr.loadManifest(older, testTrust())).rejects.toMatchObject({
      reason: 'downgrade',
    });
    const mgr2 = new AssetManager({
      store,
      fetch: s1.server.fetch,
      allowTestKeys: true,
      allowedOrigins: [ORIGIN],
    });
    await expect(mgr2.loadManifest(older, testTrust())).rejects.toMatchObject({
      reason: 'downgrade',
    });
    await expect(
      mgr2.loadManifest(older, testTrust(), { allowDowngrade: true }),
    ).resolves.toBeDefined();
    expect((await store.readIndex()).manifests['dev.airplanemode.test']?.version).toBe('1.1.9');
  });
});

describe('AssetManager: reconcile', () => {
  it('removes orphan files, drops rows without files, removes stale parts, keeps fresh parts, never promotes', async () => {
    const { mgr, store, events, manifest } = await setup({
      assets: { a: SMALL, b: SMALL.subarray(0, 100) },
    });
    await mgr.ensure('a');
    // Orphan .bin: a committed file with no index row.
    const orphan = 'f'.repeat(64);
    await store.appendPart(orphan, new Uint8Array([1, 2, 3]));
    await store.commit(orphan);
    // Row without a file.
    const index = await store.readIndex();
    const ghost = 'e'.repeat(64);
    index.rows[ghost] = {
      entryId: 'ghost',
      sha256: ghost,
      size: 3,
      verifiedAt: Date.now(),
      lastAccess: Date.now(),
      pinned: false,
    };
    await store.writeIndex(index);
    // Stale part (31 days) and a fresh part.
    const stale = 'd'.repeat(64);
    await store.appendPart(stale, new Uint8Array(10));
    await store.writePartState(stale, {
      sha256: stale,
      size: 100,
      url: `${ORIGIN}/assets/x`,
      chunkSize: 10,
      bytesWritten: 10,
      updatedAt: Date.now() - 31 * 24 * 3600 * 1000,
    });
    const fresh = manifest.entries[1]!.sha256;
    await store.appendPart(fresh, new Uint8Array(10));
    await store.writePartState(fresh, {
      sha256: fresh,
      size: 100,
      url: `${ORIGIN}/assets/b`,
      chunkSize: 10,
      bytesWritten: 10,
      updatedAt: Date.now(),
    });
    // Part data without a state file.
    const headless = 'c'.repeat(64);
    await store.appendPart(headless, new Uint8Array(5));
    // Part whose state file fails validation (S1-017): removed like a stale one.
    const corrupt = 'b'.repeat(64);
    await store.appendPart(corrupt, new Uint8Array(10));
    await store.writePartState(corrupt, {
      sha256: corrupt,
      size: 100,
      url: `${ORIGIN}/assets/y`,
      chunkSize: 10,
      bytesWritten: 'abc',
      updatedAt: Date.now(),
    } as never);

    const r = await mgr.reconcile();
    expect(r).toEqual({ orphansRemoved: 1, rowsDropped: 1, stalePartsRemoved: 3 });
    const { bins, parts, index: after } = await assertConsistent(store);
    expect(bins).toEqual([manifest.entries[0]!.sha256]);
    expect(Object.keys(after.rows)).toEqual([manifest.entries[0]!.sha256]);
    expect(parts).toEqual([fresh]);
    expect(find(events, 'asset.reconcile').pop()!.attrs).toMatchObject({
      orphansRemoved: 1,
      rowsDropped: 1,
      stalePartsRemoved: 3,
    });
  });

  it('an empty store reconciles to an empty index without throwing', async () => {
    const { mgr, store } = await setup({ assets: { a: SMALL } });
    expect(await mgr.reconcile()).toEqual({
      orphansRemoved: 0,
      rowsDropped: 0,
      stalePartsRemoved: 0,
    });
    expect(await store.readIndex()).toMatchObject({ rows: {} });
    expect(await mgr.list()).toEqual([]);
  });

  it('a manager whose index.json vanished (origin evicted) rebuilds an empty index and re-downloads', async () => {
    const { mgr, store, server } = await setup({ assets: { a: SMALL } });
    await mgr.ensure('a');
    await store.writeIndex({ version: 1, rows: {}, manifests: {} });
    await store.remove((await store.list()).bins[0]!);
    expect(await mgr.has('a')).toBe(false);
    server.reset();
    await mgr.ensure('a');
    expect(server.calls).toBe(1);
  });
});

describe('AssetManager: Sprint 2 deferred Low findings', () => {
  const HELD = (sha: string) => `airplanemode-held:${sha}`;

  /** A memory store that also reports a modification time per committed file. */
  class TimedStore extends MemoryAssetStore {
    modified = new Map<string, number>();
    override async list(): Promise<StoreListing> {
      const l = await super.list();
      return { ...l, binModified: Object.fromEntries(this.modified) };
    }
  }

  async function orphanBin(store: AssetStore, bytes = new Uint8Array([1, 2, 3])) {
    const sha = sha256HexNode(bytes);
    await store.appendPart(sha, bytes);
    await store.commit(sha);
    return sha;
  }

  it('S1-015: reconcile() skips a .bin whose asset:<sha> lock is held (commit not yet indexed)', async () => {
    const locks = new InProcessLockProvider();
    const { mgr, store } = await setup({ assets: { a: SMALL }, manager: { locks } });
    await mgr.ready();
    const sha = await orphanBin(store);
    let during: Awaited<ReturnType<typeof mgr.reconcile>> | undefined;
    await locks.request(`asset:${sha}`, async () => {
      during = await mgr.reconcile();
    });
    expect(during).toEqual({ orphansRemoved: 0, rowsDropped: 0, stalePartsRemoved: 0 });
    expect((await store.list()).bins).toContain(sha);
    // once the commit is finished (lock free) and still no row, the file really is an orphan
    expect((await mgr.reconcile()).orphansRemoved).toBe(1);
    expect((await store.list()).bins).not.toContain(sha);
  });

  it('S1-015: reconcile() skips a .bin that is held under airplanemode-held:<sha> by another instance', async () => {
    const locks = new InProcessLockProvider();
    const { mgr, store } = await setup({ assets: { a: SMALL }, manager: { locks } });
    await mgr.ready();
    const sha = await orphanBin(store);
    const release = await locks.hold!(HELD(sha));
    expect((await mgr.reconcile()).orphansRemoved).toBe(0);
    expect((await store.list()).bins).toContain(sha);
    release();
    expect((await mgr.reconcile()).orphansRemoved).toBe(1);
  });

  it('S1-015: reconcile() skips a .bin younger than 60 s where the store reports a modification time', async () => {
    const store = new TimedStore();
    let clock = 1_000_000;
    const { mgr } = await setup({ assets: { a: SMALL }, store, manager: { now: () => clock } });
    await mgr.ready();
    const young = await orphanBin(store, new Uint8Array([9, 9, 9]));
    store.modified.set(young, clock - 59_000);
    expect((await mgr.reconcile()).orphansRemoved).toBe(0);
    expect((await store.list()).bins).toContain(young);
    clock += 2_000; // now 61 s old
    expect((await mgr.reconcile()).orphansRemoved).toBe(1);
    expect((await store.list()).bins).not.toContain(young);
  });

  describe('S1-018: IndexedDB fileSize() trusts chunk metadata', () => {
    let restore: () => void;
    beforeAll(() => {
      restore = installFakeKeyRange();
    });
    afterAll(() => restore());

    it('S1-018: a truncated chunk Blob makes getBlob reject not_verified even without rehash, and the row is removed', async () => {
      const factory = new FakeIdbFactory();
      const store = new IndexedDbAssetStore(factory as unknown as IDBFactory);
      const { mgr, events, manifest } = await setup({
        assets: { a: A },
        store: store as unknown as MemoryAssetStore,
      });
      await mgr.ensure('a');
      expect((await mgr.getBlob('a')).size).toBe(A.length);
      const sha = manifest.entries[0]!.sha256;
      expect(await store.fileSize(sha)).toBe(A.length);
      // Truncate chunk 1 in place; chunkmeta still claims the original length.
      const chunks = factory.rows('chunks');
      const victim = chunks[1]!;
      const row = victim.value as { sha: string; seq: number; data: Blob };
      factory.setRow('chunks', victim.key, { ...row, data: row.data.slice(0, row.data.size - 10) });
      expect(await store.fileSize(sha)).toBe(A.length - 10);
      await rejectsWith(mgr.getBlob('a'), 'not_verified');
      expect(await mgr.list()).toEqual([]);
      expect(find(events, 'asset.verify.failed').pop()!.attrs['reason']).toBe('size_changed');
      expect(await mgr.has('a')).toBe(false);
    });

    it('S1-018: the IndexedDB store lists a commit time for each committed file', async () => {
      const factory = new FakeIdbFactory();
      const store = new IndexedDbAssetStore(factory as unknown as IDBFactory);
      const { mgr, manifest } = await setup({
        assets: { a: SMALL },
        store: store as unknown as MemoryAssetStore,
      });
      await mgr.ensure('a');
      const listing = await store.list();
      const sha = manifest.entries[0]!.sha256;
      expect(listing.binModified?.[sha]).toBeGreaterThan(0);
    });
  });

  describe('S1-021: eviction window between ensure() and acquire()', () => {
    /** Runs `afterAsset` right after the asset:<sha> lock has been released, in the old gap. */
    class GapLocks extends InProcessLockProvider {
      afterAsset: (() => Promise<unknown>) | undefined;
      override async request<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const r = await super.request(name, fn);
        if (name.startsWith('asset:') && this.afterAsset) {
          const hook = this.afterAsset;
          this.afterAsset = undefined;
          await hook();
        }
        return r;
      }
    }

    it('S1-021: acquire() takes the refcount inside the asset lock: an evictToFit() right after ensure() leaves the asset alone', async () => {
      const locks = new GapLocks();
      const { mgr } = await setup({
        assets: { a: SMALL },
        manager: { locks, quotaBytes: MiB },
      });
      await mgr.ensure('a');
      locks.afterAsset = () => mgr.evictToFit(Number.MAX_SAFE_INTEGER).catch(() => 0);
      const h = await mgr.acquire('a');
      expect(h.held).toBe(true);
      expect(await mgr.has('a')).toBe(true);
      expect((await mgr.list())[0]).toMatchObject({ entryId: 'a', refcount: 1 });
      expect((await mgr.getBlob('a')).size).toBe(SMALL.length);
      h.release();
    });

    it('S1-021: cross-instance hold: A.acquire(x); B.evictToFit(MAX_SAFE_INTEGER) and B.reconcile() leave x intact', async () => {
      const locks = new InProcessLockProvider();
      const a = await setup({ assets: { x: SMALL }, manager: { locks } });
      const hx = await a.mgr.acquire('x');
      const sha = a.manifest.entries[0]!.sha256;
      const b = new AssetManager({
        store: a.store,
        fetch: a.server.fetch,
        allowTestKeys: true,
        allowedOrigins: [ORIGIN],
        headroomBytes: 0,
        quotaBytes: MiB,
        locks,
      });
      await b.ready();
      // B cannot make room for MAX_SAFE_INTEGER bytes and says so, but it must not touch x.
      await rejectsWith(b.evictToFit(Number.MAX_SAFE_INTEGER), 'quota');
      await b.reconcile();
      const { bins, index } = await assertConsistent(a.store);
      expect(bins).toEqual([sha]);
      expect(Object.keys(index.rows)).toEqual([sha]);
      // an explicit evict() in the other instance refuses too, unless forced
      await b.loadManifest(a.manifest, testTrust());
      await rejectsWith(b.evict('x'), 'store');
      expect((await a.store.list()).bins).toEqual([sha]);
      // once A releases, B may evict
      hx.release();
      await rejectsWith(b.evictToFit(Number.MAX_SAFE_INTEGER), 'quota');
      expect((await a.store.list()).bins).toEqual([]);
    });

    it('S1-021: the quota make-room path of another instance also skips a held asset', async () => {
      const locks = new InProcessLockProvider();
      const a = await setup({
        assets: { x: SMALL, y: SMALL.subarray(0, 100) },
        manager: { locks },
      });
      const hx = await a.mgr.acquire('x');
      const b = new AssetManager({
        store: a.store,
        fetch: a.server.fetch,
        allowTestKeys: true,
        allowedOrigins: [ORIGIN],
        headroomBytes: 0,
        quotaBytes: SMALL.length + 50,
        locks,
      });
      await b.loadManifest(a.manifest, testTrust());
      await rejectsWith(b.ensure('y'), 'quota');
      expect(await a.mgr.has('x')).toBe(true);
      hx.release();
    });

    it('S1-021: release() frees the shared hold and is idempotent', async () => {
      const locks = new InProcessLockProvider();
      const { mgr, manifest } = await setup({ assets: { x: SMALL }, manager: { locks } });
      const sha = manifest.entries[0]!.sha256;
      const h = await mgr.acquire('x');
      expect(await locks.isHeld!(HELD(sha))).toBe(true);
      h.release();
      h.release();
      expect(await locks.isHeld!(HELD(sha))).toBe(false);
      const h2 = await mgr.acquire('x');
      const h3 = await mgr.acquire('x');
      h2.release();
      expect(await locks.isHeld!(HELD(sha))).toBe(true);
      h3.release();
      expect(await locks.isHeld!(HELD(sha))).toBe(false);
    });
  });

  describe('S1-054: a hold check that cannot be answered fails closed', () => {
    /**
     * A navigator.locks look-alike on top of an in-process provider. `query` is absent (an old or
     * restricted LockManager) or throws; request() works either way, so holds and the index lock behave.
     */
    function lockManager(query: 'absent' | 'throws'): LockManagerLike {
      const inner = new InProcessLockProvider();
      const m: LockManagerLike = {
        request: (async (name: string, a: unknown, b?: () => Promise<unknown>) => {
          const cb = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
          const mode =
            typeof a === 'object' && a !== null ? (a as { mode?: string }).mode : undefined;
          if (mode === 'shared') {
            const release = await inner.hold(name);
            try {
              return await cb();
            } finally {
              release();
            }
          }
          return inner.request(name, cb);
        }) as LockManagerLike['request'],
      };
      if (query === 'throws')
        m.query = async () => {
          throw new Error('SENTINEL-LOCK-ENGINE-TEXT');
        };
      return m;
    }

    for (const kind of ['absent', 'throws'] as const) {
      const label = kind === 'absent' ? 'has no query()' : 'query() throws';

      it(`S1-054: WebLocksProvider.isHeld reports unknown when navigator.locks ${label}`, async () => {
        const provider = new WebLocksProvider(lockManager(kind));
        expect(await provider.isHeld('airplanemode-held:abc')).toBe('unknown');
      });

      it(`S1-054: A.acquire(x); B.evictToFit(MAX_SAFE_INTEGER) and B.reconcile() leave x's row and .bin intact when navigator.locks ${label}`, async () => {
        const lm = lockManager(kind);
        const a = await setup({
          assets: { x: SMALL },
          manager: { locks: new WebLocksProvider(lm) },
        });
        const hx = await a.mgr.acquire('x');
        const sha = a.manifest.entries[0]!.sha256;
        const bEvents = new EventBus(100);
        const b = new AssetManager({
          store: a.store,
          fetch: a.server.fetch,
          allowTestKeys: true,
          allowedOrigins: [ORIGIN],
          headroomBytes: 0,
          quotaBytes: MiB,
          locks: new WebLocksProvider(lm),
          events: bEvents,
        });
        await b.ready();
        await rejectsWith(b.evictToFit(Number.MAX_SAFE_INTEGER), 'quota');
        await b.reconcile();
        const { bins, index } = await assertConsistent(a.store);
        expect(bins).toEqual([sha]);
        expect(Object.keys(index.rows)).toEqual([sha]);
        // an explicit evict() in the other instance refuses as well
        await b.loadManifest(a.manifest, testTrust());
        await rejectsWith(b.evict('x'), 'store');
        expect((await a.store.list()).bins).toEqual([sha]);
        // one warn event, with an allowed attrs set and no engine text
        const warns = find(bEvents, 'asset.hold.unknown');
        expect(warns).toHaveLength(1);
        expect(warns[0]!.level).toBe('warn');
        expect(warns[0]!.attrs).toEqual({ reason: 'lock_state_unavailable' });
        expect(JSON.stringify(bEvents.snapshot())).not.toContain('SENTINEL');
        hx.release();
      });

      it(`S1-054: reconcile() leaves an unindexed .bin alone when navigator.locks ${label} (a commit may be in flight)`, async () => {
        const lm = lockManager(kind);
        const { mgr, store } = await setup({
          assets: { a: SMALL },
          manager: { locks: new WebLocksProvider(lm) },
        });
        await mgr.ready();
        const bytes = new Uint8Array([4, 5, 6]);
        const sha = sha256HexNode(bytes);
        await store.appendPart(sha, bytes);
        await store.commit(sha);
        expect((await mgr.reconcile()).orphansRemoved).toBe(0);
        expect((await store.list()).bins).toContain(sha);
      });
    }

    it('S1-054: a provider that answers true or false is unchanged: no unknown event, orphans are still removed', async () => {
      const locks = new InProcessLockProvider();
      const { mgr, store, events } = await setup({ assets: { a: SMALL }, manager: { locks } });
      await mgr.ready();
      const bytes = new Uint8Array([7, 8, 9]);
      const sha = sha256HexNode(bytes);
      await store.appendPart(sha, bytes);
      await store.commit(sha);
      expect((await mgr.reconcile()).orphansRemoved).toBe(1);
      expect(find(events, 'asset.hold.unknown')).toHaveLength(0);
    });
  });

  it('S1-031: an invalid stored downgrade state fails closed with reason state and event reason state_unavailable; allowDowngrade bypasses it', async () => {
    const { mgr, manifest, events, store } = await setup({ assets: { a: SMALL }, skipLoad: true });
    await mgr.ready();
    for (const bad of [
      { version: '1.0.0', createdAt: 'garbage' },
      { version: 'not-semver', createdAt: '2026-11-09T00:00:00Z' },
      { version: '1.0.0', createdAt: '2026-99-99T00:00:00Z' },
      { version: 7, createdAt: '2026-11-09T00:00:00Z' },
      'junk',
    ]) {
      const index = await store.readIndex();
      index.manifests[manifest.id] = bad as never;
      await store.writeIndex(index);
      await expect(mgr.loadManifest(manifest, testTrust())).rejects.toMatchObject({
        reason: 'state',
      });
      expect(find(events, 'manifest.verify.failed').pop()!.attrs['reason']).toBe(
        'state_unavailable',
      );
    }
    await expect(
      mgr.loadManifest(manifest, testTrust(), { allowDowngrade: true }),
    ).resolves.toBeDefined();
    // the bypass replaced the corrupt state with a valid one
    expect((await store.readIndex()).manifests[manifest.id]).toEqual({
      version: manifest.version,
      createdAt: manifest.createdAt,
    });
    await expect(mgr.loadManifest(manifest, testTrust())).resolves.toBeDefined();
  });
});
