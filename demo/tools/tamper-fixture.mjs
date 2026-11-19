// The Tamper lab fixture of the runtime demo: a VERBATIM copy of spec/vectors/tamper (fifteen tamper
// vectors and tamper.json), spec/vectors/expect-id/expect-id.json, three files of spec/vectors/weak-keys
// (the table, the verify rows and the forged-identity manifest: lab case 15) and spec/vectors/tamper-assets
// (three signed manifests, three .bin files and expect.json) into demo/public/tamper/, which Vite copies to
// demo/dist/tamper/.
//
//   demo/public/tamper/vectors/   <- spec/vectors/tamper/*   (README.md is documentation, not copied)
//   demo/public/tamper/assets/    <- spec/vectors/tamper-assets/*
//
// Nothing is regenerated or re-signed here: the lab shows the bytes the spec publishes. After the copy,
// verifyTamperFixture() hashes every source and every copy with SHA-256 and fails the build if any pair
// differs, a file is missing or a stray file is present. (A tool that re-signed or reformatted a vector
// would otherwise let the demo show something the spec does not contain.)
//
// Output path safety: the copy refuses any outDir that is not inside <repo>/demo/public/ (or the OS
// temp directory, for the tests).

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const TAMPER_VECTORS = [
  'tamper-01-entry-sha-byte.json',
  'tamper-02-entry-size.json',
  'tamper-03-sig-bitflip.json',
  'tamper-04-swapped-key.json',
  'tamper-05-publickey-mismatch.json',
  'tamper-06-untrusted-key.json',
  'tamper-07-truncated.txt',
  'tamper-08-rollback.json',
  'tamper-09-replay-older-createdAt.json',
  'tamper-10-expired.json',
  'tamper-11-rotation-ok.json',
  'tamper-12-stripped.json',
  'tamper-13-alg-none.json',
  'tamper-14-test-key-refused.json',
  'tamper-15-noncanonical-s.json',
  'tamper.json',
];
const TAMPER_ASSETS = [
  'asset-ok.bin',
  'asset-flip.bin',
  'asset-truncated.bin',
  'manifest-ok.json',
  'manifest-flip.json',
  'manifest-truncated.json',
  'expect.json',
];

/** Every copied file: `from` is relative to spec/vectors, `to` relative to the fixture directory. */
export const TAMPER_FIXTURE_FILES = Object.freeze([
  ...TAMPER_VECTORS.map((f) => ({ from: `tamper/${f}`, to: `vectors/${f}` })),
  // manifest 0.1.2: the expect-id table (the lab's case 'other-product' runs its row 02)
  { from: 'expect-id/expect-id.json', to: 'vectors/expect-id.json' },
  // manifest 0.1.3: the weak-key vectors (the lab's case 'weak-key' runs row 1 of verify.json)
  { from: 'weak-keys/weak-keys.json', to: 'vectors/weak-keys.json' },
  { from: 'weak-keys/verify.json', to: 'vectors/weak-keys-verify.json' },
  { from: 'weak-keys/forged-identity.manifest.json', to: 'vectors/forged-identity.manifest.json' },
  ...TAMPER_ASSETS.map((f) => ({ from: `tamper-assets/${f}`, to: `assets/${f}` })),
]);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function assertSafeOut(outDir) {
  const out = path.resolve(outDir);
  const allowed = [
    path.resolve(repo, 'demo', 'public'),
    realpathSync(tmpdir()),
    path.resolve(tmpdir()),
  ];
  const ok = allowed.some((root) => out === root || out.startsWith(root + path.sep));
  if (!ok) throw new Error(`refusing to write outside demo/public or the temp directory: ${out}`);
  return out;
}

/** Copies the fixture files byte for byte into `outDir` (replacing vectors/ and assets/ there). */
export function copyTamperFixture({ vectorsDir, outDir }) {
  const out = assertSafeOut(outDir);
  for (const sub of ['vectors', 'assets'])
    rmSync(path.join(out, sub), { recursive: true, force: true });
  for (const f of TAMPER_FIXTURE_FILES) {
    const dest = path.join(out, f.to);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(vectorsDir, f.from), dest);
  }
}

/**
 * Throws unless `outDir` holds exactly the fixture files and each has the sha256 of its source under
 * `vectorsDir`.
 */
export function verifyTamperFixture({ vectorsDir, outDir }) {
  const problems = [];
  for (const f of TAMPER_FIXTURE_FILES) {
    const copy = path.join(outDir, f.to);
    if (!existsSync(copy)) {
      problems.push(`missing file ${f.to}`);
      continue;
    }
    const want = sha256(path.join(vectorsDir, f.from));
    const got = sha256(copy);
    if (got !== want)
      problems.push(`${f.to}: sha256 ${got} differs from the spec's ${f.from} (${want})`);
  }
  const expected = new Set(TAMPER_FIXTURE_FILES.map((f) => f.to));
  for (const sub of ['vectors', 'assets']) {
    const dir = path.join(outDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir))
      if (!expected.has(`${sub}/${name}`)) problems.push(`unexpected file ${sub}/${name}`);
  }
  if (problems.length > 0)
    throw new Error(`tamper fixture is not the spec: ${problems.join('; ')}`);
}

/** The build step: copy, then verify. Returns the number of files. */
export function buildTamperFixture({ vectorsDir, outDir }) {
  copyTamperFixture({ vectorsDir, outDir });
  verifyTamperFixture({ vectorsDir, outDir });
  return TAMPER_FIXTURE_FILES.length;
}

export const SPEC_VECTORS_DIR = path.resolve(repo, 'spec', 'vectors');
export const DEFAULT_TAMPER_OUT = path.resolve(repo, 'demo', 'public', 'tamper');
