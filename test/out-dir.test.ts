// S1-096 (fix round 2): the browser specs and the Playwright configs write their results into a
// git-ignored folder INSIDE this repository (runtime/test-results/), resolved from the file's own
// directory, never from the working directory. Before the fix every default was '../../test-results'
// resolved against the cwd, which is the parent Projects folder when `npm run` starts in runtime/.
// Written before test/browser/out-dir.ts existed (red run: evidence/sprint-4/D1/red-fix2-D1.log).

import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESULTS_DIR, REPO_ROOT, resultsDir } from './browser/out-dir';
import { repoDir } from './helpers';

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

describe('S1-096: the default results folder lies inside the repository', () => {
  it('REPO_ROOT is this repository and DEFAULT_RESULTS_DIR is runtime/test-results', () => {
    expect(REPO_ROOT).toBe(repoDir);
    expect(DEFAULT_RESULTS_DIR).toBe(resolve(repoDir, 'test-results'));
    expect(inside(repoDir, DEFAULT_RESULTS_DIR)).toBe(true);
    expect(isAbsolute(DEFAULT_RESULTS_DIR)).toBe(true);
  });

  it('with no environment variable (or an empty one) the folder is the default, whatever the cwd', () => {
    const cwd = process.cwd();
    expect(resultsDir('RUNTIME_DEMO_OUT', {})).toBe(DEFAULT_RESULTS_DIR);
    expect(resultsDir('RUNTIME_DEMO_OUT', { RUNTIME_DEMO_OUT: '' })).toBe(DEFAULT_RESULTS_DIR);
    expect(resultsDir(undefined, { RUNTIME_DEMO_OUT: '/somewhere/else' })).toBe(
      DEFAULT_RESULTS_DIR,
    );
    // the result never depends on the working directory
    expect(process.cwd()).toBe(cwd);
    expect(inside(repoDir, resultsDir('RUNTIME_TAMPER_OUT', {}))).toBe(true);
  });

  it('an environment variable overrides the default, and only then is anything written elsewhere', () => {
    const out = resultsDir('RUNTIME_TAMPER_OUT', { RUNTIME_TAMPER_OUT: '/tmp/out-x' });
    expect(out).toBe(resolve('/tmp/out-x'));
    expect(inside(repoDir, out)).toBe(false);
    expect(resultsDir('RUNTIME_TAMPER_OUT', { RUNTIME_STOP_OUT: '/tmp/other' })).toBe(
      DEFAULT_RESULTS_DIR,
    );
  });

  it('the spec of the folder: runtime/.gitignore ignores test-results/', () => {
    const ignore = readFileSync(resolve(repoDir, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('test-results/');
  });
});

describe('S1-096: no browser spec or Playwright config still resolves ../../test-results', () => {
  const dir = resolve(repoDir, 'test/browser');
  const files = readdirSync(dir).filter((f) => /\.(ts|mjs)$/.test(f));

  it('there are browser specs and configs to check', () => {
    expect(files.filter((f) => f.endsWith('.spec.ts')).length).toBeGreaterThanOrEqual(10);
    expect(files.filter((f) => f.startsWith('playwright.')).length).toBeGreaterThanOrEqual(6);
  });

  for (const f of files) {
    it(`${f} has no cwd-relative or parent-relative test-results path`, () => {
      const src = readFileSync(resolve(dir, f), 'utf8');
      expect(src).not.toContain("'../../test-results'");
      expect(src).not.toContain('"../../test-results"');
      expect(src).not.toMatch(
        /resolve\(process\.env\[[^\]]+\]\s*\?\?\s*'[^']*test-results[^']*'\)/,
      );
    });
  }

  it('every spec that wrote to a RUNTIME_*_OUT default and every config outputDir uses the helper', () => {
    for (const f of files.filter((n) => n.endsWith('.spec.ts'))) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      if (/RUNTIME_[A-Z_]*OUT/.test(src) && /OUT_DIR\b/.test(src))
        expect(src, f).toContain("from './out-dir'");
    }
    for (const f of files.filter((n) => /^playwright\..*\.ts$/.test(n))) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      if (src.includes('outputDir')) expect(src, f).toContain('DEFAULT_RESULTS_DIR');
    }
  });

  it('the repository root is never walked out of: no ".." segment reaches the parent folder', () => {
    expect(DEFAULT_RESULTS_DIR.split(sep)).not.toContain('..');
  });
});
