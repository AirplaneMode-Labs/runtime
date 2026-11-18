import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORT_FACTORY_FILE,
  ORT_FACTORY_SHA256,
  ORT_PINS,
  ORT_WASM_FILE,
  ORT_WASM_SHA256,
  ORT_WEB_VERSION,
} from '../src/backends/ort-pins';
import { repoDir } from './helpers';

const dist = resolve(repoDir, 'node_modules/onnxruntime-web/dist');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('ort-pins.ts matches the installed onnxruntime-web (re-hashes the files; fails on drift)', () => {
  it('S1-055: pins the stable onnxruntime-web 1.31.1 that package.json overrides in and that is installed', () => {
    expect(ORT_WEB_VERSION).toBe('1.31.1');
    expect(ORT_WEB_VERSION).not.toMatch(/dev/);
    const pkg = JSON.parse(readFileSync(resolve(repoDir, 'package.json'), 'utf8')) as {
      overrides: Record<string, string>;
    };
    expect(pkg.overrides['onnxruntime-web']).toBe(ORT_WEB_VERSION);
    const installed = JSON.parse(
      readFileSync(resolve(repoDir, 'node_modules/onnxruntime-web/package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe(ORT_WEB_VERSION);
    // the engine still declares the nightly it was tested with; the override replaces it
    const hf = JSON.parse(
      readFileSync(resolve(repoDir, 'node_modules/@huggingface/transformers/package.json'), 'utf8'),
    ) as { version: string; dependencies: Record<string, string> };
    expect(hf.version).toBe('4.3.1');
    expect(hf.dependencies['onnxruntime-web']).toMatch(/^1\.31\.0-dev\./);
  });

  it('the lockfile entry of onnxruntime-web is the registry tarball with a sha512 integrity', () => {
    const lock = JSON.parse(readFileSync(resolve(repoDir, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string; resolved: string; integrity: string }>;
    };
    const e = lock.packages['node_modules/onnxruntime-web']!;
    expect(e.version).toBe(ORT_WEB_VERSION);
    expect(e.resolved).toBe(
      `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT_WEB_VERSION}.tgz`,
    );
    expect(e.integrity).toMatch(/^sha512-/);
    // onnxruntime-node keeps its own onnxruntime-common at the top level; the web package's is nested
    const common =
      lock.packages['node_modules/onnxruntime-web/node_modules/onnxruntime-common'] ??
      lock.packages['node_modules/onnxruntime-common']!;
    expect(common.version).toBe(ORT_WEB_VERSION);
  });

  it('the demo model bundle writes an ort block into PROVENANCE.json with the pins and the cross-check', () => {
    // since Sprint 5 the demo models come from scripts/bundle-models.mjs, which writes the ort block
    const src = readFileSync(resolve(repoDir, 'scripts/bundle-models.mjs'), 'utf8');
    for (const key of [
      'ort:',
      'version',
      'npmIntegrity',
      'attestations',
      'wasmSha256',
      'factorySha256',
      'crossCheck',
    ])
      expect(src, key).toContain(key);
    expect(src).toContain('package-lock.json');
  });

  it('the wasm binary hashes to ORT_WASM_SHA256', () => {
    expect(ORT_WASM_FILE).toMatch(/^ort-wasm-[a-z.-]+\.wasm$/);
    expect(ORT_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(resolve(dist, ORT_WASM_FILE))).toBe(ORT_WASM_SHA256);
  });

  it('the wasm factory hashes to ORT_FACTORY_SHA256', () => {
    expect(ORT_FACTORY_FILE).toMatch(/^ort-wasm-[a-z.-]+\.mjs$/);
    expect(ORT_FACTORY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(resolve(dist, ORT_FACTORY_FILE))).toBe(ORT_FACTORY_SHA256);
  });

  it('the factory and the wasm are the same ORT build variant (matching file stems)', () => {
    expect(ORT_FACTORY_FILE.replace(/\.mjs$/, '')).toBe(ORT_WASM_FILE.replace(/\.wasm$/, ''));
  });

  it('one pin per device, both complete', () => {
    for (const device of ['wasm', 'webgpu'] as const) {
      const p = ORT_PINS[device];
      expect(p.wasmFile).toMatch(/\.wasm$/);
      expect(p.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(resolve(dist, p.wasmFile))).toBe(p.wasmSha256);
      expect(sha256(resolve(dist, p.factoryFile))).toBe(p.factorySha256);
    }
    expect(ORT_PINS.wasm.wasmSha256).toBe(ORT_WASM_SHA256);
  });
});
