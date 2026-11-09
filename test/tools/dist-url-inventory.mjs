#!/usr/bin/env node
// Lists every URL string with a Hugging Face, CDN, GitHub or Google host in a built demo (demo/dist):
// chunk, string, which library put it there and, for the ones that look like endpoints, the line of
// src/backends/transformers.ts that overrides it. It also scans for the same hosts as bare names
// (huggingface.co, hf.co, jsdelivr, unpkg, cdnjs, github.com, raw.githubusercontent.com, googleapis,
// gstatic) outside any https:// string, such as the engine's host allow-list literal (T1-S2-08).
// Exits 1 if a string or a bare name cannot be attributed, so a new library URL has to be reviewed. A
// string in a bundle is not a request: the adapter configures the engine so that none of these is ever
// fetched (configureEnv + the verified-file shim) and the page CSP is connect-src 'self'.
//
//   node test/tools/dist-url-inventory.mjs <demo/dist> [<out.txt>]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const [, , distArg, outArg] = process.argv;
if (!distArg) {
  console.error('usage: dist-url-inventory.mjs <demo/dist> [<out.txt>]');
  process.exit(2);
}
const dist = resolve(distArg);

const HOSTS =
  /(huggingface\.co|hf\.co|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|github\.com|githubusercontent\.com|googleapis\.com|gstatic\.com)/;
const URL_RE = /https?:\/\/[^\s"'`<>)\\]+/g;
// A listed host as a bare name: not part of a longer word (a letter, digit or hyphen before or after).
const BARE_RE =
  /(?<![A-Za-z0-9-])(huggingface\.co|hf\.co|jsdelivr|unpkg|cdnjs|raw\.githubusercontent\.com|githubusercontent|github\.com|googleapis|gstatic)(?![A-Za-z0-9-])/gi;

const adapterSource = readFileSync(join(root, 'src/backends/transformers.ts'), 'utf8').split('\n');
const lineOf = (needle) => {
  const i = adapterSource.findIndex((l) => l.includes(needle));
  return i < 0 ? null : `src/backends/transformers.ts:${i + 1}`;
};

/** Returns {library, role, override} or null when the string is not recognised. */
function attribute(url, file) {
  if (/^https:\/\/huggingface\.co\/$/.test(url))
    return {
      library: '@huggingface/transformers 4.3.1',
      role: 'default env.remoteHost',
      override: `${lineOf('remoteHost: REMOTE_HOST_SINK')} (remoteHost = https://invalid.invalid/) and allowRemoteModels = false`,
    };
  if (/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/.test(url))
    return {
      library: '@huggingface/transformers 4.3.1',
      role: 'default ONNX Runtime wasmPaths prefix (a template literal)',
      override: `${lineOf("wasm['wasmPaths'] = { mjs: ctx.ortFactoryUrl }")} (wasmPaths = {mjs: same-origin}, no wasm key), ${lineOf('useWasmCache: false')} (useWasmCache = false)`,
    };
  if (/^https:\/\/huggingface\.co\/(docs|papers|datasets)\//.test(url))
    return {
      library: '@huggingface/transformers 4.3.1',
      role: 'documentation link in a doc comment or error string; never requested',
      override: null,
    };
  if (/^https:\/\/(gist\.)?github\.com\//.test(url) && /transformers\.web/.test(file))
    return {
      library: '@huggingface/transformers 4.3.1',
      role: 'link in a comment or error string; never requested',
      override: null,
    };
  if (/^https:\/\/github\.com\/AirplaneMode-Labs\/runtime/.test(url))
    return { library: 'this repository', role: 'link text in the page', override: null };
  return null;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|html|css|json|txt)$/.test(name)) out.push(p);
  }
  return out;
}

const rows = [];
let unattributed = 0;
for (const file of walk(dist).sort()) {
  const text = readFileSync(file, 'utf8');
  const seen = new Set();
  const covered = []; // [start, end) of every https string, so a bare name inside one is not counted twice
  for (const m of text.matchAll(URL_RE)) {
    covered.push([m.index, m.index + m[0].length]);
    const url = m[0].replace(/[.,;]+$/, '');
    if (!HOSTS.test(url.split('/')[2] ?? '') || seen.has(url)) continue;
    seen.add(url);
    const a = attribute(url, file);
    if (!a) unattributed++;
    rows.push({ kind: 'url', chunk: relative(dist, file), url, a });
  }
  const seenBare = new Set();
  for (const m of text.matchAll(BARE_RE)) {
    if (covered.some(([from, to]) => m.index >= from && m.index < to)) continue;
    const context = text
      .slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
      .replace(/\s+/g, ' ');
    if (seenBare.has(context)) continue;
    seenBare.add(context);
    // nothing is attributed as a bare name: an endpoint that was neutralised is not in the build at all
    unattributed++;
    rows.push({ kind: 'bare', chunk: relative(dist, file), url: context, a: null });
  }
}
const lines = [
  `# URL inventory of ${relative(root, dist)} (host patterns, as https:// strings and as bare names: huggingface.co, hf.co, jsdelivr, unpkg, cdnjs, github, githubusercontent, googleapis, gstatic)`,
  '',
];
for (const r of rows) {
  lines.push(`chunk:    ${r.chunk}`);
  lines.push(`${r.kind === 'bare' ? 'bare:     ' : 'string:   '}${r.url}`);
  lines.push(`from:     ${r.a ? `${r.a.library}: ${r.a.role}` : 'UNATTRIBUTED'}`);
  lines.push(`override: ${r.a?.override ?? '(none needed: not an endpoint)'}`);
  lines.push('');
}
lines.push(`strings: ${rows.length}; unattributed: ${unattributed}`);
const text = lines.join('\n') + '\n';
if (outArg) writeFileSync(resolve(outArg), text);
console.log(text);
process.exit(unattributed ? 1 : 0);
