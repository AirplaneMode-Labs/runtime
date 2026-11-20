#!/usr/bin/env node
// Decisions of the publish job that are easy to get wrong in shell (Sprint 7 fix round 1; TD-125, TD-121, S1-130).
// Owner-only context: .github/workflows/publish.yml calls this file; nobody on the team runs a publish. Nothing here
// reads the environment: the commit, the version and the repository arrive as arguments (the workflow passes
// "$GITHUB_SHA" and "$VERSION" from its own step env), and the ref that triggered the run is never consulted.
//
//   node scripts/release/publish-guard.mjs semver <version>
//   node scripts/release/publish-guard.mjs tag --version <v> --sha <40 hex> --repo <owner/name>
//   node scripts/release/publish-guard.mjs no-expiry --file <release-manifest.json>
//   node scripts/release/publish-guard.mjs key-id --keys <docs/release-keys.json> --id <RELEASE_KEY_ID>        (lock 6)
//   node scripts/release/publish-guard.mjs registry-absent --package <npm name> --version <v>              (a 404 is the pass)
//   node scripts/release/publish-guard.mjs tarball --manifest <release-manifest.json> --dir <verify dir>   (prints the path)
//
// exit 0 passes, 1 refuses (a reason on stderr), 2 is a usage error. A check that cannot run (npm missing, a reset
// connection, an unreadable file) is a refusal, never a pass. Fix round 2 (BUG-T3-S7-17) moved key-id, registry-absent and
// tarball here from inline shell and node in publish.yml so that each is unit-tested (test/publish-guard.test.ts) and the
// workflow only has to call it (test/workflows-release.test.ts pins the calls).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { pathToFileURL } from 'node:url';

/** The very pattern of spec/manifest.ts SEMVER_PATTERN (test/publish-guard.test.ts compares them): strict SemVer 2.0, no build metadata. */
export const GUARD_SEMVER_SOURCE =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?$';
const SEMVER = new RegExp(GUARD_SEMVER_SOURCE);
const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** An npm package name as the registry allows it for a new package: optional lower-case scope, then the name. */
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** The grammar of a manifest entry id (spec/manifest.ts): a plain file name, never a path. */
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** A directory the publish job names: no space, no newline, no shell metacharacter, never an option. */
const SAFE_DIR = /^[A-Za-z0-9_./-]+$/;
/** The registry the publish step publishes to (publish.yml's setup-node registry-url; the policy test compares them). */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** The wire string of docs/release-keys.json (spec/release.ts RELEASE_KEYS_SPEC). */
export const RELEASE_KEYS_SPEC = 'airplanemode.release-keys/0.1';

/** A version that may be written to GITHUB_ENV: strict SemVer (JS `$` without the m flag does not match before a trailing line feed). */
export function assertStrictSemver(version) {
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw new Error(
      `not strict SemVer 2.0 without build metadata: ${JSON.stringify(String(version))}`,
    );
}

/**
 * The commit that tag v<version> resolves to. `api(path)` returns the parsed JSON of GET repos/<repo>/<path>. A lightweight tag
 * points at a commit; an annotated tag points at a tag object that is dereferenced (a short chain, never a loop) until a
 * commit is reached. Anything else is an error.
 */
export function resolveTagCommit(version, api) {
  assertStrictSemver(version);
  let obj = api(`git/ref/tags/v${version}`)?.object;
  for (let hops = 0; hops < 4; hops++) {
    if (!obj || typeof obj.type !== 'string' || !SHA40.test(String(obj.sha)))
      throw new Error(`tag v${version}: the answer does not name an object`);
    if (obj.type === 'commit') return obj.sha;
    if (obj.type !== 'tag')
      throw new Error(`tag v${version} points at a ${obj.type}, not a commit`);
    obj = api(`git/tags/${obj.sha}`)?.object;
  }
  throw new Error(`tag v${version}: too many nested tag objects`);
}

/** Refuses unless tag v<version> resolves to `sha`. */
export function assertTagResolvesTo(version, sha, api) {
  assertStrictSemver(version);
  if (typeof sha !== 'string' || !SHA40.test(sha))
    throw new Error('the commit must be 40 lowercase hex characters');
  const got = resolveTagCommit(version, api);
  if (got !== sha) throw new Error(`tag v${version} points at ${got}, not at ${sha}`);
}

/** TD-121 / R5: a release manifest carries no expiresAt member (the owner signs with cp-sign sign --no-expiry). */
export function assertNoExpiresAt(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new Error('the manifest is not JSON');
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m))
    throw new Error('the manifest is not a JSON object');
  if (Object.hasOwn(m, 'expiresAt'))
    throw new Error(
      'the release manifest has an expiresAt member: sign again with cp-sign sign --no-expiry (TD-121)',
    );
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameMembers = (o, names) => Object.keys(o).sort().join(',') === names;

/**
 * Lock 6 (S1-129): the key id the owner set in RELEASE_KEY_ID equals the one key committed in docs/release-keys.json at this
 * commit. The file must hold exactly one key; the keyId must be the SHA-256 of the canonical padded base64 of 32 raw bytes;
 * the variable must be 64 lower-case hex digits and equal that keyId. This file has the members `spec` and `keys` only, each
 * key `keyId` and `publicKey` only. The release tool's verify step, which runs right after this one, applies the strict
 * parser (repeated members, lone surrogates), the test-key refusal and the weak-key refusal.
 */
export function assertReleaseKeyId(text, id) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('docs/release-keys.json is not JSON');
  }
  if (
    !isObject(doc) ||
    !sameMembers(doc, 'keys,spec') ||
    doc.spec !== RELEASE_KEYS_SPEC ||
    !Array.isArray(doc.keys)
  )
    throw new Error(`docs/release-keys.json is not an ${RELEASE_KEYS_SPEC} file`);
  if (doc.keys.length !== 1)
    throw new Error(
      `docs/release-keys.json must hold exactly one key at this commit, found ${doc.keys.length}`,
    );
  const k = doc.keys[0];
  if (
    !isObject(k) ||
    !sameMembers(k, 'keyId,publicKey') ||
    typeof k.keyId !== 'string' ||
    typeof k.publicKey !== 'string'
  )
    throw new Error(
      'the key in docs/release-keys.json must be an object with keyId and publicKey only',
    );
  const raw = Buffer.from(k.publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== k.publicKey)
    throw new Error('the publicKey is not the canonical padded base64 of 32 bytes');
  if (createHash('sha256').update(raw).digest('hex') !== k.keyId)
    throw new Error('the keyId is not the SHA-256 of the publicKey');
  if (typeof id !== 'string' || !HEX64.test(id))
    throw new Error(
      'RELEASE_KEY_ID must be 64 lowercase hex characters (the keyId of the release key)',
    );
  if (k.keyId !== id)
    throw new Error('RELEASE_KEY_ID does not equal the keyId in docs/release-keys.json');
}

/** The argument list of the registry lookup: no shell, the public registry, and no user config, so no token is sent. */
export function npmViewArgs(pkg, version) {
  return [
    'view',
    `${pkg}@${version}`,
    'version',
    '--registry',
    NPM_REGISTRY,
    '--userconfig',
    devNull,
  ];
}

/** The line npm prints for a 404 (npm 10 says 'npm error', older npm 'npm ERR!'), on a line of its own on stderr. */
const NPM_E404_LINE = /^npm (?:error|ERR!) code E404\r?$/m;
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The registry-absent binding: `npm view <name>@<version> version` must answer E404 (npm 10 answers E404 for an unknown name
 * and for an existing package that lacks the version). `answer` is the spawnSync result. Exit 0 means the registry holds the
 * version (or answered nothing we can read); any other failure (a reset connection, a timeout, a 401, a 5xx, a missing npm,
 * a signal) proves nothing about absence. All of them refuse.
 */
export function assertRegistryAbsent(pkg, version, answer) {
  if (answer.error) throw new Error(`could not ask the registry: ${answer.error.message}`);
  if (answer.signal || answer.status === null || answer.status === undefined)
    throw new Error(
      `could not ask the registry: npm did not exit normally (${answer.signal ?? 'no status'})`,
    );
  const err = String(answer.stderr ?? '').replace(ANSI, '');
  if (answer.status === 0) {
    const out = String(answer.stdout ?? '').trim();
    throw new Error(
      out === ''
        ? `${pkg}@${version}: the registry gave an empty answer with exit 0, which is not a 404`
        : `${pkg}@${version} is already published (npm view answered ${JSON.stringify(out.slice(0, 80))})`,
    );
  }
  if (NPM_E404_LINE.test(err)) return;
  const first = err.split('\n').find((l) => l.trim() !== '') ?? '(no message)';
  throw new Error(
    `${pkg}@${version}: the registry did not answer 404 (npm exit ${answer.status}): ${first.trim().slice(0, 160)}`,
  );
}

function runNpmView(args) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    timeout: 60_000,
    shell: process.platform === 'win32',
  });
}

/**
 * The one tarball the verified manifest names: exactly one entry whose id ends in .tgz, a plain file name, present in `dir`
 * as a regular file (lstat: a symlink is not one). Returns `<dir>/<id>`, the path publish.yml hands to attest and publish.
 */
export function selectTarball(manifestText, dir, lstat = lstatSync) {
  if (typeof dir !== 'string' || !SAFE_DIR.test(dir) || dir.startsWith('-'))
    throw new Error(`not a directory name the job may use: ${JSON.stringify(String(dir))}`);
  let m;
  try {
    m = JSON.parse(manifestText);
  } catch {
    throw new Error('the manifest is not JSON');
  }
  if (!isObject(m) || !Array.isArray(m.entries))
    throw new Error('the manifest has no entries array');
  const tgz = m.entries.filter(
    (e) => isObject(e) && typeof e.id === 'string' && e.id.endsWith('.tgz'),
  );
  if (tgz.length !== 1)
    throw new Error(
      `expected exactly one .tgz entry in the verified manifest, found ${tgz.length}`,
    );
  const id = tgz[0].id;
  if (!ENTRY_ID.test(id))
    throw new Error(`the .tgz entry id is not a plain file name: ${JSON.stringify(id)}`);
  const path = `${dir}/${id}`;
  let st;
  try {
    st = lstat(path);
  } catch {
    throw new Error(`${path} does not exist`);
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  return path;
}

function ghApi(repo) {
  return (path) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
}

function opts(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) return undefined;
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}

/** The command line. `ctx` injects the GitHub api, `npmView`, `lstat`, the file reader and the output streams (tests). Returns the exit code. */
export function guardMain(argv, ctx = {}) {
  const stdout = ctx.stdout ?? ((s) => process.stdout.write(s));
  const stderr = ctx.stderr ?? ((s) => process.stderr.write(s));
  const readFile = ctx.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const [cmd, ...rest] = argv;
  const usage = (m) => {
    stderr(`usage: ${m}\n`);
    return 2;
  };
  const refuse = (e) => {
    stderr(`refused: ${e.message}\n`);
    return 1;
  };
  if (cmd === 'semver') {
    if (rest.length !== 1) return usage('publish-guard semver <version>');
    try {
      assertStrictSemver(rest[0]);
      stdout('ok\n');
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'tag') {
    const o = opts(rest);
    if (!o || o.version === undefined || o.sha === undefined || o.repo === undefined)
      return usage('publish-guard tag --version <v> --sha <sha> --repo <owner/name>');
    if (!REPO.test(o.repo)) return usage('--repo must be owner/name');
    try {
      assertTagResolvesTo(o.version, o.sha, ctx.api ?? ghApi(o.repo));
      stdout(`ok: tag v${o.version} resolves to ${o.sha}\n`);
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'no-expiry') {
    const o = opts(rest);
    if (!o || o.file === undefined) return usage('publish-guard no-expiry --file <manifest>');
    try {
      assertNoExpiresAt(readFile(o.file));
      stdout('ok: no expiresAt\n');
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'key-id') {
    const o = opts(rest);
    if (!o || o.keys === undefined || o.id === undefined)
      return usage('publish-guard key-id --keys <docs/release-keys.json> --id <RELEASE_KEY_ID>');
    try {
      assertReleaseKeyId(readFile(o.keys), o.id);
      stdout('ok: RELEASE_KEY_ID equals the single key in docs/release-keys.json\n');
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'registry-absent') {
    const o = opts(rest);
    if (!o || o.package === undefined || o.version === undefined)
      return usage('publish-guard registry-absent --package <npm name> --version <v>');
    if (!NPM_NAME.test(o.package) || o.package.length > 214)
      return usage('--package must be an npm package name');
    try {
      assertStrictSemver(o.version);
      assertRegistryAbsent(
        o.package,
        o.version,
        (ctx.npmView ?? runNpmView)(npmViewArgs(o.package, o.version)),
      );
      stdout(`ok: ${o.package}@${o.version} is not on the registry (404)\n`);
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  if (cmd === 'tarball') {
    const o = opts(rest);
    if (!o || o.manifest === undefined || o.dir === undefined)
      return usage('publish-guard tarball --manifest <release-manifest.json> --dir <dir>');
    try {
      stdout(`${selectTarball(readFile(o.manifest), o.dir, ctx.lstat)}\n`);
      return 0;
    } catch (e) {
      return refuse(e);
    }
  }
  return usage('publish-guard semver|tag|no-expiry|key-id|registry-absent|tarball ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = guardMain(process.argv.slice(2));
