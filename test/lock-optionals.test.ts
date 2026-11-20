// Sprint 7, D1-05 (B5; S1 supply-chain condition): scripts/check-lock-optionals.mjs. A lockfile whose native optional
// packages lack `resolved` or `integrity`, or lack a build for linux-x64 (glibc), darwin-arm64 or win32-x64, makes
// `npm ci` need an unlocked fetch on one of the three CI operating systems. The same check lists the packages with
// install scripts, and this test pins that set: a new entry fails here until S1 accepts it in writing.
// Written before the script existed; the red run is D1/red/D1-05-*.log in the sprint scratch.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJson, repoDir } from './helpers';

const script = resolve(repoDir, 'scripts/check-lock-optionals.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'amt-lockopt-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface LockPkg {
  version?: string | undefined;
  resolved?: string | undefined;
  integrity?: string | undefined;
  optional?: boolean | undefined;
  os?: string[] | undefined;
  cpu?: string[] | undefined;
  libc?: string[] | undefined;
  hasInstallScript?: boolean | undefined;
  optionalDependencies?: Record<string, string> | undefined;
}
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const tgz = (n: string) => `https://registry.npmjs.org/${n}/-/${n.split('/').pop()}-1.0.0.tgz`;
const native = (
  name: string,
  os: string,
  cpu: string,
  libc?: string,
  over: LockPkg = {},
): [string, LockPkg] => [
  `node_modules/${name}`,
  {
    version: '1.0.0',
    resolved: tgz(name),
    integrity: INTEGRITY,
    optional: true,
    os: [os],
    cpu: [cpu],
    ...(libc ? { libc: [libc] } : {}),
    ...over,
  },
];
function lockOf(entries: [string, LockPkg][], parent = 'fam'): Record<string, unknown> {
  const optionalDependencies = Object.fromEntries(
    entries.map(([k]) => [k.replace(/^node_modules\//, ''), '1.0.0']),
  );
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', version: '1.0.0' },
      [`node_modules/${parent}`]: { version: '1.0.0', optionalDependencies },
      ...Object.fromEntries(entries),
    },
  };
}
const FAMILY: [string, LockPkg][] = [
  native('fam-linux-x64-gnu', 'linux', 'x64', 'glibc'),
  native('fam-linux-x64-musl', 'linux', 'x64', 'musl'),
  native('fam-darwin-arm64', 'darwin', 'arm64'),
  native('fam-win32-x64-msvc', 'win32', 'x64'),
];
function check(lock: unknown, ...flags: string[]) {
  const f = join(tmp, `lock-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(lock));
  const r = spawnSync(process.execPath, [script, '--lock', f, ...flags], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-lock-optionals.mjs on synthetic lockfiles', () => {
  it('exists', () => {
    expect(existsSync(script)).toBe(true);
  });

  it('a complete family (linux glibc, darwin arm64, win32 x64) passes and the report names each platform', () => {
    const r = check(lockOf(FAMILY));
    expect(r.status, r.out).toBe(0);
    for (const p of ['linux-x64-gnu', 'darwin-arm64', 'win32-x64-msvc']) expect(r.out).toContain(p);
  });

  it('a family without a win32-x64 build fails and says which', () => {
    const r = check(lockOf(FAMILY.filter(([k]) => !k.includes('win32'))));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/fam.*win32-x64-msvc/s);
  });

  it('a family without a darwin-arm64 build fails', () => {
    const r = check(lockOf(FAMILY.filter(([k]) => !k.includes('darwin'))));
    expect(r.status).toBe(1);
    expect(r.out).toContain('darwin-arm64');
  });

  it('a linux build that is musl only does not satisfy linux-x64 (glibc)', () => {
    const r = check(lockOf(FAMILY.filter(([k]) => !k.includes('linux-x64-gnu'))));
    expect(r.status).toBe(1);
    expect(r.out).toContain('linux-x64-gnu');
  });

  it('a native optional without integrity, or without resolved, fails, even for a platform CI does not use', () => {
    const noIntegrity: [string, LockPkg][] = [
      ...FAMILY,
      native('fam-freebsd-x64', 'freebsd', 'x64', undefined, { integrity: undefined }),
    ];
    const a = check(lockOf(noIntegrity));
    expect(a.status).toBe(1);
    expect(a.out).toContain('fam-freebsd-x64');
    expect(a.out).toMatch(/integrity/);
    const noResolved: [string, LockPkg][] = [
      ...FAMILY,
      native('fam-sunos-x64', 'sunos', 'x64', undefined, { resolved: undefined }),
    ];
    const b = check(lockOf(noResolved));
    expect(b.status).toBe(1);
    expect(b.out).toMatch(/resolved/);
  });

  it('an integrity that is not sha512 and a resolved url outside the registry fail', () => {
    const weak: [string, LockPkg][] = [
      native('fam-linux-x64-gnu', 'linux', 'x64', 'glibc', {
        integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
      ...FAMILY.slice(1),
    ];
    expect(check(lockOf(weak)).status).toBe(1);
    const elsewhere: [string, LockPkg][] = [
      native('fam-linux-x64-gnu', 'linux', 'x64', 'glibc', {
        resolved: 'https://example.invalid/x.tgz',
      }),
      ...FAMILY.slice(1),
    ];
    expect(check(lockOf(elsewhere)).status).toBe(1);
  });

  it('a single-platform optional (fsevents-like) needs resolved and integrity only, not a three-platform family', () => {
    const lock = lockOf([native('fsevents-like', 'darwin', 'arm64')], 'chokidar-like');
    expect(check(lock).status).toBe(0);
    const bad = lockOf(
      [native('fsevents-like', 'darwin', 'arm64', undefined, { integrity: undefined })],
      'chokidar-like',
    );
    expect(check(bad).status).toBe(1);
  });

  it('a non-native optional with neither resolved nor integrity fails too (npm ci would fetch it unlocked)', () => {
    const lock = lockOf(FAMILY) as { packages: Record<string, LockPkg> };
    lock.packages['node_modules/plain-optional'] = { version: '1.0.0', optional: true };
    expect(check(lock).status).toBe(1);
  });

  it('--install-scripts lists the entries that have hasInstallScript', () => {
    const lock = lockOf(FAMILY) as { packages: Record<string, LockPkg> };
    lock.packages['node_modules/with-script'] = {
      version: '2.0.0',
      resolved: tgz('with-script'),
      integrity: INTEGRITY,
      hasInstallScript: true,
    };
    const r = check(lock, '--install-scripts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('with-script@2.0.0');
  });
});

describe('the repository lockfile', () => {
  const lock = readJson<{ packages: Record<string, LockPkg> }>(
    resolve(repoDir, 'package-lock.json'),
  );

  it('passes: every native optional is locked with resolved and integrity, for linux-x64, darwin-arm64 and win32-x64', () => {
    const r = spawnSync(process.execPath, [script], { cwd: repoDir, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    for (const fam of ['@esbuild', '@rolldown/binding', 'lightningcss'])
      expect(r.stdout, fam).toContain(fam);
  });

  it('the packages with install scripts are exactly the ones S1 has accepted (a new one needs S1 in writing)', () => {
    const withScript = Object.entries(lock.packages)
      .filter(([, v]) => v.hasInstallScript)
      .map(([k, v]) => `${k.replace(/^node_modules\//, '')}@${v.version}`)
      .sort();
    // esbuild (tsup), fsevents (macOS file watching, optional), onnxruntime-node (a peer of transformers.js; never run:
    // .npmrc has ignore-scripts and CI installs with --ignore-scripts) and protobufjs: all four were in the lockfile
    // before Sprint 7 and are listed by `npm run deps:scripts`. Vite 8 and vitest 5 add none.
    expect(withScript.map((s) => s.replace(/@.*/, ''))).toEqual([
      'esbuild',
      'fsevents',
      'onnxruntime-node',
      'protobufjs',
    ]);
  });

  it('vite is 8.x and vitest is 5.x or the deferral is recorded (package.json and lock agree)', () => {
    const pkg = readJson<{ devDependencies: Record<string, string> }>(
      resolve(repoDir, 'package.json'),
    );
    const root = (lock.packages[''] as unknown as { devDependencies: Record<string, string> })
      .devDependencies;
    for (const n of ['vite', 'vitest', 'tsup', 'typescript', '@types/node'])
      expect(root[n], n).toBe(pkg.devDependencies[n]);
    expect(pkg.devDependencies['tsup']).toBe('8.5.1'); // tsup 9 is deferred (TD-112): it bundles the vendored release tool
    expect(pkg.devDependencies['typescript']).toBe('5.9.3'); // TypeScript 7 is deferred (TD-112)
    expect(pkg.devDependencies['@types/node']).toBe('22.20.5'); // Node 22 engine
  });
});
