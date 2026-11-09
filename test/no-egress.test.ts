import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

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
