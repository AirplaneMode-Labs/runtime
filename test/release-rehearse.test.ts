// Sprint 7, D1-03 (B1, B2): scripts/release/rehearse.mjs and publish-dry-run.mjs. The refusal proofs check the exact
// exit code, the exact first stderr line and the JSON reason; an I/O error, a crash, a signal or a missing tool is
// never a refusal; a self-test points the script at tools that lie and expects it to go red. The full rehearsal (npm
// ci, build, pack, a clean install, the proofs) is the CI job release-rehearsal (<os>) and `npm run release:rehearse`.
// Written before the scripts existed; the red run is D1/red/D1-03-*.log in the sprint scratch.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { readText, repoDir } from './helpers';
// @ts-expect-error: plain ESM script
import * as rehearse from '../scripts/release/rehearse.mjs';
// @ts-expect-error: plain ESM script
import { distTagFor } from '../scripts/release/publish-dry-run.mjs';

const tool = resolve(repoDir, 'spec/tools/release-tool.mjs');
const docsKeys = resolve(repoDir, 'docs/release-keys.json');
const SDE = '1795132800';

const tmpRoot = mkdtempSync(join(tmpdir(), 'amt-rehearse-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string): string => {
  const d = join(tmpRoot, `${label}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** A signed rehearsal directory made with the REAL tool: the id runtime-rehearsal, one synthetic artefact. */
function signedDir(): string {
  const d = fresh('signed');
  writeFileSync(join(d, 'airplanemode-runtime-0.0.0-test.tgz'), 'synthetic tarball bytes\n');
  for (const args of [
    [
      'manifest',
      '--dir',
      d,
      '--id',
      'runtime-rehearsal',
      '--version',
      '0.0.0',
      '--licence',
      'Apache-2.0',
      '--publisher',
      'rehearsal',
    ],
    ['sums', '--dir', d],
    ['sign', '--dir', d, '--test-key', 'rfc8032-1'],
  ]) {
    const r = spawnSync(process.execPath, [tool, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', SOURCE_DATE_EPOCH: SDE },
    });
    if (r.status !== 0) throw new Error(`fixture: ${args[0]} failed: ${r.stderr}`);
  }
  return d;
}

const fakeRun = (over: Record<string, unknown>) => ({
  error: undefined,
  signal: null,
  status: 0,
  stdout: '',
  stderr: '',
  ...over,
});

describe('expectOutcome: only the exact outcome counts', () => {
  const eo = rehearse.expectOutcome as (
    name: string,
    r: Record<string, unknown>,
    want: Record<string, unknown>,
  ) => unknown;

  it('accepts exit 3 with the exact first line and the exact JSON reason', () => {
    expect(() =>
      eo(
        'x',
        fakeRun({
          status: 3,
          stderr: 'refused: test_key_refused\nmore\n',
          stdout: '{"verdict":"refused","reason":"test_key_refused"}\n',
        }),
        { exit: 3, reason: 'test_key_refused' },
      ),
    ).not.toThrow();
  });

  it('refuses an I/O error (exit 1) that prints a refusal-looking message', () => {
    expect(() =>
      eo(
        'x',
        fakeRun({
          status: 1,
          stderr: 'refused: test_key_refused\n',
          stdout: '{"verdict":"refused","reason":"test_key_refused"}\n',
        }),
        { exit: 3, reason: 'test_key_refused' },
      ),
    ).toThrow(/exit 1, expected 3/);
  });

  it('refuses a crash, a signal and a missing tool', () => {
    expect(() =>
      eo('x', fakeRun({ error: { code: 'ENOENT' }, status: null }), { exit: 3, reason: 'a' }),
    ).toThrow(/could not be run/);
    expect(() =>
      eo('x', fakeRun({ signal: 'SIGKILL', status: null }), { exit: 3, reason: 'a' }),
    ).toThrow(/killed by SIGKILL/);
  });

  it('refuses the wrong first line, the wrong JSON reason and a usage error that prints to stdout', () => {
    expect(() =>
      eo(
        'x',
        fakeRun({
          status: 3,
          stderr: 'refused: other\n',
          stdout: '{"verdict":"refused","reason":"a"}',
        }),
        {
          exit: 3,
          reason: 'a',
        },
      ),
    ).toThrow(/first stderr line/);
    expect(() =>
      eo(
        'x',
        fakeRun({
          status: 3,
          stderr: 'refused: a\n',
          stdout: '{"verdict":"refused","reason":"b"}',
        }),
        {
          exit: 3,
          reason: 'a',
        },
      ),
    ).toThrow(/stdout JSON/);
    expect(() =>
      eo('x', fakeRun({ status: 2, stderr: 'usage: a: msg\n', stdout: 'noise' }), {
        exit: 2,
        reason: 'a',
      }),
    ).toThrow(/nothing on stdout/);
    expect(() =>
      eo('x', fakeRun({ status: 2, stderr: 'usage: b: msg\n' }), { exit: 2, reason: 'a' }),
    ).toThrow(/first stderr line/);
  });

  it('exit 0 checks the JSON members it is given', () => {
    expect(() =>
      eo('x', fakeRun({ status: 0, stdout: '{"verdict":"ok","testKey":true}' }), {
        exit: 0,
        ok: { verdict: 'ok', testKey: true },
      }),
    ).not.toThrow();
    expect(() =>
      eo('x', fakeRun({ status: 0, stdout: '{"verdict":"ok","testKey":false}' }), {
        exit: 0,
        ok: { verdict: 'ok', testKey: true },
      }),
    ).toThrow(/testKey/);
  });
});

describe('proveRefusals against the real tool', () => {
  it('every proof holds and each record carries the exact first stderr line', () => {
    const dir = signedDir();
    const records = rehearse.proveRefusals({
      tool,
      dir,
      docsKeys,
      work: fresh('proofs'),
      sde: SDE,
    }) as { name: string; exit: number; firstStderrLine: string; reason: string | null }[];
    expect(records.length).toBeGreaterThanOrEqual(9);
    const byName = new Map(records.map((r) => [r.name, r]));
    expect(byName.get('the test key without the flag is refused')).toMatchObject({
      exit: 3,
      firstStderrLine: 'refused: test_key_refused',
    });
    expect(byName.get('docs/release-keys.json does not trust the rehearsal')).toMatchObject({
      exit: 3,
      firstStderrLine: 'refused: no_trusted_key',
    });
    expect(byName.get('the test-key flag with a release id is a usage error')?.exit).toBe(2);
    expect(byName.get('a changed artefact is refused')?.firstStderrLine).toBe(
      'refused: artifact_hash_mismatch',
    );
    expect(byName.get('a changed SHA256SUMS is refused')?.firstStderrLine).toBe(
      'refused: sums_mismatch',
    );
    expect(byName.get('an edited manifest is refused')?.firstStderrLine).toBe(
      'refused: no_valid_signature',
    );
    expect(byName.get('the test key cannot sign a release id (R1)')?.exit).toBe(2);
  });

  it('with a release key in docs/release-keys.json the proof expects no_valid_signature instead', () => {
    const dir = signedDir();
    const keys = fresh('keys');
    // an ephemeral public key: valid, in the prime-order subgroup, and not an RFC 8032 test key
    const spki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    const pub = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
    const keyId = createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex');
    const f = join(keys, 'release-keys.json');
    writeFileSync(
      f,
      JSON.stringify({ spec: 'airplanemode.release-keys/0.1', keys: [{ keyId, publicKey: pub }] }),
    );
    const records = rehearse.proveRefusals({
      tool,
      dir,
      docsKeys: f,
      work: fresh('proofs'),
      sde: SDE,
    }) as {
      name: string;
      firstStderrLine: string;
    }[];
    expect(
      records.find((r) => r.name === 'docs/release-keys.json does not trust the rehearsal')
        ?.firstStderrLine,
    ).toBe('refused: no_valid_signature');
  });
});

describe('the self-test: tools that lie turn the proofs red', () => {
  it('a missing tool, an accept-everything tool, an exit-1 look-alike, a signalled tool and a wrong first line all go red', () => {
    const work = fresh('selftest');
    const results = rehearse.selfTest({
      realTool: tool,
      makeDir: signedDir,
      docsKeys,
      work,
    }) as string[];
    expect(results).toHaveLength(6);
    expect(results.slice(0, 5).every((r) => r.endsWith('red, as it must be'))).toBe(true);
    expect(results[5]).toBe('the real tool: green');
  });

  it('node scripts/release/rehearse.mjs --self-test exits 0 and says so', () => {
    const r = spawnSync(
      process.execPath,
      [resolve(repoDir, 'scripts/release/rehearse.mjs'), '--self-test', '--work', fresh('st')],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
        },
        timeout: 120_000,
      },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('self-test: a missing tool: red, as it must be');
    expect(r.stdout).toContain('self-test: the real tool: green');
  });

  it('pointing the rehearsal at a missing tool exits non-zero before it builds or clears anything', () => {
    const out = join(fresh('out'), 'dist-release');
    const r = spawnSync(
      process.execPath,
      [
        resolve(repoDir, 'scripts/release/rehearse.mjs'),
        '--tool',
        join(fresh('t'), 'no-such-release-tool.mjs'),
        '--out',
        out,
        '--report',
        join(fresh('r'), 'dist-release-report'),
        '--work',
        fresh('w'),
      ],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' }, timeout: 60_000 },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/release tool is missing/);
    expect(existsSync(out)).toBe(false);
  });

  it('the report directory may not be inside the release directory, and --work may not be inside the checkout', async () => {
    const base = fresh('dirs');
    const out = join(base, 'dist-release');
    await expect(
      rehearse.main([
        '--out',
        out,
        '--report',
        join(out, 'dist-release-report'),
        '--work',
        fresh('w'),
      ]),
    ).rejects.toThrow(/report directory must not be inside/);
    await expect(
      rehearse.main([
        '--out',
        out,
        '--report',
        join(base, 'dist-release-report'),
        '--work',
        repoDir,
      ]),
    ).rejects.toThrow(/--work must be outside the checkout/);
    expect(existsSync(out)).toBe(false);
    // a refused --work creates nothing in the checkout (it once left an empty directory per run)
    expect(
      readdirSync(repoDir).filter((n) => n.startsWith('airplanemode-runtime-rehearsal-')),
    ).toEqual([]);
  });
});

describe('assertReleaseDirectoryClean', () => {
  const clean = rehearse.assertReleaseDirectoryClean as (dir: string) => string[];
  it('accepts the signed directory: the artefact, the manifest and SHA256SUMS', () => {
    expect(clean(signedDir())).toEqual([
      'SHA256SUMS',
      'airplanemode-runtime-0.0.0-test.tgz',
      'release-manifest.json',
    ]);
  });
  it('refuses credential-like names, a stray file, a directory, a missing file and a CRLF SHA256SUMS', () => {
    for (const name of [
      '.npmrc',
      '.pypirc',
      'a.pem',
      'a.key',
      'a.der',
      'a.pkcs8',
      'my-seed.txt',
      'stray.txt',
    ]) {
      const d = signedDir();
      writeFileSync(join(d, name), 'x');
      expect(() => clean(d), name).toThrow();
    }
    const sub = signedDir();
    mkdirSync(join(sub, 'subdir'));
    expect(() => clean(sub)).toThrow(/not a regular file/);
    const missing = signedDir();
    rmSync(join(missing, 'SHA256SUMS'));
    expect(() => clean(missing)).toThrow();
    const crlf = signedDir();
    writeFileSync(
      join(crlf, 'SHA256SUMS'),
      readFileSync(join(crlf, 'SHA256SUMS'), 'latin1').replace(/\n/g, '\r\n'),
      'latin1',
    );
    expect(() => clean(crlf)).toThrow(/CR/);
  });
});

describe('publish-dry-run: the dist-tag', () => {
  const tag = distTagFor as (v: string) => string;
  it('alpha, beta and rc give their own tag, a plain version gives latest', () => {
    expect(tag('0.3.0-beta.2')).toBe('beta');
    expect(tag('0.4.0-alpha.1')).toBe('alpha');
    expect(tag('1.0.0-rc.1')).toBe('rc');
    expect(tag('1.0.0')).toBe('latest');
  });
  it('any other prerelease identifier, build metadata and non-SemVer are refused', () => {
    for (const v of ['0.4.0-dev', '1.0.0-foo.1', '1.0.0+build', '1.0', 'v1.0.0', ''])
      expect(() => tag(v), v).toThrow();
  });
});

describe('the scripts hold no real key and read no runner variable', () => {
  for (const f of ['scripts/release/rehearse.mjs', 'scripts/release/publish-dry-run.mjs']) {
    it(`${f}: no GITHUB_SHA or GITHUB_REF read, no cp-sign, no key file, no allow flag from the environment`, () => {
      const code = readText(resolve(repoDir, f))
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      expect(code).not.toMatch(/process\.env(\.|\[['"])GITHUB_/);
      expect(code).not.toMatch(/cp-sign|key\.secret|PRIVATE KEY/);
      expect(code).not.toMatch(/process\.env(\.|\[['"])[A-Z_]*(ALLOW|TEST_KEY)/i);
      expect(code).not.toMatch(/--key['"]/);
    });
  }

  it('docs/release-keys.json is committed with keys []', () => {
    expect(JSON.parse(readText(resolve(repoDir, 'docs/release-keys.json')))).toEqual({
      spec: 'airplanemode.release-keys/0.1',
      keys: [],
    });
  });

  it('.gitignore holds dist-release/ and dist-release-report/', () => {
    const g = readText(resolve(repoDir, '.gitignore')).split('\n');
    expect(g).toContain('dist-release/');
    expect(g).toContain('dist-release-report/');
  });

  it('package.json has the two scripts', () => {
    const pkg = JSON.parse(readText(resolve(repoDir, 'package.json'))) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['release:rehearse']).toBe('node scripts/release/rehearse.mjs');
    expect(pkg.scripts['spec:release-tool']).toContain('tsup --config tsup.release-tool.config.ts');
  });
});
