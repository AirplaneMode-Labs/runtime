// A tiny in-memory IndexedDB for node tests of IndexedDbAssetStore: just the subset the store uses
// (open with onupgradeneeded, object stores with in-line or out-of-line keys including compound
// keys, get / getAll / getAllKeys / put / delete with IDBKeyRange.bound, transactions that complete
// when their requests are done). Not a conformance implementation.

type Key = string | number | Key[];

function cmp(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i]!, b[i]!);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return typeof a === 'number' ? -1 : 1;
}

export class FakeKeyRange {
  constructor(
    readonly lower: Key,
    readonly upper: Key,
  ) {}
  static bound(lower: Key, upper: Key): FakeKeyRange {
    return new FakeKeyRange(lower, upper);
  }
}

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

interface StoreData {
  keyPath: string | string[] | undefined;
  rows: Map<string, { key: Key; value: unknown }>;
}

function clone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return typeof v === 'object' && v !== null ? ({ ...(v as object) } as T) : v;
  }
}

class FakeStore {
  constructor(
    private readonly tx: FakeTx,
    private readonly data: StoreData,
  ) {}

  private keyOf(value: unknown, key?: Key): Key {
    const kp = this.data.keyPath;
    if (kp === undefined) return key as Key;
    const rec = value as Record<string, Key>;
    return Array.isArray(kp) ? kp.map((p) => rec[p]!) : rec[kp]!;
  }
  private inRange(key: Key, range: FakeKeyRange | undefined): boolean {
    return !range || (cmp(key, range.lower) >= 0 && cmp(key, range.upper) <= 0);
  }
  private sorted(range?: FakeKeyRange) {
    return [...this.data.rows.values()]
      .filter((r) => this.inRange(r.key, range))
      .sort((a, b) => cmp(a.key, b.key));
  }

  get(key: Key) {
    return this.tx.run(() => this.data.rows.get(JSON.stringify(key))?.value);
  }
  getAll(range?: FakeKeyRange) {
    return this.tx.run(() => this.sorted(range).map((r) => r.value));
  }
  getAllKeys(range?: FakeKeyRange) {
    return this.tx.run(() => this.sorted(range).map((r) => r.key));
  }
  put(value: unknown, key?: Key) {
    return this.tx.run(() => {
      const k = this.keyOf(value, key);
      this.data.rows.set(JSON.stringify(k), { key: k, value: clone(value) });
      return k;
    });
  }
  delete(keyOrRange: Key | FakeKeyRange) {
    return this.tx.run(() => {
      if (keyOrRange instanceof FakeKeyRange) {
        for (const r of this.sorted(keyOrRange)) this.data.rows.delete(JSON.stringify(r.key));
      } else this.data.rows.delete(JSON.stringify(keyOrRange));
      return undefined;
    });
  }
}

class FakeTx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private finished = false;
  constructor(private readonly db: FakeDb) {
    this.schedule();
  }
  objectStore(name: string): FakeStore {
    const data = this.db.stores.get(name);
    if (!data) throw new Error(`no object store ${name}`);
    return new FakeStore(this, data);
  }
  run<T>(fn: () => T): FakeRequest<T> {
    const r = new FakeRequest<T>();
    this.pending++;
    let failed = false;
    try {
      r.result = fn();
    } catch (e) {
      failed = true;
      r.error = e as Error;
    }
    queueMicrotask(() => {
      if (failed) r.onerror?.();
      else r.onsuccess?.();
      this.pending--;
      this.schedule();
    });
    return r;
  }
  private schedule(): void {
    setTimeout(() => {
      if (!this.finished && this.pending === 0) {
        this.finished = true;
        this.oncomplete?.();
      }
    }, 0);
  }
}

class FakeDb {
  readonly stores = new Map<string, StoreData>();
  onversionchange: (() => void) | null = null;
  readonly objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string, opts?: { keyPath?: string | string[] }) {
    this.stores.set(name, { keyPath: opts?.keyPath, rows: new Map() });
  }
  transaction(_names: string | string[], _mode?: string): FakeTx {
    return new FakeTx(this);
  }
  close(): void {}
}

/** One fake database shared by every open() of the same factory, like a real origin. */
export class FakeIdbFactory {
  private readonly db = new FakeDb();
  private upgraded = false;
  open(_name: string, _version?: number) {
    const r = new FakeRequest<FakeDb>() as FakeRequest<FakeDb> & {
      onupgradeneeded: (() => void) | null;
    };
    r.onupgradeneeded = null;
    setTimeout(() => {
      r.result = this.db;
      if (!this.upgraded) {
        this.upgraded = true;
        r.onupgradeneeded?.();
      }
      r.onsuccess?.();
    }, 0);
    return r;
  }
  /** TEST ONLY: direct access to the rows of one object store. */
  rows(store: string): { key: Key; value: unknown }[] {
    return [...(this.db.stores.get(store)?.rows.values() ?? [])].sort((a, b) => cmp(a.key, b.key));
  }
  /** TEST ONLY: replaces the value of the row at `key`. */
  setRow(store: string, key: Key, value: unknown): void {
    const data = this.db.stores.get(store)!;
    data.rows.set(JSON.stringify(key), { key, value });
  }
}

/** Installs the IDBKeyRange global the store needs; returns a restore function. */
export function installFakeKeyRange(): () => void {
  const g = globalThis as { IDBKeyRange?: unknown };
  const prev = g.IDBKeyRange;
  g.IDBKeyRange = FakeKeyRange;
  return () => {
    if (prev === undefined) delete g.IDBKeyRange;
    else g.IDBKeyRange = prev;
  };
}
