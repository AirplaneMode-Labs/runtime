#!/usr/bin/env node
// Measures the packed tarball (files, packed bytes, unpacked bytes) with `npm pack --dry-run`, writes
// docs/benchmarks/pack-size.json (the raw `npm pack --json` output with its date, commit, machine and command)
// and rewrites the README: the Benchmarks tables (through scripts/bench-readme.mjs) and the sentence in the
// Install section. README.md is itself in the tarball, so the figure depends on the text that quotes it: the
// script repeats pack, write, rewrite until a pack of the finished README gives the figure the README states.
//
//   npm run build && node scripts/bench-pack.mjs
//
// The machine label comes from sysctl on macOS; elsewhere set BENCH_MACHINE_LABEL="<model> <N> GB".
// test/pack-figure.test.ts compares the same figures with a fresh pack on every `npm run ci`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prettier from 'prettier';
import {
  BENCH_DIR,
  LAPTOP_8GB,
  SCHEMA,
  applyTables,
  loadBenchmarks,
  packFigure,
  root,
  tables,
} from './bench-readme.mjs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = join(BENCH_DIR, 'pack-size.json');
const readmePath = join(root, 'README.md');

function machineLabel() {
  if (process.env.BENCH_MACHINE_LABEL) return process.env.BENCH_MACHINE_LABEL;
  if (process.platform !== 'darwin') throw new Error('set BENCH_MACHINE_LABEL="<model> <N> GB"');
  const sys = (k) => execFileSync('sysctl', ['-n', k], { encoding: 'utf8' }).trim();
  return `${sys('machdep.cpu.brand_string')} ${Math.round(Number(sys('hw.memsize')) / 2 ** 30)} GB`;
}

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function pack() {
  const stdout = execFileSync(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  return { stdout, json: JSON.parse(stdout) };
}

if (!existsSync(join(root, 'dist', 'index.js')))
  throw new Error('dist/ is missing: run npm run build first');

const dirty = git('status', '--porcelain').length > 0;
const sha = git('rev-parse', '--short=12', 'HEAD');
const label = machineLabel();

let stable = false;
for (let i = 0; i < 6 && !stable; i++) {
  const { stdout, json } = pack();
  const env = {
    schema: SCHEMA,
    id: 'pack-size',
    title: 'Packed tarball: file count, packed bytes and unpacked bytes (npm pack --dry-run)',
    measuredAt: new Date().toISOString().slice(0, 10),
    commit: {
      recorded: true,
      sha,
      dirty,
      note: dirty
        ? 'HEAD at the moment of the run, with uncommitted changes in the working tree (the change that stores this file), so sha is the parent of the commit that holds it.'
        : 'HEAD at the moment of the run, a clean working tree.',
    },
    machine: { label, os: process.platform === 'darwin' ? 'macOS arm64' : process.platform },
    laptop8gb: LAPTOP_8GB,
    method:
      'npm pack --dry-run --json lists what npm would put in the tarball: the file count, the sum of the file sizes (unpackedSize) and the gzip size (size). The file count and the unpacked bytes are exact and stable (every text file is LF, .gitattributes); the packed size is quoted to the nearest KiB because a gzip stream is not byte-stable across zlib builds. A file size, not a timing: the 8 GB column does not apply to it but is kept for uniformity.',
    commands: [
      'npm run build',
      'npm pack --dry-run --json --ignore-scripts',
      'node scripts/bench-pack.mjs  (writes this file and rewrites the README figures)',
    ],
    files: [
      {
        name: 'npm-pack.json',
        origin: 'generated',
        source: 'npm pack --dry-run --json --ignore-scripts, run by scripts/bench-pack.mjs',
        sha256: createHash('sha256').update(stdout).digest('hex'),
        json: json,
      },
    ],
  };
  // formatted the way `npm run fmt:check` wants it, so the run leaves the tree clean
  const config = (await prettier.resolveConfig(out)) ?? {};
  writeFileSync(
    out,
    await prettier.format(JSON.stringify(env, null, 2), { ...config, parser: 'json' }),
  );

  const benches = loadBenchmarks();
  let readme = readFileSync(readmePath, 'utf8').replace(/\r\n?/g, '\n');
  const at = readme.indexOf('\n## Install');
  const end = readme.indexOf('\n## Quick start', at);
  const install = readme
    .slice(at, end)
    .replace(/about \d+ KiB in \d+ files \([\d,]+ B unpacked\)/, packFigure(benches['pack-size']));
  readme = readme.slice(0, at) + install + readme.slice(end);
  const next = applyTables(readme, tables(benches));
  const before = readFileSync(readmePath, 'utf8');
  if (next !== before) writeFileSync(readmePath, next);
  stable = next === before;
  console.log(`${stable ? 'stable' : 'rewrote README'}: ${packFigure(benches['pack-size'])}`);
}
if (!stable) throw new Error('the pack figure did not settle in 6 rounds');
