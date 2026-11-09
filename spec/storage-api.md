# Storage API 0.1.0

Normative definition: `storage-api.ts`. This page is the prose companion. Implemented by
`@airplanemode/localdata` over OPFS with an IndexedDB fallback (and an in-memory driver for tests).

## Shape

```ts
interface StorageApi {
  set(ns, key, value: StorableValue, opts?: { ttlMs?: number }): Promise<void>;
  get<T extends StorableValue = StorableValue>(ns, key): Promise<T | undefined>;
  delete(ns, key): Promise<boolean>;
  query(ns, vector: Float32Array, k: number, opts?: { filterPrefix?: string }): Promise<QueryHit[]>;
  usage(ns?): Promise<{ bytes: number; quotaBytes?: number; items: number }>;
  clear(ns): Promise<void>;
  list(ns, opts?: { prefix?; limit?; cursor? }): Promise<{ keys: string[]; cursor?: string }>;
  readonly driver: 'opfs' | 'indexeddb' | 'memory';
  close(): Promise<void>;
}
```

`StorableValue` is `Primitive | Binary | Date | StorableValue[] | { [key: string]: StorableValue }`
where `Primitive = string | number | boolean | null` and `Binary` is `ArrayBuffer`, any typed array
or `Blob`. Functions, symbols, class instances, `Map` and `Set` are rejected with
`StorageError("invalid_value")`.

## Grammar

- Namespace `ns`: `^[a-z0-9][a-z0-9._-]{0,63}$`, else `invalid_namespace`.
- Key: 1..1024 UTF-16 code units, never containing U+0000, else `invalid_key`.

## Semantics

- `set` overwrites. When a `quotaBytes` is configured and the write would exceed it,
  `quota_exceeded` is thrown BEFORE anything is written; the browser's `QuotaExceededError` maps to
  the same code.
- An expired value (`ttlMs` elapsed) reads as `undefined` and is lazily deleted.
- `Binary` round-trips byte-exact; JSON-like values round-trip by deep equality (`Date` -> `Date`,
  `NaN` and `-0` preserved).
- `query()` is frozen now and in 0.1 MUST throw `StorageError("not_implemented")` whose message names
  Sprint 4. The vector index lands then (Rust -> WASM).
- `close()` releases handles; every call afterwards throws `closed`.

## Errors

`class StorageError extends Error { code; details? }` with codes `not_implemented`,
`quota_exceeded`, `invalid_key`, `invalid_namespace`, `invalid_value`, `driver_unavailable`, `io`,
`closed`.

## Driver boundary

```ts
interface StorageDriver {
  readonly name: 'opfs' | 'indexeddb' | 'memory';
  open();
  close();
  put(ns, key, bytes: Uint8Array, meta: { size: number; expiresAt?: number });
  getBytes(ns, key): Promise<{ bytes; meta } | undefined>;
  del(ns, key): Promise<boolean>;
  keys(ns, prefix?): Promise<string[]>;
  clear(ns);
  usage(ns?): Promise<{ bytes; items }>;
}
```

All methods are async. The SDK does validation, codec and quota accounting above the driver; a
driver only moves bytes.
