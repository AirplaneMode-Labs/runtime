// D1-03: the Tamper lab of the runtime demo, in installed Chrome, against the demo built exactly as
// pages.yml builds it (DEMO_MODELS=1 npm run demo:build) and served under /runtime/ by a server that 404s
// every other path (test/browser/subpath-server.mjs). Every case of the lab must show 'Refused' with the
// documented reason code, the per-signature reasons and the stage; 0 asset requests follow a manifest
// refusal; the asset flip and truncation fetch the asset exactly once, expose 0 bytes and create no blob:
// URL; nothing persistent is written; no request leaves the origin; 0 console errors.
// Written before demo/tamper-lab.ts existed (red run: evidence/sprint-4/D1/red-D1-03.log).
//
//   npm run test:demo          (the config builds the demo first)
//
// Results go to tamper-results.json (RUNTIME_TAMPER_OUT, default runtime/test-results/, git-ignored).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from 'playwright/test';
import { resultsDir } from './out-dir';

const BASE = 'http://127.0.0.1:8791/runtime/';
const OUT_DIR = resultsDir('RUNTIME_TAMPER_OUT');
const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../spec/vectors');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

interface Row {
  file: string;
  expect: { valid: boolean; stage?: string; reason?: string; signatures?: string[] };
}
const rows = readJson<Row[]>(resolve(SPEC, 'tamper/tamper.json'));
const assetExpect = readJson<
  Record<string, { informative: { runtimeCode: string | null; runtimeReason: string | null } }>
>(resolve(SPEC, 'tamper-assets/expect.json'));
const rowOf = (prefix: string): Row => rows.find((r) => r.file.startsWith(prefix))!;

/** The thirteen lab cases: id, the vector behind it and what the lab must show. */
const MANIFEST_CASES = [
  ['tamper-01', 'tamper-01'],
  ['tamper-02', 'tamper-02'],
  ['tamper-03', 'tamper-03'],
  ['tamper-04', 'tamper-04'],
  ['tamper-05', 'tamper-05'],
  ['tamper-06', 'tamper-06'],
  ['tamper-07', 'tamper-07'],
  ['tamper-08', 'tamper-08'],
  ['tamper-10', 'tamper-10'],
  ['tamper-15', 'tamper-15'],
] as const;
const ASSET_CASES = [
  ['asset-flip', 'manifest-flip.json', 'asset-flip.bin'],
  ['asset-truncated', 'manifest-truncated.json', 'asset-truncated.bin'],
] as const;

const PARSE_REASONS = new Set([
  'invalid_json',
  'lone_surrogate',
  'float',
  'bigint',
  'digit_key',
  'invalid_key',
  'bad_spec',
  'bad_url',
  'schema',
  'unsorted_entries',
  'duplicate_entries',
]);

const results: Record<string, unknown> = { generatedAt: new Date().toISOString(), base: BASE };
test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'tamper-results.json'), JSON.stringify(results, null, 2));
});

test('allowTestKeys: true appears only in the lab module of the shipped page code (grep)', () => {
  const demo = resolve(HERE, '../../demo');
  const files = readdirSync(demo).filter((f) => f.endsWith('.ts'));
  expect(files).toContain('tamper-lab.ts');
  const lab = readFileSync(resolve(demo, 'tamper-lab.ts'), 'utf8');
  expect(lab).toMatch(/allowTestKeys:\s*true/);
  // the lab never reads its trust, its state or the flag from the URL, storage or the pasted roots
  for (const forbidden of [
    /location\.search/,
    /URLSearchParams/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /getDirectory/,
    /ta-roots/,
    /chk-testkey/,
  ])
    expect(lab, String(forbidden)).not.toMatch(forbidden);
  // elsewhere the literal true is only on the loopback path of the backend page (existing rule)
  const main = readFileSync(resolve(demo, 'main.ts'), 'utf8');
  expect(main).not.toMatch(/allowTestKeys:\s*true/);
  expect(main).not.toMatch(/allowTestKeys\s*=\s*true/);
});

test('every Tamper lab case is refused with its documented reason, and nothing leaks', async () => {
  test.setTimeout(5 * 60_000);
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: { url: string; at: number }[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    context.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));

    await page.goto(BASE);
    // the refreshed root page: a Sprint 4 build id, its status line, the not-yet box, the strict CSP meta
    await expect(page.locator('#build-id')).toHaveText(/^([0-9a-f]{12}|local)$/);
    await expect(page.locator('#status-line')).toContainText('Sprint 4 (14 Nov 2026)');
    await expect(page.locator('#status-line')).toContainText(
      "manifest spec v0.1 published in runtime/spec (committed; public after the owner's push)",
    );
    await expect(page.locator('#not-yet')).toContainText(
      'WebLLM (cut from Sprint 4; revisit after the Sprint 5 measurement)',
    );
    await expect(page.locator('#not-yet')).toContainText('Windows and 8 GB no-GPU measurements');
    expect(
      await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    ).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    await expect(page.locator('#tamper-lab')).toBeVisible();
    await expect(page.locator('#tamper-lab')).toContainText(
      'RFC 8032 public test keys: demo only; allowTestKeys is false by default in the library',
    );
    const caseIds = await page
      .locator('#tamper-lab [data-case]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-case')));
    expect(caseIds).toEqual([
      ...MANIFEST_CASES.map(([id]) => id),
      ...ASSET_CASES.map(([id]) => id),
      'valid',
    ]);

    const cell = (id: string, name: string) =>
      page.locator(`#tamper-lab [data-case="${id}"] [data-cell="${name}"]`);
    const run = async (id: string) => {
      await page.locator(`#tamper-lab [data-case="${id}"] button[data-action="run"]`).click();
      await expect(cell(id, 'after')).toContainText('Requests after refusal:', {
        timeout: 20_000,
      });
    };
    const assetRequests = (since: number, file: string) =>
      requests.filter(
        (r) => r.at >= since && new URL(r.url).pathname.endsWith(`/tamper/assets/${file}`),
      ).length;

    const manifestRuns: Record<string, unknown> = {};
    for (const [id, prefix] of MANIFEST_CASES) {
      const row = rowOf(prefix);
      const t0 = Date.now();
      await run(id);
      await expect(cell(id, 'verdict'), id).toHaveText('Refused');
      await expect(cell(id, 'reason'), id).toHaveText(row.expect.reason!);
      await expect(cell(id, 'signatures'), id).toHaveText(
        (row.expect.signatures ?? []).join(', ') || '(none)',
      );
      await expect(cell(id, 'stage'), id).toHaveText(
        PARSE_REASONS.has(row.expect.reason!) ? 'parse' : 'verify',
      );
      // 0 asset requests after any manifest refusal, in the page's own counter and in the capture
      await expect(cell(id, 'after'), id).toHaveText('Requests after refusal: 0');
      await expect(cell(id, 'assetRequests'), id).toHaveText('Asset requests: 0');
      for (const f of ['asset-ok.bin', 'asset-flip.bin', 'asset-truncated.bin'])
        expect(assetRequests(t0, f), `${id} requested ${f}`).toBe(0);
      manifestRuns[id] = {
        verdict: await cell(id, 'verdict').textContent(),
        reason: await cell(id, 'reason').textContent(),
        signatures: await cell(id, 'signatures').textContent(),
        stage: await cell(id, 'stage').textContent(),
        after: await cell(id, 'after').textContent(),
      };
    }
    results['manifestCases'] = manifestRuns;

    const assetRuns: Record<string, unknown> = {};
    for (const [id, manifestFile, binFile] of ASSET_CASES) {
      const t0 = Date.now();
      await run(id);
      const exp = assetExpect[manifestFile]!.informative;
      await expect(cell(id, 'verdict'), id).toHaveText('Refused');
      await expect(cell(id, 'asset'), id).toContainText(`AssetError ${exp.runtimeCode}`);
      if (exp.runtimeReason) await expect(cell(id, 'asset'), id).toContainText(exp.runtimeReason);
      await expect(cell(id, 'asset'), id).toContainText('runtime-specific');
      await expect(cell(id, 'bytes'), id).toContainText('Bytes to consumer: 0');
      await expect(cell(id, 'bytes'), id).toContainText('getBlob: rejected');
      await expect(cell(id, 'bytes'), id).toContainText('blob: URLs created: 0');
      await expect(cell(id, 'after'), id).toHaveText('Requests after refusal: 0');
      // the asset is fetched exactly once, then refused
      await expect(cell(id, 'assetRequests'), id).toHaveText('Asset requests: 1');
      expect(assetRequests(t0, binFile), `${id}: ${binFile} fetched`).toBe(1);
      assetRuns[id] = {
        verdict: await cell(id, 'verdict').textContent(),
        asset: await cell(id, 'asset').textContent(),
        bytes: await cell(id, 'bytes').textContent(),
        assetRequests: await cell(id, 'assetRequests').textContent(),
      };
    }
    results['assetCases'] = assetRuns;

    await run('valid');
    await expect(cell('valid', 'verdict')).toHaveText('Accepted');
    await expect(cell('valid', 'signatures')).toHaveText('valid');
    results['valid'] = await cell('valid', 'verdict').textContent();

    // isolation: the persistent runtime stores hold nothing of the lab
    const assetSha = createHash('sha256')
      .update(readFileSync(resolve(SPEC, 'tamper-assets/asset-ok.bin')))
      .digest('hex');
    const persisted = await page.evaluate(async () => {
      const out = {
        opfsFiles: [] as string[],
        opfsText: '',
        idbText: '',
        idbStores: [] as string[],
      };
      const root = await navigator.storage.getDirectory();
      let dir: FileSystemDirectoryHandle | undefined;
      try {
        dir = await root.getDirectoryHandle('airplanemode-runtime');
      } catch {
        dir = undefined;
      }
      const walk = async (d: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        for await (const [name, handle] of (
          d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries()) {
          if (handle.kind === 'directory')
            await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
          else {
            out.opfsFiles.push(`${prefix}${name}`);
            const f = await (handle as FileSystemFileHandle).getFile();
            if (f.size < 1_000_000) out.opfsText += await f.text();
          }
        }
      };
      if (dir) await walk(dir, 'airplanemode-runtime/');
      const dbs = (await indexedDB.databases?.()) ?? [];
      if (dbs.some((d) => d.name === 'airplanemode-runtime')) {
        const db: IDBDatabase = await new Promise((res, rej) => {
          const r = indexedDB.open('airplanemode-runtime');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        out.idbStores = [...db.objectStoreNames];
        for (const name of out.idbStores) {
          if (/chunk/i.test(name)) continue;
          const all: unknown[] = await new Promise((res, rej) => {
            const r = db.transaction(name).objectStore(name).getAll();
            r.onsuccess = () => res(r.result as unknown[]);
            r.onerror = () => rej(r.error);
          });
          out.idbText += JSON.stringify(all, (_k, v) => (v instanceof Blob ? '[blob]' : v));
        }
        db.close();
      }
      return out;
    });
    results['persisted'] = {
      opfsFiles: persisted.opfsFiles,
      idbStores: persisted.idbStores,
    };
    expect(persisted.opfsText).not.toContain('tamper-base');
    expect(persisted.idbText).not.toContain('tamper-base');
    expect(persisted.opfsFiles.some((f) => f.includes(assetSha))).toBe(false);
    expect(persisted.idbText).not.toContain(assetSha);

    // nothing leaves the origin; every request is under /runtime/
    const origin = new URL(BASE).origin;
    for (const r of requests) {
      const u = new URL(r.url);
      if (u.protocol === 'blob:' || u.protocol === 'data:') continue;
      expect(u.origin, r.url).toBe(origin);
      expect(u.pathname.startsWith('/runtime/'), r.url).toBe(true);
    }
    expect(errors, 'console and page errors').toEqual([]);
    results['buildId'] = await page.locator('#build-id').textContent();
    results['statusLine'] = (await page.locator('#status-line').textContent())
      ?.replace(/\s+/g, ' ')
      .trim();
    results['requests'] = requests.length;
    results['consoleErrors'] = errors.length;

    mkdirSync(OUT_DIR, { recursive: true });
    await page.locator('#tamper-lab').screenshot({ path: resolve(OUT_DIR, 'tamper-lab.png') });
  } finally {
    await browser.close();
  }
});
