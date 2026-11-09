#!/usr/bin/env node
// Hardened Range test server for the runtime browser proof. Node built-ins only.
//
//   node test/browser/range-server.mjs --port <n> --serve <dir> [--test-endpoints] [--ignore-range]
//        [--corrupt-hash] --asset <name>=<bytes> ...
//
// Contract (runtime range-server contract):
// - binds 127.0.0.1 only; any Host header other than 127.0.0.1[:port] or localhost[:port] gets 400;
// - bytes for asset <name> are the xorshift64* stream seeded 0x9E3779B97F4A7C15 XOR FNV-1a-64(name)
//   (test/tools/xorshift.mjs, shared with test/tools/asset-digest.mjs), truncated to <bytes>;
// - GET /assets/<name> supports single-range Range/If-Range with the strong ETag "<name>-<bytes>"
//   and Last-Modified fixed to Mon, 09 Nov 2026 00:00:00 GMT; answers 206/200/416;
// - --ignore-range: every asset response is 200 with the whole body (simulates a host without Range);
// - --corrupt-hash: the manifest carries a wrong sha256 for every asset (first hex digit flipped);
// - GET /manifest.json: the configured assets as relative urls assets/<name>, chunkSize 8388608 or
//   1048576 when bytes <= 1048576, signed with the RFC 8032 test seed (test/tools/lib.mjs);
// - /__requests (GET: JSON list of {method, path, range, ifRange, status, bytesSent}) and
//   /__reset (POST) exist only with --test-endpoints; /__* requests are never logged themselves;
// - static files from --serve on the same origin (index.html for /), no directory listings, no
//   path escapes; /assets/* is reserved for the streams and never served from the directory.
//
// No query string is ever honoured; a request path with ? or # is answered 404 for assets and the
// manifest (the manifest contract forbids them).

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStream } from '../tools/xorshift.mjs';
import { RFC8032_SEED_HEX, signManifest } from '../tools/lib.mjs';

const LAST_MODIFIED = 'Mon, 09 Nov 2026 00:00:00 GMT';
const CREATED_AT = '2026-11-09T00:00:00Z';
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const WRITE_CHUNK = 1 << 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function parseArgs(argv) {
  const opts = {
    port: 8787,
    serve: null,
    testEndpoints: false,
    ignoreRange: false,
    corruptHash: false,
    assets: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--port': {
        const v = next();
        if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new Error(`bad --port ${v}`);
        opts.port = Number(v);
        break;
      }
      case '--serve':
        opts.serve = resolve(next());
        break;
      case '--test-endpoints':
        opts.testEndpoints = true;
        break;
      case '--ignore-range':
        opts.ignoreRange = true;
        break;
      case '--corrupt-hash':
        opts.corruptHash = true;
        break;
      case '--asset': {
        const v = next();
        const eq = v.indexOf('=');
        if (eq <= 0) throw new Error(`bad --asset ${v}; expected name=bytes`);
        const name = v.slice(0, eq);
        const bytes = v.slice(eq + 1);
        if (!ASSET_NAME.test(name)) throw new Error(`bad asset name ${name}`);
        if (!/^\d+$/.test(bytes) || Number(bytes) > Number.MAX_SAFE_INTEGER)
          throw new Error(`bad asset size ${bytes}`);
        if (opts.assets.has(name)) throw new Error(`duplicate asset ${name}`);
        opts.assets.set(name, Number(bytes));
        break;
      }
      case '--host': {
        const v = next();
        if (v !== '127.0.0.1')
          throw new Error(`refusing to bind to ${v}: this server binds 127.0.0.1 only`);
        break;
      }
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  return opts;
}

function sha256OfStream(name, bytes) {
  const hash = createHash('sha256');
  const stream = new AssetStream(name);
  const buf = new Uint8Array(WRITE_CHUNK);
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, buf.length);
    const chunk = n === buf.length ? buf : buf.subarray(0, n);
    stream.fill(chunk);
    hash.update(chunk);
    left -= n;
  }
  return hash.digest('hex');
}

function flipFirstHexDigit(hex) {
  const first = hex[0] === '0' ? '1' : '0';
  return first + hex.slice(1);
}

/** Build the (lazily hashed) manifest for the configured assets. */
export function buildManifest(opts, digests) {
  const names = [...opts.assets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = names.map((name) => {
    const size = opts.assets.get(name);
    let sha256 = digests.get(name);
    if (opts.corruptHash) sha256 = flipFirstHexDigit(sha256);
    return {
      id: name,
      kind: 'data',
      url: `assets/${name}`,
      sha256,
      size,
      version: '1.0.0',
      licence: 'Apache-2.0',
      minProfile: {},
      chunkSize: size <= 1048576 ? 1048576 : 8388608,
    };
  });
  const body = {
    spec: 'airplanemode.manifest/0.1',
    id: 'dev.airplanemode.range-server',
    version: '1.0.0',
    publisher: 'Airplane Mode Labs range test server',
    createdAt: CREATED_AT,
    entries,
    signatures: [],
  };
  // RFC 8032 test vector key: public, non-secret test data; trusted only with allowTestKeys.
  body.signatures = [signManifest(body, RFC8032_SEED_HEX, CREATED_AT)];
  return body;
}

function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const m = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/.exec(hostHeader);
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

/** Parse a single-range `Range` header against `size`. Returns {start,end} | 'unsatisfiable' | null. */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range: ignore the header (RFC 9110 section 14.2)
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  if (s === '') {
    const suffix = Number(e);
    if (suffix === 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return size === 0 ? 'unsatisfiable' : { start, end: size - 1 };
  }
  const start = Number(s);
  if (start >= size) return 'unsatisfiable';
  const end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  if (end < start) return null;
  return { start, end };
}

function safeStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = resolve(root, '.' + sep + rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function createRangeServer(opts) {
  const log = [];
  const digests = new Map();
  let manifestCache = null;

  const manifestJson = () => {
    if (!manifestCache) {
      for (const [name, bytes] of opts.assets) {
        if (!digests.has(name)) digests.set(name, sha256OfStream(name, bytes));
      }
      manifestCache = JSON.stringify(buildManifest(opts, digests), null, 2) + '\n';
    }
    return manifestCache;
  };

  const server = createServer((req, res) => {
    const rawUrl = req.url || '/';
    const qIndex = rawUrl.search(/[?#]/);
    const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const hasQuery = qIndex !== -1;
    const entry = {
      method: req.method,
      path: rawUrl,
      range: req.headers.range ?? null,
      ifRange: req.headers['if-range'] ?? null,
      status: 0,
      bytesSent: 0,
    };
    const isTestEndpoint = path.startsWith('/__');
    const finish = () => {
      if (!isTestEndpoint) log.push(entry);
    };
    const send = (status, headers, body) => {
      entry.status = status;
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      if (body !== undefined && req.method !== 'HEAD') {
        entry.bytesSent = Buffer.byteLength(body);
        res.end(body);
      } else {
        res.end();
      }
      finish();
    };
    const text = (status, msg) =>
      send(status, { 'Content-Type': 'text/plain; charset=utf-8' }, msg + '\n');

    const port = server.address()?.port ?? opts.port;
    if (!hostAllowed(req.headers.host, port)) return text(400, 'bad host');

    if (isTestEndpoint) {
      if (!opts.testEndpoints) return text(404, 'not found');
      if (path === '/__requests' && req.method === 'GET')
        return send(200, { 'Content-Type': 'application/json' }, JSON.stringify(log));
      if (path === '/__reset' && req.method === 'POST') {
        log.length = 0;
        return text(200, 'reset');
      }
      return text(404, 'not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed');

    if (path === '/manifest.json') {
      if (hasQuery) return text(404, 'not found');
      let body;
      try {
        body = manifestJson();
      } catch (e) {
        return text(500, `manifest error: ${e.message}`);
      }
      return send(200, { 'Content-Type': 'application/json; charset=utf-8' }, body);
    }

    if (path.startsWith('/assets/')) {
      if (hasQuery) return text(404, 'not found');
      const name = path.slice('/assets/'.length);
      if (!opts.assets.has(name)) return text(404, 'no such asset');
      const size = opts.assets.get(name);
      const etag = `"${name}-${size}"`;
      const base = {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Last-Modified': LAST_MODIFIED,
      };
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (!opts.ignoreRange) {
        const range = parseRange(req.headers.range, size);
        const ifRange = req.headers['if-range'];
        const ifRangeOk = ifRange === undefined || ifRange === etag || ifRange === LAST_MODIFIED;
        if (range === 'unsatisfiable' && ifRangeOk) {
          return send(416, { ...base, 'Content-Range': `bytes */${size}` });
        }
        if (range && range !== 'unsatisfiable' && ifRangeOk) {
          start = range.start;
          end = range.end;
          status = 206;
        }
      }
      const length = size === 0 ? 0 : end - start + 1;
      const headers = { ...base, 'Content-Length': String(length) };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      entry.status = status;
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      if (req.method === 'HEAD' || length === 0) {
        res.end();
        return finish();
      }
      streamAsset(name, start, length, res, entry).finally(finish);
      return undefined;
    }

    if (!opts.serve) return text(404, 'not found');
    const file = safeStaticPath(opts.serve, path === '/' ? '/index.html' : path);
    if (!file) return text(404, 'not found');
    fs.stat(file)
      .then(async (st) => {
        let target = file;
        if (st.isDirectory()) {
          target = resolve(file, 'index.html');
          await fs.stat(target);
        }
        const data = await fs.readFile(target);
        send(
          200,
          { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' },
          data,
        );
      })
      .catch(() => text(404, 'not found'));
    return undefined;
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, log, manifestJson, digests };
}

/** Stream bytes [start, start+length) of the asset to `res`, honouring backpressure. */
async function streamAsset(name, start, length, res, entry) {
  const stream = new AssetStream(name);
  const skipWords = Math.floor(start / 8);
  for (let i = 0; i < skipWords; i++) stream.nextWord();
  const rem = start - skipWords * 8;
  if (rem > 0) stream.fill(new Uint8Array(rem));
  let left = length;
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  while (left > 0 && !aborted) {
    const n = Math.min(left, WRITE_CHUNK);
    const chunk = stream.fill(new Uint8Array(n));
    const ok = res.write(chunk);
    entry.bytesSent += n;
    left -= n;
    if (!ok && !aborted) {
      // Wait for drain, but give up if the client goes away first (a navigation mid-download).
      await new Promise((r) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          r();
        };
        res.once('drain', done);
        res.once('close', done);
      });
    }
  }
  if (!aborted) res.end();
}

export function startRangeServer(opts) {
  const ctx = createRangeServer(opts);
  return new Promise((resolveStart, reject) => {
    ctx.server.once('error', reject);
    ctx.server.listen(opts.port, '127.0.0.1', () => {
      const addr = ctx.server.address();
      ctx.port = addr.port;
      resolveStart(ctx);
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.assets.size === 0) throw new Error('at least one --asset name=bytes is required');
  } catch (e) {
    console.error(`range-server: ${e.message}`);
    process.exit(2);
  }
  startRangeServer(opts)
    .then((ctx) => {
      const flags = [
        opts.testEndpoints && 'test-endpoints',
        opts.ignoreRange && 'ignore-range',
        opts.corruptHash && 'corrupt-hash',
      ].filter(Boolean);
      console.log(
        `range-server listening on http://127.0.0.1:${ctx.port} assets=${[...opts.assets].map(([n, b]) => `${n}=${b}`).join(',')}${flags.length ? ' flags=' + flags.join(',') : ''}`,
      );
      const stop = () => ctx.server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      console.error(`range-server: ${e.message}`);
      process.exit(1);
    });
}
