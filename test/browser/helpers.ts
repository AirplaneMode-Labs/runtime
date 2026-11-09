// Shared helpers and scenarios for the browser proof. The same scenario functions drive the
// 64 MiB specs (asset.spec.ts) and the 700 MB specs (big.spec.ts, RUNTIME_BIG=1).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type CDPSession, type Page } from 'playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const toolsDir = join(here, '..', 'tools');
export const specDir = join(here, '..', '..', 'spec');

export type Store = 'opfs' | 'indexeddb';

export interface IndexRowLike {
  entryId: string;
  sha256: string;
  size: number;
  verifiedAt: number | string | null | undefined;
  lastAccess: number;
  pinned: boolean;
  refcount: number;
}

export interface EventLike {
  name: string;
  kind: string;
  level: string;
  ts: number;
  attrs: Record<string, string | number | boolean | null>;
}

export interface LogEntry {
  method: string;
  path: string;
  range: string | null;
  ifRange: string | null;
  status: number;
  bytesSent: number;
}

export interface ManifestEntryLike {
  id: string;
  url: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}

export interface ManifestLike {
  entries: ManifestEntryLike[];
  [k: string]: unknown;
}

export type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; code: string | null; message: string } };

export class CallError extends Error {
  constructor(
    public readonly code: string | null,
    public readonly errorName: string,
    message: string,
  ) {
    super(`${errorName}${code ? ` [${code}]` : ''}: ${message}`);
  }
}

/** SHA-256 of the synthetic stream, computed by the Node tool independently of the browser. */
export function digest(name: string, bytes: number): string {
  return execFileSync(process.execPath, [join(toolsDir, 'asset-digest.mjs'), name, String(bytes)])
    .toString()
    .trim();
}

export async function serverLog(base: string): Promise<LogEntry[]> {
  const r = await fetch(`${base}/__requests`);
  if (!r.ok) throw new Error(`/__requests -> ${r.status} (start the server with --test-endpoints)`);
  return (await r.json()) as LogEntry[];
}

export async function resetLog(base: string): Promise<void> {
  const r = await fetch(`${base}/__reset`, { method: 'POST' });
  if (!r.ok) throw new Error(`/__reset -> ${r.status}`);
}

export const assetRequests = (log: LogEntry[]): LogEntry[] =>
  log.filter((e) => e.path.startsWith('/assets/'));

export async function fetchManifest(base: string): Promise<ManifestLike> {
  const r = await fetch(`${base}/manifest.json`);
  if (!r.ok) throw new Error(`/manifest.json -> ${r.status}`);
  return (await r.json()) as ManifestLike;
}

export function entryOf(manifest: ManifestLike, id: string): ManifestEntryLike {
  const e = manifest.entries.find((x) => x.id === id);
  if (!e) throw new Error(`manifest has no entry ${id}`);
  return e;
}

// --- page -----------------------------------------------------------------------------------------

export async function waitForRuntime(page: Page): Promise<void> {
  await page.waitForFunction(() => '__runtime' in window, undefined, { timeout: 15_000 });
  await page.evaluate(
    () => (window as unknown as { __runtime: { ready: Promise<void> } }).__runtime.ready,
  );
}

export interface DemoQuery {
  /** quotaBytes injection (the demo passes it to the AssetManager; quota source 'quotaBytes'). */
  quota?: number;
  /** Progress throttle of the demo's manager in ms (default 50 in the demo). */
  progressMs?: number;
}

export async function openDemo(
  page: Page,
  base: string,
  store: Store,
  query: DemoQuery = {},
): Promise<void> {
  const url = new URL(base);
  url.pathname = '/';
  url.searchParams.set('store', store);
  if (query.quota !== undefined) url.searchParams.set('quota', String(query.quota));
  if (query.progressMs !== undefined) url.searchParams.set('progressMs', String(query.progressMs));
  await page.goto(url.toString());
  await waitForRuntime(page);
}

export const quotaSource = (page: Page): Promise<'estimate' | 'quotaBytes'> =>
  call<'estimate' | 'quotaBytes'>(page, 'quotaSource');

export interface AccountedUsage {
  rows: number;
  rowBytes: number;
  partBytes: number;
  bytes: number;
}
/** The manager's own accounting (index rows plus in-flight parts), via the demo. */
export const accountedUsage = (page: Page): Promise<AccountedUsage> =>
  call<AccountedUsage>(page, 'accountedUsage');

export async function callRaw(page: Page, method: string, ...args: unknown[]): Promise<CallResult> {
  return page.evaluate(
    ([m, a]) =>
      (
        window as unknown as {
          __runtime: { call: (method: string, ...args: unknown[]) => Promise<CallResult> };
        }
      ).__runtime.call(m, ...a),
    [method, args] as const,
  );
}

/** Call a demo runtime method; a failure becomes a CallError carrying the AssetError code. */
export async function call<T = unknown>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const r = await callRaw(page, method, ...args);
  if (!r.ok) throw new CallError(r.error.code, r.error.name, r.error.message);
  return r.value as T;
}

export async function expectCode(
  page: Page,
  method: string,
  code: string,
  ...args: unknown[]
): Promise<void> {
  const r = await callRaw(page, method, ...args);
  expect(r.ok, `${method} should fail with ${code}`).toBe(false);
  if (!r.ok) expect(r.error.code, `${method}: ${r.error.message}`).toBe(code);
}

export const events = (page: Page): Promise<EventLike[]> =>
  page.evaluate(
    () => (window as unknown as { __runtime: { events: EventLike[] } }).__runtime.events,
  );

export const list = (page: Page): Promise<IndexRowLike[]> => call<IndexRowLike[]>(page, 'list');

export const files = (page: Page): Promise<{ path: string; size: number }[]> =>
  call<{ path: string; size: number }[]>(page, 'storageFiles');

export const rowFor = async (page: Page, entryId: string): Promise<IndexRowLike | undefined> =>
  (await list(page)).find((r) => r.entryId === entryId);

export const named = (evs: EventLike[], name: string): EventLike[] =>
  evs.filter((e) => e.name === name);

export const isPartFile = (path: string): boolean =>
  /\.part(\.json)?$/.test(path) || path.includes('.part');

// --- CDP -----------------------------------------------------------------------------------------

export async function cdpFor(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Limit download throughput (bytes per second) for the page, or lift the limit with null. */
export async function throttle(cdp: CDPSession, bytesPerSecond: number | null): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: bytesPerSecond ?? -1,
    uploadThroughput: -1,
  });
}

/** Set the origin's storage quota through Chrome itself (no quotaBytes injection). */
export async function overrideQuota(
  cdp: CDPSession,
  origin: string,
  quotaSize: number,
): Promise<void> {
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
}

export class HeapSampler {
  private timer: NodeJS.Timeout | undefined;
  private max = 0;
  private samples = 0;
  constructor(private readonly cdp: CDPSession) {}
  async start(intervalMs = 250): Promise<void> {
    await this.cdp.send('Performance.enable');
    const tick = async (): Promise<void> => {
      try {
        const { metrics } = await this.cdp.send('Performance.getMetrics');
        const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
        this.max = Math.max(this.max, used);
        this.samples++;
      } catch {
        // page navigated or closed; keep the max so far
      }
    };
    await tick();
    this.timer = setInterval(() => void tick(), intervalMs);
  }
  async stop(): Promise<{ peakJsHeapBytes: number; samples: number }> {
    if (this.timer) clearInterval(this.timer);
    try {
      const { metrics } = await this.cdp.send('Performance.getMetrics');
      const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
      this.max = Math.max(this.max, used);
      this.samples++;
    } catch {
      // ignore
    }
    return { peakJsHeapBytes: this.max, samples: this.samples };
  }
}

/**
 * Poll the demo's progress record until entryId's fraction is within [lo, hi]. Fails if the download
 * passes `hi` without being observed inside the window, or if nothing moves before `timeoutMs`.
 */
export async function waitForProgress(
  page: Page,
  entryId: string,
  lo: number,
  hi: number,
  timeoutMs = 60_000,
): Promise<{ received: number; total: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await page.evaluate(
      (id) =>
        (
          window as unknown as {
            __runtime: { progress: Record<string, { received: number; total: number }> };
          }
        ).__runtime.progress[id] ?? null,
      entryId,
    );
    if (p && p.total > 0) {
      const f = p.received / p.total;
      if (f >= lo && f <= hi) return p;
      if (f > hi)
        throw new Error(`missed the ${lo}-${hi} window: progress is already at ${f.toFixed(3)}`);
    }
    if (Date.now() > deadline)
      throw new Error(`no progress into the ${lo}-${hi} window within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function writeReport(dir: string | undefined, name: string, data: unknown): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n');
}

// --- egress ---------------------------------------------------------------------------------------

export function isAllowedPagePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname.startsWith('/app/') ||
    pathname === '/manifest.json' ||
    pathname.startsWith('/assets/')
  );
}

/** Every URL must be on the demo origin and under the demo files, /manifest.json or /assets/*. */
export function assertEgress(urls: string[], base: string): void {
  const origin = new URL(base).origin;
  const bad = urls.filter((u) => {
    const url = new URL(u);
    return url.origin !== origin || !isAllowedPagePath(url.pathname);
  });
  expect(bad, 'unexpected request URLs').toEqual([]);
}

export function assertServerLogEgress(log: LogEntry[]): void {
  const bad = log.filter((e) => !isAllowedPagePath(e.path.split('?')[0] ?? e.path));
  expect(bad, 'unexpected server-side paths').toEqual([]);
}

// --- scenarios ------------------------------------------------------------------------------------

export interface DownloadReport {
  entryId: string;
  store: Store;
  bytes: number;
  wallMs: number;
  mbPerSecond: number;
  peakJsHeapBytes: number;
  sha256: string;
}

/** Download `entryId` in full, verify, and compare the recorded sha256 with the Node digest. */
export async function downloadAndVerify(
  page: Page,
  base: string,
  store: Store,
  entryId: string,
  size: number,
  reportDir?: string,
): Promise<DownloadReport> {
  await openDemo(page, base, store);
  const manifest = await fetchManifest(base);
  const entry = entryOf(manifest, entryId);
  expect(entry.size).toBe(size);
  const expected = digest(entryId, size);
  expect(entry.sha256, 'server manifest sha256 must equal the independent digest').toBe(expected);

  await call(page, 'loadManifest');
  const cdp = await cdpFor(page);
  const heap = new HeapSampler(cdp);
  await heap.start();
  const t0 = Date.now();
  await call(page, 'ensure', entryId);
  const wallMs = Date.now() - t0;
  const { peakJsHeapBytes } = await heap.stop();

  const row = await rowFor(page, entryId);
  expect(row, 'index row after ensure').toBeDefined();
  expect(row?.sha256).toBe(expected);
  expect(row?.size).toBe(size);
  expect(row?.verifiedAt, 'verifiedAt set').toBeTruthy();
  expect(await call<boolean>(page, 'has', entryId)).toBe(true);

  const evs = await events(page);
  expect(named(evs, 'asset.download.complete').length).toBeGreaterThanOrEqual(1);
  expect(named(evs, 'asset.verify.ok').some((e) => e.attrs['entryId'] === entryId)).toBe(true);
  expect(named(evs, 'asset.verify.failed')).toEqual([]);

  const blob = await call<{ size: number }>(page, 'getBlob', entryId);
  expect(blob.size).toBe(size);

  const leftovers = (await files(page)).filter((f) => isPartFile(f.path));
  expect(leftovers, 'no .part files after a complete download').toEqual([]);

  const report: DownloadReport = {
    entryId,
    store,
    bytes: size,
    wallMs,
    mbPerSecond: Number((size / 1e6 / (wallMs / 1000)).toFixed(1)),
    peakJsHeapBytes,
    sha256: expected,
  };
  writeReport(reportDir, `download-${entryId}-${store}.json`, report);
  return report;
}

export interface ResumeOptions {
  /** Download throughput cap while reaching the reload window (bytes/s). */
  throttleBps: number;
  /** Server honours Range (206 expected) or ignores it (200 and restart expected). */
  expectResume: boolean;
}

/** Reload at 38-42 %, then ensure() again and check the single Range request after the reload. */
export async function reloadResume(
  page: Page,
  base: string,
  store: Store,
  entryId: string,
  size: number,
  opts: ResumeOptions,
  reportDir?: string,
): Promise<void> {
  await openDemo(page, base, store);
  const manifest = await fetchManifest(base);
  const entry = entryOf(manifest, entryId);
  const expected = digest(entryId, size);
  await call(page, 'loadManifest');

  const cdp = await cdpFor(page);
  await throttle(cdp, opts.throttleBps);
  await page.evaluate(
    (id) =>
      (
        window as unknown as { __runtime: { startEnsure: (id: string) => void } }
      ).__runtime.startEnsure(id),
    entryId,
  );
  const seen = await waitForProgress(page, entryId, 0.38, 0.42);
  await page.reload();
  await throttle(cdp, null);
  await waitForRuntime(page);

  // The sidecar on disk now is what "at reload time" means: nothing writes between reload and ensure.
  const part =
    (await call<Record<string, unknown> | null>(page, 'readPartJson', entry.sha256)) ?? null;
  expect(part, `<sha>.part.json for ${entryId} after reload`).not.toBeNull();
  const bytesWritten = Number(part?.['bytesWritten']);
  expect(Number.isInteger(bytesWritten)).toBe(true);
  expect(bytesWritten).toBeGreaterThan(0);
  expect(bytesWritten).toBeLessThan(size);
  // Whole chunks can land between the last progress sample and the reload, so the sidecar may be
  // ahead of the sample by up to one chunk; it can never be ahead by more.
  const chunkSize = typeof entry['chunkSize'] === 'number' ? entry['chunkSize'] : 8_388_608;
  expect(bytesWritten).toBeLessThanOrEqual(seen.received + chunkSize);

  await resetLog(base);
  await call(page, 'loadManifest');
  await call(page, 'ensure', entryId);

  const reqs = assetRequests(await serverLog(base));
  expect(reqs, 'exactly one asset request after the reload').toHaveLength(1);
  const req = reqs[0];
  if (!req) throw new Error('unreachable');
  expect(req.path).toBe(`/assets/${entryId}`);
  expect(req.range).toBe(`bytes=${bytesWritten}-`);
  expect(req.ifRange).toBe(`"${entryId}-${size}"`);
  const evs = await events(page);
  if (opts.expectResume) {
    expect(req.status).toBe(206);
    expect(req.bytesSent).toBe(size - bytesWritten);
    expect(named(evs, 'asset.download.resumed').length).toBeGreaterThanOrEqual(1);
  } else {
    expect(req.status).toBe(200);
    expect(req.bytesSent).toBe(size);
    const restarted = named(evs, 'asset.download.restarted');
    expect(restarted.length).toBeGreaterThanOrEqual(1);
    expect(['status-200', 'ignore-range']).toContain(restarted[0]?.attrs['reason']);
  }

  const row = await rowFor(page, entryId);
  expect(row?.sha256).toBe(expected);
  expect(row?.verifiedAt).toBeTruthy();
  const leftovers = (await files(page)).filter((f) => isPartFile(f.path));
  expect(leftovers).toEqual([]);
  writeReport(reportDir, `resume-${entryId}-${store}.json`, {
    entryId,
    store,
    size,
    bytesWrittenAtReload: bytesWritten,
    receivedAtLastSample: seen.received,
    chunkSize,
    progressIntervalMs: await call<number>(page, 'progressIntervalMs'),
    throttleBps: opts.throttleBps,
    request: req,
    resumed: opts.expectResume,
  });
}

export interface QuotaScenario {
  a: { id: string; size: number };
  b: { id: string; size: number };
  c: { id: string; size: number };
  quotaBytes: number;
  /**
   * How the quota reaches the manager.
   *  'cdp'        Storage.overrideQuotaForOrigin: Chrome itself enforces the limit and throws
   *               QuotaExceededError; the manager runs on navigator.storage.estimate() alone
   *               (the real-world configuration). Used for the OPFS proof.
   *  'quotaBytes' the manager's quotaBytes test override via the demo's ?quota= parameter, no
   *               CDP override. Used for the IndexedDB proof: see CHROME_IDB_QUOTA_NOTE.
   */
  mode: 'cdp' | 'quotaBytes';
}

/**
 * Why the IndexedDB eviction proof uses quotaBytes injection instead of the CDP quota override.
 * Measured on Chrome for macOS (stable channel, Playwright 1.65, Nov 2026; T1 report
 * t1-quota-indexeddb.json and the quota-indexeddb.json this helper writes):
 *  - Storage.overrideQuotaForOrigin is enforced for OPFS: writes past it throw QuotaExceededError
 *    and the manager evicts reactively. Storage.getUsageAndQuota reports the override.
 *  - For IndexedDB Chrome under-reports usage: after storing 1,677,721,600 B of Blob chunks the CDP
 *    breakdown showed indexeddb usage 1,053,040,640 B (about 63 %), so a 1.5 GiB override never
 *    fired and no QuotaExceededError was thrown; all three assets stayed verified.
 *  - navigator.storage.estimate().quota ignores the override in both stores (10 GiB before and
 *    after) and estimate().usage follows the same under-reported figure for IndexedDB.
 * The IndexedDB proof therefore drives the manager's own accounting with quotaBytes = 1.5 GiB and
 * asserts the identical outcome. The CDP figures are still recorded in the report so the gap
 * between stored bytes and reported usage is visible. Real-quota IndexedDB eviction is deferred to
 * the 8 GB Windows laptop (runtime README Limitations, runtime/docs/security/FINDINGS.md).
 */
export const CHROME_IDB_QUOTA_NOTE =
  'Chrome under-reports IndexedDB usage (about 63 % of stored Blob bytes) and estimate().quota ignores Storage.overrideQuotaForOrigin; the IndexedDB proof uses quotaBytes injection.';

/** estimate().usage divided by the manager's accounted bytes, 4 decimals; null when undefined. */
const ratio = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;

interface UsageAndQuota {
  usage: number;
  quota: number;
  overrideActive?: boolean;
  usageBreakdown?: { storageType: string; usage: number }[];
}

/** Download a and b, touch a, download c: b must be evicted for quota; a and c stay verified. */
export async function quotaEviction(
  page: Page,
  base: string,
  store: Store,
  s: QuotaScenario,
  reportDir?: string,
): Promise<void> {
  await openDemo(page, base, store, s.mode === 'quotaBytes' ? { quota: s.quotaBytes } : {});
  const cdp = await cdpFor(page);
  const origin = new URL(base).origin;
  expect(await quotaSource(page)).toBe(s.mode === 'cdp' ? 'estimate' : 'quotaBytes');
  const estBefore = await call<{ usage: number; quota: number }>(page, 'estimate');
  if (s.mode === 'cdp') {
    await overrideQuota(cdp, origin, s.quotaBytes);
    // Chrome enforces the override (OPFS writes past it throw QuotaExceededError) and reports it
    // through CDP, but navigator.storage.estimate().quota keeps the profile default (measured on
    // Chrome for macOS, Nov 2026: 10 GiB before and after the override). The manager therefore has
    // to treat QuotaExceededError as the quota signal and evict reactively; estimate() only gives a
    // usable usage figure.
    const q = (await cdp.send('Storage.getUsageAndQuota', { origin })) as UsageAndQuota;
    expect(q.quota, 'CDP must report the overridden quota').toBe(s.quotaBytes);
  }
  const cdpQuota = (await cdp.send('Storage.getUsageAndQuota', { origin })) as UsageAndQuota;
  const est = await call<{ usage: number; quota: number }>(page, 'estimate');
  const manifest = await fetchManifest(base);
  const shaA = entryOf(manifest, s.a.id).sha256;
  const shaB = entryOf(manifest, s.b.id).sha256;
  const shaC = entryOf(manifest, s.c.id).sha256;

  await call(page, 'loadManifest');
  await call(page, 'ensure', s.a.id);
  await call(page, 'ensure', s.b.id);
  expect((await list(page)).map((r) => r.entryId).sort()).toEqual([s.a.id, s.b.id].sort());
  const cdpAfterAB = (await cdp.send('Storage.getUsageAndQuota', { origin })) as UsageAndQuota;
  const estAfterAB = await call<{ usage: number; quota: number }>(page, 'estimate');
  const accountedAfterAB = await accountedUsage(page);
  expect(accountedAfterAB.bytes, 'manager accounts for a + b').toBe(s.a.size + s.b.size);
  await new Promise((r) => setTimeout(r, 20)); // lastAccess strictly after b's commit
  const blobA = await call<{ size: number }>(page, 'getBlob', s.a.id);
  expect(blobA.size).toBe(s.a.size);
  await call(page, 'ensure', s.c.id);

  const evs = await events(page);
  const evicts = named(evs, 'asset.evict');
  expect(evicts, 'exactly one eviction').toHaveLength(1);
  expect(evicts[0]?.attrs['entryId']).toBe(s.b.id);
  expect(evicts[0]?.attrs['reason']).toBe('quota');
  expect(evicts[0]?.attrs['sha256']).toBe(shaB);
  expect(named(evs, 'asset.quota').length).toBeGreaterThanOrEqual(1);

  const rows = await list(page);
  expect(rows.map((r) => r.entryId).sort()).toEqual([s.a.id, s.c.id].sort());
  for (const r of rows) expect(r.verifiedAt, `${r.entryId} verified`).toBeTruthy();
  expect(rows.find((r) => r.entryId === s.a.id)?.sha256).toBe(shaA);
  expect(rows.find((r) => r.entryId === s.c.id)?.sha256).toBe(shaC);

  const all = await files(page);
  expect(all.filter((f) => isPartFile(f.path))).toEqual([]);
  const bins = all.filter((f) => f.path.endsWith('.bin'));
  if (bins.length > 0) {
    expect(bins.map((f) => f.path).some((p) => p.includes(shaB))).toBe(false);
    expect(bins.map((f) => f.path).some((p) => p.includes(shaA))).toBe(true);
    expect(bins.map((f) => f.path).some((p) => p.includes(shaC))).toBe(true);
  }
  expect(all.some((f) => f.path.includes(shaB))).toBe(false);
  const estAfter = await call<{ usage: number; quota: number }>(page, 'estimate');
  const cdpAfter = (await cdp.send('Storage.getUsageAndQuota', { origin })) as UsageAndQuota;
  const accountedAfter = await accountedUsage(page);
  const storedBytes = rows.reduce((n, r) => n + r.size, 0);
  expect(accountedAfter.bytes, 'manager accounts for a + c, no parts').toBe(storedBytes);
  writeReport(reportDir, `quota-${store}.json`, {
    scenario: s,
    quotaSource: await quotaSource(page),
    note: store === 'indexeddb' ? CHROME_IDB_QUOTA_NOTE : undefined,
    chrome: {
      storedBytesAfterAB: s.a.size + s.b.size,
      cdpUsageAfterAB: cdpAfterAB.usage,
      estimateUsageAfterAB: estAfterAB.usage,
      accountedUsageAfterAB: accountedAfterAB.bytes,
      estimateOverAccountedAfterAB: ratio(estAfterAB.usage, accountedAfterAB.bytes),
      storedBytesAfter: storedBytes,
      cdpUsageAfter: cdpAfter.usage,
      estimateUsageAfter: estAfter.usage,
      accountedUsageAfter: accountedAfter.bytes,
      estimateOverAccountedAfter: ratio(estAfter.usage, accountedAfter.bytes),
      cdpQuota: cdpQuota.quota,
      estimateQuotaBeforeOverride: estBefore.quota,
      estimateQuotaAfterOverride: est.quota,
      estimateQuotaAfter: estAfter.quota,
      usageBreakdownAfter: cdpAfter.usageBreakdown ?? null,
    },
    cdpQuota,
    estimateBefore: est,
    estimateAfter: estAfter,
    accountedAfterAB,
    accountedAfter,
    evictions: evicts,
    rows,
  });
}
