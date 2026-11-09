import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildId } from '../demo/build-id';
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
    expect(config).toMatch(/buildId\(process\.env\['GITHUB_SHA'\]\)/);
  });
});
