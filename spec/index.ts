/**
 * @airplanemode/runtime/spec: the five open contracts, released together as spec release 0.4.0:
 * manifest 0.1.1 (status published: "manifest spec v0.1"), capability profile 0.1.0, event 0.1.3,
 * storage API 0.2.0, backend adapter 0.3.1 plus its model descriptor 0.2.1 (every other contract
 * is a draft). Committed; public after the owner's push.
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

/** The spec release these contract versions ship in (README Versioning: the release numbering rule). */
export const SPEC_RELEASE = '0.4.0' as const;

export const SPEC_VERSIONS = Object.freeze({
  manifest: '0.1.1',
  capabilityProfile: '0.1.0',
  event: '0.1.3',
  storageApi: '0.2.0',
  backendAdapter: '0.3.1',
  modelDescriptor: '0.2.1',
} as const);

/**
 * Status of each contract. "published" means frozen on its wire string: later changes are additive
 * patches that change no accepted or refused input, or a new wire string. "draft" may change in a
 * minor version. Release 0.4.0: manifest 0.1.1 published; every other contract draft.
 */
export const SPEC_STATUS = Object.freeze({
  manifest: 'published',
  capabilityProfile: 'draft',
  event: 'draft',
  storageApi: 'draft',
  backendAdapter: 'draft',
  modelDescriptor: 'draft',
} as const);

/** Wire-format discriminators (major.minor) carried by instances. */
export const SPEC_WIRE = Object.freeze({
  manifest: 'airplanemode.manifest/0.1',
  capabilityProfile: 'airplanemode.capability/0.1',
  event: 'airplanemode.event/0.1',
  modelDescriptor: 'airplanemode.model/0.2',
} as const);
