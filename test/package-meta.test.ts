// D1-10: alpha packaging (0.2.0-alpha.0, then 0.2.0-alpha.1); Sprint 5 (D1-09) makes it the beta 0.3.0-beta.0. Written before package.json, tsup.config.ts, README,
// CHANGELOG and docs/release.md changed (red-D1-10.log). The offline fresh-directory install itself
// is scripts/pack-check.mjs (npm run pack:check), run on CI and logged under the lane evidence.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

const read = (rel: string) => readFileSync(resolve(repoDir, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const pkg = JSON.parse(read('package.json')) as Record<string, unknown> & {
  version: string;
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  sideEffects: unknown;
};

const NOT_PUBLISHED =
  "Not published yet: the npm scope @airplanemode and the PyPI and crates.io names are not reserved. The commands below were proven from locally built artifacts on macOS arm64 (an npm pack tarball installed offline into a fresh empty directory, a wheel installed into a fresh venv); publishing to the registries is the owner's step.";

describe('package.json', () => {
  it('is version 0.3.0-beta.2, public, ESM, node 22', () => {
    expect(pkg.version).toBe('0.3.0-beta.2');
    expect(pkg['name']).toBe('@airplanemode/runtime');
    expect(pkg['private']).toBe(false);
    expect(pkg['type']).toBe('module');
    expect((pkg['engines'] as { node: string }).node).toBe('>=22');
    expect(pkg['license']).toBe('Apache-2.0');
  });

  it('has the exports map with types for each entry, and ships dist, spec (without vectors and examples), LICENSE, NOTICE and README only', () => {
    const e = pkg.exports as Record<string, { types?: string; import?: string } | string>;
    for (const key of ['.', './backends', './spec']) {
      const v = e[key] as { types: string; import: string };
      expect(v.types, key).toMatch(/^\.\/dist\/.*\.d\.ts$/);
      expect(v.import, key).toMatch(/^\.\/dist\/.*\.js$/);
    }
    // the engine worker is its own export (a self-contained file; sideEffects covers it)
    expect(e['./worker']).toEqual({
      types: './dist/backends/index.d.ts',
      import: './dist/worker/engine-worker.js',
    });
    // Sprint 5: the helpers for an application's own workers (installEgressGuard, startModuleWorker)
    expect(e['./worker-support']).toEqual({
      types: './dist/worker-support.d.ts',
      import: './dist/worker-support.js',
    });
    expect(e['./spec/*.json']).toBe('./spec/*.json');
    expect(e['./package.json']).toBe('./package.json');
    expect(pkg.files.slice(0, 5)).toEqual(['dist', 'spec', 'LICENSE', 'NOTICE', 'README.md']);
    expect(pkg.files).toContain('!spec/vectors');
    expect(pkg.files).toContain('!spec/examples');
  });

  it('has no preinstall, install, postinstall, prepare or publish-time lifecycle script, and a pack:check script', () => {
    for (const s of [
      'preinstall',
      'install',
      'postinstall',
      'prepare',
      'prepublish',
      'prepublishOnly',
      'prepack',
      'postpack',
    ])
      expect(pkg.scripts[s], s).toBeUndefined();
    expect(pkg.scripts['pack:check']).toBe('node scripts/pack-check.mjs');
  });

  it('keeps both engines as optional peers only; the main entry has no dependencies', () => {
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg.peerDependencies['@huggingface/transformers']).toBe('4.3.1');
    expect(pkg.peerDependenciesMeta['@huggingface/transformers']).toEqual({ optional: true });
    for (const [name, v] of Object.entries(pkg.peerDependencies)) {
      expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.peerDependenciesMeta[name]!.optional, name).toBe(true);
    }
  });

  it('sideEffects names the worker files and is never false', () => {
    expect(pkg.sideEffects).not.toBe(false);
    expect(pkg.sideEffects).toEqual(['./dist/worker/*.js']);
  });
});

describe('tsup.config.ts', () => {
  const cfg = read('tsup.config.ts');
  it('has no source maps and keeps every engine external', () => {
    expect(cfg).toMatch(/sourcemap:\s*false/);
    for (const ext of ['@huggingface/transformers', 'onnxruntime-web', 'onnxruntime-common'])
      expect(cfg, ext).toContain(`'${ext}'`);
  });
});

describe('scripts/pack-check.mjs and its allow-list', () => {
  it('exist, and the allow-list is a commented file', () => {
    expect(existsSync(resolve(repoDir, 'scripts/pack-check.mjs'))).toBe(true);
    expect(existsSync(resolve(repoDir, 'scripts/url-allowlist.txt'))).toBe(true);
    expect(read('scripts/url-allowlist.txt')).toMatch(/^#/m);
  });

  it('checks the tarball contents, the engine-default URLs, the offline fresh-directory install and the Node call', () => {
    const src = read('scripts/pack-check.mjs');
    for (const needle of [
      'npm',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--cache',
      'init',
      'huggingface.co',
      'raw.githubusercontent.com',
      'cdn.jsdelivr.net',
      'unpkg.com',
      '.map',
      '5 * 1024 * 1024',
      'allowTestKeys',
      'valid',
      "'@airplanemode/runtime'",
    ])
      expect(src, needle).toContain(needle);
  });
});

describe('README, CHANGELOG, release.md, NOTICE, ci.yml', () => {
  const readme = read('README.md');

  it('README Status opens with the Sprint 7 line and says beta, not tag-ready (TD-30), with the promise limited to 0.3.x', () => {
    const status = flat(readme.slice(readme.indexOf('## Status'), readme.indexOf('## Install')));
    expect(status.startsWith('## Status Sprint 7 (20 Nov 2026): Working:')).toBe(true);
    expect(status).toContain('Not yet:');
    expect(status).toContain('beta, not tagged');
    expect(status).toContain('not tag-ready (TD-30)');
    expect(status).toContain('no breaking change within 0.3.x');
  });

  it("README 'What beta means' names the draft contracts, the unmet definition-of-done rows and what is not included (TD-36)", () => {
    const at = readme.indexOf('### What beta means');
    expect(at, 'a What beta means section').toBeGreaterThan(0);
    const section = flat(readme.slice(at, readme.indexOf('\n## ', at)));
    for (const s of [
      'no breaking change within 0.3.x',
      'storage API 0.4.1',
      'backend adapter 0.5.0',
      'event 0.1.6',
      'capability profile',
      'manifest verify with expectId',
      'worker host with generate (Stop, budget) and embed',
      'in-worker integrity',
      'worker-support exports',
      'DevTools panel',
      'three-OS CI read',
      '8 GB benchmark',
      'signed artifacts with a real key',
      'publish',
      'tag',
      'not tag-ready (TD-30)',
      'WebLLM (TD-08)',
      'key revocation',
    ])
      expect(section, s).toContain(s);
  });

  it('README Install carries the exact honest sentence, the offline tarball commands and an After the owner publishes block', () => {
    const install = flat(
      readme.slice(readme.indexOf('## Install'), readme.indexOf('## Quick start')),
    );
    expect(install).toContain(NOT_PUBLISHED);
    for (const cmd of [
      'npm pack',
      'npm init -y',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ])
      expect(install, cmd).toContain(cmd);
    expect(install).toContain('After the owner publishes');
    // a bare registry command only inside the After block
    const before = install.slice(0, install.indexOf('After the owner publishes'));
    expect(before).not.toMatch(/npm (i|install) @airplanemode\/runtime(?!\S*\.tgz)/);
  });

  it('README has the DevTools panel section and the alpha Limitations', () => {
    const f = flat(readme);
    expect(f).toContain('## DevTools panel');
    expect(f).toContain('npm run devtools:build');
    expect(f).toContain('Load unpacked');
    const lim = flat(readme.slice(readme.indexOf('## Limitations'), readme.indexOf('## Security')));
    for (const s of [
      "Chrome's non-standard performance.memory",
      'absent in workers, so worker figures may all be null',
      'not on the Chrome Web Store',
      'not measured on 8 GB',
      'Pages sends no headers',
      'Apple silicon only',
    ])
      expect(lim, s).toContain(s);
  });

  it('README Benchmarks has an 8 GB Windows no-GPU laptop column reading not measured, and cites no /private/tmp path', () => {
    expect(flat(readme)).toContain('8 GB Windows no-GPU laptop');
    expect(flat(readme)).toContain('not measured');
    expect(readme).not.toContain('/private/tmp');
  });

  it('T3-S5-14 (updated in Sprint 7): the README states the CI facts it read, and claims nothing green that it has not read', () => {
    const f = flat(readme);
    // read with gh on 20 Nov 2026 (D1/partA-ci.log): the Sprint 6 head 7d3777b was green on three operating systems
    expect(f).toContain(
      'CI status: at 7d3777b (19 Nov 2026) `check (<os>)` on all three operating systems, `model-wasm (ubuntu-latest)` and the Pages deploy were green (CI run 44580189216, pages run 44580189184)',
    );
    // the new job has not run on GitHub yet, and the README says so
    expect(f).toContain(
      "Sprint 7 adds the job `release-rehearsal (<os>)`; it first runs after the owner's next push, and nothing here claims it green until then",
    );
    expect(f).not.toMatch(/on 9 Nov 2026,? green/);
    expect(f).not.toContain('CI at that head red: run 43667709960');
  });

  it('T3-S5-15: every cell of the 8 GB laptop column in the README Benchmarks tables reads exactly "not measured on 8 GB"', () => {
    const start = readme.indexOf('\n## Benchmarks');
    const end = readme.indexOf('\n## ', start + 5);
    const section = readme.slice(start, end);
    const rows = section.split('\n').filter((l) => l.startsWith('|'));
    expect(rows.length).toBeGreaterThan(20);
    let tables = 0;
    let cells = 0;
    for (const row of rows) {
      const cols = row
        .slice(1, row.lastIndexOf('|'))
        .split('|')
        .map((c) => c.trim());
      const last = cols[cols.length - 1]!;
      if (/^-+$/.test(last)) continue;
      if (/Scenario/.test(cols[0]!)) {
        tables++;
        expect(last, row.slice(0, 60)).toBe('8 GB laptop');
        continue;
      }
      cells++;
      expect(last, row.slice(0, 60)).toBe('not measured on 8 GB');
    }
    expect(tables).toBe(2);
    expect(cells).toBeGreaterThan(15);
  });

  it('CHANGELOG has the 0.3.0-beta.1 section (untagged) for Sprint 6 with Added, Changed, Fixed, Security and Known gaps, naming the ids and the spec release', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain('## [0.3.0-beta.1] - 2026-11-19 (untagged)');
    const start = log.indexOf('## [0.3.0-beta.1]');
    const section = log.slice(start, log.indexOf('\n## [', start + 5));
    for (const h of ['### Added', '### Changed', '### Fixed', '### Security', '### Known gaps'])
      expect(section, h).toContain(h);
    for (const id of [
      'spec release 0.6.0',
      'S1-113',
      'weak_key_refused',
      'TD-54',
      'TD-57',
      'TD-68',
      'TD-69',
      'TD-81',
      'S1-116',
      'S1-119',
      'S1-036',
      'T3-R2-05',
      'T3-R2-06',
      'R16',
      'R17',
      'R18',
      'R19',
      'R20',
      'model.unload',
      'out_of_memory',
      'engine-load-retry.md',
      'skipped 1',
      'not measured on 8 GB',
    ])
      expect(section, id).toContain(id);
    expect(section).toContain('no tag, no publish');
    expect(log.indexOf('## [0.3.0-beta.1]')).toBeLessThan(log.indexOf('## [0.3.0-beta.0]'));
  });

  it('CHANGELOG has the 0.3.0-beta.2 section (untagged) for Sprint 7 with Added, Changed, Fixed, Security and Deferred, naming the ids and the spec release', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain('## [0.3.0-beta.2] - 2026-11-20 (untagged)');
    const start = log.indexOf('## [0.3.0-beta.2]');
    const section = log.slice(start, log.indexOf('\n## [', start + 5));
    for (const h of ['### Added', '### Changed', '### Fixed', '### Security', '### Deferred'])
      expect(section, h).toContain(h);
    for (const id of [
      'spec release 0.6.1',
      'D1-01',
      'D1-02',
      'D1-03',
      'D1-04',
      'D1-05',
      'D1-06',
      'D1-07',
      'D1-08',
      'TD-103',
      'TD-105',
      'TD-106',
      'TD-107',
      'TD-112',
      'TD-115',
      'TD-116',
      'TD-117',
      'TD-118',
      'TD-121',
      'S1-127',
      'S1-129',
      'release-rehearsal',
      'publish.yml',
      'release-tool',
      'vite 8.3.8',
      'vitest 5.1.0',
      'no tag, no publish',
      'not measured on 8 GB',
    ])
      expect(section, id).toContain(id);
    expect(log.indexOf('## [0.3.0-beta.2]')).toBeLessThan(log.indexOf('## [0.3.0-beta.1]'));
  });

  it('CHANGELOG keeps the Sprint 5 section as 0.3.0-beta.0 (untagged) with Added, Changed, Fixed and Security, naming the fixes and the spec release', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain('## [0.3.0-beta.0] - 2026-11-18 (untagged)');
    const start = log.indexOf('## [0.3.0-beta.0]');
    expect(start, '## [0.3.0-beta.0]').toBeGreaterThan(0);
    const section = log.slice(start, log.indexOf('\n## [', start + 5));
    for (const h of ['### Added', '### Changed', '### Fixed', '### Security'])
      expect(section, h).toContain(h);
    for (const id of [
      '0.3.0-beta.0',
      'spec release 0.5.0',
      'expectId',
      'unexpected_id',
      'S1-070',
      'S1-097',
      'S1-102',
      'S1-039',
      'R14',
      'R15',
      'worker-support',
      'model.embed',
      'model.memory',
      'bundle-models',
      'model.spec.ts',
      'devtools-hook.test.ts',
    ])
      expect(section, id).toContain(id);
    expect(section).toContain('no tag, no publish');
    expect(log.indexOf('## [0.3.0-beta.0]')).toBeLessThan(log.indexOf('## [0.2.0-alpha.1]'));
  });

  it('CHANGELOG has the 0.2.0-alpha.0 heading with ids on every Added, Changed, Fixed and Security line', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain('## [0.2.0-alpha.0] - UNRELEASED (not tagged, not published)');
    const section = log.slice(
      log.indexOf('## [0.2.0-alpha.0]'),
      log.indexOf('\n## [', log.indexOf('## [0.2.0-alpha.0]') + 5) === -1
        ? undefined
        : log.indexOf('\n## [', log.indexOf('## [0.2.0-alpha.0]') + 5),
    );
    for (const h of ['### Added', '### Changed', '### Fixed', '### Security'])
      expect(section, h).toContain(h);
    for (const id of ['S1-053', 'S1-066', 'T1-S2-07', 'D1-06', 'D1-07', 'D1-10'])
      expect(section, id).toContain(id);
  });

  it('CHANGELOG has the 0.2.0-alpha.1 heading (untagged) with every fixed id named and WebLLM described as cut', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain('## [0.2.0-alpha.1] - 2026-11-14 (untagged)');
    expect(log.indexOf('## [0.2.0-alpha.1]')).toBeLessThan(log.indexOf('## [0.2.0-alpha.0]'));
    const start = log.indexOf('## [0.2.0-alpha.1]');
    const section = log.slice(start, log.indexOf('\n## [', start + 5));
    for (const h of ['### Added', '### Changed', '### Fixed', '### Security'])
      expect(section, h).toContain(h);
    for (const id of ['S1-074', 'S1-075', 'BUG-T2-S3-22', 'BUG-T2-S3-23-R2', 'T3-S3-035'])
      expect(section, id).toContain(id);
    expect(section).toContain('manifest spec v0.1 published in runtime/spec');
    expect(section).toContain("committed; public after the owner's push");
    expect(section).toContain('WebLLM: not yet (cut from Sprint 4');
    expect(section).not.toMatch(/\bcompliance\b|\bDPDP\b|\bAIBOM\b/);
  });

  it('docs/release.md has seven definition-of-done rows; the CI row is not Done; every Open row has an Owner must line', () => {
    const md = read('docs/release.md');
    const rows = md.split('\n').filter((l) => /^\|\s*[1-7]\s*\|/.test(l));
    expect(rows).toHaveLength(7);
    const ci = rows.find((r) => /CI/.test(r))!;
    expect(ci).toContain(
      "tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push",
    );
    expect(ci).not.toMatch(/\|\s*Done\s*\|/);
    for (const r of rows) expect(r).toMatch(/\|\s*(Done|Open|Partial)[^|]*\|/);
    const open = rows.filter((r) => /\|\s*Open/.test(r));
    expect(open.length).toBeGreaterThanOrEqual(5);
    const ownerMust = (md.match(/Owner must:/g) ?? []).length;
    expect(ownerMust).toBeGreaterThanOrEqual(open.length);
    expect(md).toContain('cp-sign');
    expect(md).toContain('keygen');
    expect(md).toContain('release-manifest');
  });

  it('every npm job of ci.yml and pages.yml installs with npm ci --ignore-scripts (S1-079 hygiene)', () => {
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/pages.yml']) {
      const text = read(f);
      const installs = [...text.matchAll(/run:\s*(npm ci[^\n]*)/g)].map((m) => m[1]!);
      expect(installs.length, f).toBeGreaterThan(0);
      for (const i of installs) expect(i, f).toContain('--ignore-scripts');
      expect(text, f).not.toMatch(/run:\s*npm (i|install)\b/);
    }
  });

  it('pack-check proves the beta: the worker-support entry, no test hook in the build, spec release 0.6.1, expectId and the weak-key refusal from the tarball', () => {
    const src = read('scripts/pack-check.mjs');
    for (const needle of [
      'dist/worker-support.js',
      'RUNTIME_TEST_HOOKS',
      'test-probe',
      'expectId',
      'unexpected_id',
      "'0.6.1'",
      "'0.1.4'",
      "'0.5.0'",
      'weak_key_refused',
      'beta, not tagged',
    ])
      expect(src, needle).toContain(needle);
  });

  it('ci.yml runs pack:check in the check job, with every pin unchanged', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run pack:check');
    for (const m of ci.matchAll(/uses:\s*(\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(ci).toMatch(/os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  });

  it('NOTICE names the alpha package contents', () => {
    expect(flat(read('NOTICE'))).toContain('no runtime dependencies');
  });
});
