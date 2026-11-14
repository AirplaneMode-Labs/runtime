/**
 * How the engine worker is started (backend-adapter.md R3w). A fresh dedicated MODULE worker is started
 * from a blob: bootstrap whose source is exactly 'import ' + JSON.stringify(abs) + ';': one static import
 * of the engine worker script, nothing else. The blob inherits the page's CSP; the worker script itself is
 * a same-origin file, so script-src 'self' still decides what it may load.
 *
 * `abs` is checked before anything is created: an http(s) URL on the page origin, no query, no fragment,
 * built from a conservative character set. A double quote, a newline, a backslash, a space, javascript:,
 * data:, a cross-origin host or a query string is refused before URL.createObjectURL is called.
 *
 * Trusted Types: the blob URL goes through one module-singleton policy named 'airplanemode-worker'
 * (created once per page and only where the browser has trustedTypes). Its createScriptURL accepts only
 * URLs it was told about; revoking removes them. No default policy is ever created.
 */

import { AdapterError } from '../../spec/backend-adapter';

export const WORKER_POLICY_NAME = 'airplanemode-worker';

/** The slice of window.trustedTypes this file uses (so tests can hand it a fake). */
export interface TrustedTypesLike {
  createPolicy(
    name: string,
    options: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): unknown };
}

export interface WorkerUrlPolicy {
  /** Registers a URL the policy may later hand out. */
  allow(url: string): void;
  /** Forgets it again. */
  revoke(url: string): void;
  /** The value to give `new Worker()`: a TrustedScriptURL where Trusted Types exist, else the string. */
  wrap(url: string): string;
}

const SAFE = /^[A-Za-z0-9\-._~:/@+]+$/;

const refuse = (message: string): AdapterError => new AdapterError('egress_refused', message);

/**
 * Resolves `workerUrl` against `baseURI` and requires a same-origin http(s) module URL with no query and
 * no fragment. Throws AdapterError('egress_refused') otherwise; the message never repeats the input.
 */
export function resolveWorkerUrl(workerUrl: string, baseURI: string, pageOrigin: string): string {
  if (typeof workerUrl !== 'string' || workerUrl === '' || workerUrl.length > 2048)
    throw refuse('the engine worker URL is not usable');
  if (!SAFE.test(workerUrl))
    throw refuse('the engine worker URL contains characters that are not allowed');
  let url: URL;
  try {
    url = new URL(workerUrl, baseURI);
  } catch {
    throw refuse('the engine worker URL cannot be resolved');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw refuse('the engine worker URL must be http or https');
  if (url.origin !== pageOrigin) throw refuse('the engine worker URL is not on the page origin');
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(url.href))
    throw refuse('the engine worker URL must have no query and no fragment');
  return url.href;
}

/** 'import ' + JSON.stringify(abs) + ';' for a clean absolute http(s) URL; anything else is refused. */
export function bootstrapSource(abs: string): string {
  if (typeof abs !== 'string' || !/^https?:\/\//.test(abs) || !SAFE.test(abs) || /[?#]/.test(abs))
    throw refuse('the engine worker URL is not a clean absolute URL');
  return `import ${JSON.stringify(abs)};`;
}

const policies = new WeakMap<object, WorkerUrlPolicy>();
const passthrough: WorkerUrlPolicy = {
  allow: () => undefined,
  revoke: () => undefined,
  wrap: (url) => url,
};

/** The page's one policy (created on first use), or a pass-through where Trusted Types do not exist. */
export function getWorkerUrlPolicy(
  env: { trustedTypes?: TrustedTypesLike | undefined } = globalThis as unknown as {
    trustedTypes?: TrustedTypesLike;
  },
): WorkerUrlPolicy {
  const tt = env.trustedTypes;
  if (!tt || typeof tt.createPolicy !== 'function') return passthrough;
  const existing = policies.get(tt);
  if (existing) return existing;
  const allowed = new Set<string>();
  let policy: { createScriptURL(input: string): unknown } | undefined;
  try {
    policy = tt.createPolicy(WORKER_POLICY_NAME, {
      createScriptURL(input: string): string {
        if (!allowed.has(input)) throw new TypeError('this URL was not created by the runtime');
        return input;
      },
    });
  } catch {
    // the page's CSP forbids the name or a duplicate: use the string and let the browser decide
    policies.set(tt, passthrough);
    return passthrough;
  }
  const made: WorkerUrlPolicy = {
    allow: (url) => void allowed.add(url),
    revoke: (url) => void allowed.delete(url),
    wrap: (url) => policy!.createScriptURL(url) as string,
  };
  policies.set(tt, made);
  return made;
}

export interface BootstrapDeps {
  policy: WorkerUrlPolicy;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface Bootstrap {
  /** The blob: URL. */
  url: string;
  /** What to pass to `new Worker()` (a TrustedScriptURL under Trusted Types). */
  trusted: string;
  /** Revokes the URL and removes it from the policy. Idempotent. */
  revoke(): void;
}

/** Builds the bootstrap Blob and its URL. `abs` is validated first; nothing is created for a bad one. */
export function createBootstrapUrl(abs: string, deps: BootstrapDeps): Bootstrap {
  const source = bootstrapSource(abs);
  const url = deps.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  deps.policy.allow(url);
  let revoked = false;
  return {
    url,
    trusted: deps.policy.wrap(url),
    revoke() {
      if (revoked) return;
      revoked = true;
      deps.policy.revoke(url);
      deps.revokeObjectURL(url);
    },
  };
}
