// D1-01 (Sprint 5, Part A): the Windows failure in devtools-hook.test.ts was a path-separator bug in the
// test, not in the library: it compared 'src\devtools-hook.ts' with 'src/devtools-hook.ts'. This file feeds
// the shared helpers backslash and mixed paths and path.win32 so the fault reproduces on macOS and Linux.
// Written before the helpers existed.

import { posix, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesContaining, relPosix, repoDir, toPosix } from './helpers';

describe('toPosix', () => {
  it('turns backslashes into forward slashes whatever the host separator is', () => {
    expect(toPosix('src\\devtools-hook.ts')).toBe('src/devtools-hook.ts');
    expect(toPosix('src/x\\y.ts')).toBe('src/x/y.ts');
    expect(toPosix('a\\\\b')).toBe('a//b');
  });

  it('leaves a POSIX path untouched', () => {
    expect(toPosix('src/devtools-hook.ts')).toBe('src/devtools-hook.ts');
    expect(toPosix('')).toBe('');
  });
});

describe('relPosix', () => {
  it('returns the POSIX form of a path.win32 relative path (the Windows CI shape)', () => {
    // the raw native result is what failed on windows-latest
    const raw = win32.relative('C:\\a', 'C:\\a\\src\\devtools-hook.ts');
    expect(raw).toBe('src\\devtools-hook.ts');
    expect(raw).not.toBe('src/devtools-hook.ts');
    expect(relPosix('C:\\a', 'C:\\a\\src\\devtools-hook.ts', win32)).toBe('src/devtools-hook.ts');
  });

  it('handles mixed separators under path.win32', () => {
    expect(relPosix('C:\\a', 'C:/a/src\\x/y.ts', win32)).toBe('src/x/y.ts');
    expect(relPosix('C:\\a', 'C:\\a\\src/x\\y.ts', win32)).toBe('src/x/y.ts');
  });

  it('is the identity-compatible result under path.posix', () => {
    expect(relPosix('/a', '/a/src/devtools-hook.ts', posix)).toBe('src/devtools-hook.ts');
  });

  it('defaults to the host path module', () => {
    expect(relPosix(repoDir, resolve(repoDir, 'src', 'x.ts'))).toBe('src/x.ts');
  });
});

describe('filesContaining', () => {
  it('returns POSIX-form paths relative to the root, for any separator the walker yields', () => {
    const files = new Map<string, string>([
      ['C:\\a\\src\\devtools-hook.ts', 'export function exposeDevtoolsHook() {}'],
      ['C:\\a\\src\\x\\y.ts', 'nothing here'],
      ['C:\\a\\src\\index.ts', 'export { exposeDevtoolsHook } from "./devtools-hook"'],
    ]);
    const hits = filesContaining(
      'C:\\a',
      [...files.keys()],
      /exposeDevtoolsHook\s*\(/,
      (f) => files.get(f)!,
      win32,
    );
    expect(hits).toEqual(['src/devtools-hook.ts']);
  });

  it('strips comment lines before matching (the original test did)', () => {
    const hits = filesContaining(
      '/a',
      ['/a/src/c.ts'],
      /exposeDevtoolsHook\s*\(/,
      () => '// exposeDevtoolsHook() is documented here\n * exposeDevtoolsHook()\nconst x = 1;',
      posix,
    );
    expect(hits).toEqual([]);
  });
});
