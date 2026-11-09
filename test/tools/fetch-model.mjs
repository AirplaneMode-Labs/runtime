#!/usr/bin/env node
// Fetches a pinned model from Hugging Face into a gitignored cache and proves every byte.
//
//   node test/tools/fetch-model.mjs <name> [--dest .cache/models] [--pin]
//
// <name> is a key of test/tools/models.json ("smollm2-135m-instruct",
// "qwen3-1.7b-webgpu-q4f16"). The files land at <dest>/<name>/<path>; the pinned ONNX Runtime Web
// wasm and factory are copied from node_modules into <dest>/ort/ (checked against
// src/backends/ort-pins.ts once that file exists).
//
// Rules (security review S1):
//  - https only, no Authorization header, HF_TOKEN is never read;
//  - default and CI mode refuse any file without a pinned sha256 before fetching anything; --pin is
//    the only mode that rewrites models.json, and it only fills in a missing sha256 for a file that
//    has a git blob id to check (non-LFS files); an LFS file's sha256 must come from the HF API;
//  - every path is validated against the ModelFile regex of the descriptor schema and every write is
//    confined to --dest (a symlink that leaves it is refused);
//  - a download goes to <file>.part and is renamed only after size, sha256 and git-blob checks pass;
//  - a re-run re-hashes every existing file (never a stat-only skip) and re-downloads on mismatch.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/** The descriptor schema's ModelFile.path pattern (spec/model-descriptor.schema.json). */
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){0,7}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REV_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

export class FetchModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchModelError';
    this.code = code;
  }
}

export function validateModelPath(path) {
  if (typeof path !== 'string' || path.length > 256 || !PATH_RE.test(path))
    throw new FetchModelError('bad_path', `refusing model path ${JSON.stringify(path)}`);
}

/** The git blob id of `bytes`: sha1("blob <size>\0" + bytes). */
export function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function hashFile(path, withGit, size) {
  const sha = createHash('sha256');
  const git = withGit ? createHash('sha1').update(`blob ${size}\0`) : undefined;
  let n = 0;
  for await (const chunk of createReadStream(path)) {
    sha.update(chunk);
    git?.update(chunk);
    n += chunk.length;
  }
  return { size: n, sha256: sha.digest('hex'), git: git?.digest('hex') };
}

/** Throws unless `target` (not yet existing) would be written inside the real directory `root`. */
async function confine(root, target) {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== target)
    throw new FetchModelError('dest_escape', `refusing to write outside ${root}: ${target}`);
  // every existing ancestor between root and target must be a real directory inside root
  let cur = target;
  const parents = [];
  while (cur !== root) {
    cur = dirname(cur);
    parents.push(cur);
    if (cur.length <= root.length) break;
  }
  for (const p of parents.reverse()) {
    let st;
    try {
      st = await lstat(p);
    } catch {
      continue; // not created yet: mkdir below creates a plain directory
    }
    if (st.isSymbolicLink())
      throw new FetchModelError('dest_escape', `refusing symlink inside the destination: ${p}`);
    const real = await realpath(p);
    if (real !== root && !real.startsWith(root + sep))
      throw new FetchModelError('dest_escape', `${p} resolves outside ${root}`);
  }
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink())
      throw new FetchModelError('dest_escape', `refusing symlink at ${target}`);
  } catch (e) {
    if (e instanceof FetchModelError) throw e;
  }
}

function checkModelsJson(models) {
  if (!models || models.schema !== 1 || typeof models.models !== 'object' || models.models === null)
    throw new FetchModelError('bad_models_json', 'models.json: schema must be 1 with a models map');
}

function entryOf(models, name) {
  checkModelsJson(models);
  if (typeof name !== 'string' || !NAME_RE.test(name) || !Object.hasOwn(models.models, name))
    throw new FetchModelError('unknown_model', `unknown model ${JSON.stringify(name)}`);
  const m = models.models[name];
  if (!m || !REPO_RE.test(m.repo) || !REV_RE.test(m.revision) || !Array.isArray(m.files))
    throw new FetchModelError(
      'bad_models_json',
      `models.json: ${name} needs repo, a 40-hex revision and files`,
    );
  for (const f of m.files) {
    validateModelPath(f.path);
    if (!Number.isSafeInteger(f.size) || f.size < 0)
      throw new FetchModelError(
        'bad_models_json',
        `${name}/${f.path}: size must be a non-negative integer`,
      );
    if (f.sha256 !== undefined && !SHA256_RE.test(f.sha256))
      throw new FetchModelError(
        'bad_models_json',
        `${name}/${f.path}: sha256 is not 64 lowercase hex`,
      );
    if (f.gitBlobSha1 !== undefined && !SHA1_RE.test(f.gitBlobSha1))
      throw new FetchModelError(
        'bad_models_json',
        `${name}/${f.path}: gitBlobSha1 is not 40 lowercase hex`,
      );
  }
  return m;
}

/** Streams `url` to `part`, enforcing the declared size while it streams. Returns the digests. */
async function download(fetchImpl, url, part, f) {
  if (!url.startsWith('https://'))
    throw new FetchModelError('not_https', `refusing non-https URL ${url}`);
  // No credentials of any kind: no Authorization header, no cookies, HF_TOKEN is never read.
  const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', credentials: 'omit' });
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchModelError('http_status', `${url} answered ${res.status}`);
  }
  const sha = createHash('sha256');
  const git = createHash('sha1').update(`blob ${f.size}\0`);
  const fh = await open(part, 'w');
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > f.size) {
        await reader.cancel().catch(() => undefined);
        throw new FetchModelError(
          'size_mismatch',
          `${f.path}: more than the pinned ${f.size} bytes`,
        );
      }
      sha.update(value);
      git.update(value);
      await fh.write(value);
    }
  } finally {
    await fh.close();
  }
  if (n !== f.size)
    throw new FetchModelError('size_mismatch', `${f.path}: got ${n} bytes, pinned ${f.size}`);
  return { size: n, sha256: sha.digest('hex'), git: git.digest('hex') };
}

function verifyDigests(f, d, { pinning }) {
  if (f.gitBlobSha1 !== undefined && d.git !== f.gitBlobSha1)
    throw new FetchModelError(
      'git_blob_mismatch',
      `${f.path}: git blob ${d.git}, pinned ${f.gitBlobSha1}`,
    );
  if (!pinning && d.sha256 !== f.sha256)
    throw new FetchModelError(
      'sha256_mismatch',
      `${f.path}: sha256 ${d.sha256}, pinned ${f.sha256}`,
    );
  if (pinning && f.sha256 !== undefined && d.sha256 !== f.sha256)
    throw new FetchModelError(
      'sha256_mismatch',
      `${f.path}: sha256 ${d.sha256}, pinned ${f.sha256}`,
    );
}

/**
 * Fetches (or pins) one model. Returns the per-file status. In pin mode only files that lack a
 * sha256 are fetched; models.json is rewritten (when `modelsPath` is given) only if a file was
 * pinned and every file of the run passed.
 */
export async function fetchModel({
  name,
  models,
  dest,
  pin = false,
  modelsPath,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  const m = entryOf(models, name);
  const files = m.files;
  if (pin) {
    for (const f of files)
      if (f.sha256 === undefined && f.gitBlobSha1 === undefined)
        throw new FetchModelError(
          'unpinnable',
          `${name}/${f.path}: no sha256 and no git blob id to check; take the LFS sha256 from the Hugging Face API`,
        );
  } else {
    for (const f of files)
      if (f.sha256 === undefined)
        throw new FetchModelError(
          'missing_sha256',
          `${name}/${f.path}: no pinned sha256 (run with --pin locally after checking the git blob)`,
        );
  }

  await mkdir(dest, { recursive: true });
  const root = await realpath(resolve(dest));
  const out = [];
  let pinned = 0;
  for (const f of files) {
    const needsPin = pin && f.sha256 === undefined;
    if (pin && !needsPin) {
      out.push({ path: f.path, status: 'cached', size: f.size });
      continue;
    }
    const target = join(root, name, ...f.path.split('/'));
    await confine(root, target);
    await mkdir(dirname(target), { recursive: true });
    await confine(root, target);

    // Re-hash an existing file: never trust a stat. A mismatch falls through to a re-download.
    if (!pin && existsSync(target)) {
      const d = await hashFile(target, false, f.size);
      if (d.size === f.size && d.sha256 === f.sha256) {
        log(`ok      ${name}/${f.path} (cached, re-hashed)`);
        out.push({ path: f.path, status: 'cached', size: f.size });
        continue;
      }
      log(`stale   ${name}/${f.path}: cached bytes do not match the pin, downloading again`);
    }

    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`;
    const part = `${target}.part`;
    await rm(part, { force: true });
    try {
      const d = await download(fetchImpl, url, part, f);
      verifyDigests(f, d, { pinning: needsPin });
      if (needsPin) {
        f.sha256 = d.sha256;
        pinned++;
        log(`pinned  ${name}/${f.path} sha256 ${d.sha256}`);
      }
      await rename(part, target);
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
    log(`${needsPin ? 'fetched' : 'ok     '} ${name}/${f.path} (${f.size} bytes)`);
    out.push({ path: f.path, status: needsPin ? 'pinned' : 'downloaded', size: f.size });
  }
  if (pin && pinned > 0 && modelsPath) {
    await writeFile(modelsPath, JSON.stringify(models, null, 2) + '\n');
    log(`wrote ${modelsPath}`);
  }
  return { files: out, pinned };
}

function pinOf(text, key) {
  const m = new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`).exec(text);
  return m ? m[1] : undefined;
}

/**
 * Copies the pinned ONNX Runtime Web wasm and factory from the installed package into
 * <dest>/ort/ after checking both against src/backends/ort-pins.ts.
 */
export async function copyOrtFiles({ dest, distDir, pinsPath, log = () => {} }) {
  if (!existsSync(pinsPath))
    throw new FetchModelError(
      'ort_missing',
      `no ${pinsPath}; run node test/tools/gen-ort-pins.mjs`,
    );
  const text = await readFile(pinsPath, 'utf8');
  const wanted = [
    [pinOf(text, 'ORT_WASM_FILE'), pinOf(text, 'ORT_WASM_SHA256')],
    [pinOf(text, 'ORT_FACTORY_FILE'), pinOf(text, 'ORT_FACTORY_SHA256')],
  ];
  const toCopy = [];
  for (const [file, sha] of wanted) {
    if (!file || !sha || !PATH_RE.test(file) || file.includes('/') || !SHA256_RE.test(sha))
      throw new FetchModelError('ort_pin_mismatch', `${pinsPath}: malformed ORT pin`);
    const src = join(distDir, file);
    if (!existsSync(src)) throw new FetchModelError('ort_missing', `${src} is not installed`);
    const d = await hashFile(src, false, 0);
    if (d.sha256 !== sha)
      throw new FetchModelError('ort_pin_mismatch', `${file}: sha256 ${d.sha256}, pinned ${sha}`);
    toCopy.push([file, src]);
  }
  const root = (await mkdir(dest, { recursive: true }), await realpath(resolve(dest)));
  const ortDir = join(root, 'ort');
  for (const [file] of toCopy) await confine(root, join(ortDir, file));
  await mkdir(ortDir, { recursive: true });
  const copied = [];
  for (const [file, src] of toCopy) {
    const target = join(ortDir, file);
    await copyFile(src, `${target}.part`);
    await rename(`${target}.part`, target);
    copied.push(file);
    log(`ok      ort/${file}`);
  }
  return { copied, checked: true };
}

function parseArgs(argv) {
  const o = { name: undefined, dest: join(repoRoot, '.cache/models'), pin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pin') o.pin = true;
    else if (a === '--dest') o.dest = resolve(argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (o.name === undefined) o.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (o.name === undefined) throw new Error('usage: fetch-model.mjs <name> [--dest <dir>] [--pin]');
  return o;
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const modelsPath = join(here, 'models.json');
  const models = JSON.parse(await readFile(modelsPath, 'utf8'));
  const log = (line) => console.log(line);
  try {
    const r = await fetchModel({
      name: args.name,
      models,
      dest: args.dest,
      pin: args.pin,
      modelsPath,
      log,
    });
    if (!args.pin) {
      const distDir = join(repoRoot, 'node_modules/onnxruntime-web/dist');
      const pinsPath = join(repoRoot, 'src/backends/ort-pins.ts');
      if (existsSync(pinsPath) && existsSync(distDir))
        await copyOrtFiles({ dest: args.dest, distDir, pinsPath, log });
      else
        log(
          'skipped ort/: src/backends/ort-pins.ts or node_modules/onnxruntime-web is not there yet',
        );
    }
    console.log(`done: ${r.files.length} files${args.pin ? `, ${r.pinned} pinned` : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof FetchModelError) {
      console.error(`refused (${e.code}): ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
