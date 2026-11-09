import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative as nativeRelative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

// Repo-relative paths with POSIX separators, so the checks below behave the same on Windows.
const relative = (from: string, to: string): string =>
  nativeRelative(from, to).split(sep).join('/');

const srcDir = resolve(repoDir, 'src');
const specDir = resolve(repoDir, 'spec');

/** Network and loader APIs no library file may touch, except the asset manager's fetch. */
const PATTERNS: [string, RegExp][] = [
  ['fetch(', /\bfetch\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /sendBeacon/],
  ['importScripts', /importScripts/],
  ['navigator.connection', /navigator\.connection/],
  ['EventSource', /\bEventSource\b/],
  ['navigator.userAgent', /navigator\.userAgent/],
  ['userAgentData', /userAgentData/],
];

const ALLOWED: Record<string, string[]> = {
  'src/asset-manager.ts': ['fetch('],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no network egress in library code', () => {
  const files = [...walk(srcDir), ...walk(specDir)];

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = relative(repoDir, file);
    it(`${rel} has no unexpected network or user-agent access`, () => {
      const text = readFileSync(file, 'utf8');
      const hits: string[] = [];
      for (const [label, re] of PATTERNS) {
        if (re.test(text) && !(ALLOWED[rel] ?? []).includes(label)) hits.push(label);
      }
      expect(hits, `${rel}: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('src/backends never touches the global fetch, the network or a CDN: fetch( appears in src/asset-manager.ts only', () => {
    const backends = files.filter((f) => relative(repoDir, f).startsWith('src/backends'));
    expect(backends.length).toBeGreaterThanOrEqual(5);
    const callers = files
      .filter((f) => /\bfetch\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repoDir, f));
    expect(callers.filter((c) => c !== 'src/asset-manager.ts')).toEqual([]);
    for (const f of backends) {
      const text = readFileSync(f, 'utf8');
      const rel = relative(repoDir, f);
      expect(text, rel).not.toMatch(/globalThis\.fetch|window\.fetch|self\.fetch/);
      expect(text, rel).not.toMatch(
        /cdn\.jsdelivr|unpkg\.com|cdnjs|huggingface\.co|raw\.githubusercontent/,
      );
    }
  });

  it('the main entry never imports an engine package; only src/backends/transformers.ts names one', () => {
    for (const f of files) {
      const rel = relative(repoDir, f);
      const text = readFileSync(f, 'utf8');
      const named = /@huggingface\/transformers|@mlc-ai\/web-llm/.test(text);
      if (rel === 'src/backends/transformers.ts') expect(named, rel).toBe(true);
      else expect(named, rel).toBe(false);
    }
    const index = readFileSync(resolve(srcDir, 'index.ts'), 'utf8');
    expect(index).not.toMatch(
      /backends\/(transformers|chain|chrome-prompt|descriptor|verified-files)/,
    );
  });

  it('the asset manager uses fetch with the fixed hardened options', () => {
    const text = readFileSync(resolve(srcDir, 'asset-manager.ts'), 'utf8');
    for (const opt of [
      "credentials: 'omit'",
      "cache: 'no-store'",
      "redirect: 'error'",
      "referrerPolicy: 'no-referrer'",
      "mode: 'cors'",
    ]) {
      expect(text, opt).toContain(opt);
    }
  });
});
