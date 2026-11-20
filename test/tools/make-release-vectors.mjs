#!/usr/bin/env node
// Generates the release vectors of spec release 0.6.1 (manifest 0.1.4, "Release manifests"; TD-103):
//
//   spec/vectors/release/base/          example-a.bin, example-b.txt, release-manifest.json (id example-rehearsal,
//                                       REHEARSAL_PUBLISHER, signed with RFC 8032 TEST 1), SHA256SUMS
//   spec/vectors/release/release-id/    id example-release, RELEASE_PUBLISHER, signed with TEST 1 (what R1 forbids)
//   spec/vectors/release/vk-release/    id example-release, RELEASE_PUBLISHER, signed with the synthetic vector key
//   spec/vectors/release/vk-publisher/  the same key, id example-release, REHEARSAL_PUBLISHER
//   spec/vectors/release/tk-publisher/  TEST 1, id example-rehearsal, RELEASE_PUBLISHER
//   spec/vectors/release/keys/          release-keys files: empty, test-key, weak, vector-key, duplicate-member,
//                                       keyid-mismatch, duplicate-keyid, too-many (9 keys)
//   spec/vectors/release/ids.json       the id pattern table shared with control-plane
//   spec/vectors/release/release.json   the cases (name, level, command, dir, mutation, args, expect)
//   spec/vectors/release/README.md
//
// Built on the independent oracle test/tools/lib.mjs, which never imports src/. The seed of the vector key is
// SHA-256 of a fixed phrase and lives only in lib.mjs; only its public key is written here. Deterministic: a rerun
// reproduces every byte. Every file is written with LF (the directory is '-text' in .gitattributes).
//
//   node test/tools/make-release-vectors.mjs [--check] [--out <dir>]
//
// --check compares what would be written with spec/vectors/release/ and exits 1 on any difference or stray file.
// --out writes into <dir> instead (used by test/spec-0.6.1.test.ts to prove two runs are byte-identical).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_ID_RE,
  RELEASE_KEYS_SPEC,
  RELEASE_PUBLISHER,
  REHEARSAL_ID_RE,
  REHEARSAL_PUBLISHER,
  RFC8032_SEED_HEX,
  VECTOR_KEY_SEED_HEX,
  buildReleaseManifest,
  keyEntryOf,
  publicKeyOfSeedHex,
  releaseManifestText,
  releaseSumsText,
  signReleaseManifest,
  syntheticSeedHex,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(here, '../../spec/vectors/release');

const args = process.argv.slice(2);
const check = args.includes('--check');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : defaultOut;

const sha = (b) => createHash('sha256').update(b).digest();
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/** relative path (always '/') to bytes */
const files = new Map();
const put = (rel, data) => files.set(rel, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));

// ---- the artefacts: synthetic, public, tiny ----------------------------------------------------------
const artefactA = Buffer.concat([
  sha('airplanemode release example artefact a, block 0'),
  sha('airplanemode release example artefact a, block 1'),
]);
const artefactB = Buffer.from(
  'Airplane Mode Labs release vector artefact b: synthetic, public, safe to commit.\n',
  'utf8',
);
const ARTEFACTS = [
  { name: 'example-a.bin', bytes: artefactA },
  { name: 'example-b.txt', bytes: artefactB },
];
const CREATED_AT = '2026-11-20T00:00:00Z';

const vectorPub = publicKeyOfSeedHex(VECTOR_KEY_SEED_HEX);
const DIRS = [
  { dir: 'base', id: 'example-rehearsal', publisher: REHEARSAL_PUBLISHER, seed: RFC8032_SEED_HEX },
  {
    dir: 'release-id',
    id: 'example-release',
    publisher: RELEASE_PUBLISHER,
    seed: RFC8032_SEED_HEX,
  },
  {
    dir: 'vk-release',
    id: 'example-release',
    publisher: RELEASE_PUBLISHER,
    seed: VECTOR_KEY_SEED_HEX,
  },
  {
    dir: 'vk-publisher',
    id: 'example-release',
    publisher: REHEARSAL_PUBLISHER,
    seed: VECTOR_KEY_SEED_HEX,
  },
  {
    dir: 'tk-publisher',
    id: 'example-rehearsal',
    publisher: RELEASE_PUBLISHER,
    seed: RFC8032_SEED_HEX,
  },
];
for (const d of DIRS) {
  const unsigned = buildReleaseManifest({
    id: d.id,
    version: '1.0.0',
    publisher: d.publisher,
    createdAt: CREATED_AT,
    licence: 'Apache-2.0',
    files: ARTEFACTS,
  });
  const signed = signReleaseManifest(unsigned, d.seed);
  for (const a of ARTEFACTS) put(`${d.dir}/${a.name}`, a.bytes);
  put(`${d.dir}/release-manifest.json`, releaseManifestText(signed));
  put(`${d.dir}/SHA256SUMS`, releaseSumsText(ARTEFACTS));
}

// ---- release-keys files -------------------------------------------------------------------------------
const keysFile = (keys) => json({ spec: RELEASE_KEYS_SPEC, keys });
const testPub = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
);
const identity = Buffer.from('01' + '00'.repeat(31), 'hex'); // the identity point: the weakest key there is
put('keys/empty.json', keysFile([]));
put('keys/test-key.json', keysFile([keyEntryOf(testPub)]));
put('keys/weak.json', keysFile([keyEntryOf(identity)]));
put('keys/vector-key.json', keysFile([keyEntryOf(vectorPub)]));
put(
  'keys/duplicate-member.json',
  `{\n  "spec": "${RELEASE_KEYS_SPEC}",\n  "spec": "${RELEASE_KEYS_SPEC}",\n  "keys": []\n}\n`,
);
put(
  'keys/keyid-mismatch.json',
  keysFile([
    {
      keyId: createHash('sha256')
        .update('airplanemode release vector: a keyId that is not the key')
        .digest('hex'),
      publicKey: keyEntryOf(vectorPub).publicKey,
    },
  ]),
);
put('keys/duplicate-keyid.json', keysFile([keyEntryOf(vectorPub), keyEntryOf(vectorPub)]));
put(
  'keys/too-many.json',
  keysFile(
    Array.from({ length: 9 }, (_, n) =>
      keyEntryOf(publicKeyOfSeedHex(syntheticSeedHex(`too-many ${n + 1}`))),
    ),
  ),
);

// ---- the id table: written by hand, then checked against the oracle patterns ---------------------------
const MANIFEST_ID_RE = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const row = (id, release, rehearsal, manifestId) => ({ id, release, rehearsal, manifestId });
const ids = [
  ...['runtime', 'localdata', 'glyphsift', 'pagetriage', 'control-plane'].flatMap((p) => [
    row(`${p}-release`, true, false, true),
    row(`${p}-rehearsal`, false, true, true),
  ]),
  row('example-release', true, false, true),
  row('example-rehearsal', false, true, true),
  row('x-release', true, false, true),
  row('x-release\n', false, false, false),
  row('x-rehearsal\n', false, false, false),
  row('X-release', false, false, false),
  row('a-releasex', false, false, true),
  row('-release', false, false, false),
  row('-rehearsal', false, false, false),
  row('release', false, false, true),
  row('a.b-release', false, false, true),
  row('a_b-release', false, false, false),
  row('a b-release', false, false, false),
  row('a-release ', false, false, false),
  row(' a-release', false, false, false),
  row('a-Release', false, false, false),
  row('a-release-release', true, false, true),
  row('a-rehearsal-release', true, false, true),
  row('a-release-rehearsal', false, true, true),
  row('a'.repeat(119) + '-release', true, false, true), // 127 characters: the longest release id
  row('a'.repeat(120) + '-release', false, false, true), // 128: one over the pattern, still a manifest id
  row('a'.repeat(117) + '-rehearsal', false, true, true), // 127: the longest rehearsal id
  row('a'.repeat(118) + '-rehearsal', false, false, true), // 128: one over
  row('a'.repeat(121) + '-release', false, false, false), // 129: not even a manifest id
  row('', false, false, false),
  row('é-release', false, false, false),
  row('0-release', true, false, true),
  row('a--release', true, false, true),
  row('a-release\u0000', false, false, false),
  row('a-release\r\n', false, false, false),
  row('a-releasee', false, false, true),
  row('a-rehearsal-', false, false, true),
  row('ab', false, false, false),
  row('dev.airplanemode.runtime-models', false, false, true),
];
for (const r of ids) {
  const got = [RELEASE_ID_RE.test(r.id), REHEARSAL_ID_RE.test(r.id), MANIFEST_ID_RE.test(r.id)];
  if (got[0] !== r.release || got[1] !== r.rehearsal || got[2] !== r.manifestId)
    throw new Error(`id table row ${JSON.stringify(r.id)} disagrees with the patterns: ${got}`);
}
if (new Set(ids.map((r) => r.id)).size !== ids.length) throw new Error('duplicate id in the table');
put('ids.json', json(ids));

// ---- the cases ----------------------------------------------------------------------------------------
const REHEARSE = ['--trust-test-key', '--allow-test-key', '--expect-id', 'example-rehearsal'];
const cases = [];
const add = (name, level, dir, mutation, args, exit, reason, extra = {}) =>
  cases.push({
    name,
    level,
    command: extra.command ?? 'verify',
    dir,
    mutation,
    args,
    expect: { exit, reason, ...(extra.testKey !== undefined ? { testKey: extra.testKey } : {}) },
    ...(extra.platform !== undefined ? { platform: extra.platform } : {}),
  });
const none = { op: 'none' };

add('rehearsal-ok-with-flags', 'manifest', 'base', none, REHEARSE, 0, null, { testKey: true });
add(
  'test-key-refused-without-flag',
  'manifest',
  'base',
  none,
  ['--trust-test-key', '--expect-id', 'example-rehearsal'],
  3,
  'test_key_refused',
);
add(
  'trust-file-empty',
  'directory',
  'base',
  none,
  ['--trust-file', '@keys/empty.json', '--expect-id', 'example-rehearsal'],
  3,
  'no_trusted_key',
);
add(
  'trust-file-test-key',
  'manifest',
  'base',
  none,
  ['--trust-file', '@keys/test-key.json', '--expect-id', 'example-rehearsal'],
  3,
  'test_key_refused',
);
add(
  'trust-file-weak',
  'manifest',
  'base',
  none,
  ['--trust-file', '@keys/weak.json', '--expect-id', 'example-rehearsal'],
  3,
  'weak_key_refused',
);
for (const [n, f] of [
  ['trust-file-duplicate-member', 'duplicate-member'],
  ['trust-file-keyid-mismatch', 'keyid-mismatch'],
  ['trust-file-duplicate-keyid', 'duplicate-keyid'],
  ['trust-file-too-many', 'too-many'],
])
  add(
    n,
    'directory',
    'base',
    none,
    ['--trust-file', `@keys/${f}.json`, '--expect-id', 'example-rehearsal'],
    3,
    'bad_release_keys',
  );
add(
  'unexpected-id',
  'manifest',
  'base',
  none,
  ['--trust-test-key', '--allow-test-key', '--expect-id', 'other-rehearsal'],
  3,
  'unexpected_id',
);
add(
  'no-expect-id',
  'directory',
  'base',
  none,
  ['--trust-test-key', '--allow-test-key'],
  2,
  'expect_id_required',
);
add(
  'release-id-trust-test-key-allow',
  'manifest',
  'release-id',
  none,
  ['--trust-test-key', '--allow-test-key', '--expect-id', 'example-release'],
  2,
  'test_key_flag_misuse',
);
add(
  'release-id-trust-test-key-no-flag',
  'directory',
  'release-id',
  none,
  ['--trust-test-key', '--expect-id', 'example-release'],
  2,
  'test_key_flag_misuse',
);
add(
  'release-id-trust-file-test-key',
  'directory',
  'release-id',
  none,
  ['--trust-file', '@keys/test-key.json', '--expect-id', 'example-release'],
  3,
  'test_key_refused',
);
add(
  'trust-file-with-allow-flag',
  'directory',
  'base',
  none,
  ['--trust-file', '@keys/vector-key.json', '--allow-test-key', '--expect-id', 'example-rehearsal'],
  2,
  'test_key_flag_misuse',
);
add(
  'vk-release-ok',
  'manifest',
  'vk-release',
  none,
  ['--trust-file', '@keys/vector-key.json', '--expect-id', 'example-release'],
  0,
  null,
  { testKey: false },
);
add(
  'vk-publisher-mismatch',
  'manifest',
  'vk-publisher',
  none,
  ['--trust-file', '@keys/vector-key.json', '--expect-id', 'example-release'],
  3,
  'publisher_mismatch',
);
add('tk-publisher-mismatch', 'manifest', 'tk-publisher', none, REHEARSE, 3, 'publisher_mismatch');
add(
  'artifact-byte-flipped',
  'directory',
  'base',
  { op: 'flip-byte', file: 'example-a.bin', offset: 0 },
  REHEARSE,
  3,
  'artifact_hash_mismatch',
);
add(
  'artifact-truncated',
  'directory',
  'base',
  { op: 'truncate', file: 'example-a.bin', bytes: 1 },
  REHEARSE,
  3,
  'artifact_size_mismatch',
);
add(
  'artifact-removed',
  'directory',
  'base',
  { op: 'remove', file: 'example-b.txt' },
  REHEARSE,
  3,
  'artifact_missing',
);
add(
  'artifact-extra-file',
  'directory',
  'base',
  { op: 'add-file', file: 'extra.txt', content: 'an extra file\n' },
  REHEARSE,
  3,
  'artifact_extra',
);
add(
  'sums-line-changed',
  'directory',
  'base',
  { op: 'sums-edit', line: 0 },
  REHEARSE,
  3,
  'sums_mismatch',
);
add('sums-crlf', 'directory', 'base', { op: 'sums-crlf' }, REHEARSE, 3, 'sums_mismatch');
add('sums-reordered', 'directory', 'base', { op: 'sums-reorder' }, REHEARSE, 3, 'sums_mismatch');
add(
  'manifest-publisher-edited',
  'manifest',
  'base',
  { op: 'manifest-publisher-edit' },
  REHEARSE,
  3,
  'no_valid_signature',
);
add(
  'symlinked-artifact',
  'directory',
  'base',
  { op: 'symlink-artifact', file: 'example-a.bin' },
  REHEARSE,
  3,
  'not_regular_file',
);
add('symlinked-dir', 'directory', 'base', { op: 'symlink-dir' }, REHEARSE, 3, 'not_regular_file');
add(
  'subdirectory',
  'directory',
  'base',
  { op: 'subdir', name: 'sub' },
  REHEARSE,
  3,
  'not_regular_file',
);
add(
  'junction-artifact',
  'directory',
  'base',
  { op: 'junction-artifact', file: 'example-a.bin' },
  REHEARSE,
  3,
  'not_regular_file',
  { platform: 'win32' },
);
add(
  'sign-release-id',
  'manifest',
  'release-id',
  none,
  ['--test-key', 'rfc8032-1'],
  2,
  'test_key_release_id',
  { command: 'sign' },
);
add(
  'sign-already-signed',
  'directory',
  'base',
  none,
  ['--test-key', 'rfc8032-1'],
  2,
  'already_signed',
  { command: 'sign' },
);
add(
  'sign-other-test-key',
  'directory',
  'base',
  none,
  ['--test-key', 'rfc8032-2'],
  2,
  'test_key_flag_misuse',
  { command: 'sign' },
);
add(
  'verify-bad-release-id',
  'directory',
  'base',
  none,
  ['--trust-file', '@keys/vector-key.json', '--expect-id', 'not-a-release-id'],
  2,
  'bad_release_id',
);
add(
  'verify-both-trust-sources',
  'directory',
  'base',
  none,
  ['--trust-file', '@keys/vector-key.json', '--trust-test-key', '--expect-id', 'example-rehearsal'],
  2,
  'bad_trust_source',
);
add(
  'verify-no-trust-source',
  'directory',
  'base',
  none,
  ['--expect-id', 'example-rehearsal'],
  2,
  'bad_trust_source',
);
put('release.json', json(cases));

put(
  'README.md',
  `# Release vectors (spec release 0.6.1, manifest 0.1.4)

Shared conformance vectors for release manifests (MANIFEST.md, "Release manifests"; rules R1 to R5). Generated by
\`test/tools/make-release-vectors.mjs\` on the independent oracle \`test/tools/lib.mjs\`, which never imports \`src/\`.
Everything here is synthetic and public. This directory is '-text' (byte for byte, LF): do not let a checkout
convert line endings, because SHA256SUMS and the manifests are hashed and signed.

| Path | What it is |
| --- | --- |
| \`base/\` | two artefacts, a rehearsal manifest (id \`example-rehearsal\`, REHEARSAL_PUBLISHER) signed with RFC 8032 TEST 1, SHA256SUMS |
| \`release-id/\` | id \`example-release\` signed with TEST 1: exactly what R1 forbids a signer to produce |
| \`vk-release/\` | id \`example-release\`, RELEASE_PUBLISHER, signed with a synthetic non-test "vector key": the production path |
| \`vk-publisher/\` | the same key, id \`example-release\`, REHEARSAL_PUBLISHER |
| \`tk-publisher/\` | TEST 1, id \`example-rehearsal\`, RELEASE_PUBLISHER |
| \`keys/\` | release-keys files (airplanemode.release-keys/0.1): empty, test-key, weak, vector-key, duplicate-member, keyid-mismatch, duplicate-keyid, too-many (9 keys) |
| \`ids.json\` | rows { id, release, rehearsal, manifestId }: the two id patterns and the manifest id grammar, ${ids.length} ids |
| \`release.json\` | the cases below |

The vector key is a deterministic, public, non-secret key that is not an RFC 8032 test key. Its seed is the SHA-256 of a
fixed phrase and is kept only in \`test/tools/lib.mjs\`; only its public key is under \`keys/\`.

## release.json

An array of cases \`{ name, level, command, dir, mutation, args, expect, platform? }\`:

- \`level\`: \`manifest\` (a verdict that depends on the signed manifest and the trust set only; a signer or verifier
  that takes a manifest file, such as cp-sign, runs these) or \`directory\` (artefacts, SHA256SUMS or the release-keys
  file format; only a tool that takes a release directory runs these).
- \`command\`: \`verify\` or \`sign\`.
- \`dir\`: the directory under this one that the case starts from. The harness copies it to a fresh temporary directory
  and applies \`mutation\` to the copy. Nothing here is ever modified.
- \`args\`: the arguments after the command, without \`--dir\`. A \`@keys/<file>\` argument stands for that file in \`keys/\`.
- \`expect\`: \`{ exit, reason }\` and, for exit 0, \`testKey\` (whether the signature that verified belongs to a published
  test key). Exit 0 is accepted (reason null), 2 is a usage error (\`usage: <reason>: ...\`), 3 is refused
  (\`refused: <reason>\` first on stderr, \`{"verdict":"refused","reason":...}\` on stdout).
- \`platform\`: when present, the case runs only on that \`process.platform\`. A case that applies and cannot be set up
  (a link that the OS refuses) FAILS; it is never skipped.

Mutations (\`mutation.op\`):

| op | effect on the copy |
| --- | --- |
| \`none\` | nothing |
| \`flip-byte\` { file, offset } | xor 0x01 into that byte of the artefact |
| \`truncate\` { file, bytes } | drop that many bytes from the end of the artefact |
| \`remove\` { file } | delete the artefact |
| \`add-file\` { file, content } | add a file that no entry names |
| \`sums-edit\` { line } | change the first hex digit of that SHA256SUMS line |
| \`sums-crlf\` | convert SHA256SUMS to CRLF line endings |
| \`sums-reorder\` | reverse the line order of SHA256SUMS |
| \`manifest-publisher-edit\` | append " (edited)" to the publisher member of release-manifest.json (the signature no longer covers it) |
| \`symlink-artifact\` { file } | replace the artefact with a symbolic link to a copy outside the directory |
| \`junction-artifact\` { file } | replace the artefact with a directory link (a junction on Windows) |
| \`subdir\` { name } | add a subdirectory |
| \`symlink-dir\` | run with \`--dir\` set to a symbolic link (a junction on Windows) that points at the copy |

The link cases are made at test time and never committed. On Windows a junction needs no privilege; a file symlink may.

## Expected verdicts

Every case, with its exit code and reason, is in \`release.json\`; a consumer runs each of them and compares the exit code
and the reason token (and \`testKey\` for exit 0). \`ids.json\` is shared with control-plane: an implementation in another
language must give the same answer for every id, in particular for \`x-release\\n\` (a trailing newline never matches).
`,
);

// ---- write or check -----------------------------------------------------------------------------------
function listDir(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? listDir(p, base)
      : [
          p
            .slice(base.length + 1)
            .split(/[\\/]/)
            .join('/'),
        ];
  });
}

if (check) {
  const problems = [];
  const onDisk = new Set(listDir(defaultOut));
  for (const [rel, data] of files) {
    const p = join(defaultOut, rel);
    if (!existsSync(p)) problems.push(`missing ${rel}`);
    else if (!readFileSync(p).equals(data)) problems.push(`differs ${rel}`);
    onDisk.delete(rel);
  }
  for (const stray of onDisk) problems.push(`stray ${stray}`);
  if (problems.length) {
    console.error(`release vectors are out of date:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`release vectors are up to date (${files.size} files)`);
} else {
  for (const [rel, data] of files) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  console.log(`wrote ${files.size} files to ${outDir}`);
}
