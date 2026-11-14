/**
 * Model descriptor contract 0.2.1 (airplanemode.model/0.2), part of the backend-adapter 0.3.1
 * contract.
 *
 * Normative JSON Schema: model-descriptor.schema.json ($id urn:airplanemode:spec:model-descriptor:0.2.1).
 *
 * 0.2.1 (spec release 0.4.0, wire-compatible patch): branch C (webllm) pins the 0.2 wire string
 * (BUG-T2-S3-22: a webllm descriptor with airplanemode.model/0.1 is schema-invalid), a repeated
 * member name at any depth is invalid_json, and DESCRIPTOR_REJECT_PRECEDENCE fixes which reason wins
 * when several faults hold (a missing "spec" is bad_spec, duplicate devices are schema; S1-075).
 *
 * 0.2.0 adds `sessionOptions` (transformers-js only) and fixes the shape of the webllm branch:
 * devices exactly ['webgpu'], `modelLib` required, `runtimeWasm` and `sessionOptions` absent.
 * Consumers accept both wire strings (MODEL_DESCRIPTOR_SPECS_ACCEPTED); writers emit 0.2. A 0.1
 * descriptor never carries `sessionOptions`.
 *
 * A model usually is not one file: weights, tokenizer, configs and a WASM runtime. A descriptor is a
 * small JSON file, itself an entry of a signed manifest (kind 'model', mediaType
 * MODEL_DESCRIPTOR_MEDIA_TYPE), that lists the other manifest entries an engine needs and how to
 * run them. The manifest signature and the per-entry SHA-256 therefore cover the descriptor and
 * every file it names; a descriptor never carries a URL and nothing in it is ever fetched
 * (`source` is provenance only).
 *
 * This file imports nothing from the other spec files (it is vendored on its own).
 */

/** Wire-format discriminator that writers emit. */
export const MODEL_DESCRIPTOR_SPEC = 'airplanemode.model/0.2' as const;
/** Every wire string a consumer accepts; it rejects any other value (reason 'bad_spec'). */
export const MODEL_DESCRIPTOR_SPECS_ACCEPTED = Object.freeze([
  'airplanemode.model/0.1',
  'airplanemode.model/0.2',
] as const);
export type ModelDescriptorSpec = (typeof MODEL_DESCRIPTOR_SPECS_ACCEPTED)[number];

/**
 * Why a descriptor is rejected. `invalid_json` to `lone_surrogate` are the canonical parse rules
 * shared with the manifest; `bad_spec` is an unknown wire string; `schema` covers every JSON Schema
 * fault plus the code-checked rule that `modelLib` and `runtimeWasm` name a path listed in `files`;
 * `unsorted_files`, `duplicate_paths` and `unsorted_devices` are the ordering rules JSON Schema
 * cannot express; `invalid_key` also covers the prototype-polluting keys `__proto__`, `constructor`
 * and `prototype` in `generation.chatTemplateKwargs`.
 */
export const DESCRIPTOR_REJECT_REASONS = Object.freeze([
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
] as const);
export type DescriptorRejectReason = (typeof DESCRIPTOR_REJECT_REASONS)[number];

/**
 * Reason precedence (normative): the reason is the first stage below that fails. Shared vectors never
 * combine two parse-stage faults, so the order inside the first group is not tested.
 *
 *  1. parse stage: invalid_json (including a repeated member name at any depth), float, bigint,
 *     digit_key, invalid_key, lone_surrogate
 *  2. bad_spec (a missing, non-string or unknown spec)
 *  3. schema (every JSON Schema fault, including duplicate devices through uniqueItems, `modelLib` or
 *     `runtimeWasm` not listed in `files`, and an explicit null on a banned property)
 *  4. unsorted_files
 *  5. duplicate_paths
 *  6. unsorted_devices
 *
 * `invalid_key` for a prototype-polluting `generation.chatTemplateKwargs` key (`__proto__`,
 * `constructor`, `prototype`) is a code-checked rule that ranks after unsorted_devices.
 */
export const DESCRIPTOR_REJECT_PRECEDENCE: readonly (readonly DescriptorRejectReason[])[] =
  Object.freeze([
    Object.freeze([
      'invalid_json',
      'float',
      'bigint',
      'digit_key',
      'invalid_key',
      'lone_surrogate',
    ] as const),
    Object.freeze(['bad_spec'] as const),
    Object.freeze(['schema'] as const),
    Object.freeze(['unsorted_files'] as const),
    Object.freeze(['duplicate_paths'] as const),
    Object.freeze(['unsorted_devices'] as const),
  ]);

/** `mediaType` of the manifest entry that holds a descriptor. */
export const MODEL_DESCRIPTOR_MEDIA_TYPE = 'application/vnd.airplanemode.model+json' as const;

/** A descriptor entry larger than this is refused before anything is downloaded (bad_descriptor). */
export const MODEL_DESCRIPTOR_MAX_BYTES = 65536 as const;

/** 'webllm' runs on 'webgpu' only (devices is exactly ['webgpu']) and needs `modelLib`. */
export type ModelEngine = 'transformers-js' | 'webllm';
export type ModelTask = 'text-generation' | 'feature-extraction';
/** The execution devices a descriptor supports; 1 or 2 items, unique, sorted ('wasm' < 'webgpu'). */
export type ModelDevice = 'wasm' | 'webgpu';

/**
 * One file of a model: `path` is where the engine expects it (relative, `/`-separated, no
 * traversal) and `entryId` names the manifest entry that holds its bytes. The entry's kind must not
 * be a descriptor. Paths: at most 256 characters, matching
 * `^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){0,7}$`, so no leading dot,
 * no `..`, no empty segment and no backslash.
 */
export interface ModelFile {
  path: string;
  /** `^[a-z0-9][a-z0-9._-]{0,127}$`, an id in the same manifest as the descriptor. */
  entryId: string;
}

export interface ModelGeneration {
  /** Default token budget when the caller gives none, 1..32768. */
  maxNewTokens?: number;
  /**
   * Extra variables for the chat template, for example `{ "enable_thinking": false }` for Qwen3.
   * Keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and are never `__proto__`, `constructor` or
   * `prototype` (rejected with reason `invalid_key`); values are strings, integers or booleans. An
   * engine adapter copies them into a fresh object literal, never with Object.assign, for-in or spread.
   */
  chatTemplateKwargs?: Record<string, string | number | boolean>;
}

/** ONNX Runtime session options a descriptor may set (transformers-js, 0.2 only). */
export interface ModelSessionOptions {
  /**
   * ONNX Runtime graphOptimizationLevel. The planned Qwen3-1.7B q4f16 builds only with 'disabled'
   * (the default 'all' runs out of the 4 GB WebAssembly heap). 'disabled' is accepted: it changes
   * only graph transforms, and the descriptor is hash-pinned by the signed manifest.
   */
  graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'layout' | 'all';
}

/** Where the files came from. Provenance only: never fetched, never trusted. */
export interface ModelSource {
  /** `owner/name` on the hosting site. */
  repo: string;
  /** 40-hex commit revision. */
  revision: string;
}

export interface ModelDescriptor {
  spec: ModelDescriptorSpec;
  /** `^[a-z0-9][a-z0-9._-]{0,127}$`: the logical model id; two descriptors (one per device) may share it. */
  id: string;
  engine: ModelEngine;
  task: ModelTask;
  /** 1..2 items, unique, sorted. */
  devices: ModelDevice[];
  /** Quantisation label, `^[a-z0-9_]{1,16}$`, for example q4, q8, q4f16. */
  dtype: string;
  /** 1..256 items sorted by `path` (byte order), paths unique. */
  files: ModelFile[];
  /**
   * Path (listed in `files`) of the engine's WASM runtime; required for 'transformers-js' and
   * absent for 'webllm'.
   */
  runtimeWasm?: string;
  /**
   * Path (listed in `files`) of the compiled model library; required for 'webllm' and absent for
   * 'transformers-js'.
   */
  modelLib?: string;
  /**
   * 0.2 and transformers-js only; absent for webllm and for wire string 0.1. Reaches ONNX Runtime
   * session_options as a fresh object literal built from the validated fields; never Object.assign,
   * for-in or spread of the parsed object. A deprecated application option wins when given.
   */
  sessionOptions?: ModelSessionOptions;
  /** Integer 1..1048576. */
  contextLength: number;
  generation?: ModelGeneration;
  source: ModelSource;
  /** SPDX expression of the model weights. */
  licence: string;
}
