// D1-04 (S1-102, S1-100, S1-101 at the asset manager's state store): a validly signed manifest whose id is
// 'constructor' or 'prototype' verifies on first use with a REAL state store, on all three stores (memory,
// IndexedDB through fake-idb, OPFS through a fake directory tree), and the index the stores read back never
// carries a prototype taken from stored bytes. Rows: spec/vectors/state-ids/state-ids.json.
// Written before the fix (red run: evidence/sprint-5/D1/red/D1-04.log).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetManager } from '../src/asset-manager';
import { EventBus } from '../src/events';
import { InMemoryManifestState, verifyManifest, type ManifestState } from '../src/manifest';
import { IndexedDbAssetStore } from '../src/store/indexeddb';
import { MemoryAssetStore } from '../src/store/memory';
import { OpfsAssetStore } from '../src/store/opfs';
import type { AssetStore, IndexFile } from '../src/store/types';
import { FakeIdbFactory, installFakeKeyRange } from './fake-idb';
import { fakeStorageManager, writeOpfsIndexText } from './fake-opfs';
import { RFC8032_PUBLIC, keyIdOf, readJson, specDir } from './helpers';

const dir = resolve(specDir, 'vectors/state-ids');
interface Row {
  file: string;
  trust: string[];
  allowTestKeys: boolean;
  now: string;
  state: ManifestState | null;
  requiresState: boolean;
  expect: { valid: boolean; stage?: string; reason?: string };
}
const rows = readJson<Row[]>(resolve(dir, 'state-ids.json'));
const trust = new Map([[keyIdOf(RFC8032_PUBLIC), RFC8032_PUBLIC]]);
const text = (file: string) => readFileSync(resolve(dir, file), 'utf8');
const idOf = (file: string) => (JSON.parse(text(file)) as { id: string }).id;

let restoreKeyRange: () => void;
beforeAll(() => {
  restoreKeyRange = installFakeKeyRange();
});
afterAll(() => restoreKeyRange());

interface Backend {
  name: string;
  make(): { store: AssetStore; poisonIndex(manifestsJson: string): Promise<void> };
}
const BACKENDS: Backend[] = [
  {
    name: 'memory',
    make: () => {
      const store = new MemoryAssetStore();
      return {
        store,
        poisonIndex: async (manifestsJson) => {
          // the memory store keeps whatever object it is given; crafted bytes cannot reach it any other way
          await store.writeIndex({
            version: 1,
            rows: {},
            manifests: JSON.parse(manifestsJson) as IndexFile['manifests'],
          });
        },
      };
    },
  },
  {
    name: 'indexeddb',
    make: () => {
      const factory = new FakeIdbFactory();
      const store = new IndexedDbAssetStore(factory as unknown as IDBFactory);
      return {
        store,
        poisonIndex: async (manifestsJson) => {
          await store.open();
          factory.setRow('meta', 'index', {
            version: 1,
            rows: {},
            manifests: JSON.parse(manifestsJson) as IndexFile['manifests'],
          });
        },
      };
    },
  },
  {
    name: 'opfs',
    make: () => {
      const sm = fakeStorageManager();
      const store = new OpfsAssetStore(sm as unknown as StorageManager);
      return {
        store,
        poisonIndex: async (manifestsJson) => {
          await store.open();
          await writeOpfsIndexText(sm, `{"version":1,"rows":{},"manifests":${manifestsJson}}`);
        },
      };
    },
  },
];

const STATE = { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' };

for (const backend of BACKENDS) {
  describe(`state-ids on the ${backend.name} store`, () => {
    for (const [i, row] of rows.entries()) {
      it(`row ${i + 1}: ${row.file} ${row.state ? 'with state ' + row.state.version : 'on first use'}: ${row.expect.valid ? 'valid' : row.expect.reason}`, async () => {
        const { store } = backend.make();
        await store.open();
        const id = idOf(row.file);
        if (row.state) {
          // seed through the manager's own path: a first accepted manifest writes the state
          const seed = new AssetManager({
            store,
            allowTestKeys: true,
            allowedOrigins: ['https://assets.test'],
          });
          const first = row.state.version === '1.1.0' ? 'constructor-1.1.0.json' : row.file;
          const seeded = id === 'constructor' ? first : row.file;
          await seed.loadManifest(JSON.parse(text(seeded)), trust, { now: Date.parse(row.now) });
        }
        const events = new EventBus();
        const mgr = new AssetManager({
          store,
          events,
          allowTestKeys: true,
          allowedOrigins: ['https://assets.test'],
        });
        const attempt = mgr.loadManifest(JSON.parse(text(row.file)), trust, {
          now: Date.parse(row.now),
        });
        if (row.expect.valid) {
          await expect(attempt).resolves.toMatchObject({ id });
          // the state was written as an OWN member of the stored index and reads back
          const index = await store.readIndex();
          expect(Object.hasOwn(index.manifests, id)).toBe(true);
          expect(Object.getPrototypeOf(index.manifests)).toBe(null);
          expect(index.manifests[id]).toEqual({
            version: JSON.parse(text(row.file)).version,
            createdAt: '2026-11-01T00:00:00Z',
          });
        } else {
          await expect(attempt).rejects.toMatchObject({
            name: 'ManifestError',
            reason: row.expect.reason,
          });
          // a refused manifest leaves the stored state as it was
          const index = await store.readIndex();
          expect(index.manifests[id]).toEqual(STATE);
        }
      });
    }

    it("a validly signed manifest with the id 'constructor' verifies on first use and the state is written", async () => {
      const { store } = backend.make();
      await store.open();
      const mgr = new AssetManager({
        store,
        allowTestKeys: true,
        allowedOrigins: ['https://assets.test'],
      });
      const m = await mgr.loadManifest(JSON.parse(text('constructor-1.1.0.json')), trust, {
        now: Date.parse('2026-11-14T00:00:00Z'),
      });
      expect(m.id).toBe('constructor');
      expect((await store.readIndex()).manifests['constructor']).toEqual(STATE);
    });

    it('crafted stored bytes never set a prototype: __proto__ and constructor members read back as null-prototype data', async () => {
      const { store, poisonIndex } = backend.make();
      await poisonIndex(
        '{"__proto__":{"version":"9.9.9","createdAt":"2026-11-01T00:00:00Z"},"constructor":{"version":"1.1.0","createdAt":"2026-11-01T00:00:00Z"}}',
      );
      const index = await store.readIndex();
      expect(Object.getPrototypeOf(index.manifests)).toBe(null);
      expect(Object.getPrototypeOf(index.rows)).toBe(null);
      expect(Object.hasOwn(index.manifests, 'constructor')).toBe(true);
      // the object prototype was not touched by the poisoned member
      expect(({} as Record<string, unknown>)['version']).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'version')).toBe(false);
    });

    it('an id with no stored state reads as undefined, never an inherited member', async () => {
      const { store } = backend.make();
      await store.open();
      const index = await store.readIndex();
      for (const id of ['constructor', 'prototype', 'tostring', 'valueof'])
        expect(index.manifests[id], id).toBeUndefined();
      expect(index.rows['constructor']).toBeUndefined();
    });
  });
}

describe('state-ids with the in-memory ManifestState (a Map): the vector rows through verifyManifest', () => {
  for (const [i, row] of rows.entries()) {
    it(`row ${i + 1}: ${row.file}`, async () => {
      const state = new InMemoryManifestState();
      if (row.state) await state.set(idOf(row.file), row.state);
      const r = await verifyManifest(text(row.file), trust, {
        allowTestKeys: true,
        now: Date.parse(row.now),
        state,
      });
      expect(r.ok).toBe(row.expect.valid);
      if (!r.ok) expect(r.reason).toBe(row.expect.reason);
    });
  }
});
