/**
 * AdapterError subclasses that name the manifest entry a failure concerns, and the mapping from the
 * asset manager's errors to the adapter codes `integrity` and `not_cached` (backend adapter 0.3.0).
 *
 * The entry id is an id from the signed manifest (never a path, a URL or engine text), so it is safe
 * to put in an event attr; the original AssetError stays in `cause` and never reaches a message.
 */

import { AdapterError } from '../../spec/backend-adapter';
import { AssetError } from '../errors';

/** An AdapterError 'integrity' or 'not_cached' that names the manifest entry it concerns. */
export class AdapterEntryError extends AdapterError {
  readonly entryId: string;
  constructor(
    code: 'integrity' | 'not_cached',
    message: string,
    entryId: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.entryId = entryId;
  }
}

export const INTEGRITY_MESSAGE = 'a downloaded file failed its integrity check';
export const NOT_CACHED_MESSAGE = 'a file that was needed is not stored on this device';

/**
 * Maps what acquire() or getBlob() threw for `entryId`:
 * - AssetError hash_mismatch (a download whose hash did not match) -> integrity;
 * - AssetError not_cached (a cacheOnly miss) -> not_cached;
 * - AssetError not_verified from getBlob: reason file_missing (NotFoundError, the file is gone) ->
 *   not_cached; size_changed, unreadable (NotReadableError: the OPFS snapshot changed) and
 *   hash_mismatch -> integrity;
 * anything else is returned unchanged.
 */
export function mapEntryFailure(e: unknown, entryId: string): unknown {
  if (!(e instanceof AssetError)) return e;
  if (e.code === 'hash_mismatch')
    return new AdapterEntryError('integrity', INTEGRITY_MESSAGE, entryId, { cause: e });
  if (e.code === 'not_cached')
    return new AdapterEntryError('not_cached', NOT_CACHED_MESSAGE, entryId, { cause: e });
  if (e.code === 'not_verified') {
    if (e.reason === 'file_missing')
      return new AdapterEntryError('not_cached', NOT_CACHED_MESSAGE, entryId, { cause: e });
    if (e.reason === 'size_changed' || e.reason === 'unreadable' || e.reason === 'hash_mismatch')
      return new AdapterEntryError('integrity', INTEGRITY_MESSAGE, entryId, { cause: e });
  }
  return e;
}

/** Runs `fn` and rethrows its failure through mapEntryFailure(). */
export async function forEntry<T>(entryId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapEntryFailure(e, entryId);
  }
}
