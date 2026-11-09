// Node-only tests for test/browser/range-server.mjs (no browser, no dependencies).
//   node --test test/browser/range-server.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamBytesBig } from '../tools/xorshift.mjs';
import { RFC8032_PUBLIC_HEX, verifySig } from '../tools/lib.mjs';
import { parseArgs, parseRange, startRangeServer } from './range-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'range-server.mjs');
const digestTool = join(here, '..', 'tools', 'asset-digest.mjs');

const SMALL = 70000; // not a multiple of 8, not a multiple of the write chunk
let ctx;
let base;
let serveDir;

before(async () => {
  serveDir = mkdtempSync(join(tmpdir(), 'range-server-static-'));
  writeFileSync(join(serveDir, 'index.html'), '<!doctype html><title>demo</title>');
  writeFileSync(join(serveDir, 'secret.txt'), 'static ok');
  ctx = await startRangeServer(
    parseArgs([
      '--port',
      '0',
      '--serve',
      serveDir,
      '--test-endpoints',
      '--asset',
      `small=${SMALL}`,
      '--asset',
      'hello-data=1048576',
      '--asset',
      'big-ish=9000000',
    ]),
  );
  base = `http://127.0.0.1:${ctx.port}`;
});

after(() => {
  ctx.server.close();
  rmSync(serveDir, { recursive: true, force: true });
});

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const get = (path, headers = {}) => fetch(base + path, { headers });

test('parseArgs validates names, sizes, duplicates and refuses foreign --host', () => {
  assert.throws(() => parseArgs(['--asset', 'Bad=1']), /bad asset name/);
  assert.throws(() => parseArgs(['--asset', 'a=1', '--asset', 'a=2']), /duplicate/);
  assert.throws(() => parseArgs(['--asset', 'a=x']), /bad asset size/);
  assert.throws(() => parseArgs(['--host', '0.0.0.0']), /refusing to bind/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  const o = parseArgs(['--port', '1234', '--asset', 'a=5', '--ignore-range', '--corrupt-hash']);
  assert.equal(o.port, 1234);
  assert.equal(o.assets.get('a'), 5);
  assert.equal(o.ignoreRange, true);
  assert.equal(o.corruptHash, true);
});

test('parseRange handles the RFC 9110 forms', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-99,200-299', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
});

test('refuses to start with a foreign --host and prints the listening line otherwise', async () => {
  const bad = spawn(process.execPath, [serverPath, '--host', '0.0.0.0', '--asset', 'a=1']);
  const code = await new Promise((r) => bad.on('exit', r));
  assert.equal(code, 2);

  const good = spawn(process.execPath, [serverPath, '--port', '0', '--asset', 'a=16']);
  const line = await new Promise((r) => good.stdout.once('data', (d) => r(String(d))));
  assert.match(line, /^range-server listening on http:\/\/127\.0\.0\.1:\d+ assets=a=16/);
  good.kill('SIGTERM');
  await new Promise((r) => good.on('exit', r));
});

// fetch() drops a caller-supplied Host header, so raw http.request is used for the Host checks.
const statusWithHost = (host) =>
  new Promise((resolveStatus, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ctx.port,
        path: '/manifest.json',
        method: 'GET',
        setHost: false,
        headers: { Host: host },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolveStatus(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });

test('rejects a foreign Host header with 400 and accepts 127.0.0.1 and localhost', async () => {
  for (const host of [
    'example.com',
    `example.com:${ctx.port}`,
    '127.0.0.1:1',
    'evil.127.0.0.1',
    '',
  ]) {
    assert.equal(await statusWithHost(host), 400, host);
  }
  for (const host of ['127.0.0.1', `127.0.0.1:${ctx.port}`, 'localhost', `localhost:${ctx.port}`]) {
    assert.equal(await statusWithHost(host), 200, host);
  }
});

test('full GET of an asset returns the xorshift64* stream with the strong ETag', async () => {
  const r = await get('/assets/small');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"small-${SMALL}"`);
  assert.equal(r.headers.get('last-modified'), 'Mon, 09 Nov 2026 00:00:00 GMT');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-length'), String(SMALL));
  const body = new Uint8Array(await r.arrayBuffer());
  assert.equal(body.length, SMALL);
  assert.deepEqual(body, streamBytesBig('small', SMALL));
});

test('asset bytes agree with test/tools/asset-digest.mjs', async () => {
  const expected = execFileSync(process.execPath, [digestTool, 'hello-data', '1048576'])
    .toString()
    .trim();
  const r = await get('/assets/hello-data');
  assert.equal(sha256(new Uint8Array(await r.arrayBuffer())), expected);
  const manifest = await (await get('/manifest.json')).json();
  const entry = manifest.entries.find((e) => e.id === 'hello-data');
  assert.equal(entry.sha256, expected);
  assert.equal(entry.chunkSize, 1048576);
  assert.equal(manifest.entries.find((e) => e.id === 'big-ish').chunkSize, 8388608);
});

test('Range requests get 206 with Content-Range; If-Range mismatch gets 200; past-end gets 416', async () => {
  const r = await get('/assets/small', { Range: 'bytes=1000-1999' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-1999/${SMALL}`);
  assert.equal(r.headers.get('content-length'), '1000');
  const body = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual(body, streamBytesBig('small', 2000).subarray(1000));

  const open = await get('/assets/small', { Range: `bytes=${SMALL - 7}-` });
  assert.equal(open.status, 206);
  assert.equal((await open.arrayBuffer()).byteLength, 7);

  const matched = await get('/assets/small', {
    Range: 'bytes=10-19',
    'If-Range': `"small-${SMALL}"`,
  });
  assert.equal(matched.status, 206);
  const mismatched = await get('/assets/small', { Range: 'bytes=10-19', 'If-Range': '"small-1"' });
  assert.equal(mismatched.status, 200);
  assert.equal((await mismatched.arrayBuffer()).byteLength, SMALL);

  const past = await get('/assets/small', { Range: `bytes=${SMALL}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${SMALL}`);

  const head = await fetch(base + '/assets/small', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(SMALL));
});

test('unknown asset, query strings and non-GET methods are refused', async () => {
  assert.equal((await get('/assets/nope')).status, 404);
  assert.equal((await get('/assets/small?x=1')).status, 404);
  assert.equal((await get('/manifest.json?x=1')).status, 404);
  assert.equal((await fetch(base + '/assets/small', { method: 'POST' })).status, 405);
});

test('manifest is sorted, uses relative urls and verifies under the RFC 8032 public key', async () => {
  const manifest = await (await get('/manifest.json')).json();
  assert.equal(manifest.spec, 'airplanemode.manifest/0.1');
  const ids = manifest.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const e of manifest.entries) {
    assert.equal(e.url, `assets/${e.id}`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(manifest.signatures.length, 1);
  assert.equal(manifest.signatures[0].alg, 'ed25519');
  assert.equal(verifySig(manifest, manifest.signatures[0].sig, RFC8032_PUBLIC_HEX), true);
});

test('--corrupt-hash flips the first hex digit of every sha256', async () => {
  const bad = await startRangeServer(
    parseArgs(['--port', '0', '--corrupt-hash', '--asset', 'hello-data=1048576']),
  );
  try {
    const good = JSON.parse(ctx.manifestJson());
    const goodSha = good.entries.find((e) => e.id === 'hello-data').sha256;
    const m = await (await fetch(`http://127.0.0.1:${bad.port}/manifest.json`)).json();
    assert.equal(m.entries.length, 1);
    assert.notEqual(m.entries[0].sha256, goodSha);
    assert.equal(m.entries[0].sha256.slice(1), goodSha.slice(1));
    // the bytes themselves are unchanged
    const r = await fetch(`http://127.0.0.1:${bad.port}/assets/hello-data`);
    assert.equal(sha256(new Uint8Array(await r.arrayBuffer())), goodSha);
  } finally {
    bad.server.close();
  }
});

test('--ignore-range always answers 200 with the whole body', async () => {
  const srv = await startRangeServer(
    parseArgs(['--port', '0', '--ignore-range', '--asset', `small=${SMALL}`]),
  );
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/assets/small`, {
      headers: { Range: 'bytes=100-199', 'If-Range': `"small-${SMALL}"` },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-range'), null);
    assert.equal((await r.arrayBuffer()).byteLength, SMALL);
  } finally {
    srv.server.close();
  }
});

test('/__requests and /__reset exist only with --test-endpoints and log range, ifRange, status, bytesSent', async () => {
  const plain = await startRangeServer(parseArgs(['--port', '0', '--asset', 'a=16']));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${plain.port}/__requests`)).status, 404);
    assert.equal(
      (await fetch(`http://127.0.0.1:${plain.port}/__reset`, { method: 'POST' })).status,
      404,
    );
  } finally {
    plain.server.close();
  }

  await fetch(base + '/__reset', { method: 'POST' });
  await (
    await get('/assets/small', { Range: 'bytes=64-127', 'If-Range': `"small-${SMALL}"` })
  ).arrayBuffer();
  await (await get('/manifest.json')).text();
  const log = await (await get('/__requests')).json();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], {
    method: 'GET',
    path: '/assets/small',
    range: 'bytes=64-127',
    ifRange: `"small-${SMALL}"`,
    status: 206,
    bytesSent: 64,
  });
  assert.equal(log[1].path, '/manifest.json');
  assert.equal(log[1].status, 200);
  await fetch(base + '/__reset', { method: 'POST' });
  assert.deepEqual(await (await get('/__requests')).json(), []);
});

test('static files come from --serve; /assets is never static; path escapes are refused', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /<title>demo<\/title>/);
  assert.equal((await get('/secret.txt')).status, 200);
  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/assets/index.html')).status, 404);
  const escape = await fetch(base + '/%2e%2e/%2e%2e/etc/passwd');
  assert.equal(escape.status, 404);
});

test('a request aborted mid-stream records the bytes actually written', async () => {
  await fetch(base + '/__reset', { method: 'POST' });
  const ac = new AbortController();
  const r = await get('/assets/big-ish');
  const reader = r.body.getReader();
  await reader.read();
  await reader.cancel();
  ac.abort();
  // give the server a tick to observe the close
  await new Promise((res) => setTimeout(res, 100));
  const log = await (await get('/__requests')).json();
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 200);
  assert.ok(log[0].bytesSent >= 1 << 20 && log[0].bytesSent <= 9000000, String(log[0].bytesSent));
});
