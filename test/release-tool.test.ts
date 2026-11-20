// Sprint 7, D1-02 (TD-103, TD-104; S1 hardening): the release tool, runtime's own verifier bundled for the
// rehearsal. Every case of spec/vectors/release/release.json goes through the TypeScript entry (src/release/cli.ts)
// and through the committed bundle (spec/tools/release-tool.mjs, a spawned process), and both must give the exit
// code, the first stderr line and the JSON reason of the vector. Link cases (a symlinked artefact, a symlinked
// --dir, a subdirectory, and on win32 a junction) are made at test time and FAIL rather than skip when the OS
// refuses a link. Written before src/release/ existed; the red run is D1/red/D1-02-*.log in the sprint scratch.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REHEARSAL_PUBLISHER,
  RELEASE_EXIT,
  RELEASE_REJECT_REASONS,
  RELEASE_USAGE_REASONS,
  TEST_KEY_SIGN_BANNER,
  TEST_KEY_VERIFY_BANNER,
} from '../spec/release';
import { runCli } from '../src/release/cli';
import { hashRegularFile, readRegularFile, ReleaseStop } from '../src/release/fsutil';
import { parseReleaseKeys } from '../src/release/keys';
import { postVerifyChecks } from '../src/release/tool';
import { makeLink, readJson, readText, repoDir, specDir } from './helpers';
// @ts-expect-error: plain ESM oracle (test/tools/lib.mjs never imports src/)
import { applyReleaseMutation } from './tools/lib.mjs';

const releaseDir = resolve(specDir, 'vectors/release');
const bundlePath = resolve(specDir, 'tools/release-tool.mjs');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const tmpRoot = mkdtempSync(join(tmpdir(), 'amt-reltool-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const fresh = (label = 'w'): string => {
  const d = join(tmpRoot, `${label}-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
};

interface Result {
  exit: number;
  stdout: string;
  stderr: string;
}
type Runner = (argv: string[], opts?: { sde?: string }) => Promise<Result>;

/** The TypeScript entry, in this process. */
const runTs: Runner = async (argv, opts = {}) => {
  let stdout = '';
  let stderr = '';
  const exit = await runCli(
    argv,
    { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) },
    { sourceDateEpoch: opts.sde },
  );
  return { exit, stdout, stderr };
};

/** The committed bundle, in a child process with a scrubbed environment. */
const runBundle: Runner = async (argv, opts = {}) => {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    ...(opts.sde !== undefined ? { SOURCE_DATE_EPOCH: opts.sde } : {}),
  };
  const r = spawnSync(process.execPath, [bundlePath, ...argv], { encoding: 'utf8', env });
  if (r.error) throw r.error;
  return { exit: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

const firstLine = (s: string): string => s.split('\n')[0] ?? '';

interface Case {
  name: string;
  level: string;
  command?: 'verify' | 'sign';
  dir: string;
  mutation: Record<string, unknown>;
  args: string[];
  expect: { exit: number; reason: string | null; testKey?: boolean };
  platform?: string;
}
const cases = readJson<Case[]>(resolve(releaseDir, 'release.json'));

async function runCase(c: Case, run: Runner): Promise<void> {
  if (c.platform !== undefined && c.platform !== process.platform) return;
  const work = fresh('case');
  const arranged = await applyReleaseMutation(releaseDir, c.dir, join(work, 'dir'), c.mutation, {
    work,
  });
  const args = c.args.map((a) =>
    a.startsWith('@keys/') ? join(releaseDir, 'keys', a.slice(6)) : a,
  );
  const before = existsSync(join(work, 'dir')) ? listTree(join(work, 'dir')) : '';
  const r = await run([c.command ?? 'verify', '--dir', arranged.dir, ...args]);
  expect(r.exit, `${c.name}: exit (stderr: ${r.stderr})`).toBe(c.expect.exit);
  if (c.expect.exit === 0) {
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    if ((c.command ?? 'verify') === 'verify') {
      expect(out['verdict']).toBe('ok');
      expect(out['testKey']).toBe(c.expect.testKey);
      expect(r.stderr.includes(TEST_KEY_VERIFY_BANNER)).toBe(c.expect.testKey === true);
    }
    return;
  }
  if (c.expect.exit === RELEASE_EXIT.refused) {
    expect(firstLine(r.stderr), `${c.name}: first stderr line`).toBe(`refused: ${c.expect.reason}`);
    expect(JSON.parse(r.stdout)).toEqual({ verdict: 'refused', reason: c.expect.reason });
  } else {
    expect(r.exit).toBe(RELEASE_EXIT.usage);
    expect(firstLine(r.stderr), `${c.name}: first stderr line`).toMatch(
      new RegExp(`^usage: ${c.expect.reason}: .+`),
    );
    expect(r.stdout).toBe('');
  }
  // a refusal and a usage error never change the directory they were pointed at
  expect(existsSync(join(work, 'dir')) ? listTree(join(work, 'dir')) : '').toBe(before);
}

function listTree(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((n) => {
      const p = join(dir, n);
      const st = statSync(p);
      return st.isFile() ? `${n}:${sha(readFileSync(p))}` : `${n}/`;
    })
    .join('|');
}

describe('release-tool: every release.json case through the TypeScript entry', () => {
  it('release.json has the specified cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(36);
  });
  for (const c of cases)
    it(`${c.name}: ${c.expect.exit} ${c.expect.reason ?? 'ok'}`, async () => {
      await runCase(c, runTs);
    });
});

describe('release-tool: every release.json case through the committed bundle (a child process)', () => {
  it('the bundle and its .sha256 are committed', () => {
    expect(existsSync(bundlePath)).toBe(true);
    expect(existsSync(`${bundlePath}.sha256`)).toBe(true);
  });
  for (const c of cases)
    it(`${c.name}: ${c.expect.exit} ${c.expect.reason ?? 'ok'}`, async () => {
      await runCase(c, runBundle);
    });
});

describe('release-tool: the bundle is the build of src/release/ and is what it says it is', () => {
  const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';

  it('the committed bundle matches its .sha256 (LF text, one line, name and digest)', () => {
    const line = readText(`${bundlePath}.sha256`);
    expect(line).toBe(`${sha(readFileSync(bundlePath))}  release-tool.mjs\n`);
  });

  it('a fresh build is byte-identical to the committed bundle', () => {
    const out = fresh('build');
    execFileSync(
      process.execPath,
      [
        resolve(repoDir, 'node_modules/tsup/dist/cli-default.js'),
        '--config',
        'tsup.release-tool.config.ts',
        '--out-dir',
        out,
      ],
      { cwd: repoDir, stdio: 'pipe' },
    );
    expect(sha(readFileSync(join(out, 'release-tool.mjs')))).toBe(sha(readFileSync(bundlePath)));
  });

  it('the banner names spec release 0.6.1', () => {
    // esbuild hoists the import lines above the banner; it is still the first comment of the file
    expect(bundle.slice(0, 700)).toContain(
      '// @airplanemode/runtime release tool, spec release 0.6.1',
    );
  });

  it('allowlist: it imports only node:crypto, node:fs, node:fs/promises, node:path, node:process and node:url', () => {
    const imports = [...bundle.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    expect(imports.length).toBeGreaterThan(0);
    const allowed = new Set([
      'node:crypto',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:process',
      'node:url',
    ]);
    for (const i of imports) expect(allowed.has(i), i).toBe(true);
    expect(bundle).not.toMatch(/(?:^|\n)\s*import\s*["']/); // no bare side-effect import either
  });

  it('allowlist: none of the forbidden modules, calls or globals appears', () => {
    for (const bad of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:child_process',
      'node:worker_threads',
      'node:vm',
      'node:module',
      'child_process',
      'worker_threads',
      'fetch(',
      'WebSocket',
      'eval(',
      'new Function',
      'require(',
    ])
      expect(bundle.includes(bad), bad).toBe(false);
    expect(bundle).not.toMatch(/\bimport\s*\(/); // no dynamic import
  });

  it('allowlist: exactly one process.env read, and it is SOURCE_DATE_EPOCH', () => {
    const reads = bundle.match(/process\d*\.env\b[^\n]*/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('SOURCE_DATE_EPOCH');
    expect(bundle).not.toMatch(/\benv\b\s*\[(?!\s*["']SOURCE_DATE_EPOCH["']\s*\])/); // no computed environment read
  });

  it('allowlist: every 64-hex string is one of the RFC 8032 public keys, their keyIds or the TEST 1 seed', () => {
    const allowed = new Set([
      // the five RFC 8032 section 7.1 public keys
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
      '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e',
      'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
      // their keyIds
      '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
      '39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f',
      'dac073e0123bdea59dd9b3bda9cf6037f63aca82627d7abcd5c4ac29dd74003e',
      '91384c411e5af29648f17f922b402655b11ecaec1b33fc45796241963f95f202',
      '5f9b247e2a654719f198e4f241d6b0df9a1a937a13ef5ef899f64d9285fce224',
      // the TEST 1 seed
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    ]);
    const found = [...bundle.matchAll(/(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/g)].map(
      (m) => m[0],
    );
    expect(found.length).toBeGreaterThan(5);
    for (const h of found) expect(allowed.has(h), h).toBe(true);
    // the pkcs8 prefix is there, for node:crypto, and no other seed-like constant
    expect(bundle).toContain('302e020100300506032b657004220420');
  });

  it('allowlist: no key file is read and there is no --key option; the test key is a literal, not an input', () => {
    expect(bundle).not.toContain('"--key"');
    expect(bundle).not.toContain("'--key'");
    expect(bundle).not.toMatch(/PRIVATE KEY|key\.secret|\.pem/);
    expect(bundle).toContain('rfc8032-1');
  });

  it('R3: the allow flags are command-line flags only (no environment, URL, file or state read decides them)', () => {
    for (const flag of ['--allow-test-key', '--trust-test-key']) expect(bundle).toContain(flag);
    // the only place an environment variable is read is SOURCE_DATE_EPOCH (checked above); no storage, no URL
    expect(bundle).not.toMatch(/localStorage|sessionStorage|indexedDB|location\.|URLSearchParams/);
  });

  it('spec/tools is not in the npm package: package.json files excludes it and pack --dry-run lists none', () => {
    const pkg = readJson<{ files: string[] }>(resolve(repoDir, 'package.json'));
    expect(pkg.files).toContain('!spec/tools');
    const out = execFileSync(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    const files = (JSON.parse(out)[0] as { files: { path: string }[] }).files.map((f) =>
      f.path.replace(/\\/g, '/'),
    );
    expect(files.filter((f) => f.startsWith('spec/tools'))).toEqual([]);
    expect(files.filter((f) => f.includes('release-tool'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('src/release'))).toEqual([]);
  });

  it('the bundle holds no source map, no test hook and no absolute builder path', () => {
    expect(bundle).not.toContain('sourceMappingURL');
    for (const p of ['/Users/', '/home/', 'C:\\\\']) expect(bundle.includes(p), p).toBe(false);
  });
});

describe('release-tool: usage and the exact messages', () => {
  const base = (): string => {
    const d = join(fresh('base'), 'dir');
    cpSync(join(releaseDir, 'base'), d, { recursive: true });
    return d;
  };

  for (const [label, run] of [
    ['ts', runTs],
    ['bundle', runBundle],
  ] as const) {
    it(`${label}: verify without --expect-id prints "usage: expect_id_required" and exits 2`, async () => {
      const r = await run(['verify', '--dir', base(), '--trust-test-key', '--allow-test-key']);
      expect(r.exit).toBe(2);
      expect(firstLine(r.stderr)).toMatch(/^usage: expect_id_required: .+/);
      expect(r.stdout).toBe('');
    });

    it(`${label}: a missing directory is an I/O error (exit 1), never a refusal`, async () => {
      const r = await run([
        'verify',
        '--dir',
        join(fresh('none'), 'missing'),
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
      ]);
      expect(r.exit).toBe(1);
      expect(firstLine(r.stderr)).toMatch(/^error: /);
      expect(r.stderr).not.toContain('refused:');
      expect(r.stdout).toBe('');
    });

    it(`${label}: an unknown command, an unknown option and a repeated option are usage: bad_arguments`, async () => {
      for (const argv of [
        [],
        ['frobnicate'],
        ['verify', '--dir', base(), '--expect-id', 'example-rehearsal', '--bogus'],
        ['verify', '--dir', base(), '--dir', base(), '--expect-id', 'example-rehearsal'],
        ['verify', '--dir', base(), '--expect-id', 'example-rehearsal', '--key', 'k.pem'],
        ['verify', '--expect-id', 'example-rehearsal', '--trust-test-key'],
      ]) {
        const r = await run(argv);
        expect(r.exit, JSON.stringify(argv)).toBe(2);
        expect(firstLine(r.stderr), JSON.stringify(argv)).toMatch(/^usage: bad_arguments: .+/);
      }
    });

    it(`${label}: --now is accepted as RFC 3339 UTC and refused otherwise`, async () => {
      const ok = await run([
        'verify',
        '--dir',
        base(),
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
        '--now',
        '2030-01-01T00:00:00Z',
      ]);
      expect(ok.exit).toBe(0);
      const bad = await run([
        'verify',
        '--dir',
        base(),
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
        '--now',
        'yesterday',
      ]);
      expect(bad.exit).toBe(2);
      expect(firstLine(bad.stderr)).toMatch(/^usage: bad_arguments: /);
    });

    it(`${label}: the verified-with-a-test-key line goes to stderr, and the JSON says testKey true from the signature, not the flag`, async () => {
      const r = await run([
        'verify',
        '--dir',
        base(),
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
      ]);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe(
        '{"verdict":"ok","id":"example-rehearsal","version":"1.0.0","entries":2,"testKey":true}\n',
      );
      expect(r.stderr).toContain(TEST_KEY_VERIFY_BANNER);
    });

    it(`${label}: the production path (vk-release, trust file) is ok with testKey false and no banner`, async () => {
      const d = join(fresh('vk'), 'dir');
      cpSync(join(releaseDir, 'vk-release'), d, { recursive: true });
      const r = await run([
        'verify',
        '--dir',
        d,
        '--expect-id',
        'example-release',
        '--trust-file',
        join(releaseDir, 'keys/vector-key.json'),
      ]);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe(
        '{"verdict":"ok","id":"example-release","version":"1.0.0","entries":2,"testKey":false}\n',
      );
      expect(r.stderr).toBe('');
    });
  }

  it('the tool lists are the specified ones: every refusal token a case expects is a known reason', () => {
    const known = new Set<string>([
      ...RELEASE_REJECT_REASONS,
      ...RELEASE_USAGE_REASONS,
      'test_key_refused',
      'weak_key_refused',
      'no_valid_signature',
      'unexpected_id',
    ]);
    for (const c of cases)
      if (c.expect.reason) expect(known.has(c.expect.reason), c.name).toBe(true);
  });
});

describe('release-tool: manifest, sums and sign build exactly the vector (determinism)', () => {
  // 2026-11-20T00:00:00Z
  const SDE = '1795132800';
  const stage = (): string => {
    const d = join(fresh('stage'), 'dir');
    mkdirSync(d);
    for (const f of ['example-a.bin', 'example-b.txt'])
      cpSync(join(releaseDir, 'base', f), join(d, f));
    return d;
  };
  const build = async (run: Runner, d: string, id = 'example-rehearsal') => {
    const m = await run(
      [
        'manifest',
        '--dir',
        d,
        '--id',
        id,
        '--version',
        '1.0.0',
        '--licence',
        'Apache-2.0',
        '--publisher',
        'rehearsal',
      ],
      { sde: SDE },
    );
    const s = await run(['sums', '--dir', d]);
    const g = await run(['sign', '--dir', d, '--test-key', 'rfc8032-1']);
    return { m, s, g };
  };

  for (const [label, run] of [
    ['ts', runTs],
    ['bundle', runBundle],
  ] as const)
    it(`${label}: manifest, sums and sign on the two artefacts give the bytes of base/ (the oracle's output)`, async () => {
      const d = stage();
      const { m, s, g } = await build(run, d);
      expect([m.exit, s.exit, g.exit]).toEqual([0, 0, 0]);
      expect(g.stderr).toContain(TEST_KEY_SIGN_BANNER);
      expect(readFileSync(join(d, 'release-manifest.json'))).toEqual(
        readFileSync(join(releaseDir, 'base/release-manifest.json')),
      );
      expect(readFileSync(join(d, 'SHA256SUMS'))).toEqual(
        readFileSync(join(releaseDir, 'base/SHA256SUMS')),
      );
      // and the tool accepts its own output
      const v = await run([
        'verify',
        '--dir',
        d,
        '--expect-id',
        'example-rehearsal',
        '--trust-test-key',
        '--allow-test-key',
      ]);
      expect(v.exit).toBe(0);
    });

  it('the same SOURCE_DATE_EPOCH gives byte-identical files on a second run; another one changes createdAt only', async () => {
    const a = stage();
    const b = stage();
    await build(runTs, a);
    await build(runTs, b);
    for (const f of ['release-manifest.json', 'SHA256SUMS'])
      expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    const c = stage();
    await runTs(
      [
        'manifest',
        '--dir',
        c,
        '--id',
        'example-rehearsal',
        '--version',
        '1.0.0',
        '--licence',
        'Apache-2.0',
        '--publisher',
        'rehearsal',
      ],
      { sde: '1795132801' },
    );
    expect(readFileSync(join(c, 'release-manifest.json'), 'utf8')).toContain(
      '"createdAt": "2026-11-20T00:00:01Z"',
    );
  });

  it('SHA256SUMS is LF only, sorted, one line per artefact and never lists the manifest', async () => {
    const d = stage();
    await build(runTs, d);
    const bytes = readFileSync(join(d, 'SHA256SUMS'));
    expect(bytes.includes(0x0d)).toBe(false);
    const lines = bytes.toString('latin1').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines[0]!.endsWith('  example-a.bin')).toBe(true);
    expect(lines[1]!.endsWith('  example-b.txt')).toBe(true);
  });

  it('the manifest has no expiresAt (R5) and carries the rehearsal publisher and the media types', async () => {
    const d = stage();
    writeFileSync(join(d, 'pkg-1.0.0.tgz'), 'x');
    writeFileSync(join(d, 'pkg-1.0.0-py3-none-any.whl'), 'x');
    writeFileSync(join(d, 'pkg-1.0.0.crate'), 'x');
    writeFileSync(join(d, 'pkg-1.0.0.zip'), 'x');
    const r = await runTs(
      [
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
      ],
      { sde: SDE },
    );
    expect(r.exit).toBe(0);
    const m = readJson<{
      publisher: string;
      expiresAt?: string;
      entries: { id: string; mediaType: string; url: string }[];
    }>(join(d, 'release-manifest.json'));
    expect(m.publisher).toBe(REHEARSAL_PUBLISHER);
    expect('expiresAt' in m).toBe(false);
    const types = Object.fromEntries(m.entries.map((e) => [e.id, e.mediaType]));
    expect(types).toEqual({
      'example-a.bin': 'application/octet-stream',
      'example-b.txt': 'application/octet-stream',
      'pkg-1.0.0-py3-none-any.whl': 'application/zip',
      'pkg-1.0.0.crate': 'application/gzip',
      'pkg-1.0.0.tgz': 'application/gzip',
      'pkg-1.0.0.zip': 'application/zip',
    });
    expect(m.entries.every((e) => e.url === e.id)).toBe(true);
    expect(m.entries.map((e) => e.id)).toEqual([...m.entries.map((e) => e.id)].sort());
  });

  const argsFor = (d: string, over: Record<string, string | undefined> = {}): string[] => {
    const o: Record<string, string | undefined> = {
      '--dir': d,
      '--id': 'example-rehearsal',
      '--version': '1.0.0',
      '--licence': 'Apache-2.0',
      '--publisher': 'rehearsal',
      ...over,
    };
    return ['manifest', ...Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [k, v]))];
  };

  it('manifest: a release id with --publisher rehearsal is publisher_mismatch, an id of neither kind is bad_release_id', async () => {
    const d = stage();
    const a = await runTs(argsFor(d, { '--id': 'example-release' }), { sde: SDE });
    expect(a.exit).toBe(2);
    expect(firstLine(a.stderr)).toMatch(/^usage: publisher_mismatch: /);
    const b = await runTs(argsFor(d, { '--id': 'example' }), { sde: SDE });
    expect(b.exit).toBe(2);
    expect(firstLine(b.stderr)).toMatch(/^usage: bad_release_id: /);
    const c = await runTs(argsFor(d, { '--id': 'x-release\n' }), { sde: SDE });
    expect(firstLine(c.stderr)).toMatch(/^usage: bad_release_id: /);
    expect(existsSync(join(d, 'release-manifest.json'))).toBe(false);
  });

  it('manifest: an artefact name that is not lowercase or not in the entry grammar is bad_artifact_name', async () => {
    for (const name of ['Upper.tgz', '.hidden', 'sp ace.tgz', 'x'.repeat(129)]) {
      const d = stage();
      writeFileSync(join(d, name), 'x');
      const r = await runTs(argsFor(d), { sde: SDE });
      expect(r.exit, name).toBe(2);
      expect(firstLine(r.stderr), name).toMatch(/^usage: bad_artifact_name: /);
    }
  });

  it('manifest: a symlinked artefact, a subdirectory and a symlinked --dir are usage: not_regular_file', async () => {
    const a = stage();
    const real = join(fresh('real'), 'real.bin');
    writeFileSync(real, 'x');
    makeLink('file', real, join(a, 'link.bin'));
    const ra = await runTs(argsFor(a), { sde: SDE });
    expect(ra.exit).toBe(2);
    expect(firstLine(ra.stderr)).toMatch(/^usage: not_regular_file: /);
    const b = stage();
    mkdirSync(join(b, 'sub'));
    const rb = await runTs(argsFor(b), { sde: SDE });
    expect(firstLine(rb.stderr)).toMatch(/^usage: not_regular_file: /);
    const c = stage();
    const l = join(fresh('lnk'), 'dirlink');
    makeLink('dir', c, l);
    for (const argv of [
      argsFor(l),
      ['sums', '--dir', l],
      ['sign', '--dir', l, '--test-key', 'rfc8032-1'],
    ]) {
      const r = await runTs(argv, { sde: SDE });
      expect(r.exit, argv[0]).toBe(2);
      expect(firstLine(r.stderr), argv[0]).toMatch(/^usage: not_regular_file: /);
    }
    const v = await runTs([
      'verify',
      '--dir',
      l,
      '--expect-id',
      'example-rehearsal',
      '--trust-test-key',
      '--allow-test-key',
    ]);
    expect(v.exit).toBe(3);
    expect(firstLine(v.stderr)).toBe('refused: not_regular_file');
  });

  it('manifest: a symlinked release-manifest.json or SHA256SUMS in the directory is not_regular_file too', async () => {
    const d = stage();
    const real = join(fresh('real'), 'm.json');
    writeFileSync(real, '{}');
    makeLink('file', real, join(d, 'release-manifest.json'));
    const r = await runTs(argsFor(d), { sde: SDE });
    expect(r.exit).toBe(2);
    expect(firstLine(r.stderr)).toMatch(/^usage: not_regular_file: /);
  });

  it('manifest: missing or malformed options and a bad SOURCE_DATE_EPOCH are usage: bad_arguments', async () => {
    const d = stage();
    for (const argv of [
      argsFor(d, { '--version': undefined }),
      argsFor(d, { '--licence': undefined }),
      argsFor(d, { '--publisher': 'nobody' }),
      argsFor(d, { '--version': '1.0' }),
      argsFor(d, { '--version': '1.0.0+build' }),
    ]) {
      const r = await runTs(argv, { sde: SDE });
      expect(r.exit, argv.join(' ')).toBe(2);
      expect(firstLine(r.stderr)).toMatch(/^usage: bad_arguments: /);
    }
    for (const sde of ['abc', '-1', '1.5', '253402300800', '']) {
      const r = await runTs(argsFor(d), { sde });
      expect(r.exit, sde).toBe(2);
      expect(firstLine(r.stderr), sde).toMatch(/^usage: bad_arguments: .*SOURCE_DATE_EPOCH/);
    }
    const ok = await runTs(argsFor(d), { sde: '253402300799' });
    expect(ok.exit).toBe(0);
    expect(readText(join(d, 'release-manifest.json'))).toContain(
      '"createdAt": "9999-12-31T23:59:59Z"',
    );
  });

  it('manifest: an empty directory has no artefacts to list', async () => {
    const d = join(fresh('empty'), 'dir');
    mkdirSync(d);
    const r = await runTs(argsFor(d), { sde: SDE });
    expect(r.exit).toBe(2);
    expect(firstLine(r.stderr)).toMatch(/^usage: bad_arguments: .*no artefact/);
  });

  it('sums: an artefact that no longer matches its manifest entry is an error (exit 1), never a SHA256SUMS', async () => {
    const d = stage();
    await runTs(argsFor(d), { sde: SDE });
    writeFileSync(join(d, 'example-a.bin'), 'changed after the manifest was written');
    const r = await runTs(['sums', '--dir', d]);
    expect(r.exit).toBe(1);
    expect(firstLine(r.stderr)).toMatch(/^error: /);
    expect(existsSync(join(d, 'SHA256SUMS'))).toBe(false);
  });
});

describe('release-tool: sign', () => {
  const unsigned = (): string => {
    const d = join(fresh('sign'), 'dir');
    mkdirSync(d);
    for (const f of ['example-a.bin', 'example-b.txt'])
      cpSync(join(releaseDir, 'base', f), join(d, f));
    return d;
  };
  const prep = async (d: string, id: string, publisher: string) =>
    runTs(
      [
        'manifest',
        '--dir',
        d,
        '--id',
        id,
        '--version',
        '1.0.0',
        '--licence',
        'Apache-2.0',
        '--publisher',
        publisher,
      ],
      { sde: '1795132800' },
    );

  it('refuses any --test-key other than the literal rfc8032-1, a missing one, and never writes then', async () => {
    const d = unsigned();
    await prep(d, 'example-rehearsal', 'rehearsal');
    const before = listTree(d);
    for (const v of ['rfc8032-2', 'RFC8032-1', 'rfc8032-1 ', 'test1', '', '../key']) {
      const r = await runTs(['sign', '--dir', d, '--test-key', v]);
      expect(r.exit, v).toBe(2);
      expect(firstLine(r.stderr), v).toMatch(/^usage: test_key_flag_misuse: /);
    }
    const none = await runTs(['sign', '--dir', d]);
    expect(none.exit).toBe(2);
    expect(firstLine(none.stderr)).toMatch(/^usage: (test_key_flag_misuse|bad_arguments): /);
    expect(listTree(d)).toBe(before);
  });

  it('signing twice is already_signed, and the first signature is unchanged', async () => {
    const d = unsigned();
    await prep(d, 'example-rehearsal', 'rehearsal');
    const a = await runTs(['sign', '--dir', d, '--test-key', 'rfc8032-1']);
    expect(a.exit).toBe(0);
    const once = readFileSync(join(d, 'release-manifest.json'));
    const b = await runTs(['sign', '--dir', d, '--test-key', 'rfc8032-1']);
    expect(b.exit).toBe(2);
    expect(firstLine(b.stderr)).toMatch(/^usage: already_signed: /);
    expect(readFileSync(join(d, 'release-manifest.json'))).toEqual(once);
  });

  it('R1: a release id is test_key_release_id (exit 2), signed or not, and nothing is written', async () => {
    const d = unsigned();
    const m = await prep(d, 'example-release', 'release');
    expect(m.exit).toBe(0);
    const before = listTree(d);
    const r = await runTs(['sign', '--dir', d, '--test-key', 'rfc8032-1']);
    expect(r.exit).toBe(2);
    expect(firstLine(r.stderr)).toMatch(/^usage: test_key_release_id: /);
    expect(listTree(d)).toBe(before);
    for (const n of ['runtime-release', 'pagetriage-release', 'control-plane-release']) {
      const e = unsigned();
      await prep(e, n, 'release');
      const x = await runTs(['sign', '--dir', e, '--test-key', 'rfc8032-1']);
      expect(firstLine(x.stderr), n).toMatch(/^usage: test_key_release_id: /);
    }
  });

  it('sign adds exactly one ed25519 signature of TEST 1 with signedAt equal to createdAt, and writes only inside --dir', async () => {
    const d = unsigned();
    await prep(d, 'example-rehearsal', 'rehearsal');
    const parent = join(d, '..');
    const outsideBefore = readdirSync(parent).sort();
    const r = await runTs(['sign', '--dir', d, '--test-key', 'rfc8032-1']);
    expect(r.exit).toBe(0);
    expect(firstLine(r.stderr)).toBe(TEST_KEY_SIGN_BANNER);
    expect(readdirSync(parent).sort()).toEqual(outsideBefore);
    expect(readdirSync(d).sort()).toEqual([
      'example-a.bin',
      'example-b.txt',
      'release-manifest.json',
    ]);
    const m = readJson<{
      createdAt: string;
      signatures: { alg: string; keyId: string; publicKey: string; signedAt: string }[];
    }>(join(d, 'release-manifest.json'));
    expect(m.signatures).toHaveLength(1);
    expect(m.signatures[0]).toMatchObject({
      alg: 'ed25519',
      keyId: '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
      publicKey: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
      signedAt: m.createdAt,
    });
  });
});

describe('release-tool: file handling (lstat, then open, then fstat)', () => {
  it('readRegularFile refuses a symlink, a directory and a missing file with the right token or error', async () => {
    const d = fresh('fs');
    const f = join(d, 'f.txt');
    writeFileSync(f, 'hello');
    expect((await readRegularFile(f, 1024)).toString()).toBe('hello');
    const l = join(d, 'l.txt');
    makeLink('file', f, l);
    await expect(readRegularFile(l, 1024)).rejects.toMatchObject({ token: 'not_regular_file' });
    await expect(readRegularFile(d, 1024)).rejects.toMatchObject({ token: 'not_regular_file' });
    await expect(readRegularFile(join(d, 'nope'), 1024)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readRegularFile(f, 3)).rejects.toBeInstanceOf(Error);
  });

  // The swaps below must not depend on how a filesystem hands out inode numbers. Deleting a file and creating a new one at
  // its name is NOT a different identity on ext4 (the Linux runners): the freed inode is handed straight back, so device
  // and inode are equal and the check cannot tell the new file from the old one (CI run 44651017065, ubuntu-latest; APFS
  // and NTFS never reuse one that fast, which is why this passed on macOS and Windows). So the replacement is a file that
  // already exists, and stays linked while the original goes: two live files cannot share an identity on any filesystem.
  it('a file replaced by a different file between the lstat and the open is refused by the identity check on the handle', async () => {
    const d = fresh('race');
    const f = join(d, 'a.bin');
    const other = join(d, 'other.bin');
    writeFileSync(f, 'original');
    writeFileSync(other, 'substitute');
    await expect(
      readRegularFile(f, 1024, {
        afterLstat: () => {
          rmSync(f);
          renameSync(other, f); // keeps other's inode, which was live next to f's
        },
      }),
    ).rejects.toMatchObject({ token: 'not_regular_file' });
  });

  it('hashRegularFile shares the same check: a different file in the lstat/open gap is refused, never hashed', async () => {
    const d = fresh('race-hash');
    const f = join(d, 'a.bin');
    const other = join(d, 'other.bin');
    writeFileSync(f, 'original');
    writeFileSync(other, 'substitute');
    await expect(
      hashRegularFile(f, {
        afterLstat: () => {
          rmSync(f);
          renameSync(other, f);
        },
      }),
    ).rejects.toMatchObject({ token: 'not_regular_file' });
  });

  it('a file replaced by a link between the lstat and the open is refused (O_NOFOLLOW on POSIX; the identity check where a link is followed)', async () => {
    const d = fresh('race-link');
    const f = join(d, 'a.bin');
    const target = join(d, 'target.bin');
    writeFileSync(f, 'original');
    writeFileSync(target, 'substitute');
    await expect(
      readRegularFile(f, 1024, {
        afterLstat: () => {
          rmSync(f);
          makeLink('file', target, f); // a symlink, or a hard link where the OS refuses symlinks: both end in the same token
        },
      }),
    ).rejects.toMatchObject({ token: 'not_regular_file' });
  });

  // The documented boundary (README, Limitations: "not a defence against another process that can write in the release
  // directory while it runs"): identity is device and inode, so the check closes the swap of a file for a link or for
  // another live file and is not a defence against a writer that keeps the inode. An in-place
  // rewrite is that case on every platform, and it is what delete-and-recreate looks like when the filesystem reuses the
  // inode (ext4). Pinned so that nobody "fixes" the Linux result by changing the tool: the digest check against the signed
  // manifest, not this check, is what rejects changed content.
  it('identity is device and inode only: a rewrite that keeps the inode is outside the check (documented limit)', async () => {
    const d = fresh('same-inode');
    const f = join(d, 'a.bin');
    writeFileSync(f, 'original');
    const bytes = await readRegularFile(f, 1024, {
      afterLstat: () => writeFileSync(f, 'a different file'),
    });
    expect(bytes.toString()).toBe('a different file');
  });

  it('a FIFO in the directory is refused as not_regular_file (POSIX)', async () => {
    if (process.platform === 'win32') return; // no FIFOs on Windows; the symlink and junction cases cover it there
    const d = join(fresh('fifo'), 'dir');
    cpSync(join(releaseDir, 'base'), d, { recursive: true });
    execFileSync('mkfifo', [join(d, 'pipe')]);
    const r = await runTs([
      'verify',
      '--dir',
      d,
      '--expect-id',
      'example-rehearsal',
      '--trust-test-key',
      '--allow-test-key',
    ]);
    expect(r.exit).toBe(3);
    expect(firstLine(r.stderr)).toBe('refused: not_regular_file');
  });

  it('a dangling symlink in the directory is not_regular_file', async () => {
    const d = join(fresh('dangle'), 'dir');
    cpSync(join(releaseDir, 'base'), d, { recursive: true });
    try {
      symlinkSync(join(d, 'does-not-exist'), join(d, 'dangling'), 'file');
    } catch (e) {
      throw new Error(
        `cannot create a symlink (${(e as NodeJS.ErrnoException).code}); must not skip`,
      );
    }
    const r = await runTs([
      'verify',
      '--dir',
      d,
      '--expect-id',
      'example-rehearsal',
      '--trust-test-key',
      '--allow-test-key',
    ]);
    expect(r.exit).toBe(3);
    expect(firstLine(r.stderr)).toBe('refused: not_regular_file');
  });

  it('ReleaseStop carries its token', () => {
    const e = new ReleaseStop('not_regular_file', 'x');
    expect(e.token).toBe('not_regular_file');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('release-tool: the release-keys file (strict scan)', () => {
  const keys = (n: string): string => readText(join(releaseDir, 'keys', n));
  const rejects = (text: string) => {
    try {
      parseReleaseKeys(text);
    } catch (e) {
      return (e as { token?: string; reason?: string }).token ?? (e as { reason?: string }).reason;
    }
    return 'accepted';
  };

  it('the vector key file parses to one key; every refusal file gives its token', () => {
    const ok = parseReleaseKeys(keys('vector-key.json'));
    expect(ok).toHaveLength(1);
    expect(ok[0]!.raw).toHaveLength(32);
    expect(rejects(keys('empty.json'))).toBe('no_trusted_key');
    expect(rejects(keys('test-key.json'))).toBe('test_key_refused');
    expect(rejects(keys('weak.json'))).toBe('weak_key_refused');
    for (const f of ['duplicate-member', 'keyid-mismatch', 'duplicate-keyid', 'too-many'])
      expect(rejects(keys(`${f}.json`)), f).toBe('bad_release_keys');
  });

  it('a test key is refused before a keyId mismatch is looked at (test and weak keys first)', () => {
    const t = JSON.parse(keys('test-key.json')) as { keys: { keyId: string }[] };
    t.keys[0]!.keyId = 'f'.repeat(64);
    expect(rejects(JSON.stringify(t))).toBe('test_key_refused');
    const w = JSON.parse(keys('weak.json')) as { keys: { keyId: string }[] };
    w.keys[0]!.keyId = 'f'.repeat(64);
    expect(rejects(JSON.stringify(w))).toBe('weak_key_refused');
  });

  it('shape: unknown or missing members, a wrong spec, a non-array, floats, lone surrogates and bad encodings are bad_release_keys', () => {
    const good = JSON.parse(keys('vector-key.json')) as {
      spec: string;
      keys: { keyId: string; publicKey: string }[];
    };
    const variants: unknown[] = [
      { ...good, extra: 1 },
      { spec: good.spec },
      { keys: good.keys },
      { ...good, spec: 'airplanemode.release-keys/0.2' },
      { ...good, keys: {} },
      { ...good, keys: [{ ...good.keys[0], extra: 'x' }] },
      { ...good, keys: [{ keyId: good.keys[0]!.keyId }] },
      { ...good, keys: [{ ...good.keys[0], publicKey: 5 }] },
      { ...good, keys: [{ ...good.keys[0], publicKey: 'AAAA' }] },
      { ...good, keys: [{ ...good.keys[0], publicKey: good.keys[0]!.publicKey.slice(0, -1) }] },
      {
        ...good,
        keys: [{ ...good.keys[0], publicKey: good.keys[0]!.publicKey.replace(/=$/, 'A') }],
      },
      [],
      'text',
      null,
    ];
    for (const v of variants)
      expect(rejects(JSON.stringify(v)), JSON.stringify(v)).toBe('bad_release_keys');
    for (const t of ['', '{', 'not json', '{"spec":1.5,"keys":[]}', '{"spec":"\\ud800","keys":[]}'])
      expect(rejects(t), t).toBe('bad_release_keys');
  });

  it('a non-canonical base64 spelling of a key is refused (one accepted encoding per key)', () => {
    const good = JSON.parse(keys('vector-key.json')) as {
      spec: string;
      keys: { keyId: string; publicKey: string }[];
    };
    const pk = good.keys[0]!.publicKey;
    // flip the unused low bits of the last data character: the same 32 bytes under another spelling
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = pk[42]!;
    const other = alphabet[(alphabet.indexOf(last) + 1) % 64]!;
    const spelled = `${pk.slice(0, 42)}${other}=`;
    expect(Buffer.from(spelled, 'base64').equals(Buffer.from(pk, 'base64'))).toBe(true);
    good.keys[0]!.publicKey = spelled;
    expect(rejects(JSON.stringify(good))).toBe('bad_release_keys');
  });
});

describe('release-tool: post-verify checks (a) and (b) as an internal function', () => {
  const TEST1_ID = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';
  const TEST1_RAW = Buffer.from(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'hex',
  );
  const other = createHash('sha256').update('airplanemode release vector: some other key').digest();
  const otherId = createHash('sha256').update(other).digest('hex');
  const m = (id: string, publisher: string) => ({ id, publisher });
  const REL = 'Airplane Mode Labs';

  it('(a) a test key that verified a manifest whose id is not a rehearsal id is test_key_release_id', () => {
    expect(postVerifyChecks(m('runtime-release', REL), [{ keyId: TEST1_ID, raw: TEST1_RAW }])).toBe(
      'test_key_release_id',
    );
    expect(postVerifyChecks(m('example-release', REL), [{ keyId: TEST1_ID, raw: TEST1_RAW }])).toBe(
      'test_key_release_id',
    );
    // recognised by its bytes under another keyId as well
    expect(postVerifyChecks(m('runtime-release', REL), [{ keyId: otherId, raw: TEST1_RAW }])).toBe(
      'test_key_release_id',
    );
    // and by its keyId alone
    expect(
      postVerifyChecks(m('runtime-release', REL), [{ keyId: TEST1_ID, raw: new Uint8Array(32) }]),
    ).toBe('test_key_release_id');
  });

  it('(a) comes before (b): a test key on a release id with the wrong publisher is still test_key_release_id', () => {
    expect(
      postVerifyChecks(m('runtime-release', REHEARSAL_PUBLISHER), [
        { keyId: TEST1_ID, raw: TEST1_RAW },
      ]),
    ).toBe('test_key_release_id');
  });

  it('(b) the publisher must match the id suffix, for any key', () => {
    const k = [{ keyId: otherId, raw: other }];
    expect(postVerifyChecks(m('runtime-release', REL), k)).toBeUndefined();
    expect(postVerifyChecks(m('runtime-release', REHEARSAL_PUBLISHER), k)).toBe(
      'publisher_mismatch',
    );
    expect(postVerifyChecks(m('runtime-rehearsal', REHEARSAL_PUBLISHER), k)).toBeUndefined();
    expect(postVerifyChecks(m('runtime-rehearsal', REL), k)).toBe('publisher_mismatch');
    expect(postVerifyChecks(m('runtime-rehearsal', ''), k)).toBe('publisher_mismatch');
    expect(postVerifyChecks(m('some-other-id', REL), k)).toBe('publisher_mismatch');
  });

  it('a test key on a rehearsal id with the rehearsal publisher passes both checks', () => {
    expect(
      postVerifyChecks(m('runtime-rehearsal', REHEARSAL_PUBLISHER), [
        { keyId: TEST1_ID, raw: TEST1_RAW },
      ]),
    ).toBeUndefined();
  });
});

describe('release-tool: more refusals and errors (both entries)', () => {
  const REHEARSE = ['--trust-test-key', '--allow-test-key', '--expect-id', 'example-rehearsal'];
  const copyBase = (): string => {
    const d = join(fresh('more'), 'dir');
    cpSync(join(releaseDir, 'base'), d, { recursive: true });
    return d;
  };

  for (const [label, run] of [
    ['ts', runTs],
    ['bundle', runBundle],
  ] as const) {
    it(`${label}: a missing manifest and a missing SHA256SUMS are refusals of their own`, async () => {
      const a = copyBase();
      rmSync(join(a, 'release-manifest.json'));
      const ra = await run(['verify', '--dir', a, ...REHEARSE]);
      expect(ra.exit).toBe(3);
      expect(firstLine(ra.stderr)).toBe('refused: manifest_missing');
      const b = copyBase();
      rmSync(join(b, 'SHA256SUMS'));
      const rb = await run(['verify', '--dir', b, ...REHEARSE]);
      expect(rb.exit).toBe(3);
      expect(firstLine(rb.stderr)).toBe('refused: sums_missing');
    });

    it(`${label}: a manifest that is not JSON, or repeats a member, is refused with the manifest reason (invalid_json)`, async () => {
      const a = copyBase();
      writeFileSync(join(a, 'release-manifest.json'), '{ not json');
      const ra = await run(['verify', '--dir', a, ...REHEARSE]);
      expect(ra.exit).toBe(3);
      expect(firstLine(ra.stderr)).toBe('refused: invalid_json');
      const b = copyBase();
      const text = readFileSync(join(b, 'release-manifest.json'), 'utf8');
      writeFileSync(
        join(b, 'release-manifest.json'),
        text.replace('"version": "1.0.0",', '"version": "1.0.0",\n  "version": "9.9.9",'),
      );
      const rb = await run(['verify', '--dir', b, ...REHEARSE]);
      expect(rb.exit).toBe(3);
      expect(firstLine(rb.stderr)).toBe('refused: invalid_json');
    });

    it(`${label}: a missing trust file is an I/O error (exit 1); a symlinked trust file is not_regular_file (exit 3)`, async () => {
      const d = copyBase();
      const missing = await run([
        'verify',
        '--dir',
        d,
        '--expect-id',
        'example-rehearsal',
        '--trust-file',
        join(fresh('k'), 'nope.json'),
      ]);
      expect(missing.exit).toBe(1);
      expect(firstLine(missing.stderr)).toMatch(/^error: /);
      const real = join(releaseDir, 'keys/vector-key.json');
      const link = join(fresh('k'), 'link.json');
      makeLink('file', real, link);
      const linked = await run([
        'verify',
        '--dir',
        d,
        '--expect-id',
        'example-rehearsal',
        '--trust-file',
        link,
      ]);
      expect(linked.exit).toBe(3);
      expect(firstLine(linked.stderr)).toBe('refused: not_regular_file');
    });

    it(`${label}: a manifest with an expiresAt in the past is refused as expired unless --now is earlier (a manifest reason passes through)`, async () => {
      const d = copyBase();
      const m = JSON.parse(readFileSync(join(d, 'release-manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      // an expiry is not what a release manifest carries (R5), but the verdict of the library passes through unchanged
      m['expiresAt'] = '2026-12-01T00:00:00Z';
      writeFileSync(join(d, 'release-manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
      // the signature no longer covers the body: the first refusal is the signature, which comes after expiry in the order
      const r = await run(['verify', '--dir', d, ...REHEARSE, '--now', '2030-01-01T00:00:00Z']);
      expect(r.exit).toBe(3);
      expect(firstLine(r.stderr)).toBe('refused: expired');
    });
  }
});
