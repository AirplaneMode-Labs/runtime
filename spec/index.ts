/**
 * @airplanemode/runtime/spec: the five open contracts (0.1.0).
 *
 * Source of truth for every AirplaneMode-Labs repo. Other repos vendor these files under
 * src/contracts/ and never edit them there.
 */

export * from './manifest';
export * from './capability-profile';
export * from './event';
export * from './storage-api';
export * from './backend-adapter';

export const SPEC_VERSIONS = Object.freeze({
  manifest: '0.1.0',
  capabilityProfile: '0.1.0',
  event: '0.1.0',
  storageApi: '0.1.0',
  backendAdapter: '0.1.0',
} as const);

/** Wire-format discriminators (major.minor) carried by instances. */
export const SPEC_WIRE = Object.freeze({
  manifest: 'airplanemode.manifest/0.1',
  capabilityProfile: 'airplanemode.capability/0.1',
  event: 'airplanemode.event/0.1',
} as const);
