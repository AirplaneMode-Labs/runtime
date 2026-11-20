/**
 * Release tool file handling, fix round 1 (BUG-T2-S7-04 and BUG-T2-S7-05):
 *  - `sign` lists --dir with the same lstat check as manifest and sums (symlink, subdirectory, FIFO: usage not_regular_file);
 *  - a file swapped for a FIFO between the lstat and the open never hangs: it ends in exit 3 not_regular_file.
 * POSIX-only cases (mkfifo) return early on win32, where the symlink and junction cases in release-tool.test.ts apply.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/release/cli';
import { readRegularFile } from '../src/release/fsutil';
import { makeLink, specDir } from './helpers';

const releaseDir = resolve(specDir, 'vectors/release');
const bundlePath = resolve(specDir, 'tools/release-tool.mjs');
const hookPath = resolve(__dirname, 'tools/swap-hook.cjs');
const posix = process.platform !== 'win32';

const tmpRoot = mkdtempSync(join(tmpdir(), 'amt-fh-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const fresh = (): string => {
  const d = join(tmpRoot, `w-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const run = async (argv: string[]) => {
  let stdout = '';
  let stderr = '';
  const exit = await runCli(
    argv,
    { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) },
    { sourceDateEpoch: '1795132800' },
  );
  return { exit, stdout, stderr };
};
const first = (s: string): string => s.split('\n')[0] ?? '';

/** An unsigned rehearsal directory with a manifest and SHA256SUMS. */
async function unsigned(): Promise<string> {
  const d = join(fresh(), 'dir');
  mkdirSync(d);
  for (const f of ['example-a.bin', 'example-b.txt'])
    cpSync(join(releaseDir, 'base', f), join(d, f));
  const m = await run([
    'manifest',
    '--dir',
    d,
    '--id',
    'example-rehearsal',
    '--version',
    '1.0.0',
    '--licence',
    'Apache-2.0',
    '--publisher',
    'rehearsal',
  ]);
  expect(m.exit).toBe(0);
  expect((await run(['sums', '--dir', d])).exit).toBe(0);
  return d;
}
const SIGN = (d: string) => ['sign', '--dir', d, '--test-key', 'rfc8032-1'];

describe('release-tool sign: the --dir members are checked with lstat (BUG-T2-S7-04)', () => {
  it('a symlinked artefact is usage: not_regular_file and nothing is signed', async () => {
    const d = await unsigned();
    const real = join(fresh(), 'real.bin');
    writeFileSync(real, 'x');
    makeLink('file', real, join(d, 'link.bin'));
    const r = await run(SIGN(d));
    expect(r.exit).toBe(2);
    expect(first(r.stderr)).toMatch(/^usage: not_regular_file: /);
    const m = await readRegularFile(join(d, 'release-manifest.json'), 1 << 20);
    expect(m.toString()).toContain('"signatures": []');
  });

  it('a listed artefact replaced by a symlink is usage: not_regular_file', async () => {
    const d = await unsigned();
    const real = join(fresh(), 'real.txt');
    cpSync(join(d, 'example-b.txt'), real);
    rmSync(join(d, 'example-b.txt'));
    makeLink('file', real, join(d, 'example-b.txt'));
    const r = await run(SIGN(d));
    expect(r.exit).toBe(2);
    expect(first(r.stderr)).toMatch(/^usage: not_regular_file: /);
  });

  it('a subdirectory is usage: not_regular_file', async () => {
    const d = await unsigned();
    mkdirSync(join(d, 'sub'));
    const r = await run(SIGN(d));
    expect(r.exit).toBe(2);
    expect(first(r.stderr)).toMatch(/^usage: not_regular_file: /);
  });

  it('an extra FIFO is usage: not_regular_file (POSIX)', async () => {
    if (!posix) return;
    const d = await unsigned();
    execFileSync('mkfifo', [join(d, 'fifo.bin')]);
    const r = await run(SIGN(d));
    expect(r.exit).toBe(2);
    expect(first(r.stderr)).toMatch(/^usage: not_regular_file: /);
  });

  it('a listed artefact replaced by a FIFO is usage: not_regular_file (POSIX)', async () => {
    if (!posix) return;
    const d = await unsigned();
    rmSync(join(d, 'example-b.txt'));
    execFileSync('mkfifo', [join(d, 'example-b.txt')]);
    const r = await run(SIGN(d));
    expect(r.exit).toBe(2);
    expect(first(r.stderr)).toMatch(/^usage: not_regular_file: /);
  });
});

describe('release-tool: a swap to a FIFO between the lstat and the open never hangs (BUG-T2-S7-05)', () => {
  it('readRegularFile: a file swapped for a FIFO in the lstat/open gap is refused, not blocked (POSIX)', async () => {
    if (!posix) return;
    const d = fresh();
    const f = join(d, 'a.bin');
    writeFileSync(f, 'original');
    await expect(
      readRegularFile(f, 1024, {
        afterLstat: () => {
          rmSync(f);
          execFileSync('mkfifo', [f]);
        },
      }),
    ).rejects.toMatchObject({ token: 'not_regular_file' });
  }, 10_000);

  it('the bundle, with a preload hook that swaps an artefact for a FIFO after its hash-time lstat, ends in exit 3 not_regular_file within 10 s (POSIX)', async () => {
    if (!posix) return;
    const d = await unsigned();
    expect((await run(SIGN(d))).exit).toBe(0);
    const target = join(d, 'example-b.txt');
    const mark = join(fresh(), 'MARK');
    // verify lstats the artefact three times: the member listing, the size check, and openChecked in hashRegularFile
    const r = spawnSync(
      process.execPath,
      [
        '--require',
        hookPath,
        bundlePath,
        'verify',
        '--dir',
        d,
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '',
          AMT_SWAP_TARGET: target,
          AMT_SWAP_NTH: '3',
          AMT_SWAP_MARK: mark,
        },
      },
    );
    expect(r.error, 'the run must not time out').toBeUndefined();
    expect(existsSync(mark), 'the hook swapped the file').toBe(true);
    expect(r.status).toBe(3);
    expect(first(r.stderr)).toBe('refused: not_regular_file');
  }, 15_000);
});
