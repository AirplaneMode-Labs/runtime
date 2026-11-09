/**
 * Model descriptor contract 0.1.0 (airplanemode.model/0.1), part of the backend-adapter 0.2.0
 * contract.
 *
 * Normative JSON Schema: model-descriptor.schema.json ($id urn:airplanemode:spec:model-descriptor:0.1.0).
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

/** Wire-format discriminator. Consumers reject any other value. */
export const MODEL_DESCRIPTOR_SPEC = 'airplanemode.model/0.1' as const;
export type ModelDescriptorSpec = typeof MODEL_DESCRIPTOR_SPEC;

/** `mediaType` of the manifest entry that holds a descriptor. */
export const MODEL_DESCRIPTOR_MEDIA_TYPE = 'application/vnd.airplanemode.model+json' as const;

/** A descriptor entry larger than this is refused before anything is downloaded (bad_descriptor). */
export const MODEL_DESCRIPTOR_MAX_BYTES = 65536 as const;

/** `'webllm'` is reserved and unused until Sprint 3. */
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
   * Keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; values are strings, integers or booleans.
   */
  chatTemplateKwargs?: Record<string, string | number | boolean>;
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
  /** Path (listed in `files`) of the engine's WASM runtime; required for 'transformers-js'. */
  runtimeWasm?: string;
  /** Path (listed in `files`) of the compiled model library; required for 'webllm'. */
  modelLib?: string;
  /** Integer 1..1048576. */
  contextLength: number;
  generation?: ModelGeneration;
  source: ModelSource;
  /** SPDX expression of the model weights. */
  licence: string;
}
