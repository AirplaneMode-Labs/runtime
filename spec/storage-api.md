# Storage API 0.2.0

Normative definition: `storage-api.ts`. This page is the prose companion and carries the normative
semantics of the vector index. Implemented by `@airplanemode/localdata` over OPFS with an IndexedDB
fallback (and an in-memory driver for tests). Status: draft (spec release 0.4.0, committed; public
after the owner's push).

0.2.0 is a minor change over 0.1.0: `query()` is implemented, `putVectors()` and `indexInfo()` are
new, `QueryOptions` gains `metric` and `values`, `UsageResult` gains `vectorRows` and `vectorBytes`,
and the error code `corrupt` is new. Everything else is unchanged (`set`, `get`, `delete`, `usage`,
`clear`, `list`, `driver`, `close`, `StorableValue`, the namespace grammar, the key rules and the
`StorageDriver` interface). A `Float32Array` passed to `set()` is a KV value and is NOT indexed.

## Shape

```ts
interface StorageApi {
  set(ns, key, value: StorableValue, opts?: { ttlMs?: number }): Promise<void>;
  get<T extends StorableValue = StorableValue>(ns, key): Promise<T | undefined>;
  delete(ns, key): Promise<boolean>;
  query(ns, vector: Float32Array, k: number, opts?: QueryOptions): Promise<QueryHit[]>;
  putVectors(ns, rows: Iterable<VectorRow> | AsyncIterable<VectorRow>): Promise<PutVectorsResult>;
  indexInfo(ns): Promise<VectorIndexInfo | undefined>;
  usage(ns?): Promise<UsageResult>;
  clear(ns): Promise<void>;
  list(ns, opts?: { prefix?; limit?; cursor? }): Promise<{ keys: string[]; cursor?: string }>;
  readonly driver: 'opfs' | 'indexeddb' | 'memory';
  close(): Promise<void>;
}

const VECTOR_DIM_MAX = 4096;
const VECTOR_KEY_UTF8_MAX = 4096;
const VECTOR_VALUE_BYTES_MAX = 1048576;
type VectorMetric = 'cosine' | 'dot';
interface VectorRow {
  key: string;
  vector: Float32Array;
  value?: StorableValue;
}
interface PutVectorsResult {
  written: number;
  replaced: number;
  rows: number;
}
interface QueryOptions {
  filterPrefix?: string;
  metric?: VectorMetric;
  values?: boolean;
}
interface VectorIndexInfo {
  formatVersion: 1;
  dtype: 'f32';
  dim: number;
  rows: number;
  totalRows: number;
  segments: number;
  bytes: number;
  generation: number;
  kernel: 'simd' | 'scalar';
}
interface UsageResult {
  bytes: number;
  quotaBytes?: number;
  items: number;
  vectorRows?: number;
  vectorBytes?: number;
}
```

`StorableValue` is `Primitive | Binary | Date | StorableValue[] | { [key: string]: StorableValue }`
where `Primitive = string | number | boolean | null` and `Binary` is `ArrayBuffer`, any typed array
or `Blob`. Functions, symbols, class instances, `Map` and `Set` are rejected with
`StorageError("invalid_value")`.

## Grammar

- Namespace `ns`: `^[a-z0-9][a-z0-9._-]{0,63}$`, else `invalid_namespace`. The prefix `__ld_` is
  reserved: validateNamespace rejects the prefix '__ld_' for callers (the grammar already forbids a
  leading `_` and `/`, so no caller namespace can start with it).
- Key: 1..1024 UTF-16 code units, never containing U+0000, else `invalid_key`. A vector row key
  follows the same rules and must also be well formed (`String.prototype.isWellFormed()`). The 1024
  UTF-16-unit rule applies to vector keys and dominates: no vector key can come near 4096 UTF-8 bytes
  (1024 units are at most 3072 bytes). `VECTOR_KEY_UTF8_MAX` (4096 UTF-8 bytes is the on-disk bound) is the
  largest key length the index format can store and the reader accepts, not a second limit a caller can reach.

## Semantics (key-value)

- `set` overwrites. When a `quotaBytes` is configured and the write would exceed it,
  `quota_exceeded` is thrown BEFORE anything is written; the browser's `QuotaExceededError` maps to
  the same code.
- An expired value (`ttlMs` elapsed) reads as `undefined` and is lazily deleted.
- `Binary` round-trips byte-exact; JSON-like values round-trip by deep equality (`Date` -> `Date`,
  `NaN` and `-0` preserved).
- `close()` releases handles; every call afterwards throws `closed`.

## Vector index semantics (normative)

1. KV values and the vector index sit side by side in one namespace. `delete(ns, key)` removes both
   and resolves `true` if either existed. `clear(ns)` removes both and resets the namespace's `dim`.
   `list()` and `usage().items` count KV only. `usage().bytes` includes `vectorBytes`.
2. `putVectors` is all-or-nothing per call: rows become visible only when the whole call commits.
   - A key repeated within one call is `invalid_value` with reason `duplicate_key`, raised before any
     write.
   - A key with a live row is replaced.
   - An empty iterable resolves `{ written: 0, replaced: 0, rows: <current> }`.
   - The first successful call fixes `dim`; a different length is `invalid_value` with reason `dim`.
   - `quota_exceeded` rejects the whole call: the soft quota, the browser's `QuotaExceededError`,
     reason `max_index_bytes` when the projected vector, meta and key bytes would exceed
     `maxIndexBytes` (default 1073741824), or reason `wasm_memory` when the WASM allocation fails. The
     writer never creates an index the reader would refuse as `too_large`.
   - A generation of `0xFFFFFFFF` is refused as `invalid_value` with reason `generation`.
   - The previously committed index stays readable and unchanged after any failure.
3. Row rules (`VectorRow`): `key` as in Grammar, else `invalid_key`; `vector` of length 1..4096 and
   equal to the namespace `dim`, every component finite and `selfDot <= 1e30`, else `invalid_value`;
   `value` encoded at most 1 MiB, else `invalid_value`.

## Query validation order

`query(ns, vector, k, opts?)` checks, in this order, and stops at the first failure:

1. the store is open, else `closed`;
2. `ns` matches the grammar, else `invalid_namespace`;
3. `k` is an integer 0..2147483647, else `invalid_value`;
4. `vector` is a `Float32Array` of length 1..4096 with every component finite and `selfDot <= 1e30`, else `invalid_value`;
5. `filterPrefix`, when present, is a string with `isWellFormed()`, no U+0000 and a UTF-8 length of at most 4096, else `invalid_value` with reason `filter_prefix`;
6. `metric`, when present, is `'cosine'` or `'dot'`, else `invalid_value` with reason `metric`;
7. a namespace without an index returns `[]`;
8. a `vector` length different from `dim` is `invalid_value` with reason `dim`;
9. `k = 0` returns `[]`.

## Scoring (bit-exact)

IEEE-754 binary32, round-to-nearest-even, no FMA and no relaxed-simd: every multiply and every add is
rounded to f32 on its own.

- `dot4(a, b)`: four accumulators start at `+0`; for `i = 0..d-1` in order, `acc[i mod 4] += a[i] * b[i]`
  with the multiply and the add each rounded to f32; the result is `(acc0 + acc1) + (acc2 + acc3)`.
- `selfDot(v) = dot4(v, v)`.
- `invNorm(v) = 0` if `selfDot` is `0`, else `1 / sqrt(selfDot)`, in f32.
- metric `dot`: `score = dot4(row, q)`.
- metric `cosine` (the default): `score = (dot4(row, q) * invNorm(row)) * invNorm(q)`.
- `-0` becomes `+0`.

A TypeScript reference that applies `Math.fround` after each operation is bit-identical, so two
implementations agree on every score, and therefore on every hit, bit for bit.

## Order and result

- Order: score descending, then key ascending by UTF-8 bytes. Length is `min(k, candidates)`.
- Candidates are the live rows whose key starts with `filterPrefix`, compared as UTF-8 bytes.
- `value` is present on a hit if and only if the row has one and `opts.values !== false`.

## Corruption

A structural or checksum failure makes `query`, `putVectors`, `indexInfo` and `delete` on that namespace
reject with `corrupt`, with `details { ns, file, reason }`. After a `corrupt` result for a generation,
every vector call on that namespace keeps rejecting until `clear(ns)` or a new generation. Wrong results
are never returned. KV operations on the namespace are unaffected.

## Namespaces

Namespaces are isolated. Each index lives in its own reserved driver namespace `'__ld_vec.' + ns`. The
prefix `__ld_` is reserved: validateNamespace rejects the prefix '__ld_' for callers, so a caller can
neither read nor write an index file as a KV value.

## Error hygiene

StorageError messages and details for vector operations never contain a key, filterPrefix, vector component, score or value.
A bad row is identified by its 0-based position in the call (`details.row`).

## Errors

`class StorageError extends Error { code; details? }` with codes `not_implemented` (thrown by 0.1
`query()` only; a 0.2 implementation never throws it), `quota_exceeded`, `invalid_key`,
`invalid_namespace`, `invalid_value`, `driver_unavailable`, `io`, `closed` and `corrupt` (new in 0.2.0).

## On-disk format

The on-disk format is localdata-internal (`localdata/docs/vector-index-format.md`). The contract promises
only the behaviour above.

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

## Events (outside the contract)

Events are optional and are not part of this contract: localdata emits `storage.set`, `storage.get`,
`storage.delete`, `storage.quota`, `storage.query`, `storage.index.open` and `storage.index.write` (source
`localdata`; Event 0.1.3, `STORAGE_EVENT_NAMES`) through an optional `EventSink`. The sink is called
synchronously inside a try/catch and never awaited. An event never carries a key, a prefix, a query
vector, a score or a value. **Privacy:** the namespace (attr 'ns') DOES appear in events and in the
DevTools snapshot. Applications must not encode personal data or document identifiers in namespace
names.
