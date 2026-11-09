/**
 * @airplanemode/runtime
 *
 * Capability profile, verified asset manager, manifest verification, event bus, MockAdapter and
 * the five open contracts (re-exported from ./spec).
 */

export * from '../spec/index';

export {
  AssetManager,
  type AssetManagerOptions,
  type DownloadProgress,
  type EnsureOptions,
  type IndexRow,
  type LoadManifestOptions,
  type ReconcileResult,
  type StoreChoice,
} from './asset-manager';
export {
  AssetError,
  isQuotaExceeded,
  type AssetErrorCode,
  type AssetErrorDetails,
  type NetworkReason,
} from './errors';
export {
  detectCapabilities,
  envFromGlobals,
  SIMD_PROBE,
  type CapabilityEnv,
  type GlobalLike,
  type GpuAdapterLike,
  type GpuLike,
  type StorageLike,
} from './capability';
export { satisfies } from './satisfies';
export {
  InMemoryManifestState,
  ManifestError,
  RFC8032_TEST_KEY_ID,
  isAllowedAssetUrl,
  isLoopbackHost,
  parseManifest,
  verifyManifest,
  type ManifestState,
  type ManifestStateStore,
  type SignatureCheck,
  type TrustSet,
  type VerifyOptions,
  type VerifyResult,
} from './manifest';
export { CanonicalError, canonicalize, signedBytes, type CanonicalReason } from './canonical';
export { compareSemver, parseSemver, type SemVer } from './semver';
export { EventBus, newEvent, sessionId, type EventListener, type NewEventInput } from './events';
export { MockAdapter, MOCK_EMBEDDING_DIMS } from './backends/mock';
export { Sha256, sha256, sha256Hex, toHex } from './sha256';
export {
  SCHEMAS,
  validateSchema,
  type JsonSchema,
  type SchemaError,
  type SchemaResult,
} from './schema';
export { MemoryAssetStore } from './store/memory';
export { OpfsAssetStore } from './store/opfs';
export { IndexedDbAssetStore, IDB_NAME } from './store/indexeddb';
export {
  InProcessLockProvider,
  WebLocksProvider,
  defaultLockProvider,
  LOCK_PREFIX,
  type LockManagerLike,
} from './store/locks';
export {
  emptyIndex,
  type AssetStore,
  type IndexFile,
  type IndexRowStored,
  type LockProvider,
  type PartState,
  type StoreEstimate,
  type StoreKind,
  type StoreListing,
} from './store/types';
