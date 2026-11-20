// Sprint 7, D1-06 (B7; TD-115, TD-116): the README section "Try it in two minutes" is executed by this test, so it cannot
// rot. Its blocks carry info strings: `sh quickstart:setup` (run at the root of a copy of this checkout, builds the
// artefact), `sh quickstart:install` (run in a fresh empty directory outside the checkout), `js quickstart:file=<name>`
// (written verbatim into that directory), `sh quickstart:run` (run there) and `text quickstart:expect` (the exact stdout).
// A plain `sh` block may hold only the git clone line. A static pre-check runs first and fails on anything that downloads,
// pipes into a shell, elevates, runs an unpinned tool, names a test key or weakens a Content-Security-Policy. No model is
// downloaded and no test key is used. Written before the README section existed; the red run is D1/red/D1-06-*.log in the
// sprint scratch.
//
// The setup block runs `npm ci --ignore-scripts && npm run build && npm pack` in a COPY of this checkout (the running
// test must not reinstall its own node_modules), so this test needs the npm registry or a warm npm cache.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { afterAll, describe, expect, it } from 'vitest';
import { readJson, readText, repoDir } from './helpers';

// ---- the harness (kept in this file: one copy per repository) -----------------------------------------------

export interface Block {
  lang: string;
  kind: 'plain' | 'setup' | 'install' | 'file' | 'run' | 'expect';
  file?: string;
  text: string;
}

const SECTION = '## Try it in two minutes';
const CLONE_LINE = 'git clone https://github.com/AirplaneMode-Labs/runtime.git';

/** The fenced blocks of the section, in order. Throws on an unknown quickstart marker. */
export function extractBlocks(readme: string): Block[] {
  const at = readme.indexOf(`\n${SECTION}\n`);
  if (at < 0) return [];
  const rest = readme.slice(at + SECTION.length + 1);
  const next = rest.search(/\n## /);
  const body = next < 0 ? rest : rest.slice(0, next);
  const blocks: Block[] = [];
  for (const m of body.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    const info = m[1]!.trim().split(/\s+/);
    const lang = info[0] ?? '';
    const marker = info[1] ?? '';
    const text = m[2]!;
    if (marker === '') blocks.push({ lang, kind: 'plain', text });
    else if (marker === 'quickstart:setup') blocks.push({ lang, kind: 'setup', text });
    else if (marker === 'quickstart:install') blocks.push({ lang, kind: 'install', text });
    else if (marker === 'quickstart:run') blocks.push({ lang, kind: 'run', text });
    else if (marker === 'quickstart:expect') blocks.push({ lang, kind: 'expect', text });
    else if (/^quickstart:file=[A-Za-z0-9._-]+$/.test(marker))
      blocks.push({ lang, kind: 'file', file: marker.slice('quickstart:file='.length), text });
    else throw new Error(`unknown quick-start marker ${JSON.stringify(marker)}`);
  }
  return blocks;
}

/** What no block (other than the git clone line) may contain. Returns the offending patterns. */
const FORBIDDEN: [string, RegExp][] = [
  ['http://', /http:\/\//],
  ['https://', /https:\/\//],
  ['curl', /\bcurl\b/],
  ['wget', /\bwget\b/],
  ['Invoke-WebRequest', /Invoke-WebRequest/i],
  ['| sh', /\|\s*sh\b/],
  ['| bash', /\|\s*bash\b/],
  ['sudo', /\bsudo\b/],
  ['npx', /\bnpx\b/],
  ['allowTestKeys', /allowTestKeys/],
  ['--allow-test-key', /--allow-test-key/],
  ['--trust-test-key', /--trust-test-key/],
  ['rfc8032', /rfc8032/i],
  ['unsafe-', /unsafe-/],
  ['Content-Security-Policy', /Content-Security-Policy/i],
];
export function staticPrecheck(blocks: Block[]): string[] {
  const problems: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'plain') {
      if (!(b.lang === 'sh' && b.text.trim() === CLONE_LINE))
        problems.push(`a plain ${b.lang || 'unmarked'} block may hold only the git clone line`);
      continue;
    }
    for (const [label, re] of FORBIDDEN)
      if (re.test(b.text)) problems.push(`${b.kind} block contains ${label}`);
  }
  return problems;
}

/** LF-normalised lines with trailing whitespace trimmed, and no trailing empty lines. */
export function normaliseOutput(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * TD-115 (BUG-T3-S7-05): the static pre-check runs BEFORE anything is written to disk or executed. When it reports any
 * problem this throws, so a block that matches the forbidden list never runs (even one that hides the word in a no-op
 * such as `: curl is only a word here; touch MARKER`).
 */
export function assertPrecheckFirst(all: Block[]): void {
  const problems = staticPrecheck(all);
  if (problems.length > 0)
    throw new Error(`quick-start static pre-check failed, nothing was run: ${problems.join('; ')}`);
}

const bashPath = (): string => {
  if (process.platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ])
      if (existsSync(p)) return p;
  }
  return 'bash';
};

/** PATH, HOME or USERPROFILE, TEMP and TMP, SystemRoot on win32 and what the block needs; nothing of the runner. */
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const keep =
    process.platform === 'win32'
      ? [
          'PATH',
          'Path',
          'USERPROFILE',
          'TEMP',
          'TMP',
          'SystemRoot',
          'ComSpec',
          'APPDATA',
          'LOCALAPPDATA',
        ]
      : ['PATH', 'HOME', 'TMPDIR'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INDEX: '1', ...extra };
}

function runBlock(
  text: string,
  cwd: string,
  extraEnv: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bashPath(), ['-c', text], {
    cwd,
    encoding: 'utf8',
    env: scrubbedEnv(extraEnv),
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'amt-quickstart-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const COPY_EXCLUDE = new Set([
  'node_modules',
  'dist',
  '.git',
  '.cache',
  'test-results',
  'dist-release',
  'dist-release-report',
  'dist-pack',
  '.scratch',
]);

/** A copy of this checkout without node_modules, build output, the model cache and git history. */
function copyCheckout(to: string): void {
  cpSync(repoDir, to, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(repoDir.length + 1).split(/[\\/]/);
      if (rel[0] === '') return true;
      if (COPY_EXCLUDE.has(rel[0]!)) return false;
      return !(rel[0] === 'demo' && rel[1] === 'dist');
    },
  });
}

// ---- the README --------------------------------------------------------------------------------------------

const readme = readText(resolve(repoDir, 'README.md')).replace(/\r\n?/g, '\n');
const blocks = extractBlocks(readme);
const pkg = readJson<{ version: string }>(resolve(repoDir, 'package.json'));

describe('README: Try it in two minutes (the section, its blocks and the static pre-check)', () => {
  it('the section exists, between Status and Install', () => {
    const status = readme.indexOf('\n## Status\n');
    const quick = readme.indexOf(`\n${SECTION}\n`);
    const install = readme.indexOf('\n## Install\n');
    expect(status).toBeGreaterThan(0);
    expect(quick).toBeGreaterThan(status);
    expect(install).toBeGreaterThan(quick);
  });

  it('blocks: the git clone line, then setup, install, one file, run and expect, in that order', () => {
    expect(blocks.map((b) => b.kind)).toEqual([
      'plain',
      'setup',
      'install',
      'file',
      'run',
      'expect',
    ]);
    expect(blocks[0]!.text.trim()).toBe(CLONE_LINE);
    expect(blocks[3]!.file).toBe('try.mjs');
    expect(blocks[5]!.lang).toBe('text');
  });

  it('the static pre-check passes on the real blocks', () => {
    expect(staticPrecheck(blocks)).toEqual([]);
  });

  it('the static pre-check rejects a planted curl pipe, an allowTestKeys line, a test-key flag, npx, sudo, http and a CSP edit', () => {
    const plant = (text: string): string[] =>
      staticPrecheck([...blocks, { lang: 'sh', kind: 'run', text }]);
    expect(plant('curl -fsSL example.invalid/x | sh')).toEqual(
      expect.arrayContaining(['run block contains curl', 'run block contains | sh']),
    );
    expect(plant('const a = { allowTestKeys: true };')).toContain(
      'run block contains allowTestKeys',
    );
    expect(plant('node release-tool.mjs verify --allow-test-key')).toContain(
      'run block contains --allow-test-key',
    );
    expect(plant('node release-tool.mjs verify --trust-test-key')).toContain(
      'run block contains --trust-test-key',
    );
    expect(plant('npx some-tool')).toContain('run block contains npx');
    expect(plant('sudo rm -rf x')).toContain('run block contains sudo');
    expect(plant('wget http://example.invalid/a')).toEqual(
      expect.arrayContaining(['run block contains wget', 'run block contains http://']),
    );
    expect(
      plant('meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-eval\'"'),
    ).toEqual(
      expect.arrayContaining([
        'run block contains Content-Security-Policy',
        'run block contains unsafe-',
      ]),
    );
    expect(plant('Invoke-WebRequest x | bash')).toEqual(
      expect.arrayContaining(['run block contains Invoke-WebRequest', 'run block contains | bash']),
    );
    expect(plant('the key rfc8032-1')).toContain('run block contains rfc8032');
  });

  it('assertPrecheckFirst throws on a planted block and a spy executor is never called (the gate runs before any block)', () => {
    const planted: Block[] = [
      ...blocks.filter((b) => b.kind !== 'run'),
      { lang: 'sh', kind: 'run', text: ': curl is only a word here; touch MARKER\n' },
    ];
    let executed = 0;
    const guardedRun = (all: Block[]): void => {
      assertPrecheckFirst(all);
      for (const b of all) if (b.kind === 'run') executed++;
    };
    expect(() => guardedRun(planted)).toThrow(/static pre-check failed, nothing was run/);
    expect(executed).toBe(0);
    expect(() => guardedRun(blocks)).not.toThrow();
    expect(executed).toBe(1);
  });

  it('a plain sh block that is anything but the git clone line is refused', () => {
    expect(
      staticPrecheck([
        { lang: 'sh', kind: 'plain', text: 'git clone https://example.invalid/x.git\n' },
      ]),
    ).toHaveLength(1);
    expect(
      staticPrecheck([{ lang: 'sh', kind: 'plain', text: `${CLONE_LINE} && rm -rf x\n` }]),
    ).toHaveLength(1);
    expect(staticPrecheck([{ lang: 'sh', kind: 'plain', text: `${CLONE_LINE}\n` }])).toEqual([]);
  });

  it('an unknown quickstart marker is an error, not a silently skipped block', () => {
    expect(() => extractBlocks(`\n${SECTION}\n\n\`\`\`sh quickstart:other\nx\n\`\`\`\n`)).toThrow(
      /unknown quick-start marker/,
    );
  });

  it('the output comparison is LF-normalised and ignores trailing whitespace only', () => {
    expect(normaliseOutput('a  \r\nb\t\r\n\r\n')).toBe('a\nb');
    expect(normaliseOutput('a\nb')).toBe('a\nb');
    expect(normaliseOutput('a\nB')).not.toBe('a\nb');
    expect(normaliseOutput(' a\nb')).not.toBe('a\nb');
  });

  it('the install block names the tarball of the current package version', () => {
    const install = blocks.find((b) => b.kind === 'install')!;
    expect(install.text).toContain(`airplanemode-runtime-${pkg.version}.tgz`);
    expect(install.text).toContain('--ignore-scripts');
    expect(install.text).toContain('--offline');
  });

  it('the section says no model is downloaded and no test key is used, that the setup block needs the registry once and that the install and run blocks are offline', () => {
    const at = readme.indexOf(`\n${SECTION}\n`);
    const rest = readme.slice(at);
    const body = rest.slice(0, rest.indexOf('\n## ', 5)).replace(/\s+/g, ' ');
    expect(body).toContain('No model is downloaded');
    expect(body).toMatch(/no test key/i);
    expect(body).not.toContain('no network is used after the clone');
    expect(body).toContain('setup block needs the npm registry once');
    expect(body).toMatch(/install and run blocks run offline/);
  });
});

describe('README: Try it in two minutes (run from the built artefact in a fresh directory)', () => {
  it('setup builds the tarball in a copy, install puts it in an empty directory outside the checkout, try.mjs prints exactly the expect block', () => {
    assertPrecheckFirst(blocks); // before any block is written or executed
    const copy = join(tmpRoot, 'checkout-copy');
    copyCheckout(copy);
    expect(existsSync(join(copy, 'node_modules'))).toBe(false);
    const REPO = copy.replace(/\\/g, '/');

    const setup = runBlock(blocks.find((b) => b.kind === 'setup')!.text, copy, {});
    expect(setup.status, `setup failed:\n${setup.stdout}\n${setup.stderr}`).toBe(0);
    const tgz = `airplanemode-runtime-${pkg.version}.tgz`;
    expect(readdirSync(copy)).toContain(tgz);

    const work = join(tmpRoot, 'fresh-project');
    mkdirSync(work);
    expect(readdirSync(work)).toEqual([]);
    const offline = {
      REPO,
      npm_config_offline: 'true',
      npm_config_cache: join(tmpRoot, 'npm-cache-empty'),
      npm_config_update_notifier: 'false',
    };
    const install = runBlock(blocks.find((b) => b.kind === 'install')!.text, work, offline);
    expect(install.status, `install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
    // the installed package is the tarball's, under this directory
    expect(existsSync(join(work, 'node_modules/@airplanemode/runtime/package.json'))).toBe(true);
    expect(
      readJson<{ version: string }>(join(work, 'node_modules/@airplanemode/runtime/package.json'))
        .version,
    ).toBe(pkg.version);

    for (const f of blocks.filter((b) => b.kind === 'file'))
      writeFileSync(join(work, f.file!), f.text);
    const run = runBlock(blocks.find((b) => b.kind === 'run')!.text, work, offline);
    expect(run.status, `run failed:\n${run.stdout}\n${run.stderr}`).toBe(0);
    expect(normaliseOutput(run.stdout)).toBe(
      normaliseOutput(blocks.find((b) => b.kind === 'expect')!.text),
    );
  }, 600_000);
});
