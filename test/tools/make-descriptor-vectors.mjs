#!/usr/bin/env node
// Generates the shared model-descriptor vectors under spec/vectors/descriptor/:
//   pos-<n>-<name>.json   descriptors both implementations must accept
//   neg-<name>.json       descriptors both implementations must reject, each with the reason in
//                         negative.json
//
// control-plane vendors these byte for byte. The revisions and entry ids are synthetic.
//
//   node test/tools/make-descriptor-vectors.mjs [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../spec/vectors/descriptor');
const examples = resolve(here, '../../spec/examples');
const read = (f) => JSON.parse(readFileSync(resolve(examples, f), 'utf8'));
const clone = (v) => structuredClone(v);

const tjs = read('model-descriptor.example.json'); // 0.2, transformers-js, no sessionOptions
const webllm = read('model-descriptor.webllm.example.json');

const edit = (base, fn) => {
  const d = clone(base);
  fn(d);
  return d;
};

const positive = {
  'pos-01-tjs-0.1': edit(tjs, (d) => {
    d.spec = 'airplanemode.model/0.1';
  }),
  'pos-02-tjs-0.2-session': edit(tjs, (d) => {
    d.sessionOptions = { graphOptimizationLevel: 'disabled' };
  }),
  'pos-03-webllm-0.2': clone(webllm),
};

// Each negative is a (name, reason, descriptor-or-raw-text) triple.
const negative = [
  [
    'neg-session-unknown-key',
    'schema',
    edit(tjs, (d) => {
      d.sessionOptions = { externalData: [] };
    }),
  ],
  [
    'neg-session-bad-level',
    'schema',
    edit(tjs, (d) => {
      d.sessionOptions = { graphOptimizationLevel: 'turbo' };
    }),
  ],
  [
    'neg-session-on-webllm',
    'schema',
    edit(webllm, (d) => {
      d.sessionOptions = { graphOptimizationLevel: 'disabled' };
    }),
  ],
  [
    'neg-session-in-0.1',
    'schema',
    edit(tjs, (d) => {
      d.spec = 'airplanemode.model/0.1';
      d.sessionOptions = { graphOptimizationLevel: 'disabled' };
    }),
  ],
  [
    'neg-webllm-wasm-device',
    'schema',
    edit(webllm, (d) => {
      d.devices = ['wasm', 'webgpu'];
    }),
  ],
  [
    'neg-webllm-no-modellib',
    'schema',
    edit(webllm, (d) => {
      delete d.modelLib;
    }),
  ],
  [
    'neg-path-traversal',
    'schema',
    edit(tjs, (d) => {
      d.files[0].path = '../etc/passwd';
    }),
  ],
  [
    'neg-unsorted-files',
    'unsorted_files',
    edit(tjs, (d) => {
      [d.files[0], d.files[1]] = [d.files[1], d.files[0]];
    }),
  ],
  [
    'neg-dup-paths',
    'duplicate_paths',
    edit(tjs, (d) => {
      d.files[1] = { ...d.files[1], path: d.files[0].path };
    }),
  ],
  [
    'neg-bad-spec',
    'bad_spec',
    edit(tjs, (d) => {
      d.spec = 'airplanemode.model/0.3';
    }),
  ],
  [
    'neg-tjs-modellib',
    'schema',
    edit(tjs, (d) => {
      d.modelLib = d.runtimeWasm;
    }),
  ],
  [
    'neg-webllm-runtimewasm',
    'schema',
    edit(webllm, (d) => {
      d.runtimeWasm = d.modelLib;
    }),
  ],
  [
    'neg-modellib-not-in-files',
    'schema',
    edit(webllm, (d) => {
      d.modelLib = 'runtime/not-listed.wasm';
    }),
  ],
  [
    'neg-kwargs-proto-key',
    'invalid_key',
    // JSON.stringify would drop an own "__proto__" key set by assignment, so this one is raw text
    JSON.stringify(
      edit(tjs, (d) => {
        d.generation = { maxNewTokens: 256, chatTemplateKwargs: { marker: true } };
      }),
      null,
      2,
    ).replace('"marker": true', '"__proto__": true'),
  ],
  // Spec release 0.4.0 (model descriptor 0.2.1).
  // Branch C (webllm) pins the 0.2 wire string (BUG-T2-S3-22): 0.1 predates webllm.
  [
    'neg-webllm-spec-0.1',
    'schema',
    edit(webllm, (d) => {
      d.spec = 'airplanemode.model/0.1';
    }),
  ],
  // A missing "spec" is bad_spec, never schema.
  [
    'neg-missing-spec',
    'bad_spec',
    edit(tjs, (d) => {
      delete d.spec;
    }),
  ],
  // Duplicate devices fail the schema (uniqueItems) in every implementation (S1-075, BUG-T2-S3-23-R2).
  [
    'neg-dup-devices',
    'schema',
    edit(tjs, (d) => {
      d.devices = ['wasm', 'wasm'];
    }),
  ],
  // Reason precedence (README): the earlier stage names the reason. Each pair is one fault of an
  // earlier stage and one ordering fault; shared vectors never combine two parse-stage faults.
  [
    'neg-multi-badspec-unsorted',
    'bad_spec',
    edit(tjs, (d) => {
      d.spec = 'airplanemode.model/0.3';
      [d.files[0], d.files[1]] = [d.files[1], d.files[0]];
    }),
  ],
  [
    'neg-multi-schema-unsorted',
    'schema',
    edit(tjs, (d) => {
      d.dtype = 'Q4!';
      [d.files[0], d.files[1]] = [d.files[1], d.files[0]];
    }),
  ],
  // Fix round 2 (TD-29, BUG-T2-S4-11): a member that the schema does not declare is `schema`, whatever its
  // name. Own "__proto__" member at the top level: JSON.parse makes it an own member, `k in props` found it
  // through Object.prototype, so the old validator accepted a descriptor carrying unsigned-by-schema data.
  // Raw text, because JSON.stringify of an object literal would turn the key into a prototype.
  [
    'neg-proto-member',
    'schema',
    JSON.stringify(
      edit(tjs, () => {}),
      null,
      2,
    ).replace(/^\{\n/, '{\n  "__proto__": { "engine": "webllm" },\n'),
  ],
];

// The files are committed prettier-formatted (the repository's fmt:check covers them), so the
// generator formats with the repository's own prettier configuration.
const prettierOptions = {
  ...((await resolveConfig(resolve(out, 'x.json'))) ?? {}),
  parser: 'json',
};
const text = async (v) =>
  format(typeof v === 'string' ? v : JSON.stringify(v, null, 2), prettierOptions);
const files = new Map();
for (const [name, doc] of Object.entries(positive)) files.set(`${name}.json`, await text(doc));
for (const [name, , doc] of negative) files.set(`${name}.json`, await text(doc));
files.set(
  'negative.json',
  await text(negative.map(([name, reason]) => ({ file: `${name}.json`, reason }))),
);

const check = process.argv.includes('--check');
if (!check) mkdirSync(out, { recursive: true });
let bad = 0;
for (const [file, body] of files) {
  const path = resolve(out, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
      console.error(`stale: ${file}`);
      bad++;
    }
  } else writeFileSync(path, body);
}
if (check) {
  const extra = existsSync(out)
    ? readdirSync(out).filter((f) => f.endsWith('.json') && !files.has(f))
    : [];
  for (const f of extra) {
    console.error(`unexpected: ${f}`);
    bad++;
  }
  if (bad) process.exit(1);
  console.log(`descriptor vectors up to date (${files.size} files)`);
} else console.log(`wrote ${files.size} files to ${out}`);
