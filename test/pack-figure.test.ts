// Sprint 6, D1-08 (T3-R2-05, TD-81): the tarball figures in the README are pinned to a fresh `npm pack --dry-run`,
// in a way that is safe on three operating systems: exact file count and exact unpacked bytes (stable once every text
// file is LF, which .gitattributes guarantees), and the packed size as "about N KiB" within 1 KiB (a gzip stream is
// not byte-stable across zlib builds). It needs dist/, so `npm run ci` builds BEFORE it tests. When it fails it prints
// the fresh figures so the README can be refreshed from the message. Written before the README wording and the ci
// order changed; the red run is evidence/sprint-6/D1/red/D1-08.log.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const read = (rel: string): string =>
  readFileSync(resolve(repoDir, rel), 'utf8').replace(/\r\n?/g, '\n');

const readme = read('README.md');
const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Quick start'));
const benchRow = readme.split('\n').find((l) => l.includes('Packed tarball')) ?? '';

interface Pack {
  files: { path: string; size: number }[];
  size: number;
  unpackedSize: number;
}
let packed: Pack | undefined;
/** One `npm pack --dry-run` per test file: it takes seconds on a slow runner, so it is not repeated. */
function freshPack(): Pack {
  packed ??= runPack();
  return packed;
}
function runPack(): Pack {
  const out = execFileSync(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  return (JSON.parse(out) as Pack[])[0]!;
}

const FIGURE = /about (\d+) KiB in (\d+) files \(([\d,]+) B unpacked\)/;
const stated = (text: string) => {
  const m = FIGURE.exec(text.replace(/\s+/g, ' '));
  if (!m) return undefined;
  return { kib: Number(m[1]), files: Number(m[2]), unpacked: Number(m[3]!.replace(/,/g, '')) };
};

describe('the README tarball figures equal a fresh npm pack', () => {
  const built = existsSync(resolve(repoDir, 'dist/index.js'));
  const pack = built ? freshPack() : undefined;
  const fresh = pack
    ? `fresh: ${pack.files.length} files, ${pack.unpackedSize.toLocaleString('en-US')} B unpacked, about ${Math.round(pack.size / 1024)} KiB packed (${pack.size} B)`
    : 'dist/ is missing: run npm run build first (npm run ci builds before it tests)';

  it('dist/ has been built (npm run ci builds before it tests)', () => {
    expect(built, fresh).toBe(true);
  });

  it('the Install section states "about N KiB in F files (U B unpacked)" and it matches the fresh pack', () => {
    expect(pack, fresh).toBeDefined();
    const s = stated(install);
    expect(
      s,
      `no "about N KiB in F files (U B unpacked)" in the README Install section; ${fresh}`,
    ).toBeDefined();
    expect(s!.files, `file count; ${fresh}`).toBe(pack!.files.length);
    expect(s!.unpacked, `unpacked bytes; ${fresh}`).toBe(pack!.unpackedSize);
    expect(Math.abs(s!.kib - pack!.size / 1024), `packed KiB; ${fresh}`).toBeLessThanOrEqual(1);
  });

  it('the Benchmarks row states the same figures, and the exact packed byte count is not quoted (it is not stable)', () => {
    expect(pack, fresh).toBeDefined();
    const s = stated(benchRow);
    expect(s, `no figure in the Benchmarks "Packed tarball" row; ${fresh}`).toBeDefined();
    expect(s!.files, `file count; ${fresh}`).toBe(pack!.files.length);
    expect(s!.unpacked, `unpacked bytes; ${fresh}`).toBe(pack!.unpackedSize);
    expect(Math.abs(s!.kib - pack!.size / 1024), `packed KiB; ${fresh}`).toBeLessThanOrEqual(1);
    expect(install + benchRow).not.toMatch(/\b\d{3},\d{3} B in \d+ files/);
  });

  it('the figures name the version of package.json (a stale version in the row is a stale row)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(benchRow).toContain(`airplanemode-runtime-${pkg.version}.tgz`);
  });
});

describe('docs/benchmarks/pack-size.json is the raw output of a fresh npm pack', () => {
  // The README row and the Install sentence are generated from this file (scripts/bench-pack.mjs, scripts/bench-readme.mjs).
  // It is kept honest the same way as the README: the file list, every file size and the unpacked bytes equal a fresh
  // `npm pack --dry-run`, and the packed size is within 1 KiB (a gzip stream is not byte-stable across zlib builds).
  // Refresh with `npm run build && node scripts/bench-pack.mjs`; the message prints the fresh figures.
  const built = existsSync(resolve(repoDir, 'dist/index.js'));
  const committed = JSON.parse(read('docs/benchmarks/pack-size.json')) as {
    files: { json: Pack[] }[];
  };
  const raw = committed.files[0]!.json[0]!;

  it('lists the same files with the same sizes, and the same unpacked bytes, as a fresh pack', () => {
    expect(built, 'dist/ is missing: run npm run build first').toBe(true);
    const fresh = freshPack();
    const tag = `fresh: ${fresh.files.length} files, ${fresh.unpackedSize} B unpacked, ${fresh.size} B packed; run node scripts/bench-pack.mjs`;
    expect(
      raw.files.map((f) => `${f.path} ${f.size}`),
      tag,
    ).toEqual(fresh.files.map((f) => `${f.path} ${f.size}`));
    expect(raw.unpackedSize, tag).toBe(fresh.unpackedSize);
    expect(Math.abs(raw.size - fresh.size) / 1024, tag).toBeLessThanOrEqual(1);
  });

  it('is the file the README figures state: the Install sentence and the Benchmarks row equal its figure', () => {
    const figure = `about ${Math.round(raw.size / 1024)} KiB in ${raw.files.length} files (${raw.unpackedSize.toLocaleString('en-US')} B unpacked)`;
    expect(install.replace(/\s+/g, ' ')).toContain(figure);
    expect(benchRow).toContain(figure);
  });
});

describe('the packed text files are LF on every platform (what makes the unpacked figure exact)', () => {
  const BINARY = /\.(wasm|png|ico|jpg|jpeg|gif|pdf|bin|zip|gz|woff2?|ttf)$/i;

  it('.gitattributes stores and checks out every text file with LF and keeps binaries binary', () => {
    const attrs = read('.gitattributes');
    expect(attrs).toContain('* text=auto eol=lf');
    expect(attrs).toContain('*.png binary');
    expect(attrs).toContain('*.wasm binary');
  });

  it('no text file in the tarball contains a carriage return', () => {
    if (!existsSync(resolve(repoDir, 'dist/index.js'))) return;
    const withCr: string[] = [];
    for (const f of freshPack().files) {
      if (BINARY.test(f.path)) continue;
      if (readFileSync(resolve(repoDir, f.path)).includes(0x0d)) withCr.push(f.path);
    }
    expect(withCr, 'CRLF in a packed file changes the unpacked size on that platform').toEqual([]);
  });
});

describe('npm run ci builds before it tests', () => {
  it('the ci script runs build before test (the pack figure needs dist/)', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const ci = pkg.scripts['ci']!;
    expect(ci.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(ci.indexOf('npm run build')).toBeLessThan(ci.indexOf('npm run test'));
  });
});
