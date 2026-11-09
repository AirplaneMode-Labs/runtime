/**
 * The verified-file shim (backend adapter 0.2.0, rule R3).
 *
 * Model bytes reach an engine only through here. The adapter registers the Blobs it obtained after
 * acquire() and getBlob(id, { rehash: true }) under same-origin keys
 * `<VERIFIED_PREFIX><descriptor ENTRY id>/<path>`, then gives the engine a replacement for its
 * network function that serves exactly those keys. Everything else is refused: this function never
 * calls the real network function and never forwards to the engine's previous one.
 *
 * Matching (all of it, in this order): the input (a string, a URL or a Request; relative input is
 * resolved against location.href) must parse; its scheme must be http or https; its origin must equal
 * location.origin; the method must be GET or HEAD; the URL must have no query and no fragment; then
 * the lookup is by exact equality of origin + pathname after WHATWG parsing (so dot segments and
 * percent-encoded dot segments are resolved by the parser first), never by a prefix test. A hit is a
 * Response over the Blob; a path under the prefix with no entry is a 404; everything else rejects
 * with AdapterError('egress_refused') and emits backend.egress.refused with the origin only.
 */

import { AdapterError } from '../../spec/backend-adapter';
import type { EventSink } from '../../spec/event';
import { newEvent } from '../events';

/** The path segment pair appended to the app base path. */
export const VERIFIED_PATH_SEGMENT = '__airplanemode/verified/';

const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** The ModelFile.path pattern of the descriptor schema. */
const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){0,7}$/;
const SPECIAL_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:']);

interface LocationLike {
  href: string;
  origin: string;
  pathname?: string;
}

function currentLocation(override?: LocationLike): LocationLike {
  const loc = override ?? (globalThis as { location?: LocationLike }).location;
  if (!loc || typeof loc.href !== 'string' || typeof loc.origin !== 'string')
    throw new AdapterError('backend', 'no page location is available for the verified file shim');
  return loc;
}

/** `<app base path>__airplanemode/verified/`: the directory of the page plus the verified segment. */
export function defaultVerifiedPrefix(location?: LocationLike): string {
  const loc = location ?? (globalThis as { location?: LocationLike }).location;
  const pathname = loc?.pathname ?? (loc ? new URL(loc.href).pathname : '/');
  const dir = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return `${dir || '/'}${VERIFIED_PATH_SEGMENT}`;
}

function checkPrefix(prefix: string): void {
  if (
    typeof prefix !== 'string' ||
    !prefix.startsWith('/') ||
    !prefix.endsWith('/') ||
    /[?#\\\s]/.test(prefix) ||
    prefix.split('/').some((s) => s === '.' || s === '..' || /^%2e/i.test(s))
  )
    throw new AdapterError(
      'bad_descriptor',
      'the verified prefix must be a same-origin directory path',
    );
}

/** `scheme://host[:port]` for hierarchical URLs, `<scheme>:` for everything else, '' if unparsable. */
export function egressOrigin(url: URL | undefined): string {
  if (!url) return '';
  return SPECIAL_SCHEMES.has(url.protocol) ? `${url.protocol}//${url.host}` : url.protocol;
}

export interface VerifiedFileInput {
  /** Path inside the model, as listed in the descriptor. */
  path: string;
  blob: Blob;
  /** The manifest entry's sha256: two holders of one key must agree on it. */
  sha256: string;
}

interface RegistryRow {
  sha256: string;
  blob: Blob;
  holders: Set<VerifiedFileSet>;
}

/** One module-level registry for the process (the engine's env is process-global too). */
const REGISTRY = new Map<string, RegistryRow>();

export function verifiedRegistrySize(): number {
  return REGISTRY.size;
}

export class VerifiedFileSet {
  readonly keys: readonly string[];
  private released = false;
  constructor(keys: string[]) {
    this.keys = Object.freeze([...keys]);
  }
  /** Removes this set's keys (a key shared with another holder stays until it releases too). */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const key of this.keys) {
      const row = REGISTRY.get(key);
      if (!row) continue;
      row.holders.delete(this);
      if (row.holders.size === 0) REGISTRY.delete(key);
    }
  }
}

/**
 * Registers verified Blobs under `<prefix><descriptorEntryId>/<path>`. Registering a key that is
 * already held with a different sha256 throws bad_descriptor and registers nothing.
 */
export function registerVerifiedFiles(
  prefix: string,
  descriptorEntryId: string,
  files: VerifiedFileInput[],
): VerifiedFileSet {
  checkPrefix(prefix);
  if (!ENTRY_ID.test(descriptorEntryId))
    throw new AdapterError(
      'bad_descriptor',
      'the descriptor entry id cannot be used as a file key',
    );
  const planned: [string, VerifiedFileInput][] = [];
  for (const f of files) {
    if (!FILE_PATH.test(f.path) || f.path.length > 256)
      throw new AdapterError('bad_descriptor', 'a model file path is not a safe relative path');
    const key = `${prefix}${descriptorEntryId}/${f.path}`;
    const held = REGISTRY.get(key);
    if (held && held.sha256 !== f.sha256)
      throw new AdapterError(
        'bad_descriptor',
        'a verified file key is already held with other content',
      );
    planned.push([key, f]);
  }
  const seen = new Set<string>();
  for (const [key] of planned) {
    if (seen.has(key))
      throw new AdapterError('bad_descriptor', 'duplicate file path in descriptor');
    seen.add(key);
  }
  const set = new VerifiedFileSet(planned.map(([k]) => k));
  for (const [key, f] of planned) {
    const row = REGISTRY.get(key);
    if (row) row.holders.add(set);
    else REGISTRY.set(key, { sha256: f.sha256, blob: f.blob, holders: new Set([set]) });
  }
  return set;
}

export interface VerifiedFetchOptions {
  /** Adapter id for the backend.egress.refused event. */
  adapterId: string;
  events?: EventSink | undefined;
  /** The verified prefix the 404 rule applies to; default: derived from the page location. */
  prefix?: string | undefined;
  /** Override of window.location (tests). */
  location?: LocationLike | undefined;
  /**
   * Called with the pathname and the upper-cased method each time a registered file is served. It
   * observes only: a throw from it is ignored and it cannot change the answer.
   */
  onServe?: ((pathname: string, method: string) => void) | undefined;
}

export type VerifiedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createVerifiedFetch(opts: VerifiedFetchOptions): VerifiedFetch {
  const refuse = (url: URL | undefined): never => {
    try {
      opts.events?.emit(
        newEvent({
          source: 'runtime',
          kind: 'error',
          name: 'backend.egress.refused',
          level: 'error',
          attrs: { adapter: opts.adapterId, origin: egressOrigin(url) },
        }),
      );
    } catch {
      // an event sink must never turn a refusal into something else
    }
    throw new AdapterError('egress_refused', 'a request outside the verified file set was refused');
  };

  return async (input, init) => {
    const loc = currentLocation(opts.location);
    let raw: string;
    let method = 'GET';
    if (typeof input === 'string') raw = input;
    else if (typeof URL !== 'undefined' && input instanceof URL) raw = input.href;
    else {
      raw = (input as Request).url;
      method = (input as Request).method;
    }
    if (init?.method) method = init.method;
    method = method.toUpperCase();

    let url: URL;
    try {
      url = new URL(raw, loc.href);
    } catch {
      return refuse(undefined);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse(url);
    if (url.origin !== loc.origin) return refuse(url);
    if (method !== 'GET' && method !== 'HEAD') return refuse(url);
    if (/[?#]/.test(url.href)) return refuse(url); // url.search is '' for a bare "?", href is not

    const row = REGISTRY.get(url.pathname);
    if (row) {
      try {
        opts.onServe?.(url.pathname, method);
      } catch {
        // an observer must never turn a served file into a failure
      }
      const headers: Record<string, string> = {
        'content-type': row.blob.type || 'application/octet-stream',
        'content-length': String(row.blob.size),
      };
      return new Response(method === 'HEAD' ? null : row.blob, { status: 200, headers });
    }
    const prefix = opts.prefix ?? defaultVerifiedPrefix(loc);
    if (url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    return refuse(url);
  };
}
