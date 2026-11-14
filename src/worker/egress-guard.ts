/**
 * The egress guard of the engine worker (backend-adapter.md R3w). It is the FIRST import of the engine
 * host and imports nothing with side effects (only the AdapterError class), so it has run before any
 * engine module is evaluated.
 *
 * What it does, on the worker's global scope:
 *  - replaces `fetch` on `self` and on every object of its prototype chain that owns one, with a function
 *    that refuses everything until the host hands it the verified-file shim (setGuardedFetch);
 *  - makes XMLHttpRequest, WebSocket, WebSocketStream, WebTransport, EventSource, Worker, SharedWorker
 *    (each only where defined), importScripts and navigator.serviceWorker.register throw
 *    AdapterError('egress_refused');
 *  - makes Cache.prototype.add and addAll reject egress_refused (put is left alone: WebLLM stages with
 *    put only);
 *  - defines every replacement writable:false and configurable:false, so later code cannot undo it;
 *  - defines a sentinel, which the engines check first.
 * Each refusal posts { type: 'egress', origin } with the origin only (scheme://host[:port], or
 * '<scheme>:' alone); the page validates it again.
 *
 * What it cannot do: dynamic import() and FontFace URL loads cannot be intercepted in JavaScript. Only
 * the CSP the worker inherits stops them (script-src 'self'; default-src covers fonts). That limit is
 * written down in backend-adapter.md, never hidden.
 */

import { AdapterError } from '../../spec/backend-adapter';

export const EGRESS_GUARD_SENTINEL: unique symbol = Symbol.for(
  'airplanemode.egressGuard.v1',
) as never;

export interface GuardOptions {
  /** Posts a plain message to the page. A throw is ignored. */
  post(message: { type: 'egress'; origin: string }): void;
}

type Scope = Record<string | symbol, unknown>;
type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

const HIERARCHICAL = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:']);

/** scheme://host[:port] for hierarchical URLs, '<scheme>:' for data:, blob: and friends, 'invalid' if unparsable. */
function originOf(input: unknown): string {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input !== null &&
              typeof input === 'object' &&
              typeof (input as { url?: unknown }).url === 'string'
            ? (input as { url: string }).url
            : '';
    if (raw === '') return 'invalid';
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
    if (!m) return 'invalid';
    const scheme = `${m[1]!.toLowerCase()}:`;
    if (!HIERARCHICAL.has(scheme)) return scheme;
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid';
  }
}

let guarded: FetchLike | undefined;

/** Hands the guard the verified-file shim: from now on `fetch` serves what the shim serves and refuses the rest. */
export function setGuardedFetch(fn: FetchLike): void {
  guarded = fn;
}

export function isEgressGuardInstalled(scope: object = globalThis): boolean {
  return (scope as Scope)[EGRESS_GUARD_SENTINEL] === true;
}

function lock(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

/** Installs the guard on `scope` (the worker's `self`). A second call changes nothing. */
export function installEgressGuard(scope: object, options: GuardOptions): void {
  const s = scope as Scope;
  if (isEgressGuardInstalled(scope)) return;
  const refuse = (what: unknown): never => {
    try {
      options.post({ type: 'egress', origin: originOf(what) });
    } catch {
      // a closed port must not turn a refusal into something else
    }
    throw new AdapterError('egress_refused', 'a request from the engine worker was refused');
  };

  // fetch: lock every owner on the prototype chain, then always lock an own fetch on the scope itself (below)
  const guardedFetch: FetchLike = (input, init) => {
    if (guarded) return guarded(input, init);
    return Promise.reject(
      (() => {
        try {
          return refuse(input);
        } catch (e) {
          return e;
        }
      })(),
    );
  };
  for (let o: object | null = scope; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    if (Object.prototype.hasOwnProperty.call(o, 'fetch')) {
      lock(o, 'fetch', guardedFetch);
    }
  }
  // S1-072: self always gets its own locked fetch, so defineProperty(self,'fetch') throws
  if (!Object.prototype.hasOwnProperty.call(scope, 'fetch')) lock(scope, 'fetch', guardedFetch);

  // constructors and importScripts: refuse on construction or call, where they exist
  for (const name of [
    'XMLHttpRequest',
    'WebSocket',
    'WebSocketStream',
    'WebTransport',
    'EventSource',
    'Worker',
    'SharedWorker',
  ]) {
    if (!(name in s) || s[name] === undefined) continue;
    const refusing = function (this: unknown, ...args: unknown[]): never {
      return refuse(args[0]);
    };
    lock(scope, name, refusing);
  }
  if (typeof s['importScripts'] === 'function') {
    lock(scope, 'importScripts', (...urls: unknown[]) => refuse(urls[0]));
  }

  // service workers
  const nav = s['navigator'] as { serviceWorker?: { register?: unknown } } | undefined;
  const sw = nav?.serviceWorker;
  if (sw && typeof sw.register === 'function')
    lock(sw, 'register', (url: unknown) => Promise.reject(captured(url)));
  function captured(url: unknown): unknown {
    try {
      return refuse(url);
    } catch (e) {
      return e;
    }
  }

  // Cache.add and addAll fetch on the caller's behalf: they reject, put stays
  const cacheProto = (s['Cache'] as { prototype?: object } | undefined)?.prototype;
  if (cacheProto) {
    for (const method of ['add', 'addAll']) {
      if (typeof (cacheProto as Record<string, unknown>)[method] !== 'function') continue;
      lock(cacheProto, method, (arg: unknown) =>
        Promise.reject(captured(Array.isArray(arg) ? arg[0] : arg)),
      );
    }
  }

  lock(scope, EGRESS_GUARD_SENTINEL, true);
}
