/**
 * @airplanemode/runtime/backends: the inference backends behind the BackendAdapter contract.
 *
 * Engines load only from this entry point; the main entry (`@airplanemode/runtime`) never imports
 * one. The Transformers.js engine package is an optional peer dependency, imported lazily by the
 * adapter on first load.
 */

export { MockAdapter, MOCK_EMBEDDING_DIMS } from './mock';
export {
  loadDescriptor,
  parseDescriptor,
  precheckDescriptorEntry,
  type DescriptorContext,
  type LoadedDescriptor,
  type ResolvedFile,
} from './descriptor';
export {
  VERIFIED_PATH_SEGMENT,
  VerifiedFileSet,
  createVerifiedFetch,
  defaultVerifiedPrefix,
  egressOrigin,
  registerVerifiedFiles,
  verifiedRegistrySize,
  type VerifiedFetch,
  type VerifiedFetchOptions,
  type VerifiedFileInput,
} from './verified-files';
export {
  TransformersAdapter,
  createTransformersAdapter,
  probeWebGpuDevice,
  type EngineEnv,
  type GpuLike,
  type EnginePipeline,
  type OrtPin,
  type SessionOptions,
  checkSessionOptions,
  type TransformersAdapterOptions,
  type TransformersModule,
} from './transformers';
export {
  ChromePromptAdapter,
  BUILTIN_MODEL_ENTRY,
  BUILTIN_MODEL_ID,
  createChromePromptAdapter,
  type ChromePromptAdapterOptions,
  type LanguageModelLike,
  type LanguageModelSessionLike,
} from './chrome-prompt';
export {
  BackendRefusedError,
  RELOAD_SENTENCE,
  createDefaultAdapters,
  loadWithFallback,
  type Attempt,
  type AttemptOutcome,
  type AttemptReason,
  type ChainAssets,
  type EngineStateProbe,
  type LoadWithFallbackOptions,
  type LoadWithFallbackResult,
  type Rung,
} from './chain';
export {
  ORT_FACTORY_FILE,
  ORT_FACTORY_SHA256,
  ORT_PINS,
  ORT_WASM_FILE,
  ORT_WASM_SHA256,
  ORT_WEB_VERSION,
} from './ort-pins';
