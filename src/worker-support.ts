/**
 * @airplanemode/runtime/worker-support (backend adapter 0.4.0, "Worker support exports"): what an application
 * needs to run its OWN workers beside the engine worker under the same rules. dockit starts its PDF and its
 * analysis worker with startModuleWorker() and runs installEgressGuard() as the first statement of each.
 *
 *  - installEgressGuard({ allowPathPrefixes }): over fetch, XMLHttpRequest, WebSocket, EventSource,
 *    importScripts and nested Worker, the worker may reach ONLY same-origin URLs whose path starts with one
 *    of the given prefixes; everything else is AdapterError('egress_refused') and posts { v: 1, type: 'egress',
 *    origin } (the origin only) to the page. A URL is judged after the WHATWG parser has resolved it, so dot
 *    segments, percent-encoded dot segments, a backslash form and a network-path reference ('//host/...') are
 *    resolved first and can not leave the prefix. WebSocket is refused whatever the URL.
 *  - startModuleWorker(url, { policyName }): the blob bootstrap of backend adapter R7: a module worker whose
 *    source is exactly one static import of an exact same-origin URL. Anything else is refused before
 *    URL.createObjectURL. The worker inherits the page CSP. Under Trusted Types the blob URL goes through a
 *    policy named policyName that hands out only the URLs this call created.
 *
 * The guard cannot see dynamic import() or a FontFace URL: only the CSP the worker inherits stops those (the
 * same limit as R3w). Importing this file has no side effects.
 */

import { AdapterError } from '../spec/backend-adapter';
import {
  createBootstrapUrl,
  getWorkerUrlPolicy,
  resolveWorkerUrl,
  type TrustedTypesLike,
} from './backends/worker-bootstrap';

type Scope = Record<string, unknown>;

export interface WorkerEgressGuardOptions {
  /** Each starts with '/', ends with '/', and has no '..', '\\', '?' or '#'. At least one. */
  allowPathPrefixes: readonly string[];
  /** The scope to guard. Default: globalThis (the worker's `self`). Tests pass a fake. */
  scope?: object;
  /** The page origin. Default: the scope's `origin` (a blob worker has one), else the origin of its location. */
  origin?: string;
  /** Where a refusal is reported. Default: scope.postMessage({ v: 1, type: 'egress', origin }). */
  post?: (message: { v: 1; type: 'egress'; origin: string }) => void;
}

const HIERARCHICAL = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:']);
const PREFIX = /^\/(?:[A-Za-z0-9._~%@+:-]+\/)*$/;

const installed = new WeakSet<object>();

/** scheme://host[:port] for a hierarchical URL, '<scheme>:' for data:, blob: and friends, 'invalid' otherwise. */
function originOf(input: unknown, base: string): string {
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
    if (m && !HIERARCHICAL.has(`${m[1]!.toLowerCase()}:`)) return `${m[1]!.toLowerCase()}:`;
    const u = new URL(raw, base);
    return HIERARCHICAL.has(u.protocol) ? `${u.protocol}//${u.host}` : `${u.protocol}`;
  } catch {
    return 'invalid';
  }
}

function lock(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

export function installEgressGuard(options: WorkerEgressGuardOptions): void {
  const prefixes = options?.allowPathPrefixes;
  if (
    !Array.isArray(prefixes) ||
    prefixes.length === 0 ||
    !prefixes.every(
      (p) =>
        typeof p === 'string' &&
        PREFIX.test(p) &&
        !p.split('/').some((x) => x === '.' || x === '..' || /^%2e/i.test(x)),
    )
  )
    throw new TypeError(
      'allowPathPrefixes must be a non-empty array of directory paths like "/app/models/"',
    );
  const scope = (options.scope ?? globalThis) as Scope;
  if (installed.has(scope)) return;
  installed.add(scope);
  const origin =
    options.origin ??
    (typeof scope['origin'] === 'string' ? (scope['origin'] as string) : undefined) ??
    new URL((scope['location'] as { href: string }).href).origin;
  const base = `${origin}/`;
  const post =
    options.post ??
    ((m) => {
      try {
        (scope['postMessage'] as ((m: unknown) => void) | undefined)?.(m);
      } catch {
        // a closed port must not turn a refusal into something else
      }
    });

  const refuse = (what: unknown): never => {
    try {
      post({ v: 1, type: 'egress', origin: originOf(what, base) });
    } catch {
      // as above
    }
    throw new AdapterError('egress_refused', 'a request from this worker was refused');
  };
  /** True only for a same-origin http(s) URL, resolved by the WHATWG parser, under an allowed prefix. */
  const allowed = (what: unknown): boolean => {
    let raw: string;
    if (typeof what === 'string') raw = what;
    else if (what instanceof URL) raw = what.href;
    else if (
      what !== null &&
      typeof what === 'object' &&
      typeof (what as { url?: unknown }).url === 'string'
    )
      raw = (what as { url: string }).url;
    else return false;
    if (raw === '' || /[\u0000-\u001f\u007f]/.test(raw)) return false;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.origin !== origin) return false;
    return prefixes.some((p) => u.pathname.startsWith(p));
  };
  const check = (what: unknown): void => {
    if (!allowed(what)) refuse(what);
  };

  // fetch: locked on every owner of the prototype chain, and always as an own member of the scope
  const realFetch =
    typeof scope['fetch'] === 'function'
      ? (scope['fetch'] as (...a: unknown[]) => unknown).bind(scope)
      : undefined;
  const guardedFetch = (input: unknown, init?: unknown): unknown => {
    try {
      check(input);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!realFetch)
      return Promise.reject(new AdapterError('egress_refused', 'no network function'));
    return realFetch(input, init);
  };
  for (let o: object | null = scope; o !== null; o = Object.getPrototypeOf(o) as object | null)
    if (Object.prototype.hasOwnProperty.call(o, 'fetch')) lock(o, 'fetch', guardedFetch);
  if (!Object.prototype.hasOwnProperty.call(scope, 'fetch')) lock(scope, 'fetch', guardedFetch);

  // XMLHttpRequest: the URL is given to open(); patched on the prototype so the original open is not reachable by name
  const XHR = scope['XMLHttpRequest'] as
    { prototype?: { open?: (...a: unknown[]) => unknown } } | undefined;
  const xhrProto = XHR?.prototype;
  if (xhrProto && typeof xhrProto.open === 'function') {
    const originalOpen = xhrProto.open;
    lock(xhrProto, 'open', function (this: unknown, ...args: unknown[]): unknown {
      check(args[1]);
      return originalOpen.apply(this, args);
    });
  }

  // constructors that take the URL first: EventSource, Worker, SharedWorker
  for (const name of ['EventSource', 'Worker', 'SharedWorker']) {
    const Original = scope[name] as (new (...a: unknown[]) => object) | undefined;
    if (typeof Original !== 'function') continue;
    const Guarded = class extends Original {
      constructor(...args: unknown[]) {
        check(args[0]);
        super(...args);
      }
    };
    lock(scope, name, Guarded);
  }

  // importScripts: every URL must be allowed
  const real = scope['importScripts'];
  if (typeof real === 'function') {
    lock(scope, 'importScripts', (...urls: unknown[]) => {
      for (const u of urls) check(u);
      return (real as (...a: unknown[]) => unknown).apply(scope, urls);
    });
  }

  // WebSocket, WebSocketStream and WebTransport: refused whatever the URL
  for (const name of ['WebSocket', 'WebSocketStream', 'WebTransport']) {
    if (typeof scope[name] !== 'function') continue;
    lock(scope, name, function refusing(this: unknown, ...args: unknown[]): never {
      return refuse(args[0]);
    });
  }
}

// ---- startModuleWorker ------------------------------------------------------------------------------

export interface StartModuleWorkerOptions {
  /** The Trusted Types policy name for the blob URL (token characters only; never 'default'). */
  policyName: string;
  /** Optional worker name (shows in DevTools). */
  name?: string;
  /** Base for a relative url. Default: document.baseURI, else location.href. */
  baseURI?: string;
  /** The page origin. Default: location.origin. */
  origin?: string;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** Default: the global Worker. */
  workerCtor?: new (url: string, options: { type: 'module'; name?: string }) => Worker;
  trustedTypes?: TrustedTypesLike | undefined;
}

export interface ModuleWorker {
  readonly worker: Worker;
  /** Terminates the worker and revokes its blob URL. Idempotent. */
  terminate(): void;
}

const POLICY_NAME = /^[A-Za-z0-9\-#=_/@.%]{1,64}$/;

export function startModuleWorker(url: string, options: StartModuleWorkerOptions): ModuleWorker {
  const name = options?.policyName;
  if (typeof name !== 'string' || !POLICY_NAME.test(name) || name === 'default')
    throw new TypeError('policyName must be a Trusted Types policy name (not "default")');
  const g = globalThis as {
    location?: { href: string; origin: string };
    document?: { baseURI?: string };
    trustedTypes?: TrustedTypesLike;
    Worker?: StartModuleWorkerOptions['workerCtor'];
  };
  const origin = options.origin ?? g.location?.origin;
  if (!origin) throw new AdapterError('egress_refused', 'no page origin is available');
  const baseURI = options.baseURI ?? g.document?.baseURI ?? g.location?.href ?? `${origin}/`;
  // validated BEFORE anything is created: a bad URL never reaches createObjectURL
  const abs = resolveWorkerUrl(url, baseURI, origin);
  const policy = getWorkerUrlPolicy(
    { trustedTypes: 'trustedTypes' in options ? options.trustedTypes : g.trustedTypes },
    name,
  );
  const Ctor = options.workerCtor ?? g.Worker;
  if (!Ctor) throw new AdapterError('backend', 'this scope cannot start a worker');
  const bootstrap = createBootstrapUrl(abs, {
    policy,
    createObjectURL: (b) => (options.createObjectURL ?? ((x: Blob) => URL.createObjectURL(x)))(b),
    revokeObjectURL: (u) => (options.revokeObjectURL ?? ((x: string) => URL.revokeObjectURL(x)))(u),
  });
  let worker: Worker;
  try {
    worker = new Ctor(bootstrap.trusted, {
      type: 'module',
      ...(options.name !== undefined ? { name: options.name } : {}),
    });
  } catch (e) {
    bootstrap.revoke();
    throw e;
  }
  let done = false;
  return {
    worker,
    terminate(): void {
      if (done) return;
      done = true;
      try {
        worker.terminate();
      } finally {
        bootstrap.revoke();
      }
    },
  };
}
