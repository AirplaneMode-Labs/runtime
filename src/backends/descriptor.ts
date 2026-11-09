/**
 * Model descriptor loader (backend adapter 0.2.0, rule R1).
 *
 * A descriptor is a small manifest entry that names the other entries an engine needs. This module
 * reads one from an AssetSource and proves it: the entry is checked against the manifest of that
 * AssetSource and against the size cap before anything is downloaded, the bytes are read with
 * getBlob(id, { rehash: true }) after acquire() and parsed with the strict canonical rules, and the
 * cross-checks bind every referenced entry to the same manifest.
 *
 * It never fetches anything itself; acquire() may download through the asset manager. Handles taken
 * here are pushed onto `ctx.held` and stay with the caller, who releases them in unload() or on a
 * failed load.
 */

import {
  AdapterError,
  type AssetHandle,
  type AssetSource,
  type ExecutionDevice,
} from '../../spec/backend-adapter';
import type { CapabilityProfile } from '../../spec/capability-profile';
import type { ManifestEntry } from '../../spec/manifest';
import {
  MODEL_DESCRIPTOR_MAX_BYTES,
  MODEL_DESCRIPTOR_MEDIA_TYPE,
  MODEL_DESCRIPTOR_SPEC,
  type ModelDescriptor,
} from '../../spec/model-descriptor';
import { ManifestError, checkParsed } from '../manifest';
import { satisfies } from '../satisfies';
import { validateModelDescriptor } from '../schema';

export interface ResolvedFile {
  /** Path inside the model, as the descriptor lists it. */
  path: string;
  /** The manifest entry that holds its bytes. */
  entry: ManifestEntry;
}

export interface LoadedDescriptor {
  /** The descriptor's own manifest entry. */
  entry: ManifestEntry;
  descriptor: ModelDescriptor;
  /** Every file of the descriptor in path order. */
  files: ResolvedFile[];
}

export interface DescriptorContext {
  assets: AssetSource;
  profile: CapabilityProfile;
  /** The adapter id the descriptor's engine must equal. */
  adapterId: string;
  /** The execution device the descriptor's devices must include. */
  device: ExecutionDevice;
  /** Handles acquired here are pushed onto this list; the caller releases them. */
  held: AssetHandle[];
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { entryId: string; received: number; total: number }) => void) | undefined;
}

const bad = (message: string, cause?: unknown): AdapterError =>
  new AdapterError('bad_descriptor', message, cause === undefined ? undefined : { cause });

/** Strict canonical parse of descriptor text plus the schema and ordering rules. */
export function parseDescriptor(text: string): ModelDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw bad('the model descriptor is not valid JSON', e);
  }
  try {
    checkParsed(value, '');
  } catch (e) {
    if (e instanceof ManifestError)
      throw bad(`the model descriptor breaks the canonical JSON rules (${e.reason})`, e);
    throw e;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw bad('the model descriptor must be a JSON object');
  if ((value as { spec?: unknown }).spec !== MODEL_DESCRIPTOR_SPEC)
    throw bad('the model descriptor has an unknown spec string');
  const result = validateModelDescriptor(value);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw bad(`the model descriptor is invalid at ${first.path || '/'} (${first.keyword})`);
  }
  return value as ModelDescriptor;
}

/** The checks that need no download: entry identity, kind, media type, size cap, device profile. */
export function precheckDescriptorEntry(entry: ManifestEntry, ctx: DescriptorContext): void {
  let known: ManifestEntry;
  try {
    known = ctx.assets.getEntry(entry.id);
  } catch (e) {
    throw bad("the descriptor entry is not in this asset manager's manifest", e);
  }
  if (
    known.sha256 !== entry.sha256 ||
    known.size !== entry.size ||
    known.kind !== entry.kind ||
    known.mediaType !== entry.mediaType
  )
    throw bad("the descriptor entry differs from the one in this asset manager's manifest");
  if (entry.kind !== 'model' || entry.mediaType !== MODEL_DESCRIPTOR_MEDIA_TYPE)
    throw bad('the entry is not a model descriptor (kind model with the descriptor media type)');
  if (!Number.isSafeInteger(entry.size) || entry.size > MODEL_DESCRIPTOR_MAX_BYTES)
    throw bad(`the model descriptor entry is larger than ${MODEL_DESCRIPTOR_MAX_BYTES} bytes`);
  if (!satisfies(ctx.profile, entry.minProfile))
    throw new AdapterError(
      'unsupported_profile',
      "this device does not meet the descriptor entry's minimum profile",
    );
}

/** Reads, validates and cross-checks the descriptor held in `entry` (R1). */
export async function loadDescriptor(
  entry: ManifestEntry,
  ctx: DescriptorContext,
): Promise<LoadedDescriptor> {
  precheckDescriptorEntry(entry, ctx);
  if (typeof ctx.assets.acquire !== 'function')
    throw new AdapterError(
      'unsupported_operation',
      'the asset source cannot hold files (acquire is required by engine adapters)',
    );
  const acquireOpts: {
    signal?: AbortSignal;
    onProgress?: NonNullable<DescriptorContext['onProgress']>;
  } = {};
  if (ctx.signal) acquireOpts.signal = ctx.signal;
  if (ctx.onProgress) acquireOpts.onProgress = ctx.onProgress;
  ctx.held.push(await ctx.assets.acquire(entry.id, acquireOpts));

  const blob = await ctx.assets.getBlob(entry.id, { rehash: true });
  if (blob.size > MODEL_DESCRIPTOR_MAX_BYTES)
    throw bad(`the stored model descriptor is larger than ${MODEL_DESCRIPTOR_MAX_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
  } catch (e) {
    throw bad('the model descriptor is not valid UTF-8', e);
  }
  const descriptor = parseDescriptor(text);

  // Cross-checks, each bound to the manifest behind ctx.assets.
  const files: ResolvedFile[] = [];
  const byPath = new Map<string, ManifestEntry>();
  for (const f of descriptor.files) {
    let fileEntry: ManifestEntry;
    try {
      fileEntry = ctx.assets.getEntry(f.entryId);
    } catch (e) {
      throw bad('a file of the descriptor is not an entry of this manifest', e);
    }
    if (fileEntry.id === entry.id || fileEntry.mediaType === MODEL_DESCRIPTOR_MEDIA_TYPE)
      throw bad('a file of the descriptor is itself a model descriptor');
    files.push({ path: f.path, entry: fileEntry });
    byPath.set(f.path, fileEntry);
  }
  for (const [label, path] of [
    ['runtimeWasm', descriptor.runtimeWasm],
    ['modelLib', descriptor.modelLib],
  ] as const) {
    if (path === undefined) continue;
    const e = byPath.get(path);
    if (!e) throw bad(`${label} names a path that is not listed in files`);
    if (e.kind !== 'wasm') throw bad(`${label} must be a manifest entry of kind wasm`);
  }
  if (descriptor.engine !== ctx.adapterId)
    throw bad('the descriptor is for a different engine than this adapter');
  if (!descriptor.devices.includes(ctx.device as 'wasm' | 'webgpu'))
    throw bad("the descriptor does not support this adapter's execution device");
  for (const f of files)
    if (!satisfies(ctx.profile, f.entry.minProfile))
      throw new AdapterError(
        'unsupported_profile',
        "this device does not meet a model file's minimum profile",
      );
  return { entry, descriptor, files };
}
