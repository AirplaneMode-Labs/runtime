// D1-04: the egress guard inside the engine worker (R3w). A fake worker global scope stands in for
// `self`; the real browser proof is test/browser/worker.spec.ts. Written before src/worker/egress-guard.ts.

import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import {
  EGRESS_GUARD_SENTINEL,
  installEgressGuard,
  isEgressGuardInstalled,
  setGuardedFetch,
} from '../src/worker/egress-guard';

interface Posted {
  type: string;
  origin?: string;
}

function makeScope(ownFetch = true) {
  const proto: Record<string, unknown> = {};
  proto['fetch'] = async () => new Response('REAL NETWORK');
  const mid = Object.create(proto) as Record<string, unknown>;
  const scope = Object.create(mid) as Record<string, unknown>;
  if (ownFetch) scope['fetch'] = async () => new Response('REAL NETWORK (own)');
  for (const name of [
    'XMLHttpRequest',
    'WebSocket',
    'WebSocketStream',
    'WebTransport',
    'EventSource',
    'Worker',
    'SharedWorker',
  ])
    scope[name] = class {
      constructor() {
        throw new Error(`the real ${name} must never run`);
      }
    };
  scope['importScripts'] = () => {
    throw new Error('the real importScripts must never run');
  };
  const CacheFn = function Cache() {} as unknown as { prototype: Record<string, unknown> };
  const cacheProto = CacheFn.prototype;
  cacheProto['add'] = async () => 'real add';
  cacheProto['addAll'] = async () => 'real addAll';
  cacheProto['put'] = async () => 'put';
  scope['Cache'] = CacheFn;
  scope['navigator'] = { serviceWorker: { register: async () => 'real register' } };
  const posted: Posted[] = [];
  return { scope, proto, mid, cacheProto, posted, post: (m: Posted) => posted.push(m) };
}

const refused = async (p: () => unknown) => {
  try {
    await p();
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe('egress_refused');
    return;
  }
  throw new Error('expected egress_refused');
};

describe('installEgressGuard', () => {
  it('S1-072: self gets its own locked fetch even when only a prototype owns one, so defineProperty on self throws', async () => {
    const t = makeScope(false);
    expect(Object.prototype.hasOwnProperty.call(t.scope, 'fetch')).toBe(false);
    installEgressGuard(t.scope as never, { post: t.post });
    const own = Object.getOwnPropertyDescriptor(t.scope, 'fetch');
    expect(own).toBeDefined();
    expect(own!.writable).toBe(false);
    expect(own!.configurable).toBe(false);
    expect(() =>
      Object.defineProperty(t.scope, 'fetch', { value: () => 'shadowed', configurable: true }),
    ).toThrow(TypeError);
    await refused(() =>
      (t.scope['fetch'] as (u: string) => Promise<Response>)('https://example.invalid/'),
    );
  });

  it('sets a sentinel that cannot be removed or changed', () => {
    const t = makeScope();
    expect(isEgressGuardInstalled(t.scope)).toBe(false);
    installEgressGuard(t.scope as never, { post: t.post });
    expect(isEgressGuardInstalled(t.scope)).toBe(true);
    expect(t.scope[EGRESS_GUARD_SENTINEL as never]).toBe(true);
    expect(() => {
      'use strict';
      delete t.scope[EGRESS_GUARD_SENTINEL as never];
    }).toThrow(TypeError);
    expect(() => {
      'use strict';
      t.scope[EGRESS_GUARD_SENTINEL as never] = false as never;
    }).toThrow(TypeError);
    expect(isEgressGuardInstalled(t.scope)).toBe(true);
  });

  it('refuses https://huggingface.co/x, raw.githubusercontent.com, data: and blob: through fetch, recording the origin only', async () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const f = t.scope['fetch'] as (u: string) => Promise<Response>;
    await refused(() => f('https://huggingface.co/x?token=SENTINEL'));
    await refused(() => f('https://raw.githubusercontent.com/a/b/c'));
    await refused(() => f('data:text/plain,hi'));
    await refused(() => f('blob:https://app.test/1234'));
    await refused(() => f('/relative/path'));
    expect(t.posted.map((p) => p.origin)).toEqual([
      'https://huggingface.co',
      'https://raw.githubusercontent.com',
      'data:',
      'blob:',
      'invalid',
    ]);
    expect(JSON.stringify(t.posted)).not.toContain('SENTINEL');
    expect(t.posted.every((p) => p.type === 'egress')).toBe(true);
  });

  it('replaces fetch on every object of the prototype chain that owns one, so no unguarded fetch remains', async () => {
    const t = makeScope();
    const real = [t.scope['fetch'], t.proto['fetch']];
    installEgressGuard(t.scope as never, { post: t.post });
    for (const o of [t.scope, t.mid, t.proto]) {
      const own = Object.getOwnPropertyDescriptor(o, 'fetch');
      if (own) {
        expect(real).not.toContain(own.value);
        await refused(() =>
          (own.value as (u: string) => Promise<Response>)('https://example.invalid/'),
        );
      }
    }
    // walk the whole chain: every `fetch` found is the guard
    const seen: unknown[] = [];
    for (let o: object | null = t.scope; o; o = Object.getPrototypeOf(o) as object | null) {
      const d = Object.getOwnPropertyDescriptor(o, 'fetch');
      if (d) seen.push(d.value);
    }
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);
  });

  it('serves the verified shim once one is set, and still refuses what the shim refuses', async () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const shim = vi.fn(async (u: string) => {
      if (!u.startsWith('https://app.test/app/__airplanemode/verified/'))
        throw new AdapterError('egress_refused', 'no');
      return new Response('verified bytes');
    });
    setGuardedFetch(shim as never);
    const f = t.scope['fetch'] as (u: string) => Promise<Response>;
    expect(await (await f('https://app.test/app/__airplanemode/verified/x/y')).text()).toBe(
      'verified bytes',
    );
    await refused(() => f('https://example.invalid/'));
    expect(shim).toHaveBeenCalledTimes(2);
  });

  it('throws egress_refused from XHR, WebSocket, WebSocketStream, WebTransport, EventSource, importScripts, Worker, SharedWorker and serviceWorker.register', async () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const ctor = (n: string) => t.scope[n] as new (u?: string) => unknown;
    for (const name of [
      'XMLHttpRequest',
      'WebSocket',
      'WebSocketStream',
      'WebTransport',
      'EventSource',
      'Worker',
      'SharedWorker',
    ])
      await refused(() => new (ctor(name))('https://evil.test/x'));
    await refused(() =>
      (t.scope['importScripts'] as (u: string) => void)('https://evil.test/x.js'),
    );
    await refused(() =>
      (
        t.scope['navigator'] as { serviceWorker: { register(u: string): Promise<unknown> } }
      ).serviceWorker.register('/sw.js'),
    );
    expect(t.posted.length).toBeGreaterThanOrEqual(9);
    expect(t.posted.some((p) => p.origin === 'https://evil.test')).toBe(true);
  });

  it('skips the constructors the scope does not define (WebSocketStream, SharedWorker, serviceWorker)', () => {
    const t = makeScope();
    delete t.scope['WebSocketStream'];
    delete t.scope['SharedWorker'];
    (t.scope['navigator'] as { serviceWorker?: unknown }).serviceWorker = undefined;
    expect(() => installEgressGuard(t.scope as never, { post: t.post })).not.toThrow();
    expect('WebSocketStream' in t.scope).toBe(false);
    expect('SharedWorker' in t.scope).toBe(false);
  });

  it('makes Cache.prototype.add and addAll reject and leaves put alone (WebLLM stages with put only)', async () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const cache = new (
      t.scope['Cache'] as new () => {
        add(u: string): Promise<unknown>;
        addAll(u: string[]): Promise<unknown>;
        put(): Promise<unknown>;
      }
    )();
    await refused(() => cache.add('https://evil.test/a'));
    await refused(() => cache.addAll(['https://evil.test/a']));
    expect(await cache.put()).toBe('put');
  });

  it('defines every replacement non-writable and non-configurable: they cannot be reassigned or redefined', () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const check = (o: object, key: string) => {
      const d = Object.getOwnPropertyDescriptor(o, key)!;
      expect(d.writable, key).toBe(false);
      expect(d.configurable, key).toBe(false);
      expect(() => {
        'use strict';
        (o as Record<string, unknown>)[key] = () => 'x';
      }, key).toThrow(TypeError);
      expect(() => Object.defineProperty(o, key, { value: () => 'x' }), key).toThrow(TypeError);
    };
    for (const name of [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'WebSocketStream',
      'WebTransport',
      'EventSource',
      'Worker',
      'SharedWorker',
      'importScripts',
    ])
      check(t.scope, name);
    check(t.proto, 'fetch');
    check((t.scope['Cache'] as { prototype: object }).prototype, 'add');
    check((t.scope['Cache'] as { prototype: object }).prototype, 'addAll');
    check((t.scope['navigator'] as { serviceWorker: object }).serviceWorker, 'register');
  });

  it('a second install changes nothing and throws nothing', () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, { post: t.post });
    const f = t.scope['fetch'];
    expect(() => installEgressGuard(t.scope as never, { post: t.post })).not.toThrow();
    expect(t.scope['fetch']).toBe(f);
  });

  it('a throwing post never turns a refusal into something else', async () => {
    const t = makeScope();
    installEgressGuard(t.scope as never, {
      post: () => {
        throw new Error('port closed');
      },
    });
    await refused(() =>
      (t.scope['fetch'] as (u: string) => Promise<Response>)('https://evil.test/'),
    );
  });
});
