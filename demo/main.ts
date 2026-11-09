// Runtime demo page. Hosted at https://airplanemode-labs.github.io/runtime/ and served locally by
// the range test server (test/browser). Same-origin only (see the CSP meta in index.html), plus a
// manifest URL the user pastes after adding its origin to the allowed list; no inline scripts.
//
// Manifest sources:
//   fixture  default: ./fixture/manifest.json, written and signed at build time by
//            demo/tools/make-fixture.mjs; trust set = the embedded trust root (plus pasted roots);
//            allowTestKeys false.
//   range    only on 127.0.0.1 / localhost with ?manifest=range: /manifest.json of the repository
//            range test server, signed with the public RFC 8032 test key; allowTestKeys true.
//            Elsewhere the parameter is ignored and the page says so.
//
// Egress gate (demo side): AssetManager.loadManifest applies allowedOrigins to entry URLs, not to
// the manifest URL itself, so this page checks the manifest origin against the allowed list before
// any request is made. The gate also covers the bundled fixture.
//
// Shared origin: every Airplane Mode Labs demo is served from one origin on Pages. Storage listing
// and reconcile walk only the OPFS directory airplanemode-runtime/ and open only the IndexedDB
// database airplanemode-runtime; nothing outside that prefix is listed, read or deleted.
//
// Test hooks: `window.__runtime` is exposed only when location.hostname is 127.0.0.1 or localhost.

import {
  AssetError,
  AssetManager,
  IDB_NAME,
  ManifestError,
  detectCapabilities,
  verifyManifest,
} from '../src/index.ts';
import type { AssetHandle, IndexRow, SignatureCheck, TrustSet } from '../src/index.ts';
import type { Event, EventSink } from '../spec/event.ts';
import type { Manifest } from '../spec/manifest.ts';

type StoreName = 'opfs' | 'indexeddb';
type ManifestSource = 'fixture' | 'range';
type Progress = { received: number; total: number; resumedFrom?: number };
type StoreFile = { path: string; size: number };
type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; code: string | null; message: string } };
type TrustRoot = { keyId: string; publicKeyHex: string; note: string };

const MiB = 1024 * 1024;
const params = new URLSearchParams(location.search);
const store: StoreName = params.get('store') === 'indexeddb' ? 'indexeddb' : 'opfs';
const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const rangeRequested = params.get('manifest') === 'range';
let source: ManifestSource = rangeRequested && isLocal ? 'range' : 'fixture';

/** OPFS directory the asset manager uses (src/store/opfs.ts ROOT_DIR). The only one this page touches. */
const OPFS_DIR = 'airplanemode-runtime';

// RFC 8032 section 7.1 test vector 1 public key. PUBLIC, NON-SECRET RFC 8032 test vector data; the
// range test server signs its manifest with the matching key. Never trusted outside tests.
const RFC8032_TEST_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const trustRoot: TrustRoot = JSON.parse(__DEMO_TRUST_ROOT__) as TrustRoot;
const FIXTURE_URL = new URL('./fixture/manifest.json', location.href).href;
const RFC_EXAMPLE_URL = new URL('./fixture/rfc8032-signed-example.json', location.href).href;
// Range test server manifest: same origin, at the root. Loopback only (see `source`).
const RANGE_URL = new URL('/manifest.json', location.href).href;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const outCapabilities = $<HTMLPreElement>('out-capabilities');
const outManifest = $<HTMLPreElement>('out-manifest');
const outAssets = $<HTMLPreElement>('out-assets');
const outStorage = $<HTMLPreElement>('out-storage');
const outQuota = $<HTMLPreElement>('out-quota');
const outPaste = $<HTMLPreElement>('out-paste');
const outEvents = $<HTMLPreElement>('out-events');
const entriesBody = $<HTMLTableSectionElement>('entries-body');
const inQuota = $<HTMLInputElement>('in-quota');
const inHeadroom = $<HTMLInputElement>('in-headroom');
const inDrop = $<HTMLInputElement>('in-drop');
const inPaste = $<HTMLInputElement>('in-paste');
const taOrigins = $<HTMLTextAreaElement>('ta-origins');
const taRoots = $<HTMLTextAreaElement>('ta-roots');
const chkTestKey = $<HTMLInputElement>('chk-testkey');
const selStore = $<HTMLSelectElement>('sel-store');

const show = (el: HTMLElement, value: unknown): void => {
  el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

const describeError = (e: unknown): { name: string; code: string | null; message: string } => {
  if (e instanceof AssetError)
    return { name: 'AssetError', code: String(e.code), message: e.message };
  if (e instanceof ManifestError)
    return { name: 'ManifestError', code: e.reason, message: e.message };
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { name: e.name, code: typeof code === 'string' ? code : null, message: e.message };
  }
  return { name: 'Error', code: null, message: String(e) };
};

// --- header, requirements, settings -------------------------------------------------------------

$('build-id').textContent = __DEMO_BUILD__;
$('store-label').textContent = store;
selStore.value = store;
selStore.addEventListener('change', () => {
  const next = new URL(location.href);
  next.searchParams.set('store', selStore.value);
  location.href = next.href;
});
if (rangeRequested && !isLocal) $('range-note').classList.remove('hidden');
$('trust-root-keyid').textContent = trustRoot.keyId;

const REQUIREMENTS: Record<string, () => boolean> = {
  wasm: () => typeof WebAssembly === 'object',
  opfs: () => typeof navigator.storage?.getDirectory === 'function',
  idb: () => typeof indexedDB !== 'undefined' && indexedDB !== null,
  locks: () => typeof navigator.locks === 'object' && navigator.locks !== null,
  ed25519: () => typeof crypto?.subtle === 'object' && crypto.subtle !== null,
  webgpu: () => 'gpu' in navigator,
};

function setMark(key: string, ok: boolean): void {
  const li = document.querySelector<HTMLElement>(`#requirements li[data-req="${key}"]`);
  const mark = li?.querySelector<HTMLElement>('.mark');
  if (!mark) return;
  mark.textContent = ok ? '✓' : '✗';
  mark.classList.toggle('ok', ok);
  mark.classList.toggle('missing', !ok);
  mark.setAttribute('aria-label', ok ? 'available' : 'missing');
}

for (const [key, probe] of Object.entries(REQUIREMENTS)) {
  let ok = false;
  try {
    ok = probe();
  } catch {
    ok = false;
  }
  setMark(key, ok);
}

function reportEd25519(worked: boolean): void {
  $('ed25519-detail').textContent = worked
    ? 'Ed25519 verify succeeded in this browser'
    : 'Ed25519 verify did not work in this browser';
  setMark('ed25519', worked);
}

const sourceLabel = (): string =>
  source === 'range'
    ? 'range test server mode (loopback only)'
    : 'bundled fixture (signed at build)';
const manifestUrl = (): string => (source === 'range' ? RANGE_URL : FIXTURE_URL);
function showSource(): void {
  $('source-label').textContent = sourceLabel();
  $('manifest-url').textContent = manifestUrl();
}
showSource();

// --- quota inputs ---------------------------------------------------------------------------------

const quotaParam = params.get('quota');
if (quotaParam && /^\d+$/.test(quotaParam)) inQuota.value = quotaParam;
const headroomParam = params.get('headroom');
if (headroomParam && /^\d+$/.test(headroomParam)) inHeadroom.value = headroomParam;
// Progress events are throttled by the manager (default 250 ms). The browser specs steer a reload
// into a 4 % window, so the demo defaults to 50 ms; `?progressMs=` overrides it (tests only).
const progressParam = params.get('progressMs');
const progressIntervalMs =
  progressParam && /^\d+$/.test(progressParam) ? Number(progressParam) : 50;

type QuotaSource = 'estimate' | 'quotaBytes';
let quotaSource: QuotaSource = 'estimate';
const numberOrUndefined = (el: HTMLInputElement): number | undefined => {
  const v = el.value.trim();
  return v === '' || !/^\d+$/.test(v) ? undefined : Number(v);
};
const showQuotaSource = (): void => {
  const headroom = numberOrUndefined(inHeadroom) ?? 64 * MiB;
  $('quota-source').textContent =
    quotaSource === 'quotaBytes'
      ? `quotaBytes (${inQuota.value.trim()} B test quota, headroom ${headroom} B)`
      : `navigator.storage.estimate() (headroom ${headroom} B)`;
};

// --- allowed origins and trust roots --------------------------------------------------------------

type Parsed<T> = { accepted: T[]; rejected: { line: string; message: string }[] };

/**
 * One origin per line. Accepted only when the line is exactly an https origin (no path, query,
 * fragment or trailing slash), or equals location.origin while running on loopback. Every other
 * line is reported, never silently dropped.
 */
function parseAllowedOrigins(text: string): Parsed<string> {
  const out: Parsed<string> = { accepted: [], rejected: [] };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (isLocal && line === location.origin) {
      out.accepted.push(line);
      continue;
    }
    let u: URL;
    try {
      u = new URL(line);
    } catch {
      out.rejected.push({ line, message: 'not an absolute URL; expected https://host[:port]' });
      continue;
    }
    if (u.protocol !== 'https:') {
      out.rejected.push({
        line,
        message: 'only https origins are allowed (http only for 127.0.0.1 / localhost locally)',
      });
      continue;
    }
    if (u.origin !== line) {
      out.rejected.push({
        line,
        message: `an origin has no path, query or trailing slash; did you mean ${u.origin}?`,
      });
      continue;
    }
    if (!out.accepted.includes(line)) out.accepted.push(line);
  }
  return out;
}

/** One raw Ed25519 public key per line, 64 lowercase hex characters. */
function parseTrustRoots(text: string): Parsed<string> {
  const out: Parsed<string> = { accepted: [], rejected: [] };
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (line === '') continue;
    if (!/^[0-9a-f]{64}$/.test(line)) {
      out.rejected.push({ line, message: 'expected 64 hex characters (raw 32-byte public key)' });
      continue;
    }
    if (!out.accepted.includes(line)) out.accepted.push(line);
  }
  return out;
}

function renderFeedback(el: HTMLElement, parsed: Parsed<string>, noun: string): void {
  el.replaceChildren();
  for (const a of parsed.accepted) {
    const li = document.createElement('li');
    li.className = 'accepted';
    li.textContent = `accepted ${noun}: ${a}`;
    el.append(li);
  }
  for (const r of parsed.rejected) {
    const li = document.createElement('li');
    li.className = 'rejected';
    li.textContent = `rejected ${noun} "${r.line}": ${r.message}`;
    el.append(li);
  }
}

taOrigins.value = location.origin;
taRoots.value = trustRoot.publicKeyHex;
const refreshOriginFeedback = (): Parsed<string> => {
  const p = parseAllowedOrigins(taOrigins.value);
  renderFeedback($('origins-feedback'), p, 'origin');
  return p;
};
const refreshRootFeedback = (): Parsed<string> => {
  const p = parseTrustRoots(taRoots.value);
  renderFeedback($('roots-feedback'), p, 'trust root');
  return p;
};
taOrigins.addEventListener('input', refreshOriginFeedback);
taRoots.addEventListener('input', refreshRootFeedback);
refreshOriginFeedback();
refreshRootFeedback();

const allowedOrigins = (): string[] => parseAllowedOrigins(taOrigins.value).accepted;

/** Refuses, before any request, a manifest URL whose origin is not in the allowed list. */
function gateOrigin(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AssetError('policy', `manifest URL is not absolute: ${url}`);
  }
  const o = u.origin;
  if (!allowedOrigins().includes(o))
    throw new AssetError('policy', `manifest origin ${o} is not in the allowed origins list`);
  return u;
}

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function keyIdOf(pub: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', pub));
}

/**
 * fixture: the pasted trust roots (prefilled with this build's root), plus the RFC 8032 test key
 * when the checkbox is on (verifyManifest then refuses the whole set because allowTestKeys is
 * false, which is the point of the checkbox). range: the RFC 8032 test key.
 */
async function trustSet(): Promise<TrustSet> {
  const map = new Map<string, Uint8Array>();
  if (source === 'range' || chkTestKey.checked) {
    const pub = hexToBytes(RFC8032_TEST_PUBLIC_HEX);
    map.set(await keyIdOf(pub), pub);
  }
  if (source === 'fixture') {
    for (const hex of parseTrustRoots(taRoots.value).accepted) {
      const pub = hexToBytes(hex);
      map.set(await keyIdOf(pub), pub);
    }
  }
  return map;
}

// --- events -------------------------------------------------------------------------------------

const events: Event[] = [];
const progress: Record<string, Progress> = {};
const listeners = new Set<(e: Event) => void>();
const sink: EventSink = {
  emit(e: Event) {
    events.push(e);
    if (events.length > 5000) events.shift();
    if (e.name === 'asset.download.progress') {
      const id = e.attrs['entryId'];
      const received = e.attrs['received'];
      const total = e.attrs['total'];
      const resumedFrom = e.attrs['resumedFrom'];
      if (typeof id === 'string' && typeof received === 'number' && typeof total === 'number') {
        const p: Progress = { received, total };
        if (typeof resumedFrom === 'number') p.resumedFrom = resumedFrom;
        progress[id] = p;
        renderProgress(id, p);
      }
    }
    for (const l of listeners) l(e);
    const line = `${new Date(e.ts).toISOString()} ${e.level} ${e.name} ${JSON.stringify(e.attrs)}`;
    outEvents.textContent = `${line}\n${outEvents.textContent ?? ''}`
      .split('\n')
      .slice(0, 200)
      .join('\n');
  },
};

// --- simulated network drop (fetch wrapper) --------------------------------------------------------

let dropAfterBytes = 0;
let dropArmed = false;
const rangesSeen: string[] = [];

function showDropState(): void {
  $('drop-state').textContent = dropArmed
    ? `armed: the next asset response is cut after ${dropAfterBytes} bytes`
    : dropAfterBytes > 0
      ? 'used; set a value again to arm'
      : 'off';
}

inDrop.addEventListener('input', () => {
  const v = numberOrUndefined(inDrop);
  dropAfterBytes = v === undefined ? 0 : v * MiB;
  dropArmed = dropAfterBytes > 0;
  showDropState();
});

function showRangesSeen(): void {
  $('range-seen').textContent =
    rangesSeen.length === 0
      ? 'No Range header sent yet.'
      : `Range headers sent by the manager (most recent last): ${rangesSeen.join(', ')}`;
}

/**
 * fetch with two additions: it records every Range header the manager sends, and, while the drop
 * is armed, it cuts the body of the next asset response after `dropAfterBytes`, which the manager
 * sees as a stream failure (AssetError 'network'). Uses fetch only.
 */
const gatedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const range = new Headers(init?.headers).get('Range');
  if (range) {
    rangesSeen.push(range);
    showRangesSeen();
  }
  const res = await fetch(input, init);
  if (!dropArmed || !res.body || url === manifestUrl()) return res;
  dropArmed = false;
  showDropState();
  const limit = dropAfterBytes;
  const reader = res.body.getReader();
  let seen = 0;
  let tripped = false;
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>): void =>
    controller.error(new TypeError(`simulated network drop after ${limit} bytes`));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // error() resets the queue, so the final slice is enqueued first and the error is raised on
      // the next pull, which the stream only issues once the consumer has dequeued that slice.
      if (tripped) {
        fail(controller);
        return;
      }
      const step = await reader.read();
      if (step.done) {
        controller.close();
        return;
      }
      const chunk = step.value;
      if (seen + chunk.length >= limit) {
        const take = limit - seen;
        seen = limit;
        tripped = true;
        await reader.cancel().catch(() => undefined);
        if (take > 0) controller.enqueue(chunk.subarray(0, take));
        else fail(controller);
        return;
      }
      seen += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

// --- manager --------------------------------------------------------------------------------------

/**
 * Set when the selected store cannot be constructed here (for example OPFS on an insecure origin):
 * the page then runs on the in-memory store and says so next to the store label.
 */
let storeFallback: string | null = null;

function makeManager(): AssetManager {
  const quotaBytes = numberOrUndefined(inQuota);
  const headroomBytes = numberOrUndefined(inHeadroom);
  quotaSource = quotaBytes !== undefined ? 'quotaBytes' : 'estimate';
  showQuotaSource();
  const options = {
    allowedOrigins: allowedOrigins(),
    events: sink,
    allowTestKeys: source === 'range',
    progressIntervalMs,
    fetch: gatedFetch,
    ...(quotaBytes !== undefined ? { quotaBytes } : {}),
    ...(headroomBytes !== undefined ? { headroomBytes } : {}),
  };
  if (storeFallback === null) {
    try {
      return new AssetManager({ store, ...options });
    } catch (e) {
      storeFallback = describeError(e).message;
      $('store-label').textContent =
        `${store} unavailable here (${storeFallback}); using the in-memory store for this session`;
    }
  }
  return new AssetManager({ store: 'memory', ...options });
}

let manager = makeManager();
let manifest: Manifest | null = null;
/** The last manifest object that went through verifyManifest on this page (for the tamper button). */
let lastVerified: Manifest | null = null;
const handles = new Map<string, AssetHandle[]>();
const aborts = new Map<string, AbortController>();

/** Hook-level loadManifest: URL or object straight into the manager (behaviour of the Sprint 1 page). */
async function loadManifest(src?: string | Manifest): Promise<Manifest> {
  const target = src ?? manifestUrl();
  if (typeof target === 'string') gateOrigin(target);
  manifest = await manager.loadManifest(target, await trustSet());
  lastVerified = manifest;
  renderEntries();
  show(outManifest, manifest);
  return manifest;
}

type VerifyReport = {
  ok: boolean;
  source: string;
  reason?: string;
  message?: string;
  id?: string;
  version?: string;
  publisher?: string;
  createdAt?: string;
  expiresAt?: string;
  entries?: string[];
  signatures?: SignatureCheck[];
  trustedKeyIds: string[];
  allowTestKeys: boolean;
  loadedIntoManager: boolean;
};

async function fetchJson(url: string): Promise<unknown> {
  const u = gateOrigin(url);
  const res = await gatedFetch(u.href, {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok)
    throw new AssetError('network', `${u.href} returned ${res.status}`, { reason: 'status' });
  return res.json();
}

/**
 * Verifies `obj` against the current trust set and prints the full result (reason and per-signature
 * checks). When it verifies and `load` is set, the manager takes it too (so downloads work).
 */
async function verifyAndReport(
  label: string,
  obj: unknown,
  load: boolean,
  baseUrl?: string,
): Promise<VerifyReport> {
  const trust = await trustSet();
  const allowTestKeys = source === 'range';
  const report: VerifyReport = {
    ok: false,
    source: label,
    trustedKeyIds: [...trust.keys()],
    allowTestKeys,
    loadedIntoManager: false,
  };
  try {
    const result = await verifyManifest(obj, trust, { allowTestKeys });
    report.ok = result.ok;
    report.signatures = result.signatures;
    if (result.signatures.some((s) => s.valid)) reportEd25519(true);
    if (result.ok) {
      const m = result.manifest;
      lastVerified = m;
      report.id = m.id;
      report.version = m.version;
      report.publisher = m.publisher;
      report.createdAt = m.createdAt;
      report.expiresAt = m.expiresAt ?? 'none (this manifest never expires)';
      report.entries = m.entries.map((e) => `${e.id} (${e.size} B)`);
      if (load) {
        manifest = await manager.loadManifest(m, trust, baseUrl !== undefined ? { baseUrl } : {});
        report.loadedIntoManager = true;
        renderEntries();
      }
    } else {
      report.reason = result.reason;
      report.message = `refused: ${result.reason}${
        result.signatures.length > 0
          ? `; signature keyId ${result.signatures.map((s) => `${s.keyId} (${s.reason ?? 'ok'})`).join(', ')}`
          : ''
      }`;
    }
  } catch (e) {
    const d = describeError(e);
    report.reason = d.code ?? d.name;
    report.message = d.message;
  }
  show(outManifest, report);
  return report;
}

async function loadFixture(): Promise<VerifyReport> {
  manager = makeManager();
  const url = manifestUrl();
  const obj = await fetchJson(url);
  return verifyAndReport(sourceLabel(), obj, true, url);
}

async function verifyRfcExample(): Promise<VerifyReport> {
  const obj = await fetchJson(RFC_EXAMPLE_URL);
  return verifyAndReport('RFC 8032 test-signed example (not loaded into the manager)', obj, false);
}

/** Flips one hex digit of the first entry's sha256 in a copy of the last verified manifest. */
async function tamper(): Promise<VerifyReport> {
  if (!lastVerified) throw new Error('load and verify a manifest first');
  const copy = structuredClone(lastVerified);
  const first = copy.entries[0];
  if (!first) throw new Error('manifest has no entries');
  const c = first.sha256[0] ?? '0';
  const flipped = c === '0' ? '1' : '0';
  first.sha256 = flipped + first.sha256.slice(1);
  return verifyAndReport(
    `tampered copy: entries[0].sha256 first hex digit ${c} -> ${flipped} (not loaded into the manager)`,
    copy,
    false,
  );
}

// --- entries table -----------------------------------------------------------------------------------

function renderProgress(id: string, p: Progress): void {
  const bar = document.querySelector<HTMLProgressElement>(`progress[data-entry="${id}"]`);
  const label = document.querySelector<HTMLElement>(`.progress-label[data-entry="${id}"]`);
  const resumed = document.querySelector<HTMLElement>(`.resumed[data-entry="${id}"]`);
  if (bar) bar.value = p.total > 0 ? p.received / p.total : 0;
  if (label) label.textContent = `${p.received} / ${p.total} bytes`;
  if (resumed) resumed.textContent = p.resumedFrom === undefined ? '' : String(p.resumedFrom);
}

function button(text: string, onClick: () => Promise<unknown> | unknown): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', run(outAssets, onClick));
  return b;
}

function renderEntries(): void {
  entriesBody.replaceChildren();
  if (!manifest) return;
  for (const entry of manifest.entries) {
    const id = entry.id;
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.innerText = id;
    const tdSize = document.createElement('td');
    tdSize.textContent = `${entry.size} B`;
    const tdProgress = document.createElement('td');
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = 0;
    bar.dataset['entry'] = id;
    const label = document.createElement('div');
    label.className = 'progress-label';
    label.dataset['entry'] = id;
    label.textContent = 'idle';
    tdProgress.append(bar, label);
    const tdResumed = document.createElement('td');
    tdResumed.className = 'resumed';
    tdResumed.dataset['entry'] = id;
    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('ensure()', () => ensure(id)),
      button('cancel', () => aborts.get(id)?.abort()),
      button('getBlob()', () => getBlob(id)),
      button('getBlob({rehash})', () => getBlob(id, true)),
      button('sha256 in page', () => sha256InPage(id)),
      button('evict()', () => manager.evict(id)),
    );
    tdActions.append(actions);
    tr.append(tdId, tdSize, tdProgress, tdResumed, tdActions);
    entriesBody.append(tr);
    const p = progress[id];
    if (p) renderProgress(id, p);
  }
}

async function ensure(entryId: string): Promise<IndexRow | undefined> {
  aborts.get(entryId)?.abort();
  const ac = new AbortController();
  aborts.set(entryId, ac);
  await manager.ensure(entryId, { signal: ac.signal });
  const row = (await manager.list()).find((r) => r.entryId === entryId);
  show(outAssets, row ?? `${entryId}: ensured (no index row visible)`);
  return row;
}

async function getBlob(entryId: string, rehash = false): Promise<{ size: number; type: string }> {
  const blob = await manager.getBlob(entryId, rehash ? { rehash: true } : {});
  const info = { size: blob.size, type: blob.type };
  show(outAssets, { getBlob: entryId, rehash, ...info });
  return info;
}

/** SHA-256 of getBlob() computed here with WebCrypto, compared with the manifest entry. */
async function sha256InPage(
  entryId: string,
): Promise<{ entryId: string; size: number; sha256: string; manifest: string; matches: boolean }> {
  if (!manifest) throw new Error('no manifest loaded');
  const entry = manifest.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`unknown entry ${entryId}`);
  const blob = await manager.getBlob(entryId);
  const digest = bytesToHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const out = {
    entryId,
    size: blob.size,
    sha256: digest,
    manifest: entry.sha256,
    matches: digest === entry.sha256,
  };
  show(outAssets, out);
  return out;
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

// --- storage inspection, confined to this demo's prefix ----------------------------------------------

/** The manager's OPFS directory, or null when it does not exist yet. Never creates it. */
async function runtimeDir(): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(OPFS_DIR);
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFoundError') return null;
    throw e;
  }
}

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

/** Resolves a listed path (always `airplanemode-runtime/...`) inside the manager's directory only. */
async function opfsFileHandle(path: string): Promise<FileSystemFileHandle> {
  const prefix = `${OPFS_DIR}/`;
  if (!path.startsWith(prefix)) throw new Error(`refusing a path outside ${prefix}: ${path}`);
  let dir = await runtimeDir();
  if (!dir) throw new Error(`${OPFS_DIR} does not exist`);
  const parts = path.slice(prefix.length).split('/');
  const name = parts.pop();
  if (!name) throw new Error('empty path');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new Error(`bad path segment in ${path}`);
    dir = await dir.getDirectoryHandle(p);
  }
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

/** Records of the `airplanemode-runtime` database only; never opens (or creates) any other. */
async function idbRecords(
  withValues: (key: string) => boolean,
): Promise<(IdbRecord & { value?: unknown })[]> {
  const out: (IdbRecord & { value?: unknown })[] = [];
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === IDB_NAME)) return out;
  const db = await idbOpen(IDB_NAME);
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const os = tx.objectStore(storeName);
      const keys = await idbRequest(os.getAllKeys());
      for (const k of keys) {
        const key = typeof k === 'string' ? k : JSON.stringify(k);
        const rec: IdbRecord & { value?: unknown } = {
          db: IDB_NAME,
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
  return out;
}

async function storageFiles(): Promise<StoreFile[]> {
  if (store === 'opfs') {
    const out: StoreFile[] = [];
    const dir = await runtimeDir();
    if (dir) await opfsWalk(dir, `${OPFS_DIR}/`, out, 0);
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

/** Truncate the committed `<sha>.bin` by one byte (OPFS, loopback test hook only). */
async function truncateBin(sha256: string): Promise<number> {
  if (!isLocal) throw new Error('truncateBin is a loopback-only test hook');
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

// --- quota walkthrough -----------------------------------------------------------------------------

type Walkthrough = {
  quotaBytes: number;
  headroomBytes: number;
  steps: string[];
  evicted: Record<string, string | number | boolean | null>[];
  quotaEvents: Record<string, string | number | boolean | null>[];
  rows: { entryId: string; size: number; verified: boolean }[];
  partFiles: string[];
};

/**
 * Quota 24 MiB, headroom 1 MiB: demo-a (12 MiB) then demo-b (8 MiB) fit; demo-c (6 MiB) needs
 * 20 + 6 + 1 = 27 > 24, so the manager evicts the least recently used row (demo-a) and keeps two
 * verified rows. Needs the bundled fixture's entries.
 */
async function evictionWalkthrough(): Promise<Walkthrough> {
  inQuota.value = String(24 * MiB);
  inHeadroom.value = String(1 * MiB);
  manager = makeManager();
  const report = await loadFixture();
  if (!report.ok || !manifest) throw new Error(`manifest did not verify: ${report.message ?? ''}`);
  const order = ['demo-a', 'demo-b', 'demo-c'];
  for (const id of order)
    if (!manifest.entries.some((e) => e.id === id))
      throw new Error(`the walkthrough needs the bundled fixture (missing entry ${id})`);
  const out: Walkthrough = {
    quotaBytes: 24 * MiB,
    headroomBytes: 1 * MiB,
    steps: [],
    evicted: [],
    quotaEvents: [],
    rows: [],
    partFiles: [],
  };
  const listener = (e: Event): void => {
    if (e.name === 'asset.evict') out.evicted.push({ ...e.attrs });
    if (e.name === 'asset.quota') out.quotaEvents.push({ ...e.attrs });
  };
  listeners.add(listener);
  try {
    for (const id of order) {
      await ensure(id);
      out.steps.push(`ensure(${id}) ok`);
      show(outQuota, out);
    }
  } finally {
    listeners.delete(listener);
  }
  out.rows = (await manager.list()).map((r) => ({
    entryId: r.entryId,
    size: r.size,
    verified: !!r.verifiedAt,
  }));
  out.partFiles = (await storageFiles())
    .filter((f) => /\.part(\.json)?$/.test(f.path) || f.path.includes('/parts/'))
    .map((f) => f.path);
  show(outQuota, out);
  return out;
}

// --- paste --------------------------------------------------------------------------------------

async function loadPasted(): Promise<Manifest> {
  const pasted = inPaste.value.trim();
  const origins = refreshOriginFeedback();
  refreshRootFeedback();
  let u: URL;
  try {
    u = new URL(pasted);
  } catch {
    throw new AssetError('policy', `manifest URL is not absolute: ${pasted}`);
  }
  const o = u.origin;
  if (!origins.accepted.includes(o))
    throw new AssetError('policy', `manifest origin ${o} is not in the allowed origins list`);
  // Only now is anything built or fetched.
  manager = makeManager();
  manifest = await manager.loadManifest(u.href, await trustSet());
  lastVerified = manifest;
  renderEntries();
  show(outPaste, {
    ok: true,
    url: u.href,
    id: manifest.id,
    version: manifest.version,
    publisher: manifest.publisher,
    entries: manifest.entries.map((e) => `${e.id} (${e.size} B, ${e.url})`),
  });
  return manifest;
}

// --- buttons ------------------------------------------------------------------------------------

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
  run(outManifest, () => loadFixture()),
);
$('btn-rfc').addEventListener(
  'click',
  run(outManifest, () => verifyRfcExample()),
);
$('btn-tamper').addEventListener(
  'click',
  run(outManifest, () => tamper()),
);
$('btn-estimate').addEventListener(
  'click',
  run(outStorage, () => estimate()),
);
$('btn-list').addEventListener(
  'click',
  run(outStorage, () => manager.list()),
);
$('btn-files').addEventListener(
  'click',
  run(outStorage, () => storageFiles()),
);
$('btn-reconcile').addEventListener(
  'click',
  run(outStorage, () => manager.reconcile()),
);
$('btn-apply').addEventListener(
  'click',
  run(outQuota, async () => {
    manager = makeManager();
    if (manifest)
      await manager.loadManifest(manifest, await trustSet(), { baseUrl: manifestUrl() });
    return {
      rebuilt: true,
      quotaBytes: numberOrUndefined(inQuota) ?? 'navigator.storage.estimate()',
      headroomBytes: numberOrUndefined(inHeadroom) ?? 64 * MiB,
      manifestReloaded: manifest !== null,
    };
  }),
);
$('btn-walkthrough').addEventListener(
  'click',
  run(outQuota, () => evictionWalkthrough()),
);
$('btn-paste-load').addEventListener(
  'click',
  run(outPaste, () => loadPasted()),
);
$('btn-clear-events').addEventListener('click', () => {
  events.length = 0;
  outEvents.textContent = '';
});
showQuotaSource();
showDropState();

// --- test hooks (loopback only) -----------------------------------------------------------------

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
  // Demo-page scenarios (Sprint 1 demo amendment).
  manifestSource: () => ManifestSource;
  setManifestSource: (s: ManifestSource) => ManifestSource;
  setQuota: (bytes: number | null, headroom: number | null) => QuotaSource;
  setNetworkDrop: (bytes: number) => boolean;
  allowedOrigins: (list?: string[]) => string[];
  parseAllowedOrigins: typeof parseAllowedOrigins;
  loadFixture: () => Promise<VerifyReport>;
  verifyRfcExample: () => Promise<VerifyReport>;
  setTestKeyCheckbox: (on: boolean) => boolean;
  tamper: () => Promise<VerifyReport>;
  sha256InPage: typeof sha256InPage;
  evictionWalkthrough: () => Promise<Walkthrough>;
  loadPasted: (url: string) => Promise<Manifest>;
  rangesSeen: () => string[];
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
    manifestSource: () => source,
    setManifestSource: (s) => {
      source = s;
      showSource();
      manager = makeManager();
      return source;
    },
    setQuota: (bytes, headroom) => {
      inQuota.value = bytes === null ? '' : String(bytes);
      inHeadroom.value = headroom === null ? '' : String(headroom);
      manager = makeManager();
      return quotaSource;
    },
    setNetworkDrop: (bytes) => {
      dropAfterBytes = bytes;
      dropArmed = bytes > 0;
      inDrop.value = bytes > 0 ? String(bytes / MiB) : '';
      showDropState();
      return dropArmed;
    },
    allowedOrigins: (list) => {
      if (list) {
        taOrigins.value = list.join('\n');
        refreshOriginFeedback();
        manager = makeManager();
      }
      return allowedOrigins();
    },
    parseAllowedOrigins,
    loadFixture,
    verifyRfcExample,
    setTestKeyCheckbox: (on) => {
      chkTestKey.checked = on;
      return chkTestKey.checked;
    },
    tamper,
    sha256InPage,
    evictionWalkthrough,
    loadPasted: (url) => {
      inPaste.value = url;
      return loadPasted();
    },
    rangesSeen: () => [...rangesSeen],
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
