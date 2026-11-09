/** Errors raised by the asset manager. */

export type AssetErrorCode =
  'hash_mismatch' | 'quota' | 'network' | 'aborted' | 'not_verified' | 'store' | 'policy';

/** Sub-reasons for `network` errors. */
export type NetworkReason = 'oversize' | 'status' | 'content-length' | 'aborted-stream' | 'fetch';

export type AssetErrorDetails = Record<string, string | number | boolean | null>;

export class AssetError extends Error {
  override readonly name = 'AssetError';
  readonly code: AssetErrorCode;
  readonly reason: string | undefined;
  readonly details: AssetErrorDetails | undefined;

  constructor(
    code: AssetErrorCode,
    message: string,
    opts: { reason?: string; details?: AssetErrorDetails; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.reason = opts.reason;
    this.details = opts.details;
  }
}

/** True for the browser's storage-full exception in any of its spellings. */
export function isQuotaExceeded(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  const code = (e as { code?: unknown }).code;
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

export function isAbortError(e: unknown): boolean {
  return e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}
