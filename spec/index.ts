/**
 * @airplanemode/runtime/spec: the five open contracts, released together as spec release 0.2.0
 * (draft): manifest 0.1.0, capability profile 0.1.0, event 0.1.1, storage API 0.1.0, backend
 * adapter 0.2.0 plus its model descriptor 0.1.0.
 *
 * Source of truth for every AirplaneMode-Labs repo. Other repos vendor these files under
 * src/contracts/ and never edit them there.
 */

export * from './manifest';
export * from './capability-profile';
export * from './event';
export * from './storage-api';
export * from './backend-adapter';
export * from './model-descriptor';

export const SPEC_VERSIONS = Object.freeze({
  manifest: '0.1.0',
  capabilityProfile: '0.1.0',
  event: '0.1.1',
  storageApi: '0.1.0',
  backendAdapter: '0.2.0',
  modelDescriptor: '0.1.0',
} as const);

/** Wire-format discriminators (major.minor) carried by instances. */
export const SPEC_WIRE = Object.freeze({
  manifest: 'airplanemode.manifest/0.1',
  capabilityProfile: 'airplanemode.capability/0.1',
  event: 'airplanemode.event/0.1',
  modelDescriptor: 'airplanemode.model/0.1',
} as const);
