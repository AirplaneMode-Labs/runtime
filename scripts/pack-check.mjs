#!/usr/bin/env node
// Packs the runtime and proves the tarball, offline, from an empty npm cache:
//
//   1. npm pack (scripts disabled) and a check of the file list: only dist/, spec/, LICENSE, NOTICE,
//      README.md and package.json; no source map, test data, model file or file over 5 MB; no
//      lifecycle script; every `types` target of the exports map present; the README carries the
//      honest install sentence.
//   2. dist/ names no engine-default endpoint (huggingface.co, raw.githubusercontent.com,
//      cdn.jsdelivr.net, unpkg.com) outside scripts/url-allowlist.txt.
//   3. a fresh empty directory: npm init -y, then
//        npm i <tgz> --ignore-scripts --offline --no-audit --no-fund --cache <empty cache>
//      and `npm ls --all` lists exactly @airplanemode/runtime (no optional peer is installed).
//   4. a real Node call: verifyManifest() on the signed spec example with the public RFC 8032 test key
//      under allowTestKeys prints valid:true.
//
//   node scripts/pack-check.mjs [--out <dir>] [--work <dir>] [--skip-build]
//
// --out is where the tarball and pack-check.json are written (default: a new temporary directory);
// --work is the parent of the fresh install directory (default: the same). Nothing here publishes.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = resolve(arg('--out') ?? mkdtempSync(join(tmpdir(), 'airplanemode-runtime-pack-')));
const work = resolve(arg('--work') ?? out);
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const MAX_FILE = 5 * 1024 * 1024;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npm = (args, cwd) =>
  execFileSync(NPM, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });

const failures = [];
const ok = (cond, message) => {
  if (!cond) failures.push(message);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${message}`);
};

if (!process.argv.includes('--skip-build')) npm(['run', 'build'], root);

// ---- 1. the tarball ---------------------------------------------------------------------------
const packed = JSON.parse(
  npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], root),
)[0];
const tgz = join(out, packed.filename);
const files = packed.files.map((f) => ({ path: f.path.replace(/\\/g, '/'), size: f.size }));
console.log(
  `packed ${packed.filename}: ${files.length} files, ${packed.size} bytes (${packed.unpackedSize} unpacked)`,
);

const ALLOWED_TOP = /^(dist\/|spec\/|LICENSE$|NOTICE$|README\.md$|package\.json$)/;
const strays = files.filter((f) => !ALLOWED_TOP.test(f.path)).map((f) => f.path);
ok(
  strays.length === 0,
  `contents are only dist, spec, LICENSE, NOTICE, README.md and package.json${strays.length ? ` (strays: ${strays.join(', ')})` : ''}`,
);
const maps = files.filter((f) => f.path.endsWith('.map')).map((f) => f.path);
ok(maps.length === 0, `no source maps${maps.length ? ` (${maps.join(', ')})` : ''}`);
const testData = files
  .filter(
    (f) =>
      /(^|\/)(vectors|examples|fixtures|test|tests|__tests__)\//.test(f.path) ||
      /\.(onnx|safetensors|gguf|bin|wasm|part)$/.test(f.path),
  )
  .map((f) => f.path);
ok(
  testData.length === 0,
  `no test data, vectors, examples or model files${testData.length ? ` (${testData.join(', ')})` : ''}`,
);
const big = files.filter((f) => f.size > MAX_FILE).map((f) => f.path);
ok(
  big.length === 0 && packed.size <= MAX_FILE,
  `no file over 5 MB and the tarball is ${packed.size} bytes`,
);
for (const must of [
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
])
  ok(
    files.some((f) => f.path === must),
    `contains ${must}`,
  );

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lifecycle = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
].filter((s) => pkg.scripts?.[s] !== undefined);
ok(
  lifecycle.length === 0,
  `no lifecycle script${lifecycle.length ? ` (${lifecycle.join(', ')})` : ''}`,
);
for (const [key, target] of Object.entries(pkg.exports)) {
  const types = typeof target === 'object' ? target.types : undefined;
  if (types)
    ok(
      files.some((f) => `./${f.path}` === types),
      `exports ${key}: types ${types} is in the tarball`,
    );
  const entry =
    typeof target === 'object'
      ? target.import
      : typeof target === 'string' && !target.includes('*')
        ? target
        : undefined;
  if (entry)
    ok(
      files.some((f) => `./${f.path}` === entry),
      `exports ${key}: ${entry} is in the tarball`,
    );
}

// the engine worker is one self-contained file whose first act is to install the egress guard (R3w)
ok(
  files.some((f) => f.path === 'dist/worker/engine-worker.js'),
  'contains dist/worker/engine-worker.js (exports ./worker)',
);
const workerSource = readFileSync(join(root, 'dist/worker/engine-worker.js'), 'utf8');
const guardAt = workerSource.search(/installEgressGuard\(globalThis/);
const hostAt = workerSource.search(/new TjsEngine\(/);
const firstImport = workerSource.search(/\bimport\(/);
ok(
  guardAt >= 0 && hostAt > guardAt && (firstImport < 0 || firstImport > guardAt),
  'the packed worker installs the egress guard before the engine host and before any dynamic import',
);
ok(
  !/^import\s/m.test(workerSource),
  'the packed worker has no static import (no shared chunk can run before the guard)',
);

const NOT_PUBLISHED =
  "Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step.";
ok(
  readFileSync(join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ').includes(NOT_PUBLISHED),
  'the packaged README carries the "Not published yet" sentence',
);
ok(
  /alpha, not tagged/.test(readFileSync(join(root, 'README.md'), 'utf8')),
  'the packaged README says "alpha, not tagged"',
);

// ---- 2. no engine-default URL in dist ---------------------------------------------------------
const allow = readFileSync(join(root, 'scripts/url-allowlist.txt'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean);
const FORBIDDEN = ['huggingface.co', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com'];
const walk = (d) =>
  readdirSync(d).flatMap((f) =>
    statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
  );
const offenders = [];
for (const f of walk(join(root, 'dist'))) {
  if (!/\.(js|mjs|cjs|ts|json)$/.test(f)) continue;
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.some((h) => line.includes(h)) && !allow.some((a) => line.includes(a)))
        offenders.push(`${relative(root, f)}:${i + 1}`);
    });
}
ok(
  offenders.length === 0,
  `dist names no engine-default endpoint${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
);

// ---- 3. a fresh, empty directory, offline, empty cache ------------------------------------------
const fresh = mkdtempSync(join(work, 'fresh-'));
const cache = mkdtempSync(join(work, 'npm-cache-empty-'));
npm(['init', '-y'], fresh);
npm(
  ['i', tgz, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache],
  fresh,
);
const tree = JSON.parse(npm(['ls', '--all', '--json'], fresh));
const top = Object.keys(tree.dependencies ?? {});
ok(
  top.length === 1 && top[0] === '@airplanemode/runtime',
  `npm ls --all lists exactly @airplanemode/runtime (found: ${top.join(', ') || 'nothing'})`,
);
// npm ls prints an uninstalled optional peer as an empty object; an installed one has a version
const nested = Object.entries(tree.dependencies?.['@airplanemode/runtime']?.dependencies ?? {})
  .filter(([, v]) => v && typeof v === 'object' && v.version !== undefined)
  .map(([name]) => name);
ok(
  nested.length === 0,
  `no dependency and no optional peer was installed${nested.length ? ` (${nested.join(', ')})` : ''}`,
);
const installed = readdirSync(join(fresh, 'node_modules')).filter((n) => !n.startsWith('.'));
ok(
  installed.length === 1 && installed[0] === '@airplanemode',
  `node_modules holds exactly @airplanemode (found: ${installed.join(', ')})`,
);

// ---- 4. a real Node call --------------------------------------------------------------------------
const exampleSigned = join(root, 'spec/examples/manifest.signed.example.json');
const callSource = `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyManifest, SPEC_VERSIONS } from '@airplanemode/runtime';
const publicKey = Uint8Array.from(Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'));
const keyId = createHash('sha256').update(publicKey).digest('hex');
const manifest = JSON.parse(readFileSync(process.env.EXAMPLE, 'utf8'));
const result = await verifyManifest(manifest, new Map([[keyId, publicKey]]), { allowTestKeys: true, now: Date.parse('2026-11-14T00:00:00Z') });
console.log(JSON.stringify({ valid: result.ok, specVersions: SPEC_VERSIONS }));
`;
writeFileSync(join(fresh, 'call.mjs'), callSource);
const called = execFileSync(process.execPath, ['call.mjs'], {
  cwd: fresh,
  encoding: 'utf8',
  env: { ...process.env, EXAMPLE: exampleSigned },
}).trim();
const parsed = JSON.parse(called);
ok(
  parsed.valid === true,
  `verifyManifest() on the signed spec example prints valid:${parsed.valid}`,
);
ok(
  parsed.specVersions?.backendAdapter === '0.3.0' &&
    parsed.specVersions?.modelDescriptor === '0.2.0',
  'the installed package carries SPEC_VERSIONS backendAdapter 0.3.0 and modelDescriptor 0.2.0',
);

const summary = {
  tarball: packed.filename,
  tarballBytes: packed.size,
  unpackedBytes: packed.unpackedSize,
  files: files.map((f) => `${f.path} ${f.size}`),
  freshDirectory: fresh,
  emptyCache: cache,
  nodeCall: parsed,
  failures,
};
writeFileSync(join(out, 'pack-check.json'), JSON.stringify(summary, null, 2));
console.log(
  `\n${failures.length === 0 ? 'pack-check passed' : `pack-check FAILED (${failures.length})`}; tarball ${tgz}; fresh install ${fresh}`,
);
process.exit(failures.length === 0 ? 0 : 1);
