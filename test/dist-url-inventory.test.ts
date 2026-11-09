import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

// T1-S2-08: the inventory of a built demo scans bare host names as well as https:// strings, and
// exits non-zero on any hit it cannot attribute. These tests run the real tool on a fake dist folder.
const tool = resolve(repoDir, 'test/tools/dist-url-inventory.mjs');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inventory(files: Record<string, string>): { status: number | null; out: string } {
  const dist = mkdtempSync(join(tmpdir(), 'inventory-test-'));
  made.push(dist);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true });
    writeFileSync(join(dist, rel), text);
  }
  const r = spawnSync(process.execPath, [tool, dist], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const CHUNK = 'app/transformers.web-abc123.js';

describe('dist-url-inventory: https strings (unchanged behaviour)', () => {
  it('a build with no listed host passes with zero strings', () => {
    const r = inventory({ 'index.html': '<p>hello</p>', [CHUNK]: 'const a = 1;' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('strings: 0; unattributed: 0');
  });

  it('attributes the documentation link of the engine and the page link text', () => {
    const r = inventory({
      [CHUNK]:
        'throw new Error("see https://huggingface.co/docs/transformers/main/en/chat_templating");',
      'index.html': '<a href="https://github.com/AirplaneMode-Labs/runtime">source</a>',
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('strings: 2; unattributed: 0');
  });

  it('exits 1 on an https string it cannot attribute', () => {
    const r = inventory({ [CHUNK]: 'fetch("https://cdn.jsdelivr.net/npm/other@1/x.js")' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('UNATTRIBUTED');
  });
});

describe('dist-url-inventory: bare host names (T1-S2-08)', () => {
  it('flags the Hugging Face host allow-list literal of the engine chunk', () => {
    const r = inventory({
      [CHUNK]: 'const h=isValidUrl(u,["http:","https:"],["huggingface.co","hf.co"]);',
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('UNATTRIBUTED');
    expect(r.out).toContain('huggingface.co');
    expect(r.out).toContain('hf.co');
  });

  it.each([
    'huggingface.co',
    'hf.co',
    'cdn.jsdelivr.net',
    'jsdelivr',
    'unpkg.com',
    'unpkg',
    'cdnjs.cloudflare.com',
    'cdnjs',
    'github.com',
    'raw.githubusercontent.com',
    'fonts.googleapis.com',
    'googleapis',
    'fonts.gstatic.com',
    'gstatic',
  ])('exits 1 on the bare host %s', (host) => {
    const r = inventory({ [CHUNK]: `var x={host:"${host}"};` });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('bare');
  });

  it('passes once the literal is rewritten to an inert value', () => {
    const r = inventory({
      [CHUNK]: 'const h=isValidUrl(u,["http:","https:"],["invalid.invalid"]);',
    });
    expect(r.status, r.out).toBe(0);
  });

  it('does not double count a bare name that sits inside an attributed https string', () => {
    const r = inventory({
      'index.html': '<a href="https://github.com/AirplaneMode-Labs/runtime">source</a>',
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('strings: 1; unattributed: 0');
  });

  it('does not flag a longer word that merely contains a listed name', () => {
    const r = inventory({
      [CHUNK]: 'var a="mychf.corp",b="unpkgx",c="xgstatic",d="mygithub.community",e="hf.cool";',
    });
    expect(r.status, r.out).toBe(0);
  });

  it('reports the chunk and a short context for every bare hit', () => {
    const r = inventory({ [CHUNK]: 'x=["unpkg"]' });
    expect(r.out).toContain(CHUNK);
    expect(r.out).toContain('unpkg');
  });
});
