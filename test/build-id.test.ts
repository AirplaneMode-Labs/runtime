import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildId, buildLabel, type GitInfo } from '../demo/build-id';
import { repoDir } from './helpers';

// S1-052: the demo's build id is the first 12 characters of GITHUB_SHA only when GITHUB_SHA is 40
// lowercase hex characters, otherwise 'local' (the same rule as pagetriage build-site.sh and glyphsift
// build-demo.sh).
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('S1-052: buildId(GITHUB_SHA)', () => {
  it('is the first 12 characters of a valid 40-character lowercase hex sha', () => {
    expect(buildId(SHA)).toBe('0123456789ab');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['too short', 'abc'],
    ['not hex, with markup', 'not-a-sha<b>'],
    ['not hex, 40 characters', 'g'.repeat(40)],
    ['40 uppercase hex', SHA.toUpperCase()],
    ['39 hex', SHA.slice(0, 39)],
    ['41 hex', SHA + 'a'],
    ['a trailing newline', SHA + '\n'],
    ['a leading space', ' ' + SHA],
    ['a trailing space', SHA + ' '],
    ['two shas', SHA + SHA],
  ] as [string, string | undefined][])('is "local" for %s', (_label, value) => {
    expect(buildId(value)).toBe('local');
  });

  it('demo/vite.config.ts uses the helper and no longer slices GITHUB_SHA itself', () => {
    const config = readFileSync(resolve(repoDir, 'demo/vite.config.ts'), 'utf8');
    expect(config).toContain("from './build-id'");
    expect(config).not.toMatch(/GITHUB_SHA'?\]?\?\.slice/);
    expect(config).toMatch(/buildLabel\(/);
    expect(config).toMatch(/process\.env\['GITHUB_SHA'\]/);
  });
});

// D1-FIX1-02 (BUG-T1-S5-04): the convention form. CI on main: 'Built from main at <sha12>'. Otherwise the
// git HEAD of the checkout: 'Local build <sha12>[-dirty]'. 'local' only with no .git, and the label says so.
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const git = (dirty: boolean, head = HEAD): GitInfo => ({ head, dirty });

describe('D1-FIX1-02: buildLabel follows the build-id convention', () => {
  it('GITHUB_SHA on main: Built from main at <sha12>', () => {
    expect(buildLabel({ githubSha: SHA, githubRef: 'refs/heads/main', git: git(false) })).toBe(
      'Built from main at 0123456789ab',
    );
  });

  it('GITHUB_SHA with no ref given counts as CI on main (the Pages build)', () => {
    expect(buildLabel({ githubSha: SHA, git: undefined })).toBe('Built from main at 0123456789ab');
  });

  it('a clean checkout: Local build <sha12>', () => {
    expect(buildLabel({ githubSha: undefined, git: git(false) })).toBe('Local build fedcba987654');
  });

  it('a dirty checkout: Local build <sha12>-dirty', () => {
    expect(buildLabel({ githubSha: undefined, git: git(true) })).toBe(
      'Local build fedcba987654-dirty',
    );
  });

  it('a GITHUB_SHA on another ref is not "main": it falls back to the checkout', () => {
    expect(buildLabel({ githubSha: SHA, githubRef: 'refs/heads/feature', git: git(false) })).toBe(
      'Local build fedcba987654',
    );
  });

  it('a malformed GITHUB_SHA is ignored in favour of git HEAD', () => {
    expect(buildLabel({ githubSha: 'nope', git: git(false) })).toBe('Local build fedcba987654');
  });

  it('no .git and no valid GITHUB_SHA: local, and it says there is no git checkout', () => {
    expect(buildLabel({ githubSha: undefined, git: undefined })).toBe(
      'Local build local (no .git checkout)',
    );
  });

  it('a git HEAD that is not 40 hex is treated as no checkout', () => {
    expect(buildLabel({ githubSha: undefined, git: git(false, 'garbage<b>') })).toBe(
      'Local build local (no .git checkout)',
    );
  });
});
