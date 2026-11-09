/**
 * IndexedDB AssetStore (fallback when OPFS is unavailable). Database `airplanemode-runtime`:
 *   assets    sha -> { sha, size, committedAt }        committed files
 *   parts     sha -> PartState                         partial-download state
 *   chunks    [sha, seq] -> { sha, seq, data: Blob }   data of parts and committed files
 *   chunkmeta [sha, seq] -> { sha, seq, len }          chunk lengths (avoids loading data to count)
 *   meta      key -> value                             index.json
 *
 * Chunks are stored as Blobs so readBlob() can return new Blob(chunks) without copying 700 MB into
 * renderer memory; Chrome keeps IndexedDB Blobs on disk.
 *
 * The size of a committed file is the sum of the stored chunk Blob sizes (Blob.size is metadata, no
 * bytes are read), never the chunkmeta lengths: a chunk replaced or truncated in place is therefore
 * caught by the manager's size check without a rehash (S1-018). Part lengths during a download still
 * use chunkmeta, which the store itself wrote a moment earlier.
 */

import {
  emptyIndex,
  type AssetStore,
  type IndexFile,
  type PartState,
  type StoreEstimate,
  type StoreListing,
} from './types';

export const IDB_NAME = 'airplanemode-runtime';
const IDB_VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;

interface ChunkMeta {
  sha: string;
  seq: number;
  len: number;
}
interface ChunkRow {
  sha: string;
  seq: number;
  data: Blob;
}
interface AssetRow {
  sha: string;
  size: number;
  committedAt: number;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

function shaRange(sha: string): IDBKeyRange {
  return IDBKeyRange.bound([sha, 0], [sha, Number.MAX_SAFE_INTEGER]);
}

export class IndexedDbAssetStore implements AssetStore {
  readonly kind = 'indexeddb' as const;
  private db: IDBDatabase | undefined;
  private readonly factory: IDBFactory;
  private readonly storage: StorageManager | undefined;

  constructor(factory?: IDBFactory, storage?: StorageManager) {
    const f = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!f) throw new Error('indexedDB is not available');
    this.factory = f;
    this.storage =
      storage ?? (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  }

  async open(): Promise<void> {
    if (this.db) return;
    const r = this.factory.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('assets'))
        db.createObjectStore('assets', { keyPath: 'sha' });
      if (!db.objectStoreNames.contains('parts'))
        db.createObjectStore('parts', { keyPath: 'sha256' });
      if (!db.objectStoreNames.contains('chunks'))
        db.createObjectStore('chunks', { keyPath: ['sha', 'seq'] });
      if (!db.objectStoreNames.contains('chunkmeta'))
        db.createObjectStore('chunkmeta', { keyPath: ['sha', 'seq'] });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    this.db = await req(r);
    this.db.onversionchange = () => {
      this.db?.close();
      this.db = undefined;
    };
  }

  private conn(): IDBDatabase {
    if (!this.db) throw new Error('store not open');
    return this.db;
  }

  private async metas(sha: string, tx?: IDBTransaction): Promise<ChunkMeta[]> {
    const t = tx ?? this.conn().transaction('chunkmeta', 'readonly');
    const rows = (await req(t.objectStore('chunkmeta').getAll(shaRange(sha)))) as ChunkMeta[];
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  }

  private async isCommitted(sha: string, tx?: IDBTransaction): Promise<boolean> {
    const t = tx ?? this.conn().transaction('assets', 'readonly');
    return (await req(t.objectStore('assets').get(sha))) !== undefined;
  }

  async openPart(sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error(`invalid sha ${sha}`);
  }

  async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
    const tx = this.conn().transaction(['chunks', 'chunkmeta'], 'readwrite');
    const metas = await this.metas(sha, tx);
    const seq = metas.length ? metas[metas.length - 1]!.seq + 1 : 0;
    tx.objectStore('chunks').put({
      sha,
      seq,
      data: new Blob([bytes as BlobPart]),
    } satisfies ChunkRow);
    tx.objectStore('chunkmeta').put({ sha, seq, len: bytes.length } satisfies ChunkMeta);
    await done(tx);
  }

  async truncatePart(sha: string, length: number): Promise<void> {
    const tx = this.conn().transaction(['chunks', 'chunkmeta'], 'readwrite');
    const metas = await this.metas(sha, tx);
    let kept = 0;
    for (const m of metas) {
      if (kept >= length) {
        tx.objectStore('chunks').delete([sha, m.seq]);
        tx.objectStore('chunkmeta').delete([sha, m.seq]);
        continue;
      }
      const take = Math.min(m.len, length - kept);
      if (take < m.len) {
        const row = (await req(tx.objectStore('chunks').get([sha, m.seq]))) as ChunkRow | undefined;
        if (row) {
          tx.objectStore('chunks').put({
            sha,
            seq: m.seq,
            data: row.data.slice(0, take),
          } satisfies ChunkRow);
          tx.objectStore('chunkmeta').put({ sha, seq: m.seq, len: take } satisfies ChunkMeta);
        }
      }
      kept += take;
    }
    await done(tx);
  }

  async partLength(sha: string): Promise<number> {
    if (await this.isCommitted(sha)) return 0;
    return (await this.metas(sha)).reduce((n, m) => n + m.len, 0);
  }

  async *readPart(sha: string): AsyncIterable<Uint8Array> {
    if (await this.isCommitted(sha)) return;
    const metas = await this.metas(sha);
    for (const m of metas) {
      const row = (await req(
        this.conn().transaction('chunks', 'readonly').objectStore('chunks').get([sha, m.seq]),
      )) as ChunkRow | undefined;
      if (row) yield new Uint8Array(await row.data.arrayBuffer());
    }
  }

  async partState(sha: string): Promise<PartState | undefined> {
    const row = (await req(
      this.conn().transaction('parts', 'readonly').objectStore('parts').get(sha),
    )) as PartState | undefined;
    return row ? { ...row } : undefined;
  }

  async writePartState(sha: string, state: PartState): Promise<void> {
    const tx = this.conn().transaction('parts', 'readwrite');
    tx.objectStore('parts').put({ ...state, sha256: sha });
    await done(tx);
  }

  async removePart(sha: string): Promise<void> {
    if (await this.isCommitted(sha)) {
      const tx = this.conn().transaction('parts', 'readwrite');
      tx.objectStore('parts').delete(sha);
      await done(tx);
      return;
    }
    const tx = this.conn().transaction(['parts', 'chunks', 'chunkmeta'], 'readwrite');
    tx.objectStore('parts').delete(sha);
    tx.objectStore('chunks').delete(shaRange(sha));
    tx.objectStore('chunkmeta').delete(shaRange(sha));
    await done(tx);
  }

  commitReserve(_size: number, _chunkSize: number): number {
    return 0; // commit is a metadata-only transaction; the chunk Blobs stay where they are
  }

  async commit(sha: string): Promise<void> {
    const tx = this.conn().transaction(['assets', 'parts', 'chunkmeta'], 'readwrite');
    const metas = await this.metas(sha, tx);
    const size = metas.reduce((n, m) => n + m.len, 0);
    tx.objectStore('assets').put({ sha, size, committedAt: Date.now() } satisfies AssetRow);
    tx.objectStore('parts').delete(sha);
    await done(tx);
  }

  async readBlob(sha: string): Promise<Blob> {
    if (!(await this.isCommitted(sha))) throw new Error(`no committed file for ${sha}`);
    const rows = (await req(
      this.conn().transaction('chunks', 'readonly').objectStore('chunks').getAll(shaRange(sha)),
    )) as ChunkRow[];
    rows.sort((a, b) => a.seq - b.seq);
    return new Blob(rows.map((r) => r.data));
  }

  async fileSize(sha: string): Promise<number | undefined> {
    if (!(await this.isCommitted(sha))) return undefined;
    // Blob.size of the stored chunks (S1-018): independent of the chunkmeta rows an attacker or a
    // storage bug could leave unchanged while replacing the data.
    const rows = (await req(
      this.conn().transaction('chunks', 'readonly').objectStore('chunks').getAll(shaRange(sha)),
    )) as ChunkRow[];
    return rows.reduce((n, r) => n + (r.data instanceof Blob ? r.data.size : 0), 0);
  }

  async remove(sha: string): Promise<void> {
    if (!(await this.isCommitted(sha))) return;
    const tx = this.conn().transaction(['assets', 'chunks', 'chunkmeta'], 'readwrite');
    tx.objectStore('assets').delete(sha);
    tx.objectStore('chunks').delete(shaRange(sha));
    tx.objectStore('chunkmeta').delete(shaRange(sha));
    await done(tx);
  }

  async list(): Promise<StoreListing> {
    const tx = this.conn().transaction(['assets', 'parts', 'chunkmeta'], 'readonly');
    const assetRows = (await req(tx.objectStore('assets').getAll())) as AssetRow[];
    const bins = assetRows.map((r) => r.sha);
    const binModified: Record<string, number> = {};
    for (const r of assetRows)
      if (typeof r.committedAt === 'number') binModified[r.sha] = r.committedAt;
    const partStates = (await req(tx.objectStore('parts').getAllKeys())) as string[];
    const metaKeys = (await req(tx.objectStore('chunkmeta').getAllKeys())) as [string, number][];
    const committed = new Set(bins);
    const parts = [...new Set(metaKeys.map((k) => k[0]))].filter((s) => !committed.has(s));
    return { bins, binModified, parts, partStates };
  }

  async readIndex(): Promise<IndexFile> {
    const v = (await req(
      this.conn().transaction('meta', 'readonly').objectStore('meta').get('index'),
    )) as Partial<IndexFile> | undefined;
    if (!v || v.version !== 1 || typeof v.rows !== 'object') return emptyIndex();
    return { version: 1, rows: v.rows ?? {}, manifests: v.manifests ?? {} };
  }

  async writeIndex(index: IndexFile): Promise<void> {
    const tx = this.conn().transaction('meta', 'readwrite');
    tx.objectStore('meta').put(index, 'index');
    await done(tx);
  }

  async estimate(): Promise<StoreEstimate> {
    try {
      if (!this.storage || typeof this.storage.estimate !== 'function') return { usage: 0 };
      const e = await this.storage.estimate();
      const out: StoreEstimate = { usage: e.usage ?? 0 };
      if (typeof e.quota === 'number') out.quota = e.quota;
      return out;
    } catch {
      return { usage: 0 };
    }
  }
}
