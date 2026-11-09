/**
 * AssetManager: resumable, verified, cached model and data assets in the browser.
 *
 * Invariants (see README "How it works"):
 * - every fetch uses the hardened options below and only URLs allowed by policy;
 * - bytes are hashed as they stream (a resume re-hashes the stored part first) and a file is
 *   committed to `<sha>.bin` only when the full SHA-256 matches; the index row with verifiedAt is
 *   written after the file; no partial file is ever exposed;
 * - eviction removes the index row before the file; pinned rows, held rows (refcount > 0) and the
 *   asset being downloaded are never evicted;
 * - quota arithmetic never trusts navigator.storage.estimate() alone: usage is the larger of the
 *   estimate and the bytes this manager accounts for (index rows plus in-flight parts), because
 *   Chrome under-reports IndexedDB usage (T1R-01);
 * - ensure() for one sha and every index read-modify-write run inside a lock.
 */

import type { AssetHandle, AssetSource } from '../spec/backend-adapter';
import type { EventAttrs, EventKind, EventLevel, EventSink } from '../spec/event';
import { DEFAULT_CHUNK_SIZE, type Manifest, type ManifestEntry } from '../spec/manifest';
import { AssetError, isAbortError, isQuotaExceeded } from './errors';
import { EventBus, newEvent } from './events';
import {
  ManifestError,
  isAllowedAssetUrl,
  parseManifest,
  verifyManifest,
  type ManifestStateStore,
  type TrustSet,
} from './manifest';
import { Sha256 } from './sha256';
import { IndexedDbAssetStore } from './store/indexeddb';
import { defaultLockProvider } from './store/locks';
import { MemoryAssetStore } from './store/memory';
import { OpfsAssetStore } from './store/opfs';
import {
  validatePartState,
  type AssetStore,
  type IndexFile,
  type IndexRowStored,
  type LockProvider,
  type PartState,
  type StoreEstimate,
} from './store/types';

/** Fixed fetch options: no cookies, no HTTP cache, no redirects, no referrer, CORS mode. */
const FETCH_INIT = Object.freeze({
  method: 'GET',
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
  mode: 'cors',
} as const satisfies RequestInit);

const DEFAULT_HEADROOM = 64 * 1024 * 1024;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_STALE_PART_MS = 30 * 24 * 3600 * 1000;
const MAX_RESTARTS = 3;
const MAX_QUOTA_RETRIES = 3;
/**
 * Hard cap on a fetched manifest body (S1-016); larger bodies are rejected before parsing.
 * Module-internal: not part of the public API in 0.1.0-dev (S1-034).
 */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

export type StoreChoice = AssetStore | 'opfs' | 'indexeddb' | 'memory' | 'auto';

export interface AssetManagerOptions {
  store?: StoreChoice;
  fetch?: typeof fetch;
  /** Test override of the quota; default source is navigator.storage.estimate(). */
  quotaBytes?: number;
  /** Bytes kept free below the quota. Default 64 MiB. */
  headroomBytes?: number;
  /** Origins assets may be fetched from. Default: origin of the manifest URL given to loadManifest. */
  allowedOrigins?: string[];
  locks?: LockProvider;
  events?: EventSink;
  allowTestKeys?: boolean;
  /** Minimum interval between progress events. Default 250 ms. */
  progressIntervalMs?: number;
  /** Age after which reconcile() removes a partial download. Default 30 days. */
  stalePartMaxAgeMs?: number;
  now?: () => number;
}

export interface DownloadProgress {
  entryId: string;
  received: number;
  total: number;
  resumedFrom: number;
}

export interface EnsureOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
}

export interface LoadManifestOptions {
  allowDowngrade?: boolean;
  /** Base URL for relative entry URLs when a manifest object is passed. */
  baseUrl?: string;
  now?: number;
  /** Aborts the manifest fetch (URL form only). */
  signal?: AbortSignal;
}

export interface EvictOptions {
  /** Evict even when the asset is held through acquire() or its download is in flight. */
  force?: boolean;
}

export interface IndexRow extends IndexRowStored {
  refcount: number;
}

export interface ReconcileResult {
  orphansRemoved: number;
  rowsDropped: number;
  stalePartsRemoved: number;
}

type RestartReason =
  'status-200' | 'content-range' | 'part-mismatch' | 'part-short' | 'ignore-range';

/** Where the usage figure of a quota decision came from (asset.quota attrs.usageSource). */
type UsageSource = 'estimate' | 'accounted';

interface UsageSnapshot {
  /** max(estimate.usage, accounted) */
  usage: number;
  usageSource: UsageSource;
  estimate: StoreEstimate;
  accounted: number;
}

class Handle implements AssetHandle {
  private released = false;
  constructor(
    readonly entryId: string,
    readonly sha256: string,
    readonly size: number,
    readonly held: boolean,
    private readonly onRelease: (() => void) | undefined,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease?.();
  }
}

function selectStore(choice: StoreChoice): AssetStore {
  if (typeof choice !== 'string') return choice;
  const g = globalThis as { navigator?: { storage?: StorageManager }; indexedDB?: IDBFactory };
  const hasOpfs = typeof g.navigator?.storage?.getDirectory === 'function';
  const hasIdb = g.indexedDB !== undefined;
  switch (choice) {
    case 'opfs':
      return new OpfsAssetStore();
    case 'indexeddb':
      return new IndexedDbAssetStore();
    case 'memory':
      return new MemoryAssetStore();
    case 'auto':
      return hasOpfs
        ? new OpfsAssetStore()
        : hasIdb
          ? new IndexedDbAssetStore()
          : new MemoryAssetStore();
  }
}

function parseContentRange(
  h: string | null,
): { start: number; end: number; total: number } | undefined {
  if (!h) return undefined;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h.trim());
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    end < start
  )
    return undefined;
  return { start, end, total };
}

export class AssetManager implements AssetSource {
  readonly events: EventBus;
  /** Result of navigator.storage.persist(); undefined when unavailable or not yet requested. */
  persisted: boolean | undefined;

  private readonly store: AssetStore;
  private readonly fetchImpl: typeof fetch;
  private readonly quotaBytes: number | undefined;
  private readonly headroom: number;
  private allowedOrigins: string[] | undefined;
  private readonly locks: LockProvider;
  private readonly sink: EventSink | undefined;
  private readonly allowTestKeys: boolean;
  private readonly progressInterval: number;
  private readonly stalePartMs: number;
  private readonly now: () => number;
  private readyPromise: Promise<void> | undefined;
  private manifestValue: Manifest | undefined;
  private manifestUrl: string | undefined;
  private readonly refcounts = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(options: AssetManagerOptions = {}) {
    this.store = selectStore(options.store ?? 'auto');
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== 'function') {
      throw new AssetError('network', 'no fetch implementation available', { reason: 'fetch' });
    }
    // The global fetch must be called with `this` === globalThis (Chrome: "Illegal invocation").
    this.fetchImpl = f.bind(globalThis) as typeof fetch;
    this.quotaBytes = options.quotaBytes;
    this.headroom = options.headroomBytes ?? DEFAULT_HEADROOM;
    this.allowedOrigins = options.allowedOrigins
      ? options.allowedOrigins.map((o) => new URL(o).origin)
      : undefined;
    this.locks = options.locks ?? defaultLockProvider();
    if (options.events instanceof EventBus) {
      this.events = options.events;
    } else {
      this.events = new EventBus();
      this.sink = options.events;
    }
    this.allowTestKeys = options.allowTestKeys === true;
    this.progressInterval = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.stalePartMs = options.stalePartMaxAgeMs ?? DEFAULT_STALE_PART_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The loaded and verified manifest, if any. */
  get manifest(): Manifest | undefined {
    return this.manifestValue;
  }

  /** Opens the store, requests persistent storage (best effort) and reconciles once. */
  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        try {
          await this.store.open();
        } catch (e) {
          throw new AssetError('store', `cannot open ${this.store.kind} store`, { cause: e });
        }
        if (this.store.kind !== 'memory') {
          const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator
            ?.storage;
          if (storage && typeof storage.persist === 'function') {
            try {
              this.persisted = await storage.persist();
            } catch {
              this.persisted = undefined;
            }
          }
        }
        try {
          await this.reconcile();
        } catch (e) {
          if (e instanceof AssetError) throw e;
          throw new AssetError('store', `cannot reconcile ${this.store.kind} store`, { cause: e });
        }
      })();
    }
    return this.readyPromise;
  }

  // ---- manifest -------------------------------------------------------------------------------

  async loadManifest(
    urlOrObject: string | Manifest | unknown,
    trust: TrustSet,
    opts: LoadManifestOptions = {},
  ): Promise<Manifest> {
    await this.ready();
    let manifest: Manifest;
    let baseUrl: string | undefined;
    if (typeof urlOrObject === 'string') {
      let url: URL;
      try {
        url = new URL(urlOrObject);
      } catch {
        throw new AssetError('policy', `manifest URL is not absolute: ${urlOrObject}`);
      }
      if (!isAllowedAssetUrl(url)) {
        throw new AssetError(
          'policy',
          `manifest URL must be https:// or loopback http://: ${url.href}`,
        );
      }
      const signal = opts.signal;
      if (signal?.aborted) throw new AssetError('aborted', 'manifest fetch aborted');
      let res: Response;
      try {
        const init: RequestInit = { ...FETCH_INIT };
        if (signal) init.signal = signal;
        res = await this.fetchImpl(url.href, init);
      } catch (e) {
        if (isAbortError(e) || signal?.aborted)
          throw new AssetError('aborted', 'manifest fetch aborted', { cause: e });
        throw new AssetError('network', `manifest fetch failed: ${(e as Error).message}`, {
          reason: 'fetch',
          cause: e,
        });
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AssetError('network', `manifest fetch returned ${res.status}`, {
          reason: 'status',
          details: { status: res.status },
        });
      }
      manifest = parseManifest(await this.readManifestBody(res, signal));
      baseUrl = url.href;
      if (!this.allowedOrigins) this.allowedOrigins = [url.origin];
    } else {
      if (!this.allowedOrigins) {
        throw new AssetError(
          'policy',
          'allowedOrigins is required when a manifest object is passed without a URL',
        );
      }
      manifest = parseManifest(urlOrObject);
      baseUrl = opts.baseUrl;
    }
    const verifyOpts: Parameters<typeof verifyManifest>[2] = {
      allowTestKeys: this.allowTestKeys,
      state: this.manifestState(),
      events: this.allSinks(),
    };
    if (opts.allowDowngrade !== undefined) verifyOpts.allowDowngrade = opts.allowDowngrade;
    if (opts.now !== undefined) verifyOpts.now = opts.now;
    const result = await verifyManifest(manifest, trust, verifyOpts);
    if (!result.ok) {
      throw new ManifestError(result.reason, `manifest ${manifest.id} rejected: ${result.reason}`);
    }
    this.manifestValue = manifest;
    this.manifestUrl = baseUrl;
    return manifest;
  }

  /** Reads a manifest body with the MANIFEST_MAX_BYTES cap enforced while streaming (S1-016). */
  private async readManifestBody(res: Response, signal: AbortSignal | undefined): Promise<string> {
    const oversize = (received: number) =>
      new AssetError('network', `manifest body exceeds ${MANIFEST_MAX_BYTES} bytes`, {
        reason: 'oversize',
        details: { limit: MANIFEST_MAX_BYTES, received },
      });
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > MANIFEST_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw oversize(Number(declared));
    }
    const body = res.body;
    if (!body) return '';
    const reader = body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (e) {
          if (signal?.aborted)
            throw new AssetError('aborted', 'manifest fetch aborted', { cause: e });
          throw new AssetError('network', `manifest body failed: ${(e as Error).message}`, {
            reason: 'aborted-stream',
            cause: e,
          });
        }
        if (signal?.aborted) throw new AssetError('aborted', 'manifest fetch aborted');
        if (step.done) break;
        total += step.value.length;
        if (total > MANIFEST_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw oversize(total);
        }
        parts.push(step.value);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    return new TextDecoder().decode(all);
  }

  private manifestState(): ManifestStateStore {
    return {
      get: async (id) => (await this.store.readIndex()).manifests[id],
      set: async (id, state) => {
        await this.withIndex((index) => {
          index.manifests[id] = state;
          return true;
        });
      },
    };
  }

  getEntry(entryId: string): ManifestEntry {
    if (!this.manifestValue) throw new Error('no manifest loaded; call loadManifest() first');
    const entry = this.manifestValue.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`unknown entry ${JSON.stringify(entryId)}`);
    return entry;
  }

  /** Resolves and policy-checks an entry URL. Emits asset.download.blocked and throws on refusal. */
  private resolveUrl(entry: ManifestEntry): string {
    let url: URL;
    try {
      url = this.manifestUrl ? new URL(entry.url, this.manifestUrl) : new URL(entry.url);
    } catch {
      this.emit('asset.download.blocked', 'warn', {
        entryId: entry.id,
        origin: '',
        reason: 'policy',
      });
      throw new AssetError(
        'policy',
        `entry ${entry.id}: relative URL ${JSON.stringify(entry.url)} but no manifest URL to resolve against`,
      );
    }
    const origin = url.origin;
    const allowed =
      isAllowedAssetUrl(url) && !!this.allowedOrigins && this.allowedOrigins.includes(origin);
    if (!allowed) {
      this.emit('asset.download.blocked', 'warn', { entryId: entry.id, origin, reason: 'policy' });
      throw new AssetError('policy', `entry ${entry.id}: origin ${origin} is not allowed`, {
        details: { origin },
      });
    }
    return url.href;
  }

  // ---- public asset API -----------------------------------------------------------------------

  async ensure(entryId: string, opts: EnsureOptions = {}): Promise<AssetHandle> {
    await this.ready();
    const entry = this.getEntry(entryId);
    const url = this.resolveUrl(entry);
    const sha = entry.sha256;
    return this.locks.request(`asset:${sha}`, async () => {
      const row = await this.getRow(sha);
      if (row && row.verifiedAt && (await this.store.fileSize(sha)) === row.size) {
        await this.touch(sha, entry.id);
        return new Handle(entry.id, sha, entry.size, false, undefined);
      }
      if (row) await this.dropRow(sha);
      if ((await this.store.fileSize(sha)) !== undefined)
        await this.storeWrite('remove', () => this.store.remove(sha)); // never promote an unverified file
      this.active.add(sha);
      try {
        await this.download(entry, url, opts);
        await this.commitWithRetry(entry);
        const committed = await this.store.fileSize(sha);
        if (committed !== entry.size) {
          await this.storeWrite('remove', () => this.store.remove(sha));
          throw new AssetError(
            'store',
            `commit of ${entry.id} produced ${committed ?? 'no'} bytes, expected ${entry.size}`,
          );
        }
        const now = this.now();
        await this.withIndex((index) => {
          index.rows[sha] = {
            entryId: entry.id,
            sha256: sha,
            size: entry.size,
            verifiedAt: now,
            lastAccess: now,
            pinned: entry.pin === true || index.rows[sha]?.pinned === true,
          };
          return true;
        });
        this.emit('asset.verify.ok', 'info', { entryId: entry.id, sha256: sha });
      } catch (e) {
        // A storage failure leaves no dead part behind: without consistent state it could never
        // be resumed, and when the quota is the problem it would only hold space hostage.
        if (e instanceof AssetError && (e.code === 'quota' || e.code === 'store'))
          await this.store.removePart(sha).catch(() => undefined);
        throw e;
      } finally {
        this.active.delete(sha);
      }
      return new Handle(entry.id, sha, entry.size, false, undefined);
    });
  }

  async acquire(entryId: string): Promise<AssetHandle> {
    const h = await this.ensure(entryId);
    this.refcounts.set(h.sha256, (this.refcounts.get(h.sha256) ?? 0) + 1);
    return new Handle(h.entryId, h.sha256, h.size, true, () => {
      const n = (this.refcounts.get(h.sha256) ?? 1) - 1;
      if (n <= 0) this.refcounts.delete(h.sha256);
      else this.refcounts.set(h.sha256, n);
    });
  }

  async getBlob(entryId: string, opts: { rehash?: boolean } = {}): Promise<Blob> {
    await this.ready();
    const entry = this.getEntry(entryId);
    const sha = entry.sha256;
    const row = await this.getRow(sha);
    if (!row || typeof row.verifiedAt !== 'number' || row.verifiedAt <= 0) {
      throw new AssetError('not_verified', `asset ${entryId} is not verified`);
    }
    const size = await this.store.fileSize(sha);
    if (size !== row.size) {
      await this.invalidate(sha, entry.id, 'size_changed');
      throw new AssetError(
        'not_verified',
        `asset ${entryId}: stored size ${size ?? 'none'} differs from ${row.size}`,
      );
    }
    let blob: Blob;
    try {
      blob = await this.store.readBlob(sha);
    } catch (e) {
      await this.invalidate(sha, entry.id, 'size_changed');
      throw new AssetError('not_verified', `asset ${entryId}: cannot read stored file`, {
        cause: e,
      });
    }
    if (opts.rehash) {
      const h = new Sha256();
      const reader = blob.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        h.update(value);
      }
      if (h.digestHex() !== sha) {
        await this.invalidate(sha, entry.id, 'hash_mismatch');
        throw new AssetError(
          'not_verified',
          `asset ${entryId}: stored bytes no longer match ${sha}`,
        );
      }
    }
    await this.touch(sha, entry.id);
    return blob;
  }

  async has(entryId: string): Promise<boolean> {
    await this.ready();
    const entry = this.getEntry(entryId);
    const row = await this.getRow(entry.sha256);
    return !!row && typeof row.verifiedAt === 'number' && row.verifiedAt > 0;
  }

  /**
   * Removes a verified asset. Refuses (AssetError 'store', "asset is held or downloading") while
   * the asset is held through acquire() or its download is in flight, unless `force` (S1-020).
   * Emits asset.evict with reason 'explicit' only on success.
   */
  async evict(entryId: string, opts: EvictOptions = {}): Promise<boolean> {
    await this.ready();
    const entry = this.getEntry(entryId);
    const sha = entry.sha256;
    return this.locks.request('index', async () => {
      const refcount = this.refcounts.get(sha) ?? 0;
      const downloading = this.active.has(sha);
      if ((refcount > 0 || downloading) && opts.force !== true) {
        throw new AssetError('store', 'asset is held or downloading', {
          details: { entryId, refcount, downloading },
        });
      }
      const index = await this.store.readIndex();
      const row = index.rows[sha];
      if (!row) return false;
      await this.evictRow(index, row, 'explicit');
      return true;
    });
  }

  /** Frees enough space for `bytes` more (plus headroom) by evicting LRU rows. Returns bytes freed. */
  async evictToFit(bytes: number): Promise<number> {
    await this.ready();
    return this.locks.request('index', () => this.makeRoomLocked(bytes, undefined));
  }

  async list(): Promise<IndexRow[]> {
    await this.ready();
    const index = await this.store.readIndex();
    return Object.values(index.rows).map((r) => ({
      ...r,
      refcount: this.refcounts.get(r.sha256) ?? 0,
    }));
  }

  async pin(entryId: string): Promise<void> {
    await this.setPinned(entryId, true);
  }

  async unpin(entryId: string): Promise<void> {
    await this.setPinned(entryId, false);
  }

  private async setPinned(entryId: string, pinned: boolean): Promise<void> {
    await this.ready();
    const entry = this.getEntry(entryId);
    const changed = await this.withIndex((index) => {
      const row = index.rows[entry.sha256];
      if (!row) return false;
      row.pinned = pinned;
      return true;
    });
    if (!changed) throw new AssetError('not_verified', `asset ${entryId} is not in the index`);
  }

  /** Makes the index and the files agree. Never promotes a file to verified. */
  async reconcile(): Promise<ReconcileResult> {
    const result = await this.locks.request('index', async () => {
      const listing = await this.store.list();
      const index = await this.store.readIndex();
      const bins = new Set(listing.bins);
      let orphansRemoved = 0;
      let rowsDropped = 0;
      let stalePartsRemoved = 0;
      for (const sha of listing.bins) {
        if (!index.rows[sha]) {
          await this.storeWrite('remove', () => this.store.remove(sha));
          orphansRemoved++;
        }
      }
      for (const sha of Object.keys(index.rows)) {
        const row = index.rows[sha]!;
        if (!bins.has(sha) || typeof row.verifiedAt !== 'number') {
          delete index.rows[sha];
          rowsDropped++;
        }
      }
      const now = this.now();
      const partShas = new Set([...listing.parts, ...listing.partStates]);
      for (const sha of partShas) {
        const state = validatePartState(await this.store.partState(sha));
        const hasData = listing.parts.includes(sha);
        const stale = !state || !hasData || now - state.updatedAt > this.stalePartMs;
        if (stale) {
          await this.storeWrite('removePart', () => this.store.removePart(sha));
          stalePartsRemoved++;
        }
      }
      await this.storeWrite('writeIndex', () => this.store.writeIndex(index));
      return { orphansRemoved, rowsDropped, stalePartsRemoved };
    });
    this.emit('asset.reconcile', 'info', { ...result });
    return result;
  }

  // ---- download -------------------------------------------------------------------------------

  private async download(entry: ManifestEntry, url: string, opts: EnsureOptions): Promise<void> {
    const sha = entry.sha256;
    const size = entry.size;
    const chunkSize = entry.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const signal = opts.signal;
    const store = this.store;
    const t0 = this.now();

    let start = 0;
    let hasher = new Sha256();
    let state: PartState | undefined;

    const restart = async (reason: RestartReason) => {
      await this.storeWrite('removePart', () => store.removePart(sha));
      start = 0;
      hasher = new Sha256();
      state = undefined;
      this.emit('asset.download.restarted', 'info', { entryId: entry.id, reason });
    };

    // Reconcile the existing part with its state file. The state is validated (S1-017) before any
    // field is trusted; an invalid state is a mismatch and restarts from zero.
    const rawState = await store.partState(sha);
    const existing = validatePartState(rawState);
    const partLen = await store.partLength(sha);
    if (rawState !== undefined && !existing) {
      await restart('part-mismatch');
    } else if (existing) {
      const drift =
        existing.sha256 !== sha ||
        existing.size !== size ||
        existing.url !== url ||
        existing.chunkSize !== chunkSize;
      if (drift) await restart('part-mismatch');
      else if (partLen < existing.bytesWritten) await restart('part-short');
      else {
        if (partLen > existing.bytesWritten)
          await this.storeWrite('truncatePart', () =>
            store.truncatePart(sha, existing.bytesWritten),
          );
        for await (const chunk of store.readPart(sha)) hasher.update(chunk);
        start = existing.bytesWritten;
        state = existing;
      }
    } else if (partLen > 0) {
      await this.storeWrite('removePart', () => store.removePart(sha));
    }

    // A complete part (bytesWritten == size) goes straight to verification and commit: no Range
    // request, no 416 round trip (T1-B1 item 5). Its bytes were re-hashed above.
    const complete = state !== undefined && size > 0 && start === size;

    if (!complete) {
      await this.locks.request('index', () => this.makeRoomLocked(size - start, sha));
    }

    const resumedFrom = start;
    if (!complete)
      this.emit('asset.download.start', 'info', { entryId: entry.id, total: size, resumedFrom });

    let restarts = 0;
    for (; !complete;) {
      if (signal?.aborted) throw new AssetError('aborted', `download of ${entry.id} aborted`);
      const headers: Record<string, string> = {};
      if (start > 0) {
        headers['Range'] = `bytes=${start}-`;
        const validator = state?.etag ?? state?.lastModified;
        if (validator) headers['If-Range'] = validator;
      }
      let res: Response;
      try {
        const init: RequestInit = { ...FETCH_INIT, headers };
        if (signal) init.signal = signal;
        res = await this.fetchImpl(url, init);
      } catch (e) {
        if (isAbortError(e) || signal?.aborted)
          throw new AssetError('aborted', `download of ${entry.id} aborted`, { cause: e });
        throw new AssetError('network', `fetch failed for ${entry.id}: ${(e as Error).message}`, {
          reason: 'fetch',
          cause: e,
        });
      }

      const status = res.status;
      const contentLength = res.headers.get('content-length');
      const declaredLength = contentLength === null ? undefined : Number(contentLength);

      if (status === 416) {
        // We believe the part is incomplete, so the server's idea of the size differs: restart.
        await res.body?.cancel().catch(() => undefined);
        if (++restarts > MAX_RESTARTS)
          throw new AssetError('network', `too many restarts for ${entry.id}`, {
            reason: 'status',
          });
        await restart('content-range');
        continue;
      }

      if (status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        const bad =
          !cr ||
          cr.start !== start ||
          cr.total !== size ||
          (declaredLength !== undefined && declaredLength !== cr.end - cr.start + 1);
        if (bad) {
          await res.body?.cancel().catch(() => undefined);
          if (++restarts > MAX_RESTARTS)
            throw new AssetError('network', `Content-Range keeps mismatching for ${entry.id}`, {
              reason: 'content-length',
            });
          await restart('content-range');
          continue;
        }
        if (start > 0)
          this.emit('asset.download.resumed', 'info', { entryId: entry.id, resumedFrom: start });
      } else if (status === 200) {
        if (start > 0) {
          if (++restarts > MAX_RESTARTS)
            throw new AssetError('network', `server ignores Range for ${entry.id}`, {
              reason: 'status',
            });
          await restart('status-200');
        }
        if (declaredLength !== undefined && declaredLength !== size) {
          await res.body?.cancel().catch(() => undefined);
          await this.storeWrite('removePart', () => store.removePart(sha));
          throw new AssetError(
            'network',
            `Content-Length ${declaredLength} differs from entry size ${size} for ${entry.id}`,
            {
              reason: 'content-length',
              details: { declared: declaredLength, expected: size },
            },
          );
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
        throw new AssetError('network', `unexpected status ${status} for ${entry.id}`, {
          reason: 'status',
          details: { status },
        });
      }

      if (!state) {
        // Validators for If-Range: a strong ETag, else Last-Modified when the server sent no ETag
        // at all. A weak ETag means no If-Range (we still resume; a 200 answer restarts us).
        const etag = res.headers.get('etag');
        state = { sha256: sha, size, url, chunkSize, bytesWritten: 0, updatedAt: this.now() };
        if (etag && !etag.startsWith('W/')) state.etag = etag;
        const lm = res.headers.get('last-modified');
        if (lm && !etag) state.lastModified = lm;
        const st = state;
        await this.storeWrite('openPart', () => store.openPart(sha));
        await this.storeWrite('writePartState', () => store.writePartState(sha, st));
      }

      await this.pump(entry, res, start, state, hasher, resumedFrom, opts);
      break;
    }

    if (signal?.aborted) throw new AssetError('aborted', `download of ${entry.id} aborted`);
    const digest = hasher.digestHex();
    if (digest !== sha) {
      await this.storeWrite('removePart', () => store.removePart(sha));
      this.emit('asset.verify.failed', 'error', { entryId: entry.id, reason: 'hash_mismatch' });
      throw new AssetError(
        'hash_mismatch',
        `asset ${entry.id}: computed ${digest}, expected ${sha}`,
        {
          details: { expected: sha, computed: digest },
        },
      );
    }
    if (!complete)
      this.emit(
        'asset.download.complete',
        'info',
        { entryId: entry.id, total: size, resumedFrom },
        this.now() - t0,
        size,
      );
  }

  /** Streams a response body into the part in whole chunks, hashing as it goes. */
  private async pump(
    entry: ManifestEntry,
    res: Response,
    start: number,
    state: PartState,
    hasher: Sha256,
    resumedFrom: number,
    opts: EnsureOptions,
  ): Promise<void> {
    const sha = entry.sha256;
    const size = entry.size;
    const chunkSize = state.chunkSize;
    const store = this.store;
    const signal = opts.signal;
    let received = start;
    let bytesWritten = start;
    const pending: Uint8Array[] = [];
    let pendingLen = 0;
    let lastProgress = 0;

    const progress = (final: boolean) => {
      const now = this.now();
      if (!final && now - lastProgress < this.progressInterval) return;
      lastProgress = now;
      const p: DownloadProgress = { entryId: entry.id, received, total: size, resumedFrom };
      this.emit('asset.download.progress', 'debug', { ...p });
      try {
        opts.onProgress?.(p);
      } catch {
        // a progress listener must not break the download
      }
    };

    const flush = async (len: number) => {
      const chunk = new Uint8Array(len);
      let off = 0;
      while (off < len) {
        const head = pending[0]!;
        const take = Math.min(head.length, len - off);
        chunk.set(head.subarray(0, take), off);
        off += take;
        if (take === head.length) pending.shift();
        else pending[0] = head.subarray(take);
      }
      pendingLen -= len;
      await this.appendWithRetry(sha, chunk);
      bytesWritten += len;
      hasher.update(chunk);
      state.bytesWritten = bytesWritten;
      state.updatedAt = this.now();
      await this.storeWrite('writePartState', () => store.writePartState(sha, state));
    };

    const body = res.body;
    if (!body) {
      if (size - start !== 0)
        throw new AssetError('network', `empty body for ${entry.id}`, { reason: 'aborted-stream' });
      progress(true);
      return;
    }
    const reader = body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (e) {
          if (signal?.aborted)
            throw new AssetError('aborted', `download of ${entry.id} aborted`, { cause: e });
          throw new AssetError(
            'network',
            `stream failed for ${entry.id}: ${(e as Error).message}`,
            { reason: 'aborted-stream', cause: e },
          );
        }
        if (signal?.aborted) throw new AssetError('aborted', `download of ${entry.id} aborted`);
        if (step.done) break;
        const value = step.value;
        if (received + value.length > size) {
          await reader.cancel().catch(() => undefined);
          await this.storeWrite('removePart', () => store.removePart(sha));
          this.emit('asset.verify.failed', 'error', { entryId: entry.id, reason: 'oversize' });
          throw new AssetError('network', `server sent more than ${size} bytes for ${entry.id}`, {
            reason: 'oversize',
            details: { expected: size, received: received + value.length },
          });
        }
        received += value.length;
        pending.push(value);
        pendingLen += value.length;
        while (pendingLen >= chunkSize) await flush(chunkSize);
        progress(false);
      }
      if (signal?.aborted) throw new AssetError('aborted', `download of ${entry.id} aborted`);
      if (received !== size) {
        throw new AssetError(
          'network',
          `stream ended at ${received} of ${size} bytes for ${entry.id}`,
          {
            reason: 'aborted-stream',
            details: { received, expected: size },
          },
        );
      }
      if (pendingLen > 0) await flush(pendingLen);
      progress(true);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  /**
   * Every store write goes through here (S1-019): the platform QuotaExceededError (any spelling)
   * becomes AssetError 'quota', anything else AssetError 'store'. AssetErrors pass through.
   */
  private async storeWrite<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AssetError) throw e;
      if (isQuotaExceeded(e))
        throw new AssetError('quota', `storage quota exceeded during ${op}`, { cause: e });
      throw new AssetError('store', `${op} failed on the ${this.store.kind} store`, { cause: e });
    }
  }

  /** Emits asset.quota and evicts one LRU candidate (never `activeSha`). Holder of no lock. */
  private async evictOneForQuota(activeSha: string, needed: number): Promise<boolean> {
    return this.locks.request('index', async () => {
      const index = await this.store.readIndex();
      const snap = await this.usageSnapshot(index);
      this.emit('asset.quota', 'warn', {
        usage: snap.usage,
        quota: this.quotaBytes ?? snap.estimate.quota ?? -1,
        needed,
        usageSource: snap.usageSource,
      });
      const [victim] = this.candidates(index, activeSha);
      if (!victim) return false;
      await this.evictRow(index, victim, 'quota');
      return true;
    });
  }

  private async appendWithRetry(sha: string, chunk: Uint8Array): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.storeWrite('appendPart', () => this.store.appendPart(sha, chunk));
        return;
      } catch (e) {
        if (!(e instanceof AssetError) || e.code !== 'quota') throw e;
        if (attempt >= MAX_QUOTA_RETRIES) throw e;
        const evicted = await this.evictOneForQuota(sha, chunk.length);
        if (!evicted)
          throw new AssetError('quota', 'storage quota exceeded and nothing can be evicted', {
            cause: e,
          });
      }
    }
  }

  /**
   * Commits the complete, verified part (T1-B1). Reserves the store's declared transient (one chunk
   * for OPFS) under the index lock first, best effort; then commits with the same evict-one-and-
   * retry loop as appends while the part is still intact. On terminal failure the half-written
   * file and the part are removed so no orphan and no stuck complete part remain, and the error is
   * 'quota' for a quota failure, 'store' otherwise.
   */
  private async commitWithRetry(entry: ManifestEntry): Promise<void> {
    const sha = entry.sha256;
    const chunkSize = entry.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const reserve = this.store.commitReserve?.(entry.size, chunkSize) ?? 0;
    if (reserve > 0) {
      try {
        await this.locks.request('index', () => this.makeRoomLocked(reserve, sha));
      } catch (e) {
        // The estimate may be wrong (Chrome under-reports IndexedDB usage and ignores quota
        // overrides); the reactive path below is the real guard, so still attempt the commit.
        if (!(e instanceof AssetError && e.code === 'quota')) throw e;
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.storeWrite('commit', () => this.store.commit(sha));
        return;
      } catch (e) {
        const err =
          e instanceof AssetError ? e : new AssetError('store', 'commit failed', { cause: e });
        let retry = false;
        if (err.code === 'quota' && attempt < MAX_QUOTA_RETRIES) {
          const evicted = await this.evictOneForQuota(sha, reserve || chunkSize);
          // Only a still-intact part can be committed again (OPFS consumes chunks as it streams).
          const partLen = await this.store.partLength(sha).catch(() => -1);
          retry = evicted && partLen === entry.size;
        }
        if (retry) continue;
        await this.store.remove(sha).catch(() => undefined);
        await this.store.removePart(sha).catch(() => undefined);
        const opts: { cause?: unknown; reason?: string } = { cause: err.cause ?? err };
        if (err.reason !== undefined) opts.reason = err.reason;
        throw new AssetError(err.code, `commit failed for ${entry.id}: ${err.message}`, opts);
      }
    }
  }

  // ---- index helpers (callers hold the index lock where noted) --------------------------------

  private async getRow(sha: string): Promise<IndexRowStored | undefined> {
    return (await this.store.readIndex()).rows[sha];
  }

  private async withIndex(mutate: (index: IndexFile) => boolean): Promise<boolean> {
    return this.locks.request('index', async () => {
      const index = await this.store.readIndex();
      const changed = mutate(index);
      if (changed) await this.storeWrite('writeIndex', () => this.store.writeIndex(index));
      return changed;
    });
  }

  private async touch(sha: string, entryId: string): Promise<void> {
    const now = this.now();
    await this.withIndex((index) => {
      const row = index.rows[sha];
      if (!row) return false;
      row.lastAccess = now;
      row.entryId = entryId;
      return true;
    });
  }

  private async dropRow(sha: string): Promise<void> {
    await this.withIndex((index) => {
      if (!index.rows[sha]) return false;
      delete index.rows[sha];
      return true;
    });
    await this.storeWrite('remove', () => this.store.remove(sha));
  }

  private async invalidate(
    sha: string,
    entryId: string,
    reason: 'size_changed' | 'hash_mismatch',
  ): Promise<void> {
    await this.dropRow(sha);
    this.emit('asset.verify.failed', 'error', { entryId, reason });
  }

  /** Holder of the index lock only. Removes the row first, then the file. */
  private async evictRow(
    index: IndexFile,
    row: IndexRowStored,
    reason: 'quota' | 'explicit',
  ): Promise<void> {
    delete index.rows[row.sha256];
    await this.storeWrite('writeIndex', () => this.store.writeIndex(index));
    await this.storeWrite('remove', () => this.store.remove(row.sha256));
    this.emit('asset.evict', 'info', {
      entryId: row.entryId,
      sha256: row.sha256,
      bytes: row.size,
      reason,
    });
  }

  private candidates(index: IndexFile, activeSha: string | undefined): IndexRowStored[] {
    return Object.values(index.rows)
      .filter(
        (r) =>
          !r.pinned &&
          r.sha256 !== activeSha &&
          !this.active.has(r.sha256) &&
          (this.refcounts.get(r.sha256) ?? 0) === 0,
      )
      .sort((a, b) => a.lastAccess - b.lastAccess);
  }

  /**
   * Bytes this manager knows it holds: the size of every index row plus the bytes already written
   * to every partial download (the larger of the stored part length and part.json bytesWritten).
   * Holder of the index lock.
   */
  private async accountedBytes(index: IndexFile): Promise<number> {
    let total = 0;
    for (const row of Object.values(index.rows)) total += row.size;
    const listing = await this.store.list();
    for (const sha of new Set([...listing.parts, ...listing.partStates])) {
      const stored = await this.store.partLength(sha).catch(() => 0);
      const state = validatePartState(await this.store.partState(sha).catch(() => undefined));
      total += Math.max(stored, state?.bytesWritten ?? 0);
    }
    return total;
  }

  /**
   * The usage figure every quota decision uses (T1R-01): max(estimate().usage, accountedBytes()).
   * Chrome reports about 0.627 of the stored IndexedDB Blob bytes in navigator.storage.estimate(),
   * so an estimate-only manager never saw pressure against quotaBytes on that store; the estimate
   * still wins when it is larger (OPFS metadata, other data in the origin). Holder of the index lock.
   */
  private async usageSnapshot(index: IndexFile): Promise<UsageSnapshot> {
    const estimate = await this.store.estimate();
    const accounted = await this.accountedBytes(index);
    const usage = Math.max(estimate.usage, accounted);
    return {
      usage,
      usageSource: accounted > estimate.usage ? 'accounted' : 'estimate',
      estimate,
      accounted,
    };
  }

  /** Holder of the index lock only. Returns bytes freed; throws quota when it cannot make room. */
  private async makeRoomLocked(bytes: number, activeSha: string | undefined): Promise<number> {
    const index = await this.store.readIndex();
    const snap = await this.usageSnapshot(index);
    const quota = this.quotaBytes ?? snap.estimate.quota;
    if (quota === undefined) return 0;
    const usage = snap.usage;
    let needed = usage + bytes + this.headroom - quota;
    if (needed <= 0) return 0;
    this.emit('asset.quota', 'warn', { usage, quota, needed, usageSource: snap.usageSource });
    let freed = 0;
    for (const row of this.candidates(index, activeSha)) {
      if (needed <= 0) break;
      await this.evictRow(index, row, 'quota');
      freed += row.size;
      needed -= row.size;
    }
    if (needed > 0) {
      throw new AssetError(
        'quota',
        `cannot free ${needed} bytes: quota ${quota}, usage ${usage + bytes - freed}`,
        {
          details: { quota, usage, usageSource: snap.usageSource, needed, freed },
        },
      );
    }
    return freed;
  }

  // ---- events ---------------------------------------------------------------------------------

  private emit(
    name: string,
    level: EventLevel,
    attrs: EventAttrs,
    durationMs?: number,
    bytes?: number,
  ): void {
    const kind: EventKind = name.startsWith('asset.') ? 'asset' : 'log';
    const input: Parameters<typeof newEvent>[0] = { source: 'runtime', kind, name, level, attrs };
    if (durationMs !== undefined) input.durationMs = Math.max(0, durationMs);
    if (bytes !== undefined) input.bytes = bytes;
    const e = newEvent(input);
    this.events.emit(e);
    this.sink?.emit(e);
  }

  /** The ring buffer plus the optional external sink, as one EventSink. */
  private allSinks(): EventSink {
    const sink = this.sink;
    if (!sink) return this.events;
    const bus = this.events;
    return {
      emit(e) {
        bus.emit(e);
        sink.emit(e);
      },
    };
  }
}
