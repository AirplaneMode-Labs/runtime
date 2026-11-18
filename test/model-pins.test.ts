// D1-07: the pins of the two demo models (TD-33 Qwen3-0.6B q8, TD-34 multilingual-e5-small q8) agree with
// two independent sources: the Hugging Face tree JSON committed under test/fixtures/hf-tree/ (the LFS oid is
// the sha256 of an LFS file, the git oid the blob id of a small file; the size is the size) and the licence
// facts recorded for the base models. NOTICE names both models with licence, repo and revision.
// Written before the pins existed (red run: evidence/sprint-5/D1/red/D1-07.log).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitBlobSha1, type ModelsJson } from './tools/fetch-model.mjs';
import { repoDir } from './helpers';

const models = JSON.parse(
  readFileSync(resolve(repoDir, 'test/tools/models.json'), 'utf8'),
) as ModelsJson;
interface Tree {
  repo: string;
  revision: string;
  base: { repo: string; revision: string; licence: string; licenceFile: string };
  note: string;
  tree: { path: string; size: number; oid: string; lfsOid?: string }[];
}
const tree = (name: string): Tree =>
  JSON.parse(readFileSync(resolve(repoDir, 'test/fixtures/hf-tree', name), 'utf8')) as Tree;

const CASES = [
  {
    key: 'qwen3-0.6b-wasm-q8',
    fixture: 'onnx-community_Qwen3-0.6B-ONNX.json',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    revision: '79346d370dfae34801d26993fda9ae2372900fd0',
    licence: 'Apache-2.0',
    base: 'Qwen/Qwen3-0.6B',
    paths: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'onnx/model_quantized.onnx',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
    graph: { path: 'onnx/model_quantized.onnx', size: 617_687_575 },
  },
  {
    key: 'multilingual-e5-small-wasm-q8',
    fixture: 'Xenova_multilingual-e5-small.json',
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    licence: 'MIT',
    base: 'intfloat/multilingual-e5-small',
    paths: [
      'config.json',
      'onnx/model_quantized.onnx',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
    graph: { path: 'onnx/model_quantized.onnx', size: 118_308_185 },
  },
] as const;

for (const c of CASES) {
  describe(`${c.key}`, () => {
    const m = models.models[c.key];
    const t = tree(c.fixture);

    it('is pinned to the repo, the 40-hex revision and the licence the plan names', () => {
      expect(m).toBeDefined();
      expect(m!.repo).toBe(c.repo);
      expect(m!.revision).toBe(c.revision);
      expect(m!.licence).toBe(c.licence);
      expect(t.repo).toBe(c.repo);
      expect(t.revision).toBe(c.revision);
      expect(t.base.repo).toBe(c.base);
      expect(t.base.licence).toBe(c.licence);
      expect(t.base.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(t.base.licenceFile).toContain(`${c.base}/blob/${t.base.revision}/`);
    });

    it('lists exactly the files the engine can read, with the graph size the plan states', () => {
      expect(m!.files.map((f) => f.path)).toEqual([...c.paths]);
      expect(m!.files.find((f) => f.path === c.graph.path)!.size).toBe(c.graph.size);
    });

    it('every sha256 equals the Hugging Face LFS oid, every small file git blob id and every size match the tree JSON', () => {
      for (const f of m!.files) {
        const row = t.tree.find((r) => r.path === f.path);
        expect(row, `${c.key}/${f.path} is in the tree fixture`).toBeDefined();
        expect(f.size, `${f.path} size`).toBe(row!.size);
        if (row!.lfsOid) expect(f.sha256, `${f.path} sha256 = LFS oid`).toBe(row!.lfsOid);
        else expect(f.gitBlobSha1, `${f.path} git blob id`).toBe(row!.oid);
        expect(f.sha256, `${f.path} has a sha256`).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
}

describe('licences and NOTICE (pre-pilot row 17)', () => {
  const notice = readFileSync(resolve(repoDir, 'NOTICE'), 'utf8');
  const flat = notice.replace(/\s+/g, ' ');

  it('NOTICE names both models with licence, source repo and pinned revision', () => {
    for (const s of [
      'Qwen3-0.6B',
      'Apache-2.0',
      'onnx-community/Qwen3-0.6B-ONNX',
      '79346d370dfae34801d26993fda9ae2372900fd0',
      'multilingual-e5-small',
      'MIT',
      'Xenova/multilingual-e5-small',
      '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    ])
      expect(flat, s).toContain(s);
  });

  it('no copyright line is invented for the MIT model', () => {
    expect(flat).toMatch(/multilingual-e5-small[^.]*MIT[^.]*\./);
    expect(flat).not.toMatch(/Copyright[^.]*(intfloat|Wang|Microsoft Research)/i);
  });

  it('a git blob id of a fixture row is what git would compute: the helper and the tree agree on the empty file', () => {
    expect(gitBlobSha1(new Uint8Array(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});
