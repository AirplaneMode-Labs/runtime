// Runtime demo page: drives the AssetManager and capability detector against the local range test
// server. Same-origin only (see the CSP meta in index.html); no inline scripts.
//
// Test hooks: `window.__runtime` is exposed only when location.hostname is 127.0.0.1 or localhost,
// and the manager is constructed with allowTestKeys: true so the RFC 8032 test key in the range
// server's manifest verifies. A deployed app never does either.

import { AssetError, AssetManager, detectCapabilities, verifyManifest } from '../src/index.ts';
import type { AssetHandle, IndexRow } from '../src/index.ts';
import type { Event, EventSink } from '../spec/event.ts';
import type { Manifest } from '../spec/manifest.ts';

type StoreName = 'opfs' | 'indexeddb';
type Progress = { received: number; total: number };
type StoreFile = { path: string; size: number };
type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; code: string | null; message: string } };

const params = new URLSearchParams(location.search);
const store: StoreName = params.get('store') === 'indexeddb' ? 'indexeddb' : 'opfs';
const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

// RFC 8032 section 7.1 test vector 1 public key. PUBLIC, NON-SECRET RFC 8032 test vector data; the
// range server signs its manifest with the matching seed. Never trust this key outside tests.
const RFC8032_TEST_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const outCapabilities = $<HTMLPreElement>('out-capabilities');
const outManifest = $<HTMLPreElement>('out-manifest');
const outAssets = $<HTMLPreElement>('out-assets');
const outStorage = $<HTMLPreElement>('out-storage');
const outEvents = $<HTMLPreElement>('out-events');
const progressBar = $<HTMLProgressElement>('progress');
const progressLabel = $<HTMLDivElement>('progress-label');
const inManifest = $<HTMLInputElement>('in-manifest');
const inQuota = $<HTMLInputElement>('in-quota');
const inEntry = $<HTMLInputElement>('in-entry');

$('store-label').textContent = store;
inManifest.value = `${location.origin}/manifest.json`;
const quotaParam = params.get('quota');
if (quotaParam && /^\d+$/.test(quotaParam)) inQuota.value = quotaParam;
// Progress events are throttled by the manager (default 250 ms). The browser specs steer a reload
// into a 4 % window, so the demo defaults to 50 ms; `?progressMs=` overrides it (tests only).
const progressParam = params.get('progressMs');
const progressIntervalMs =
  progressParam && /^\d+$/.test(progressParam) ? Number(progressParam) : 50;

type QuotaSource = 'estimate' | 'quotaBytes';
let quotaSource: QuotaSource = 'estimate';
const showQuotaSource = (): void => {
  $('quota-source').textContent =
    quotaSource === 'quotaBytes'
      ? `quotaBytes (${inQuota.value.trim()} B, test override)`
      : 'navigator.storage.estimate()';
};

const show = (el: HTMLElement, value: unknown): void => {
  el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

const describeError = (e: unknown): { name: string; code: string | null; message: string } => {
  if (e instanceof AssetError)
    return { name: 'AssetError', code: String(e.code), message: e.message };
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { name: e.name, code: typeof code === 'string' ? code : null, message: e.message };
  }
  return { name: 'Error', code: null, message: String(e) };
};

// --- events -------------------------------------------------------------------------------------

const events: Event[] = [];
const progress: Record<string, Progress> = {};
const sink: EventSink = {
  emit(e: Event) {
    events.push(e);
    if (events.length > 5000) events.shift();
    if (e.name === 'asset.download.progress') {
      const id = e.attrs['entryId'];
      const received = e.attrs['received'];
      const total = e.attrs['total'];
      if (typeof id === 'string' && typeof received === 'number' && typeof total === 'number') {
        progress[id] = { received, total };
        progressBar.value = total > 0 ? received / total : 0;
        progressLabel.textContent = `${id}: ${received} / ${total} bytes`;
      }
    }
    const line = `${new Date(e.ts).toISOString()} ${e.level} ${e.name} ${JSON.stringify(e.attrs)}`;
    outEvents.textContent = `${line}\n${outEvents.textContent ?? ''}`
      .split('\n')
      .slice(0, 200)
      .join('\n');
  },
};

// --- manager --------------------------------------------------------------------------------------

function makeManager(quotaBytes: number | undefined): AssetManager {
  quotaSource = quotaBytes !== undefined ? 'quotaBytes' : 'estimate';
  showQuotaSource();
  return new AssetManager({
    store,
    allowedOrigins: [location.origin],
    events: sink,
    allowTestKeys: true,
    progressIntervalMs,
    ...(quotaBytes !== undefined ? { quotaBytes } : {}),
  });
}

const quotaFromInput = (): number | undefined => {
  const v = inQuota.value.trim();
  return v === '' ? undefined : Number(v);
};

let manager = makeManager(quotaFromInput());
let manifest: Manifest | null = null;
const handles = new Map<string, AssetHandle[]>();
let currentAbort: AbortController | null = null;

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function trustSet(): Promise<Map<string, Uint8Array>> {
  const pub = hexToBytes(RFC8032_TEST_PUBLIC_HEX);
  const keyId = bytesToHex(await crypto.subtle.digest('SHA-256', pub));
  return new Map([[keyId, pub]]);
}

async function loadManifest(source?: string | Manifest): Promise<Manifest> {
  const src = source ?? inManifest.value.trim();
  manifest = await manager.loadManifest(src, await trustSet());
  show(outManifest, manifest);
  return manifest;
}

async function ensure(entryId: string): Promise<IndexRow | undefined> {
  currentAbort?.abort();
  currentAbort = new AbortController();
  await manager.ensure(entryId, { signal: currentAbort.signal });
  const row = (await manager.list()).find((r) => r.entryId === entryId);
  show(outAssets, row ?? `${entryId}: ensured (no index row visible)`);
  return row;
}

async function getBlob(entryId: string, rehash = false): Promise<{ size: number; type: string }> {
  const blob = await manager.getBlob(entryId, rehash ? { rehash: true } : {});
  const info = { size: blob.size, type: blob.type };
  show(outAssets, { getBlob: entryId, ...info });
  return info;
}

async function acquire(entryId: string): Promise<number> {
  const handle = await manager.acquire(entryId);
  const list = handles.get(entryId) ?? [];
  list.push(handle);
  handles.set(entryId, list);
  show(outAssets, { acquired: entryId, held: list.length });
  return list.length;
}

function release(entryId: string): number {
  const list = handles.get(entryId) ?? [];
  const handle = list.pop();
  handle?.release();
  handles.set(entryId, list);
  show(outAssets, { released: entryId, held: list.length });
  return list.length;
}

// --- storage inspection (layout-agnostic; test hooks) ----------------------------------------------

async function opfsWalk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: StoreFile[],
  depth: number,
): Promise<void> {
  if (depth > 6) return;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path: prefix + name, size: file.size });
    } else {
      await opfsWalk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out, depth + 1);
    }
  }
}

async function opfsFileHandle(path: string): Promise<FileSystemFileHandle> {
  let dir = await navigator.storage.getDirectory();
  const parts = path.split('/');
  const name = parts.pop();
  if (!name) throw new Error('empty path');
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(name);
}

type IdbRecord = { db: string; store: string; key: string; size: number };

function idbOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
}

const idbRequest = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const valueSize = (v: unknown): number => {
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof Blob) return v.size;
  if (typeof v === 'string') return v.length;
  return 0;
};

async function idbRecords(
  withValues: (key: string) => boolean,
): Promise<(IdbRecord & { value?: unknown })[]> {
  const out: (IdbRecord & { value?: unknown })[] = [];
  const dbs = await indexedDB.databases();
  for (const info of dbs) {
    if (!info.name) continue;
    const db = await idbOpen(info.name);
    try {
      for (const storeName of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(storeName, 'readonly');
        const os = tx.objectStore(storeName);
        const keys = await idbRequest(os.getAllKeys());
        for (const k of keys) {
          const key = typeof k === 'string' ? k : JSON.stringify(k);
          const rec: IdbRecord & { value?: unknown } = {
            db: info.name,
            store: storeName,
            key,
            size: 0,
          };
          if (withValues(key)) {
            const value = await idbRequest(os.get(k));
            rec.value = value;
            rec.size = valueSize(value);
          }
          out.push(rec);
        }
      }
    } finally {
      db.close();
    }
  }
  return out;
}

async function storageFiles(): Promise<StoreFile[]> {
  if (store === 'opfs') {
    const out: StoreFile[] = [];
    await opfsWalk(await navigator.storage.getDirectory(), '', out, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  const recs = await idbRecords(() => true);
  return recs.map((r) => ({ path: `${r.db}/${r.store}/${r.key}`, size: r.size }));
}

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value === 'string') return JSON.parse(value);
  if (value instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(value));
  if (ArrayBuffer.isView(value)) return JSON.parse(new TextDecoder().decode(value));
  return value;
};

/** The `<sha>.part.json` sidecar of an in-flight download, or null. */
async function readPartJson(sha256: string): Promise<unknown> {
  if (store === 'opfs') {
    const files = await storageFiles();
    const part = files.find((f) => f.path.endsWith(`${sha256}.part.json`));
    if (!part) return null;
    const file = await (await opfsFileHandle(part.path)).getFile();
    return JSON.parse(await file.text());
  }
  // The IndexedDB store keeps partial-download state in the `parts` object store keyed by the bare
  // sha (keyPath 'sha256'); its value is the PartState with bytesWritten.
  const recs = await idbRecords((key) => key === sha256);
  for (const r of recs) {
    if (r.store !== 'parts') continue;
    if (!('value' in r) || r.value === undefined) continue;
    try {
      const v = parseJsonValue(r.value) as Record<string, unknown> | null;
      if (v && typeof v === 'object' && 'bytesWritten' in v) return v;
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

/** Truncate the committed `<sha>.bin` by one byte (OPFS only). Returns the new size. */
async function truncateBin(sha256: string): Promise<number> {
  if (store !== 'opfs') throw new Error('truncateBin is only implemented for the opfs store');
  const files = await storageFiles();
  const bin = files.find((f) => f.path.endsWith(`${sha256}.bin`));
  if (!bin) throw new Error(`no committed .bin for ${sha256}`);
  const handle = await opfsFileHandle(bin.path);
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.truncate(bin.size - 1);
  await writable.close();
  show(outStorage, { truncated: bin.path, size: bin.size - 1 });
  return bin.size - 1;
}

async function estimate(): Promise<{ usage: number; quota: number }> {
  const est = await navigator.storage.estimate();
  const out = { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  show(outStorage, out);
  return out;
}

type AccountedUsage = { rows: number; rowBytes: number; partBytes: number; bytes: number };

/**
 * The bytes the manager itself accounts for: the sum of the index rows' sizes plus the bytes of
 * in-flight part files, read from the store. Reported next to navigator.storage.estimate().usage
 * so Chrome's under-reporting of IndexedDB usage stays visible in the test reports.
 */
async function accountedUsage(): Promise<AccountedUsage> {
  const rows = await manager.list();
  const rowBytes = rows.reduce((n, r) => n + r.size, 0);
  const files = await storageFiles();
  let partBytes = 0;
  if (store === 'opfs') {
    partBytes = files.filter((f) => f.path.endsWith('.part')).reduce((n, f) => n + f.size, 0);
  } else {
    // IndexedDB keeps committed and in-flight chunks in the same `chunks` store; a sha is in flight
    // while it still has a `parts` row. Chunk keys are [sha, seq], listed as JSON.
    const inFlight = new Set(
      files.filter((f) => f.path.includes('/parts/')).map((f) => f.path.split('/').pop() ?? ''),
    );
    partBytes = files
      .filter((f) => f.path.includes('/chunks/'))
      .filter((f) =>
        inFlight.has(String((JSON.parse(f.path.split('/').pop() ?? '[]') as unknown[])[0])),
      )
      .reduce((n, f) => n + f.size, 0);
  }
  const out = { rows: rows.length, rowBytes, partBytes, bytes: rowBytes + partBytes };
  show(outStorage, out);
  return out;
}

// --- buttons ------------------------------------------------------------------------------------

const entryId = (): string => inEntry.value.trim();
const run = (el: HTMLElement, fn: () => Promise<unknown> | unknown) => async (): Promise<void> => {
  try {
    const value = await fn();
    if (value !== undefined) show(el, value);
  } catch (e) {
    show(el, { error: describeError(e) });
  }
};

$('btn-detect').addEventListener(
  'click',
  run(outCapabilities, () => detectCapabilities()),
);
$('btn-load').addEventListener(
  'click',
  run(outManifest, async () => {
    manager = makeManager(quotaFromInput());
    return loadManifest();
  }),
);
$('btn-ensure').addEventListener(
  'click',
  run(outAssets, () => ensure(entryId())),
);
$('btn-cancel').addEventListener('click', () => currentAbort?.abort());
$('btn-blob').addEventListener(
  'click',
  run(outAssets, () => getBlob(entryId())),
);
$('btn-rehash').addEventListener(
  'click',
  run(outAssets, () => getBlob(entryId(), true)),
);
$('btn-acquire').addEventListener(
  'click',
  run(outAssets, () => acquire(entryId())),
);
$('btn-release').addEventListener(
  'click',
  run(outAssets, () => release(entryId())),
);
$('btn-pin').addEventListener(
  'click',
  run(outAssets, () => manager.pin(entryId())),
);
$('btn-unpin').addEventListener(
  'click',
  run(outAssets, () => manager.unpin(entryId())),
);
$('btn-evict').addEventListener(
  'click',
  run(outAssets, () => manager.evict(entryId())),
);
$('btn-list').addEventListener(
  'click',
  run(outAssets, () => manager.list()),
);
$('btn-reconcile').addEventListener(
  'click',
  run(outAssets, () => manager.reconcile()),
);
$('btn-truncate').addEventListener(
  'click',
  run(outStorage, async () => {
    const row = (await manager.list()).find((r) => r.entryId === entryId());
    if (!row) throw new Error(`no index row for ${entryId()}`);
    return truncateBin(row.sha256);
  }),
);
$('btn-estimate').addEventListener(
  'click',
  run(outStorage, () => estimate()),
);
$('btn-files').addEventListener(
  'click',
  run(outStorage, () => storageFiles()),
);
$('btn-clear-events').addEventListener('click', () => {
  events.length = 0;
  outEvents.textContent = '';
});

// --- test hooks ---------------------------------------------------------------------------------

export interface DemoRuntime {
  store: StoreName;
  ready: Promise<void>;
  events: Event[];
  progress: Record<string, Progress>;
  manager: () => AssetManager;
  loadManifest: (source?: string | Manifest) => Promise<Manifest>;
  ensure: (entryId: string) => Promise<IndexRow | undefined>;
  startEnsure: (entryId: string) => void;
  getBlob: (entryId: string, rehash?: boolean) => Promise<{ size: number; type: string }>;
  acquire: (entryId: string) => Promise<number>;
  release: (entryId: string) => number;
  pin: (entryId: string) => Promise<void> | void;
  unpin: (entryId: string) => Promise<void> | void;
  evict: (entryId: string) => Promise<unknown>;
  evictToFit: (bytes: number) => Promise<unknown>;
  has: (entryId: string) => Promise<boolean>;
  list: () => Promise<IndexRow[]>;
  /** Where the manager takes its quota from: navigator.storage.estimate() or the quotaBytes override. */
  quotaSource: () => QuotaSource;
  progressIntervalMs: () => number;
  reconcile: () => Promise<unknown>;
  storageFiles: () => Promise<StoreFile[]>;
  readPartJson: (sha256: string) => Promise<unknown>;
  truncateBin: (sha256: string) => Promise<number>;
  estimate: () => Promise<{ usage: number; quota: number }>;
  /** Index row bytes plus in-flight part bytes: what the manager's own quota accounting sees. */
  accountedUsage: () => Promise<AccountedUsage>;
  detectCapabilities: typeof detectCapabilities;
  verifyManifest: typeof verifyManifest;
  /** Call any method above and get a serialisable result (errors keep their AssetError code). */
  call: (method: string, ...args: unknown[]) => Promise<CallResult>;
}

if (isLocal) {
  const api: Omit<DemoRuntime, 'call'> = {
    store,
    ready: Promise.resolve(),
    events,
    progress,
    manager: () => manager,
    quotaSource: () => quotaSource,
    progressIntervalMs: () => progressIntervalMs,
    loadManifest,
    ensure,
    startEnsure: (id) => {
      ensure(id).catch((e: unknown) => show(outAssets, { error: describeError(e) }));
    },
    getBlob,
    acquire,
    release,
    pin: (id) => manager.pin(id),
    unpin: (id) => manager.unpin(id),
    evict: (id) => Promise.resolve(manager.evict(id)),
    evictToFit: (bytes) => Promise.resolve(manager.evictToFit(bytes)),
    has: (id) => manager.has(id),
    list: () => manager.list(),
    reconcile: () => Promise.resolve(manager.reconcile()),
    storageFiles,
    readPartJson,
    truncateBin,
    estimate,
    accountedUsage,
    detectCapabilities,
    verifyManifest,
  };
  const call = async (method: string, ...args: unknown[]): Promise<CallResult> => {
    try {
      const fn = (api as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') throw new Error(`no such method ${method}`);
      const value: unknown = await (fn as (...a: unknown[]) => unknown)(...args);
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, error: describeError(e) };
    }
  };
  (window as unknown as { __runtime: DemoRuntime }).__runtime = { ...api, call };
}
