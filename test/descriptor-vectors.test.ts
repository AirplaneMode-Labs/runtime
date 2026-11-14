// The shared model-descriptor vectors (spec/vectors/descriptor): 3 positive and 14 negative, each
// negative rejected with exactly the reason listed in negative.json, through the JSON Schema plus
// ordering checks (validateModelDescriptor) and through parseDescriptor. control-plane vendors the
// same files byte for byte.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import { DESCRIPTOR_REJECT_REASONS, type DescriptorRejectReason } from '../spec/model-descriptor';
import { parseDescriptor } from '../src/backends/descriptor';
import { SCHEMAS, validateModelDescriptor, validateSchema } from '../src/schema';
import { readJson, readText, specDir } from './helpers';

const dir = resolve(specDir, 'vectors/descriptor');
const POSITIVE = ['pos-01-tjs-0.1', 'pos-02-tjs-0.2-session', 'pos-03-webllm-0.2'];
const NEGATIVE_LIST = [
  ['neg-session-unknown-key', 'schema'],
  ['neg-session-bad-level', 'schema'],
  ['neg-session-on-webllm', 'schema'],
  ['neg-session-in-0.1', 'schema'],
  ['neg-webllm-wasm-device', 'schema'],
  ['neg-webllm-no-modellib', 'schema'],
  ['neg-path-traversal', 'schema'],
  ['neg-unsorted-files', 'unsorted_files'],
  ['neg-dup-paths', 'duplicate_paths'],
  ['neg-bad-spec', 'bad_spec'],
  ['neg-tjs-modellib', 'schema'],
  ['neg-webllm-runtimewasm', 'schema'],
  ['neg-modellib-not-in-files', 'schema'],
  ['neg-kwargs-proto-key', 'invalid_key'],
] as const;

function reasonOf(text: string): DescriptorRejectReason {
  try {
    parseDescriptor(text);
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe('bad_descriptor');
    return (e as AdapterError & { reason: DescriptorRejectReason }).reason;
  }
  throw new Error('expected parseDescriptor to throw');
}

describe('descriptor vectors: the directory', () => {
  it('has 3 positive files, 14 negative files, negative.json and README.md', () => {
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.filter((f) => f.startsWith('pos-')).sort()).toEqual(
      POSITIVE.map((p) => `${p}.json`).sort(),
    );
    expect(files.filter((f) => f.startsWith('neg-')).sort()).toEqual(
      NEGATIVE_LIST.map(([n]) => `${n}.json`).sort(),
    );
    expect(files).toContain('negative.json');
    expect(files).toContain('README.md');
  });

  it('negative.json lists every negative with its reason, and every reason is in the published list', () => {
    const rows = readJson<{ file: string; reason: string }[]>(resolve(dir, 'negative.json'));
    expect(rows.map((r) => [r.file.replace(/\.json$/, ''), r.reason])).toEqual(
      NEGATIVE_LIST.map(([n, r]) => [n, r]),
    );
    for (const r of rows)
      expect(DESCRIPTOR_REJECT_REASONS as readonly string[]).toContain(r.reason);
    expect([...DESCRIPTOR_REJECT_REASONS]).toEqual([
      'invalid_json',
      'float',
      'bigint',
      'digit_key',
      'invalid_key',
      'lone_surrogate',
      'bad_spec',
      'schema',
      'unsorted_files',
      'duplicate_paths',
      'unsorted_devices',
    ]);
  });

  it('README.md describes each vector', () => {
    const readme = readText(resolve(dir, 'README.md'));
    for (const n of [...POSITIVE, ...NEGATIVE_LIST.map(([n]) => n)]) expect(readme, n).toContain(n);
  });
});

describe('descriptor vectors: positive', () => {
  for (const name of POSITIVE) {
    it(`${name} validates and parses`, () => {
      const text = readText(resolve(dir, `${name}.json`));
      expect(validateModelDescriptor(JSON.parse(text)).errors).toEqual([]);
      const d = parseDescriptor(text);
      expect(d.id.length).toBeGreaterThan(0);
    });
  }

  it('pos-01 is the 0.1 wire string without sessionOptions; pos-02 carries sessionOptions; pos-03 is webllm', () => {
    const p1 = readJson<Record<string, unknown>>(resolve(dir, 'pos-01-tjs-0.1.json'));
    expect(p1['spec']).toBe('airplanemode.model/0.1');
    expect(p1['sessionOptions']).toBeUndefined();
    const p2 = readJson<Record<string, unknown>>(resolve(dir, 'pos-02-tjs-0.2-session.json'));
    expect(p2['spec']).toBe('airplanemode.model/0.2');
    expect(p2['sessionOptions']).toEqual({ graphOptimizationLevel: 'disabled' });
    const p3 = readJson<Record<string, unknown>>(resolve(dir, 'pos-03-webllm-0.2.json'));
    expect(p3['engine']).toBe('webllm');
    expect(p3['devices']).toEqual(['webgpu']);
    expect(typeof p3['modelLib']).toBe('string');
  });
});

describe('descriptor vectors: negative', () => {
  for (const [name, reason] of NEGATIVE_LIST) {
    it(`${name} is rejected by parseDescriptor with reason ${reason}`, () => {
      expect(reasonOf(readText(resolve(dir, `${name}.json`)))).toBe(reason);
    });

    it(`${name} is rejected by validateModelDescriptor (schema plus ordering and membership checks)`, () => {
      const doc = JSON.parse(readText(resolve(dir, `${name}.json`)));
      const r = validateModelDescriptor(doc);
      expect(r.ok, JSON.stringify(r.errors)).toBe(false);
    });
  }

  it('the schema alone rejects every vector whose fault JSON Schema can express', () => {
    const schemaOnly = [
      'neg-session-unknown-key',
      'neg-session-bad-level',
      'neg-session-on-webllm',
      'neg-session-in-0.1',
      'neg-webllm-wasm-device',
      'neg-webllm-no-modellib',
      'neg-path-traversal',
      'neg-bad-spec',
      'neg-tjs-modellib',
      'neg-webllm-runtimewasm',
    ];
    for (const n of schemaOnly) {
      const doc = readJson(resolve(dir, `${n}.json`));
      expect(validateSchema(SCHEMAS.modelDescriptor, doc).ok, n).toBe(false);
    }
    // the four code-checked faults pass the bare schema and are caught by the code checks
    for (const n of [
      'neg-unsorted-files',
      'neg-dup-paths',
      'neg-modellib-not-in-files',
      'neg-kwargs-proto-key',
    ]) {
      const doc = readJson(resolve(dir, `${n}.json`));
      expect(validateSchema(SCHEMAS.modelDescriptor, doc).ok, n).toBe(true);
    }
  });
});
