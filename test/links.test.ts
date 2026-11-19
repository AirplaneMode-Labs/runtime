// Sprint 6, D1-06 (S1-116): the symlink-escape tests of bundle-models and fetch-model must RUN or FAIL LOUDLY,
// never skip silently. At 4f5b011 both called ctx.skip() when a link could not be made (the bundle-models one on
// ANY error, the fetch-model one on EPERM), so a Windows runner without symlink rights would have shown the
// Windows containment of both tools as skipped instead of failed. makeLink() (test/helpers.ts) makes a directory
// link with a junction on win32 (no privilege needed) and a symlink elsewhere, a file link with a symlink and, on
// EPERM, a hard link; when nothing works it THROWS with the OS and the error, and this file proves it, and that
// the only skip left in `npm run ci` is the env-gated RUNTIME_BUNDLE_REAL describe.
// Written before makeLink existed; the red run is evidence/sprint-6/D1/red/D1-06.log.
//
// What windows-latest shows after this change: skipped 1 (the RUNTIME_BUNDLE_REAL describe), and both symlink
// tests executed, through a junction for the directory links (D1/s1-116-windows.txt records the 4f5b011 log).

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLink, testDir, type LinkFs } from './helpers';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'links-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const eperm = (): never => {
  throw Object.assign(new Error('operation not permitted, symlink'), { code: 'EPERM' });
};
function fakeFs(over: Partial<LinkFs> = {}): LinkFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    symlinkSync: (_t, _p, type) => {
      calls.push(`symlink:${type ?? 'auto'}`);
    },
    linkSync: () => {
      calls.push('link');
    },
    ...over,
  };
}

describe('makeLink: which mechanism, per platform', () => {
  it('a directory link on win32 is a junction (no privilege needed); on other platforms a dir symlink', () => {
    const w = fakeFs();
    expect(makeLink('dir', 'T', 'P', { fs: w, platform: 'win32' })).toBe('junction');
    expect(w.calls).toEqual(['symlink:junction']);
    const m = fakeFs();
    expect(makeLink('dir', 'T', 'P', { fs: m, platform: 'darwin' })).toBe('symlink');
    expect(m.calls).toEqual(['symlink:dir']);
    const l = fakeFs();
    expect(makeLink('dir', 'T', 'P', { fs: l, platform: 'linux' })).toBe('symlink');
  });

  it('on win32 a directory link falls back from a refused junction to a dir symlink', () => {
    let n = 0;
    const f = fakeFs({
      symlinkSync: (_t, _p, type) => {
        f.calls.push(`symlink:${type}`);
        if (n++ === 0) eperm();
      },
    });
    expect(makeLink('dir', 'T', 'P', { fs: f, platform: 'win32' })).toBe('symlink');
    expect(f.calls).toEqual(['symlink:junction', 'symlink:dir']);
  });

  it('a file link is a file symlink; on EPERM it is a hard link, which a directory link can never be', () => {
    const ok = fakeFs();
    expect(makeLink('file', 'T', 'P', { fs: ok, platform: 'win32' })).toBe('symlink');
    expect(ok.calls).toEqual(['symlink:file']);
    const denied = fakeFs({ symlinkSync: () => eperm() });
    expect(makeLink('file', 'T', 'P', { fs: denied, platform: 'win32' })).toBe('hardlink');
    expect(denied.calls).toEqual(['link']);
  });
});

describe('makeLink: when no link can be made the test FAILS, naming the OS and the error', () => {
  it('an injected EPERM on every mechanism throws (a failure), it never returns and never skips', () => {
    const nothing = fakeFs({
      symlinkSync: () => eperm(),
      linkSync: () => {
        throw Object.assign(new Error('operation not permitted, link'), { code: 'EPERM' });
      },
    });
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const kind of ['dir', 'file'] as const) {
        let thrown: unknown;
        try {
          makeLink(kind, 'T', 'P', { fs: nothing, platform });
        } catch (e) {
          thrown = e;
        }
        expect(thrown, `${platform} ${kind}`).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(platform);
        expect(message).toContain('EPERM');
        expect(message).toContain('S1-116');
        expect(message).toContain('not be skipped');
      }
    }
  });

  it('a non-EPERM error is also a failure with its code', () => {
    const broken = fakeFs({
      symlinkSync: () => {
        throw Object.assign(new Error('boom'), { code: 'ENOSPC' });
      },
    });
    expect(() => makeLink('dir', 'T', 'P', { fs: broken, platform: 'linux' })).toThrow(/ENOSPC/);
  });
});

describe('makeLink on this machine', () => {
  it('makes a real directory link that lstat reports as a link and that resolves to the target', () => {
    const target = join(tmp, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'marker'), 'x');
    const link = join(tmp, 'link');
    const how = makeLink('dir', target, link);
    expect(['symlink', 'junction']).toContain(how);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(link)).toEqual(['marker']);
  });

  it('makes a real file link', () => {
    const target = join(tmp, 'file.txt');
    writeFileSync(target, 'content');
    const link = join(tmp, 'file-link');
    const how = makeLink('file', target, link);
    expect(['symlink', 'hardlink']).toContain(how);
    expect(readFileSync(link, 'utf8')).toBe('content');
    if (how === 'hardlink') {
      linkSync(target, join(tmp, 'again'));
      expect(existsSync(join(tmp, 'again'))).toBe(true);
    }
  });
});

describe('the only skip in `npm run ci` is the env-gated RUNTIME_BUNDLE_REAL describe', () => {
  // the patterns are built from pieces so that this file does not match itself
  const PATTERNS = [
    new RegExp(['ctx', '\\.skip\\('].join('')),
    new RegExp(['(?:it|test|describe)', '\\.skip\\('].join('')),
    new RegExp(['\\.', 'skipIf\\('].join('')),
    new RegExp(['(?:it|test|describe)', '\\.todo\\('].join('')),
    new RegExp(['\\bx', '(?:it|describe)\\('].join('')),
  ];

  it('no vitest file calls skip in any form except the one env-gated describe', () => {
    const hits: string[] = [];
    for (const name of readdirSync(testDir)) {
      if (!/\.test\.ts$/.test(name) || name === 'links.test.ts') continue;
      const lines = readFileSync(join(testDir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (PATTERNS.some((p) => p.test(line))) hits.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(
      /^bundle-models\.test\.ts:\d+: describe\.skipIf\(process\.env\['RUNTIME_BUNDLE_REAL'\] !== '1'\)/,
    );
  });

  it('the symlink-escape tests of both tools no longer take a ctx argument to skip with', () => {
    for (const name of ['bundle-models.test.ts', 'fetch-model.test.ts']) {
      const text = readFileSync(join(testDir, name), 'utf8');
      const at = text.indexOf('symlink inside');
      expect(at, name).toBeGreaterThan(-1);
      const header = text.slice(at, at + 400).split('\n')[0]!;
      expect(header, name).not.toContain('(ctx)');
      expect(text, name).toContain('makeLink(');
    }
  });
});
