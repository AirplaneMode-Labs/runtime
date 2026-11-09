/**
 * Storage boundary of the asset manager. A store moves bytes and keeps the index; the manager
 * decides what is verified. Three implementations: OPFS, IndexedDB and memory (tests).
 *
 * Layout (OPFS, under airplanemode-runtime/v1/):
 *   <sha>.part/      chunk files of a partial download (one per appendPart call)
 *   <sha>.part.json  PartState for that partial
 *   <sha>.bin        a committed file (only written by commit(), after verification)
 *   index.json       IndexFile, always written whole
 */

export type StoreKind = 'opfs' | 'indexeddb' | 'memory';

/** State of a partial download, persisted beside the part data. */
export interface PartState {
  sha256: string;
  size: number;
  url: string;
  chunkSize: number;
  /** Bytes the manager considers durably written (whole chunks). */
  bytesWritten: number;
  /** Strong validator from the first response, if any. Weak ETags are not stored. */
  etag?: string;
  lastModified?: string;
  /** Epoch ms of the last update; reconcile() removes parts older than 30 days. */
  updatedAt: number;
}

/** A verified asset in the index. Rows exist only for committed, hashed files. */
export interface IndexRowStored {
  entryId: string;
  sha256: string;
  size: number;
  /** Epoch ms when the full SHA-256 matched. Required; a row without it is never served. */
  verifiedAt: number;
  /** Epoch ms of the last ensure()/getBlob(); drives LRU eviction. */
  lastAccess: number;
  pinned: boolean;
}

const SHA_HEX = /^[0-9a-f]{64}$/;

function safeNonNegativeInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

/**
 * Validates a PartState read back from storage (S1-017). Storage is same-origin writable, so a
 * state file may hold anything; a part whose state fails this check is restarted from zero
 * (reason part-mismatch) rather than trusted. Returns a clean copy with only the known fields, or
 * undefined when invalid. Rules: sha256 is 64 lowercase hex; size, chunkSize and bytesWritten are
 * safe non-negative integers; chunkSize >= 1; 0 <= bytesWritten <= size; bytesWritten is a whole
 * multiple of chunkSize unless it equals size; updatedAt is finite; url is a string; etag and
 * lastModified are strings when present.
 */
export function validatePartState(v: unknown): PartState | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const sha256 = o['sha256'];
  if (typeof sha256 !== 'string' || !SHA_HEX.test(sha256)) return undefined;
  const size = o['size'];
  const chunkSize = o['chunkSize'];
  const bytesWritten = o['bytesWritten'];
  if (!safeNonNegativeInt(size) || !safeNonNegativeInt(chunkSize)) return undefined;
  if (!safeNonNegativeInt(bytesWritten) || chunkSize < 1) return undefined;
  if (bytesWritten > size) return undefined;
  if (bytesWritten !== size && bytesWritten % chunkSize !== 0) return undefined;
  const updatedAt = o['updatedAt'];
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  const url = o['url'];
  if (typeof url !== 'string') return undefined;
  const etag = o['etag'];
  const lastModified = o['lastModified'];
  if (etag !== undefined && typeof etag !== 'string') return undefined;
  if (lastModified !== undefined && typeof lastModified !== 'string') return undefined;
  const out: PartState = { sha256, size, url, chunkSize, bytesWritten, updatedAt };
  if (etag !== undefined) out.etag = etag;
  if (lastModified !== undefined) out.lastModified = lastModified;
  return out;
}

export interface IndexFile {
  version: 1;
  rows: Record<string, IndexRowStored>;
  /** Last accepted manifest per id, for the downgrade rule. */
  manifests: Record<string, { version: string; createdAt: string }>;
}

export function emptyIndex(): IndexFile {
  return { version: 1, rows: {}, manifests: {} };
}

export interface StoreEstimate {
  usage: number;
  quota?: number;
}

export interface StoreListing {
  /** shas with a committed .bin */
  bins: string[];
  /**
   * Epoch ms at which each committed file was last modified (OPFS lastModified, IndexedDB commit
   * time), where the store knows it. reconcile() leaves a file younger than 60 s alone: its
   * commit may not have an index row yet (S1-015). Absent for stores without timestamps.
   */
  binModified?: Record<string, number>;
  /** shas with part data */
  parts: string[];
  /** shas with a part state file */
  partStates: string[];
}

export interface AssetStore {
  readonly kind: StoreKind;
  open(): Promise<void>;

  /** Creates an empty part if none exists. */
  openPart(sha: string): Promise<void>;
  /** Appends bytes to the part. Throws the platform QuotaExceededError when storage is full. */
  appendPart(sha: string, bytes: Uint8Array): Promise<void>;
  /** Truncates the part data to `length` bytes. */
  truncatePart(sha: string, length: number): Promise<void>;
  /** Bytes of part data actually stored (0 when none). */
  partLength(sha: string): Promise<number>;
  /** Streams the stored part data in order. */
  readPart(sha: string): AsyncIterable<Uint8Array>;
  partState(sha: string): Promise<PartState | undefined>;
  writePartState(sha: string, state: PartState): Promise<void>;
  /** Removes part data and state. No-op when absent. */
  removePart(sha: string): Promise<void>;
  /**
   * Turns the (verified) part into the committed file and removes the part and its state. May
   * throw the platform QuotaExceededError; after a failure the part may no longer be intact (the
   * manager checks partLength before retrying) and the store must not leave a readable
   * `<sha>.bin` behind.
   */
  commit(sha: string): Promise<void>;
  /**
   * Transient bytes commit() needs on top of the part itself, for a part of `size` bytes written in
   * `chunkSize` chunks. The manager reserves this (evicting LRU rows) before committing. OPFS needs
   * one chunk (its swap file); IndexedDB and memory need none. Absent means 0.
   */
  commitReserve?(size: number, chunkSize: number): number;

  /** The committed file. Callers must have checked the index row first. */
  readBlob(sha: string): Promise<Blob>;
  /** Size of the committed file, or undefined when there is none. */
  fileSize(sha: string): Promise<number | undefined>;
  /** Removes the committed file. No-op when absent. */
  remove(sha: string): Promise<void>;

  list(): Promise<StoreListing>;
  readIndex(): Promise<IndexFile>;
  /** Writes the whole index atomically (createWritable without keepExistingData, or one IDB put). */
  writeIndex(index: IndexFile): Promise<void>;
  estimate(): Promise<StoreEstimate>;
}

/** Prefix of the shared lock an acquired asset is held under: `airplanemode-held:<sha256>`. */
export const HELD_LOCK_PREFIX = 'airplanemode-held:';

/** Serialises work under a named lock. */
export interface LockProvider {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Takes a SHARED lock called `name` and resolves with a release function once it is granted.
   * Any number of holders may share it. The asset manager holds `airplanemode-held:<sha>` from
   * acquire() until release(), so eviction and reconcile in any instance or tab can see the hold
   * (S1-021). Optional: a provider without it falls back to in-process reference counts only.
   */
  hold?(name: string): Promise<() => void>;
  /**
   * True while a lock called `name` is held (in any mode) or requested by anyone this provider can
   * see: every tab and worker of the origin for Web Locks, this provider for the in-process one.
   * Used for `airplanemode-held:<sha>` and `asset:<sha>` (S1-015, S1-021).
   *
   * `'unknown'` (or a rejection) means the provider cannot tell, for example `navigator.locks.query`
   * is missing or throws. The asset manager treats it as held for eviction and reconcile, so a
   * missing answer never lets another tab's model be evicted (S1-054).
   */
  isHeld?(name: string): Promise<boolean | 'unknown'>;
}
