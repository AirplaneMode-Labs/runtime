// D1-FIX1-01 / BUG-T1-S5-03 / S1-108 (fix round 1): evict() refuses a row with pin:true unless the caller
// passes {force:true}. A pinned, unheld row is refused with AssetError 'store' and the message
// 'asset is pinned'; force removes it; evictToFit keeps skipping pinned rows. Run on the memory,
// IndexedDB-fake and OPFS-fake stores.

import { beforeAll, describe, expect, it } from 'vitest';
import { AssetManager } from '../src/asset-manager';
import { AssetError } from '../src/errors';
import { EventBus } from '../src/events';
import { IndexedDbAssetStore } from '../src/store/indexeddb';
import { MemoryAssetStore } from '../src/store/memory';
import { OpfsAssetStore } from '../src/store/opfs';
import type { AssetStore } from '../src/store/types';
import { FakeIdbFactory, installFakeKeyRange } from './fake-idb';
import { FakeServer } from './fake-fetch';
import { fakeStorageManager } from './fake-opfs';
import {
  makeEntry,
  makeManifest,
  pseudoRandomBytes,
  sha256HexNode,
  signManifest,
  testTrust,
} from './helpers';

const ORIGIN = 'https://assets.test';
const BYTES = pseudoRandomBytes(64 * 1024, 41);

beforeAll(() => {
  installFakeKeyRange();
});

const STORES: { name: string; make: () => AssetStore }[] = [
  { name: 'memory', make: () => new MemoryAssetStore() },
  {
    name: 'indexeddb (fake)',
    make: () => new IndexedDbAssetStore(new FakeIdbFactory() as unknown as IDBFactory),
  },
  {
    name: 'opfs (fake)',
    make: () => new OpfsAssetStore(fakeStorageManager() as unknown as StorageManager),
  },
];

async function pinnedRow(store: AssetStore, pin: boolean) {
  const server = new FakeServer({ origin: ORIGIN });
  server.addAsset('m', BYTES);
  const entry = makeEntry('m', {
    url: `${ORIGIN}/assets/m`,
    sha256: sha256HexNode(BYTES),
    size: BYTES.length,
    chunkSize: 1048576,
    ...(pin ? { pin: true } : {}),
  });
  const manifest = signManifest(makeManifest({ entries: [entry] }));
  const events = new EventBus(500);
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
  await mgr.ensure('m');
  return { mgr, events };
}

for (const s of STORES) {
  describe(`evict() and pinned rows on the ${s.name} store`, () => {
    it('a pinned, unheld row is refused with store "asset is pinned"; the row and the file stay', async () => {
      const { mgr, events } = await pinnedRow(s.make(), true);
      let err: unknown;
      try {
        await mgr.evict('m');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AssetError);
      expect((err as AssetError).code).toBe('store');
      expect((err as AssetError).message).toBe('asset is pinned');
      expect(await mgr.has('m')).toBe(true);
      expect(events.snapshot().filter((e) => e.name === 'asset.evict')).toEqual([]);
    });

    it('force:true removes the pinned row and emits asset.evict explicit', async () => {
      const { mgr, events } = await pinnedRow(s.make(), true);
      expect(await mgr.evict('m', { force: true })).toBe(true);
      expect(await mgr.has('m')).toBe(false);
      const ev = events.snapshot().filter((e) => e.name === 'asset.evict');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.attrs).toMatchObject({ entryId: 'm', reason: 'explicit' });
    });

    it('a pin set through pin() is refused the same way, and unpin() makes plain evict() work', async () => {
      const { mgr } = await pinnedRow(s.make(), false);
      await mgr.pin('m');
      await expect(mgr.evict('m')).rejects.toMatchObject({
        code: 'store',
        message: 'asset is pinned',
      });
      await mgr.unpin('m');
      expect(await mgr.evict('m')).toBe(true);
    });

    it('an unpinned row is evicted without force (unchanged)', async () => {
      const { mgr } = await pinnedRow(s.make(), false);
      expect(await mgr.evict('m')).toBe(true);
    });

    it('evictToFit keeps skipping the pinned row', async () => {
      const { mgr } = await pinnedRow(s.make(), true);
      expect(await mgr.evictToFit(1)).toBe(0);
      expect(await mgr.has('m')).toBe(true);
    });
  });
}
