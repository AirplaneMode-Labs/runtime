// D1-10: alpha packaging (0.2.0-alpha.0). Written before package.json, tsup.config.ts, README,
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
  it('is version 0.2.0-alpha.0, public, ESM, node 22', () => {
    expect(pkg.version).toBe('0.2.0-alpha.0');
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

  it('README Status says alpha, not tagged, no API stability before the beta', () => {
    const status = flat(readme.slice(readme.indexOf('## Status'), readme.indexOf('## Install')));
    expect(status).toContain('alpha, not tagged');
    expect(status).toContain('no API stability promise before the beta (Sprint 5)');
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
      'the main thread re-hashes during load',
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
