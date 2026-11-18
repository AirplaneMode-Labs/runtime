// D1-10: the packed runtime tarball, installed offline into a fresh empty directory (scripts/pack-check.mjs),
// is imported by a bundler-free page in installed Chrome: ./node_modules/@airplanemode/runtime/dist/index.js,
// then detectCapabilities(), verifyManifest() on the signed spec example (public RFC 8032 test key,
// allowTestKeys), verifyManifest() on the text of the tamper vector tamper-01 (refused with
// no_valid_signature) and MockAdapter.generate(), with 0 console errors and same-origin requests only.
//
//   npm run test:install

import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { expect, test } from 'playwright/test';

const root = resolve('.');
let server: Server | undefined;
let fresh = '';
let origin = '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

test.beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), 'airplanemode-install-'));
  const log = execFileSync(process.execPath, [join(root, 'scripts/pack-check.mjs'), '--out', out], {
    encoding: 'utf8',
  });
  expect(log).toContain('pack-check passed');
  const summary = JSON.parse(readFileSync(join(out, 'pack-check.json'), 'utf8')) as {
    freshDirectory: string;
  };
  fresh = summary.freshDirectory;
  // the signed spec example is not in the tarball (examples are not shipped): the page fetches a copy
  // that the test places beside it
  writeFileSync(
    join(fresh, 'manifest.signed.example.json'),
    readFileSync(join(root, 'spec/examples/manifest.signed.example.json')),
  );
  writeFileSync(
    join(fresh, 'tamper-01-entry-sha-byte.json'),
    readFileSync(join(root, 'spec/vectors/tamper/tamper-01-entry-sha-byte.json')),
  );
  writeFileSync(
    join(fresh, 'index.html'),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'; img-src data:; object-src 'none'; base-uri 'none'" />
<link rel="icon" href="data:," /><title>install check</title></head>
<body><pre id="out">running</pre><script type="module" src="./check.js"></script></body></html>`,
  );
  writeFileSync(
    join(fresh, 'check.js'),
    `import { detectCapabilities, verifyManifest, MockAdapter, SPEC_VERSIONS } from './node_modules/@airplanemode/runtime/dist/index.js';
const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const out = document.getElementById('out');
try {
  const profile = await detectCapabilities();
  const publicKey = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const keyId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)), (b) => b.toString(16).padStart(2, '0')).join('');
  const manifest = await (await fetch('./manifest.signed.example.json')).json();
  const verified = await verifyManifest(manifest, new Map([[keyId, publicKey]]), { allowTestKeys: true, now: Date.parse('2026-11-14T00:00:00Z') });
  const tamperText = await (await fetch('./tamper-01-entry-sha-byte.json')).text();
  const tampered = await verifyManifest(tamperText, new Map([[keyId, publicKey]]), { allowTestKeys: true, now: Date.parse('2026-11-14T00:00:00Z') });
  const adapter = new MockAdapter();
  await adapter.load({ id: 'mock', kind: 'model', url: 'x', sha256: '0'.repeat(64), size: 0, version: '1.0.0', licence: 'Apache-2.0', minProfile: {} }, { assets: { getEntry() { throw new Error('unused'); }, async getBlob() { return new Blob([]); } }, profile });
  const answer = await adapter.generate('hello', { maxTokens: 4, temperature: 0 });
  window.__result = { tier: profile.backendTier, verified: verified.ok, tamper01: tampered.ok ? 'accepted' : tampered.reason, spec: SPEC_VERSIONS.backendAdapter, finish: answer.finishReason, text: typeof answer.text };
  out.textContent = JSON.stringify(window.__result);
} catch (e) {
  window.__result = { error: String(e && e.message || e) };
  out.textContent = 'error';
}
`,
  );
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const file = resolve(
      fresh,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    );
    if (!file.startsWith(fresh + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(() => {
  server?.close();
});

test('a bundler-free page imports the installed tarball: capabilities, verifyManifest and MockAdapter.generate, 0 console errors, same origin only', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => '__result' in window);
  const result = await page.evaluate(
    () => (window as unknown as { __result: Record<string, unknown> }).__result,
  );
  expect(result['error']).toBeUndefined();
  expect(result['verified']).toBe(true);
  expect(result['tamper01']).toBe('no_valid_signature');
  expect(result['spec']).toBe('0.4.0'); // SPEC_VERSIONS.backendAdapter of spec release 0.5.0
  expect(['webgpu-f16', 'webgpu-f32', 'wasm-simd', 'wasm', 'none']).toContain(result['tier']);
  expect(result['finish']).toBeDefined();
  expect(errors).toEqual([]);
  expect(requests.length).toBeGreaterThan(2);
  for (const u of requests) expect(u.startsWith(origin) || u.startsWith('data:'), u).toBe(true);
  expect(
    requests.some((u) => u.includes('/node_modules/@airplanemode/runtime/dist/index.js')),
  ).toBe(true);
});
