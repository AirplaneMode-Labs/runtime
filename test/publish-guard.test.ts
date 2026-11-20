// Fix round 1, TD-125 and S1-130: scripts/release/publish-guard.mjs holds the publish job's decisions that are easy to get
// wrong in shell: the strict SemVer check before a version reaches GITHUB_ENV, the tag-to-commit binding (a lightweight tag,
// an annotated tag dereferenced, a mismatch refused, GITHUB_REF never used) and the no-expiresAt rule for release manifests
// (TD-121 / R5). The registry and GitHub are injected, so nothing here touches a network.
//
// Fix round 2 (BUG-T3-S7-17): the lock-6 comparison (RELEASE_KEY_ID equals the single committed key), the registry-absent
// check (npm view must answer E404) and the exactly-one-tarball check moved out of inline shell and node in publish.yml
// into the subcommands key-id, registry-absent and tarball, so that each is unit-tested for its behaviour here and the
// workflow only has to call them (test/workflows-release.test.ts pins the calls).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEMVER_PATTERN } from '../spec/manifest';
import {
  GUARD_SEMVER_SOURCE,
  assertStrictSemver,
  assertTagResolvesTo,
  assertNoExpiresAt,
  resolveTagCommit,
  guardMain,
  NPM_REGISTRY,
  RELEASE_KEYS_SPEC,
  assertReleaseKeyId,
  assertRegistryAbsent,
  npmViewArgs,
  selectTarball,
  // @ts-expect-error: plain ESM script
} from '../scripts/release/publish-guard.mjs';
import { makeLink, repoDir } from './helpers';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJ = 'c'.repeat(40);

type Api = (path: string) => unknown;
const apiFor = (table: Record<string, unknown>): Api => {
  return (path: string) => {
    if (!(path in table)) throw new Error(`unexpected api path ${path}`);
    return table[path];
  };
};

describe('publish-guard: strict SemVer before GITHUB_ENV', () => {
  it('uses the very pattern of spec/manifest.ts', () => {
    expect(GUARD_SEMVER_SOURCE).toBe(SEMVER_PATTERN);
  });
  it('accepts plain, prerelease versions and refuses build metadata, leading zeros, newlines and injection', () => {
    for (const v of ['0.3.0-beta.2', '1.0.0', '1.0.0-rc.1', '10.20.30'])
      expect(() => assertStrictSemver(v), v).not.toThrow();
    for (const v of [
      '1.0.0+build',
      '01.0.0',
      '1.0',
      '1.0.0\n',
      '1.0.0\nEVIL=1',
      '1.0.0 ',
      '',
      'v1.0.0',
      '1.0.0-beta.2\r',
    ])
      expect(() => assertStrictSemver(v), JSON.stringify(v)).toThrow(/SemVer/);
  });
});

describe('publish-guard: the tag v<version> resolves to the commit the run builds', () => {
  const lightweight = apiFor({
    'git/ref/tags/v1.2.3': { object: { type: 'commit', sha: SHA } },
  });
  const annotated = apiFor({
    'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
    [`git/tags/${TAG_OBJ}`]: { object: { type: 'commit', sha: SHA } },
  });

  it('a lightweight tag at the commit passes', () => {
    expect(resolveTagCommit('1.2.3', lightweight)).toBe(SHA);
    expect(() => assertTagResolvesTo('1.2.3', SHA, lightweight)).not.toThrow();
  });
  it('an annotated tag is dereferenced to its commit and passes', () => {
    expect(resolveTagCommit('1.2.3', annotated)).toBe(SHA);
    expect(() => assertTagResolvesTo('1.2.3', SHA, annotated)).not.toThrow();
  });
  it('a tag at another commit is refused, lightweight and annotated', () => {
    expect(() => assertTagResolvesTo('1.2.3', OTHER, lightweight)).toThrow(/not at/);
    expect(() => assertTagResolvesTo('1.2.3', OTHER, annotated)).toThrow(/not at/);
  });
  it('an annotated tag whose object is not a commit (a tag of a tree or of another tag chain) is refused', () => {
    const tree = apiFor({
      'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
      [`git/tags/${TAG_OBJ}`]: { object: { type: 'tree', sha: SHA } },
    });
    expect(() => assertTagResolvesTo('1.2.3', SHA, tree)).toThrow();
    const loop = apiFor({
      'git/ref/tags/v1.2.3': { object: { type: 'tag', sha: TAG_OBJ } },
      [`git/tags/${TAG_OBJ}`]: { object: { type: 'tag', sha: TAG_OBJ } },
    });
    expect(() => assertTagResolvesTo('1.2.3', SHA, loop)).toThrow();
  });
  it('a missing tag (the api throws) is refused, never passed', () => {
    const missing: Api = () => {
      throw new Error('HTTP 404');
    };
    expect(() => assertTagResolvesTo('1.2.3', SHA, missing)).toThrow();
  });
  it('a malformed answer or a malformed expected commit is refused', () => {
    expect(() =>
      assertTagResolvesTo('1.2.3', SHA, apiFor({ 'git/ref/tags/v1.2.3': {} })),
    ).toThrow();
    expect(() => assertTagResolvesTo('1.2.3', 'not-a-sha', lightweight)).toThrow(/commit/);
    expect(() => assertTagResolvesTo('1.2.3', SHA.toUpperCase(), lightweight)).toThrow(/commit/);
    expect(() => assertTagResolvesTo('1.2.3+x', SHA, lightweight)).toThrow(/SemVer/);
  });
  it('the guard never reads GITHUB_REF, GITHUB_REF_NAME or any ref from the environment', () => {
    const src = readFileSync(resolve(repoDir, 'scripts/release/publish-guard.mjs'), 'utf8');
    expect(src).not.toMatch(/GITHUB_REF/);
    expect(src).not.toMatch(/process\.env/);
  });
  it('guardMain tag-sha takes the commit from its arguments only and returns 1 on a mismatch', () => {
    const io = { out: '', err: '' };
    const ctx = {
      api: annotated,
      stdout: (s: string) => (io.out += s),
      stderr: (s: string) => (io.err += s),
    };
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', SHA, '--repo', 'o/r'], ctx)).toBe(0);
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', OTHER, '--repo', 'o/r'], ctx)).toBe(1);
    expect(io.err).toMatch(/not at/);
    expect(guardMain(['tag', '--version', '1.2.3'], ctx)).toBe(2);
    expect(guardMain(['tag', '--version', '1.2.3', '--sha', SHA, '--repo', 'bad repo!'], ctx)).toBe(
      2,
    );
    expect(guardMain(['bogus'], ctx)).toBe(2);
  });
});

describe('publish-guard: a release manifest carries no expiresAt (TD-121, R5)', () => {
  it('passes without the member and refuses with it, even when null or empty', () => {
    expect(() => assertNoExpiresAt('{"id":"x-release","entries":[]}')).not.toThrow();
    for (const v of ['"2027-01-01T00:00:00Z"', 'null', '""', '0'])
      expect(() => assertNoExpiresAt(`{"id":"x-release","expiresAt":${v}}`), v).toThrow(
        /expiresAt/,
      );
  });
  it('a manifest that is not a JSON object is refused', () => {
    for (const t of ['[]', 'null', '"x"', '{', '']) expect(() => assertNoExpiresAt(t), t).toThrow();
  });
  it('guardMain no-expiry reads the file given and exits 1 on a manifest with expiresAt', () => {
    const files: Record<string, string> = {
      'ok.json': '{"id":"x-release"}',
      'bad.json': '{"id":"x-release","expiresAt":"2027-01-01T00:00:00Z"}',
    };
    const ctx = {
      api: () => ({}),
      readFile: (p: string) => files[p] ?? '',
      stdout: () => {},
      stderr: () => {},
    };
    expect(guardMain(['no-expiry', '--file', 'ok.json'], ctx)).toBe(0);
    expect(guardMain(['no-expiry', '--file', 'bad.json'], ctx)).toBe(1);
    expect(guardMain(['no-expiry'], ctx)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 2 (BUG-T3-S7-17): lock 6, the registry-absent check and the exactly-one-tarball check, as tested behaviour.
// ---------------------------------------------------------------------------------------------------------------------

const vectorKeys = readFileSync(
  resolve(repoDir, 'spec/vectors/release/keys/vector-key.json'),
  'utf8',
);
const vectorKey = (JSON.parse(vectorKeys) as { keys: { keyId: string; publicKey: string }[] })
  .keys[0]!;
const keysFile = (keys: unknown[], spec: string = RELEASE_KEYS_SPEC): string =>
  JSON.stringify({ spec, keys });

describe('publish-guard key-id (lock 6): RELEASE_KEY_ID equals the single key committed in docs/release-keys.json', () => {
  it('the vector key is a real key: its keyId is the SHA-256 of its raw public key', () => {
    const raw = Buffer.from(vectorKey.publicKey, 'base64');
    expect(raw.length).toBe(32);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(vectorKey.keyId);
  });

  it('a match passes (the file as committed by the owner: one key, the variable set to its keyId)', () => {
    expect(() => assertReleaseKeyId(keysFile([vectorKey]), vectorKey.keyId)).not.toThrow();
    expect(() => assertReleaseKeyId(vectorKeys, vectorKey.keyId)).not.toThrow();
  });

  it('a mismatch is refused: another well-formed key id, one hex digit off, upper case, empty, short, long, padded with a newline', () => {
    const other = 'e'.repeat(64);
    expect(() => assertReleaseKeyId(keysFile([vectorKey]), other)).toThrow(/does not equal/);
    const flipped = `${vectorKey.keyId.slice(0, 63)}${vectorKey.keyId.endsWith('0') ? '1' : '0'}`;
    expect(() => assertReleaseKeyId(keysFile([vectorKey]), flipped)).toThrow(/does not equal/);
    for (const id of [
      vectorKey.keyId.toUpperCase(),
      '',
      vectorKey.keyId.slice(0, 63),
      `${vectorKey.keyId}0`,
      `${vectorKey.keyId}\n`,
      ` ${vectorKey.keyId}`,
      undefined,
    ])
      expect(() => assertReleaseKeyId(keysFile([vectorKey]), id), JSON.stringify(id)).toThrow(
        /64 lowercase hex/,
      );
  });

  it('zero keys is refused, whatever the variable says (the file committed today has keys: [])', () => {
    expect(() => assertReleaseKeyId(keysFile([]), vectorKey.keyId)).toThrow(/exactly one key/);
    const committed = readFileSync(resolve(repoDir, 'docs/release-keys.json'), 'utf8');
    expect(() => assertReleaseKeyId(committed, vectorKey.keyId)).toThrow(/exactly one key/);
  });

  it('two keys is refused even when the variable names one of them', () => {
    const second = { keyId: 'd'.repeat(64), publicKey: vectorKey.publicKey };
    expect(() => assertReleaseKeyId(keysFile([vectorKey, second]), vectorKey.keyId)).toThrow(
      /exactly one key/,
    );
    expect(() => assertReleaseKeyId(keysFile([second, vectorKey]), vectorKey.keyId)).toThrow(
      /exactly one key/,
    );
  });

  it('a malformed file is refused: not JSON, not an object, wrong spec, missing or extra members, a key with the wrong shape', () => {
    const id = vectorKey.keyId;
    for (const text of [
      '',
      '{',
      '[]',
      'null',
      '"x"',
      '{}',
      '{"spec":"airplanemode.release-keys/0.1"}',
      '{"keys":[]}',
      JSON.stringify({ spec: 'airplanemode.release-keys/0.2', keys: [vectorKey] }),
      JSON.stringify({ spec: RELEASE_KEYS_SPEC, keys: 'x' }),
      JSON.stringify({ spec: RELEASE_KEYS_SPEC, keys: [vectorKey], extra: 1 }),
      keysFile(['x']),
      keysFile([null]),
      keysFile([{ keyId: id }]),
      keysFile([{ publicKey: vectorKey.publicKey }]),
      keysFile([{ ...vectorKey, extra: 1 }]),
      keysFile([{ keyId: 1, publicKey: vectorKey.publicKey }]),
      keysFile([{ keyId: id, publicKey: 1 }]),
    ])
      expect(() => assertReleaseKeyId(text, id), text.slice(0, 60)).toThrow();
  });

  it('a key whose keyId is not the SHA-256 of its publicKey, or whose publicKey is not canonical padded base64 of 32 bytes, is refused', () => {
    const lie = { keyId: 'a'.repeat(64), publicKey: vectorKey.publicKey };
    expect(() => assertReleaseKeyId(keysFile([lie]), lie.keyId)).toThrow(/SHA-256/);
    const unpadded = { keyId: vectorKey.keyId, publicKey: vectorKey.publicKey.replace(/=+$/, '') };
    expect(() => assertReleaseKeyId(keysFile([unpadded]), vectorKey.keyId)).toThrow(/canonical/);
    const short = {
      keyId: vectorKey.keyId,
      publicKey: Buffer.alloc(31, 7).toString('base64'),
    };
    expect(() => assertReleaseKeyId(keysFile([short]), vectorKey.keyId)).toThrow(/canonical/);
  });

  it('guardMain key-id: exit 0 on a match, 1 on every refusal, 2 on a usage error; the id is an argument, never read from the environment', () => {
    const files: Record<string, string> = {
      'ok.json': keysFile([vectorKey]),
      'none.json': keysFile([]),
    };
    const io = { out: '', err: '' };
    const ctx = {
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      stdout: (t: string) => (io.out += t),
      stderr: (t: string) => (io.err += t),
    };
    const run = (args: string[]) => guardMain(['key-id', ...args], ctx);
    expect(run(['--keys', 'ok.json', '--id', vectorKey.keyId])).toBe(0);
    expect(io.out).toMatch(/^ok: /);
    expect(run(['--keys', 'ok.json', '--id', 'f'.repeat(64)])).toBe(1);
    expect(io.err).toMatch(/^refused: .*does not equal/m);
    expect(run(['--keys', 'none.json', '--id', vectorKey.keyId])).toBe(1);
    expect(run(['--keys', 'ok.json', '--id', ''])).toBe(1);
    // a file that cannot be read is a refusal, never a pass
    expect(run(['--keys', 'missing.json', '--id', vectorKey.keyId])).toBe(1);
    expect(run(['--keys', 'ok.json'])).toBe(2);
    expect(run(['--id', vectorKey.keyId])).toBe(2);
    expect(run([])).toBe(2);
  });
});

describe('publish-guard registry-absent: npm view of the version must answer E404, every other answer refuses', () => {
  const NAME = '@airplanemode/runtime';
  const E404 = [
    'npm error code E404',
    'npm error 404 Not Found - GET https://registry.npmjs.org/@airplanemode%2fruntime - Not found',
    'npm error 404',
    "npm error 404  '@airplanemode/runtime@0.3.0-beta.2' is not in this registry.",
  ].join('\n');
  const answer = (o: Record<string, unknown>) => ({
    status: 1,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '',
    ...o,
  });

  it('E404 passes: an unpublished name, and an existing package that lacks this version', () => {
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ stderr: E404 })),
    ).not.toThrow();
    // npm 10 prefixes errors with 'npm error'; older npm used 'npm ERR!'
    expect(() =>
      assertRegistryAbsent(
        NAME,
        '0.3.0-beta.2',
        answer({ stderr: 'npm ERR! code E404\nnpm ERR! 404' }),
      ),
    ).not.toThrow();
    // with colour codes and CRLF, as CARGO_TERM_COLOR-style settings and Windows runners produce
    expect(() =>
      assertRegistryAbsent(
        NAME,
        '0.3.0-beta.2',
        answer({ stderr: '\u001b[31mnpm error code E404\u001b[39m\r\nnpm error 404\r\n' }),
      ),
    ).not.toThrow();
  });

  it('a published version is refused (exit 0 with the version on stdout)', () => {
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ status: 0, stdout: '0.3.0-beta.2\n' })),
    ).toThrow(/already published/);
    // whatever stdout holds, exit 0 is never a pass
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ status: 0, stdout: '"0.3.0-beta.2"\n' })),
    ).toThrow(/already published/);
  });

  it('exit 0 with an empty answer is refused: absence is proved by a 404 and by nothing else', () => {
    expect(() => assertRegistryAbsent(NAME, '1.0.0', answer({ status: 0 }))).toThrow(
      /empty answer/,
    );
    expect(() =>
      assertRegistryAbsent(NAME, '1.0.0', answer({ status: 0, stderr: E404 })),
    ).toThrow();
  });

  it('a network or server error is refused: reset, timeout, 401, 403, 429, 500, 503, DNS, and an E404 mentioned only in the detail', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'E401',
      'E403',
      'E429',
      'E500',
      'E503',
      'E4040',
      'E404X',
    ])
      expect(
        () =>
          assertRegistryAbsent(
            NAME,
            '0.3.0-beta.2',
            answer({ stderr: `npm error code ${code}\nnpm error network request failed` }),
          ),
        code,
      ).toThrow(/did not answer 404/);
    expect(() =>
      assertRegistryAbsent(
        NAME,
        '0.3.0-beta.2',
        answer({
          stderr:
            'npm error code E503\nnpm error 503 Service Unavailable (was E404 before)\nnpm error code E404 is mentioned',
        }),
      ),
    ).toThrow(/did not answer 404/);
    // not on a line of its own: indented, or after other text
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ stderr: 'x npm error code E404' })),
    ).toThrow();
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ stderr: '  npm error code E404' })),
    ).toThrow();
    // an E404 on stdout (a --json answer, a proxy page) is not the signal either
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ stdout: 'npm error code E404' })),
    ).toThrow();
  });

  it('no answer at all is refused: a spawn error, a signal, a null status, an empty failure', () => {
    expect(() =>
      assertRegistryAbsent(
        NAME,
        '0.3.0-beta.2',
        answer({ status: null, error: new Error('spawn npm ENOENT') }),
      ),
    ).toThrow(/could not ask/);
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ status: null, signal: 'SIGTERM' })),
    ).toThrow();
    expect(() => assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ status: null }))).toThrow();
    expect(() => assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ status: 1 }))).toThrow(
      /did not answer 404/,
    );
    // an error object wins over an E404 text: a half-run process proves nothing
    expect(() =>
      assertRegistryAbsent(
        NAME,
        '0.3.0-beta.2',
        answer({ error: new Error('timeout'), stderr: E404 }),
      ),
    ).toThrow(/could not ask/);
    expect(() =>
      assertRegistryAbsent(NAME, '0.3.0-beta.2', answer({ signal: 'SIGKILL', stderr: E404 })),
    ).toThrow();
  });

  it('npm is asked with an argument list (no shell), the version, the public registry and no user config (so no token is sent)', () => {
    expect(npmViewArgs(NAME, '0.3.0-beta.2')).toEqual([
      'view',
      `${NAME}@0.3.0-beta.2`,
      'version',
      '--registry',
      NPM_REGISTRY,
      '--userconfig',
      devNull,
    ]);
    expect(NPM_REGISTRY).toBe('https://registry.npmjs.org/');
  });

  it('guardMain registry-absent: 0 on a 404, 1 on every other answer, 2 on a usage error, and a bad name never reaches npm', () => {
    const calls: string[][] = [];
    const io = { out: '', err: '' };
    const mk = (a: Record<string, unknown>) => ({
      npmView: (args: string[]) => {
        calls.push(args);
        return answer(a);
      },
      stdout: (t: string) => (io.out += t),
      stderr: (t: string) => (io.err += t),
    });
    const argv = ['registry-absent', '--package', NAME, '--version', '0.3.0-beta.2'];
    expect(guardMain(argv, mk({ stderr: E404 }))).toBe(0);
    expect(io.out).toMatch(/^ok: /);
    expect(calls).toEqual([npmViewArgs(NAME, '0.3.0-beta.2')]);
    expect(guardMain(argv, mk({ status: 0, stdout: '0.3.0-beta.2\n' }))).toBe(1);
    expect(io.err).toMatch(/^refused: .*already published/m);
    expect(guardMain(argv, mk({ stderr: 'npm error code ECONNRESET' }))).toBe(1);
    expect(guardMain(argv, mk({ status: null, error: new Error('spawn npm ENOENT') }))).toBe(1);
    expect(guardMain(argv, mk({ status: 0 }))).toBe(1);
    calls.length = 0;
    // usage errors and unsafe names are stopped before npm is run
    for (const bad of [
      ['registry-absent', '--package', NAME],
      ['registry-absent', '--version', '1.0.0'],
      ['registry-absent', '--package', '--registry=https://evil.example/', '--version', '1.0.0'],
      ['registry-absent', '--package', '-x', '--version', '1.0.0'],
      ['registry-absent', '--package', 'UPPER', '--version', '1.0.0'],
      ['registry-absent', '--package', '@a/b c', '--version', '1.0.0'],
      ['registry-absent', '--package', '@a/b\nc', '--version', '1.0.0'],
      ['registry-absent', '--package', '', '--version', '1.0.0'],
    ])
      expect(guardMain(bad, mk({ stderr: E404 })), JSON.stringify(bad)).toBe(2);
    // a version that is not strict SemVer is refused, not passed to npm
    expect(
      guardMain(
        ['registry-absent', '--package', NAME, '--version', '1.0.0\nEVIL=1'],
        mk({ stderr: E404 }),
      ),
    ).toBe(1);
    expect(
      guardMain(
        ['registry-absent', '--package', NAME, '--version', '1.0.0+build'],
        mk({ stderr: E404 }),
      ),
    ).toBe(1);
    expect(calls).toEqual([]);
  });

  // The default runner really spawns `npm`. A shim named npm, first on PATH, stands in for the registry (POSIX only: the
  // publish job runs on ubuntu-latest, and a Windows shim would need npm.cmd; the classification above is OS independent).
  const posix = process.platform === 'win32' ? it.skip : it;
  posix(
    'the real script, run against a shim npm: a 404 passes; a published version, an empty answer, a network error and a killed npm all refuse',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'rt-npm-shim-'));
      try {
        const script = resolve(repoDir, 'scripts/release/publish-guard.mjs');
        const run = (body: string) => {
          const dir = mkdtempSync(join(base, 'bin-'));
          mkdirSync(dir, { recursive: true });
          const shim = join(dir, 'npm');
          writeFileSync(shim, `#!/bin/sh\n${body}\n`);
          chmodSync(shim, 0o755);
          const r = spawnSync(
            process.execPath,
            [
              script,
              'registry-absent',
              '--package',
              '@airplanemode/runtime',
              '--version',
              '0.3.0-beta.2',
            ],
            { encoding: 'utf8', env: { PATH: dir } },
          );
          return { status: r.status, out: r.stdout, err: r.stderr };
        };
        const notFound = run(
          'echo "npm error code E404" >&2; echo "npm error 404 not in this registry" >&2; exit 1',
        );
        expect(notFound.status, notFound.err).toBe(0);
        expect(notFound.out).toMatch(/^ok: /);
        expect(run('echo 0.3.0-beta.2; exit 0').status).toBe(1);
        expect(run('exit 0').status).toBe(1);
        expect(run('echo "npm error code ECONNRESET" >&2; exit 1').status).toBe(1);
        expect(run('kill -KILL $$').status).toBe(1);
        // the shim sees the arguments the guard promises: the argument list, the public registry, no user config
        const argFile = join(base, 'args.txt');
        run(`printf "%s\\n" "$@" > '${argFile}'; exit 0`);
        const seen = readFileSync(argFile, 'utf8');
        expect(seen).toBe(
          `view\n@airplanemode/runtime@0.3.0-beta.2\nversion\n--registry\n${NPM_REGISTRY}\n--userconfig\n${devNull}\n`,
        );
        // no npm on PATH at all: refused, never passed
        const none = spawnSync(
          process.execPath,
          [
            script,
            'registry-absent',
            '--package',
            '@airplanemode/runtime',
            '--version',
            '0.3.0-beta.2',
          ],
          { encoding: 'utf8', env: { PATH: join(base, 'empty-bin') } },
        );
        expect(none.status).toBe(1);
        expect(none.stderr).toMatch(/^refused: /m);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe('publish-guard tarball: the verified manifest names exactly one .tgz, a plain file name, present as a regular file', () => {
  const entry = (id: string) => ({ id, kind: 'other', url: id, sha256: '0'.repeat(64), size: 1 });
  const manifest = (ids: string[]) =>
    JSON.stringify({ id: 'runtime-release', entries: ids.map(entry) });
  const regular = { isFile: () => true, isSymbolicLink: () => false };
  const present = () => regular;
  const TGZ = 'airplanemode-runtime-0.3.0-beta.2.tgz';

  it('exactly one .tgz entry passes and yields <dir>/<file name>; the other entries are ignored', () => {
    expect(selectTarball(manifest([TGZ]), 'verify', present)).toBe(`verify/${TGZ}`);
    expect(selectTarball(manifest([TGZ, 'notes.txt']), 'verify', present)).toBe(`verify/${TGZ}`);
  });

  it('none is refused; two are refused (a weakened comparison of the count would let both through)', () => {
    expect(() => selectTarball(manifest([]), 'verify', present)).toThrow(
      /exactly one \.tgz entry.*found 0/,
    );
    expect(() => selectTarball(manifest(['notes.txt']), 'verify', present)).toThrow(/found 0/);
    expect(() =>
      selectTarball(manifest([TGZ, 'airplanemode-runtime-0.3.0-beta.1.tgz']), 'verify', present),
    ).toThrow(/found 2/);
    expect(() => selectTarball(manifest([TGZ, TGZ]), 'verify', present)).toThrow(/found 2/);
  });

  it('an id that is not a plain file name is refused (a path, a parent directory, upper case, a leading dot, a space)', () => {
    for (const id of ['sub/x.tgz', '../x.tgz', 'X.tgz', '.x.tgz', 'a b.tgz', 'a\nb.tgz'])
      expect(() => selectTarball(manifest([id]), 'verify', present), JSON.stringify(id)).toThrow(
        /plain file name/,
      );
    // an id that ends in a newline does not end in .tgz: it is not the tarball, so the count is wrong and the job stops
    for (const id of ['x.tgz\n', 'x.tgz\nTARBALL=y'])
      expect(() => selectTarball(manifest([id]), 'verify', present), JSON.stringify(id)).toThrow(
        /found 0/,
      );
  });

  it('a directory that could carry a second line into GITHUB_ENV is refused', () => {
    for (const dir of ['', 'a\nb', 'a b', '$(x)', 'a;b', '--x'])
      expect(() => selectTarball(manifest([TGZ]), dir, present), JSON.stringify(dir)).toThrow();
  });

  it('a manifest that is not JSON, not an object or has no entries array is refused', () => {
    for (const t of ['', '{', '[]', 'null', '"x"', '{}', '{"entries":{}}', '{"entries":"x"}'])
      expect(() => selectTarball(t, 'verify', present), t).toThrow();
  });

  it('a missing file, a symlink and a directory are refused (lstat, never stat)', () => {
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(() => selectTarball(manifest([TGZ]), 'verify', missing)).toThrow(/does not exist/);
    const link = { isFile: () => false, isSymbolicLink: () => true };
    expect(() => selectTarball(manifest([TGZ]), 'verify', () => link)).toThrow(/regular file/);
    const dir = { isFile: () => false, isSymbolicLink: () => false };
    expect(() => selectTarball(manifest([TGZ]), 'verify', () => dir)).toThrow(/regular file/);
  });

  it('guardMain tarball prints only the path on success and exits 1 with a reason on every refusal; 2 on a usage error', () => {
    const files: Record<string, string> = {
      'one.json': manifest([TGZ]),
      'two.json': manifest([TGZ, 'other-0.1.0.tgz']),
    };
    const io = { out: '', err: '' };
    const ctx = {
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      lstat: present,
      stdout: (t: string) => (io.out += t),
      stderr: (t: string) => (io.err += t),
    };
    expect(guardMain(['tarball', '--manifest', 'one.json', '--dir', 'verify'], ctx)).toBe(0);
    expect(io.out).toBe(`verify/${TGZ}\n`);
    io.out = '';
    expect(guardMain(['tarball', '--manifest', 'two.json', '--dir', 'verify'], ctx)).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/^refused: .*found 2/m);
    expect(guardMain(['tarball', '--manifest', 'missing.json', '--dir', 'verify'], ctx)).toBe(1);
    expect(guardMain(['tarball', '--manifest', 'one.json'], ctx)).toBe(2);
    expect(guardMain(['tarball', '--dir', 'verify'], ctx)).toBe(2);
  });

  it('the real file system, through the real command line (run inside the directory, as the job does): a regular file passes; a symlink, a directory and a missing file refuse', () => {
    const base = mkdtempSync(join(tmpdir(), 'rt-tarball-'));
    try {
      const script = resolve(repoDir, 'scripts/release/publish-guard.mjs');
      // --dir is a plain relative name, as publish.yml passes it ('verify'); the job's working directory is the checkout
      const cli = (ids: string[]) => {
        writeFileSync(join(base, 'release-manifest.json'), manifest(ids));
        const r = spawnSync(
          process.execPath,
          [script, 'tarball', '--manifest', 'release-manifest.json', '--dir', '.'],
          { encoding: 'utf8', cwd: base },
        );
        return { status: r.status, out: r.stdout, err: r.stderr };
      };
      writeFileSync(join(base, TGZ), 'x');
      expect(cli([TGZ])).toMatchObject({ status: 0, out: `./${TGZ}\n` });
      const absent = cli(['absent-0.1.0.tgz']);
      expect(absent.status).toBe(1);
      expect(absent.err).toMatch(/^refused: .*does not exist/m);
      mkdirSync(join(base, 'dir-0.1.0.tgz'));
      const dir = cli(['dir-0.1.0.tgz']);
      expect(dir.status).toBe(1);
      expect(dir.err).toMatch(/^refused: .*regular file/m);
      // a symlink to the tarball is not a regular file (lstat, never stat). Where the OS refuses a file symlink,
      // makeLink falls back to a hard link, which IS a regular file: the answer is then a pass, and it says which it made
      const how = makeLink('file', join(base, TGZ), join(base, 'link-0.1.0.tgz'));
      const link = cli(['link-0.1.0.tgz']);
      if (how === 'symlink') {
        expect(link.status).toBe(1);
        expect(link.err).toMatch(/^refused: .*regular file/m);
      } else {
        expect(how).toBe('hardlink');
        expect(link).toMatchObject({ status: 0, out: './link-0.1.0.tgz\n' });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('publish-guard: usage and the environment', () => {
  it('lists every subcommand in its usage line, and an unknown subcommand is a usage error', () => {
    const io = { err: '' };
    const ctx = { stdout: () => {}, stderr: (t: string) => (io.err += t) };
    expect(guardMain([], ctx)).toBe(2);
    expect(io.err).toContain('semver|tag|no-expiry|key-id|registry-absent|tarball');
    expect(guardMain(['bogus'], ctx)).toBe(2);
  });
  it('the script reads no environment variable (the id, the version, the commit and the repository are arguments)', () => {
    const src = readFileSync(resolve(repoDir, 'scripts/release/publish-guard.mjs'), 'utf8');
    expect(src).not.toMatch(/process\.env|import\.meta\.env/);
    // and names no test key, no secret and no token
    expect(src).not.toMatch(
      /NPM_TOKEN|NODE_AUTH_TOKEN|CARGO_REGISTRY_TOKEN|allowTestKeys|rfc8032/i,
    );
  });
});
