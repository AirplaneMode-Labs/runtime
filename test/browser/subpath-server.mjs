#!/usr/bin/env node
// Serves a built demo (demo/dist) the way GitHub Pages serves a project site: only under /<repo>/, with
// every other path a 404, Range requests answered, nothing else exposed. Binds 127.0.0.1 only. Used by
// the demo proof (test/browser/demo.spec.ts) to check that the build works at the sub-path /runtime/.
//
//   node test/browser/subpath-server.mjs --port 8791 --serve demo/dist --base /runtime/

import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(arg('--port', '8791'));
const root = resolve(arg('--serve', 'demo/dist'));
const base = arg('--base', '/runtime/');
if (!/^\/[A-Za-z0-9._-]+\/$/.test(base)) throw new Error(`bad --base ${base}`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream',
};

const rootReal = await fs.realpath(root);
const server = createServer(async (req, res) => {
  const fail = (status) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 404 ? 'not found' : 'error');
  };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(base)) return fail(404);
    path = path.slice(base.length);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const file = resolve(join(rootReal, path));
    if (file !== rootReal && !file.startsWith(rootReal + sep)) return fail(404);
    const st = await fs.stat(file).catch(() => null);
    if (!st || !st.isFile()) return fail(404);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    if (m) {
      start = Number(m[1]);
      end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
    }
    const headers = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    fail(404);
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`serving ${rootReal} under http://127.0.0.1:${port}${base}`),
);
