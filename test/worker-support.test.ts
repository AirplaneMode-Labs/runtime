// D1-05 (backend adapter 0.4.0, worker support exports): installEgressGuard({ allowPathPrefixes }) and
// startModuleWorker(url, { policyName }) from '@airplanemode/runtime/worker-support'. The dockit workers
// (pdf and analysis) start through the second and run the first as their first statement. Written before
// src/worker-support.ts existed (red run: evidence/sprint-5/D1/red/D1-05.log).

import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import { installEgressGuard, startModuleWorker } from '../src/worker-support';

const ORIGIN = 'https://app.test';
const PREFIXES = ['/dockit/models/', '/dockit/app/'];

interface Calls {
  fetch: string[];
  xhr: string[];
  eventSource: string[];
  importScripts: string[];
  worker: string[];
  posted: { type: string; origin: string }[];
}

function fakeScope(calls: Calls): Record<string, unknown> {
  class XMLHttpRequest {
    open(_method: string, url: string): void {
      calls.xhr.push(String(url));
    }
  }
  class EventSource {
    constructor(url: string) {
      calls.eventSource.push(String(url));
    }
  }
  class Worker {
    constructor(url: string) {
      calls.worker.push(String(url));
    }
  }
  class WebSocket {
    constructor() {
      throw new Error('the real WebSocket must never be reached');
    }
  }
  return {
    origin: ORIGIN,
    fetch: async (input: unknown) => {
      calls.fetch.push(String(input instanceof URL ? input.href : input));
      return new Response('ok');
    },
    XMLHttpRequest,
    EventSource,
    Worker,
    WebSocket,
    importScripts: (...urls: string[]) => calls.importScripts.push(...urls),
  };
}
const newCalls = (): Calls => ({
  fetch: [],
  xhr: [],
  eventSource: [],
  importScripts: [],
  worker: [],
  posted: [],
});
function guarded() {
  const calls = newCalls();
  const scope = fakeScope(calls);
  installEgressGuard({
    allowPathPrefixes: PREFIXES,
    scope,
    origin: ORIGIN,
    post: (m) => calls.posted.push(m),
  });
  return { calls, scope: scope as Record<string, any> };
}
const refused = async (p: Promise<unknown> | (() => unknown)): Promise<AdapterError> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe('egress_refused');
    return e as AdapterError;
  }
  throw new Error('expected egress_refused');
};

describe('installEgressGuard({ allowPathPrefixes })', () => {
  it('passes a same-origin URL under an allowed prefix through to the real fetch', async () => {
    const { calls, scope } = guarded();
    await scope['fetch']('https://app.test/dockit/models/qwen3/config.json');
    await scope['fetch']('/dockit/app/pdf.worker.js');
    await scope['fetch'](new URL('https://app.test/dockit/models/x'));
    expect(calls.fetch).toHaveLength(3);
    expect(calls.posted).toEqual([]);
  });

  it('refuses everything else with egress_refused, posts only the origin, and never calls the real fetch', async () => {
    const { calls, scope } = guarded();
    const bad = [
      'https://huggingface.co/x',
      'https://app.test/other/path',
      'https://app.test/dockit/models', // the prefix is a directory
      '/dockit/models/../secret', // dot segments are resolved before the check
      '/dockit/models/%2e%2e/secret',
      '//evil.test/dockit/models/x',
      'https://app.test.evil.test/dockit/models/x',
      'https://app.test:8443/dockit/models/x',
      'http://app.test/dockit/models/x',
      'https://evil.test\\@app.test/dockit/models/x',
      'data:text/plain,hi',
      'blob:https://app.test/1234',
      'javascript:alert(1)',
      '',
      'not a url at all \u0000',
    ];
    for (const url of bad) await refused(scope['fetch'](url));
    await refused(scope['fetch'](new Request('https://huggingface.co/y')));
    expect(calls.fetch).toEqual([]);
    expect(calls.posted).toHaveLength(bad.length + 1);
    for (const m of calls.posted) {
      expect(m.type).toBe('egress');
      // the origin only (scheme://host[:port], or the scheme alone), never a path or a query
      expect(m.origin).toMatch(/^([a-z][a-z0-9+.-]*:|[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+|invalid)$/i);
    }
    expect(calls.posted[0]!.origin).toBe('https://huggingface.co');
  });

  it('XMLHttpRequest.open, EventSource, importScripts and nested Worker follow the same rule', async () => {
    const { calls, scope } = guarded();
    const xhr = new scope['XMLHttpRequest']();
    xhr.open('GET', '/dockit/models/a');
    await refused(() => xhr.open('GET', 'https://evil.test/a'));
    new scope['EventSource']('/dockit/app/events');
    await refused(() => new scope['EventSource']('https://evil.test/e'));
    scope['importScripts']('/dockit/app/a.js', '/dockit/app/b.js');
    await refused(() => scope['importScripts']('/dockit/app/a.js', 'https://evil.test/b.js'));
    new scope['Worker']('/dockit/app/w.js');
    await refused(() => new scope['Worker']('https://evil.test/w.js'));
    expect(calls.xhr).toEqual(['/dockit/models/a']);
    expect(calls.eventSource).toEqual(['/dockit/app/events']);
    expect(calls.importScripts).toEqual(['/dockit/app/a.js', '/dockit/app/b.js']);
    expect(calls.worker).toEqual(['/dockit/app/w.js']);
  });

  it('WebSocket is refused whatever the URL, and the guard cannot be undone by a later write', async () => {
    const { scope } = guarded();
    await refused(() => new scope['WebSocket']('wss://app.test/dockit/models/s'));
    expect(() => {
      scope['fetch'] = () => 'shadowed';
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(scope, 'fetch', { value: 1 })).toThrow(TypeError);
  });

  it('a second install changes nothing; bad prefixes are a TypeError at install time', () => {
    const { scope } = guarded();
    const f = scope['fetch'];
    installEgressGuard({
      allowPathPrefixes: ['/x/'],
      scope,
      origin: ORIGIN,
      post: () => undefined,
    });
    expect(scope['fetch']).toBe(f);
    for (const bad of [
      [],
      ['dockit/'],
      ['/dockit'],
      ['/a/../b/'],
      ['/a\\b/'],
      ['/a/?q/'],
      [5],
      '/x/',
    ])
      expect(() =>
        installEgressGuard({
          allowPathPrefixes: bad as never,
          scope: fakeScope(newCalls()),
          origin: ORIGIN,
          post: () => undefined,
        }),
      ).toThrow(TypeError);
  });
});

describe('startModuleWorker(url, { policyName })', () => {
  function deps() {
    const created: string[] = [];
    const revoked: string[] = [];
    const sources: string[] = [];
    const workers: { url: string; options: unknown; terminated: boolean }[] = [];
    return {
      created,
      revoked,
      sources,
      workers,
      opts: {
        origin: ORIGIN,
        baseURI: 'https://app.test/dockit/',
        createObjectURL: (b: Blob) => {
          created.push(`blob:${created.length + 1}`);
          void b.text().then((t) => sources.push(t));
          return created.at(-1)!;
        },
        revokeObjectURL: (u: string) => revoked.push(u),
        workerCtor: class {
          terminated = false;
          constructor(
            url: string,
            readonly options: unknown,
          ) {
            workers.push({ url: String(url), options, terminated: false });
          }
          terminate() {
            workers.at(-1)!.terminated = true;
          }
        } as never,
        trustedTypes: undefined,
      },
    };
  }

  it('starts a module worker from a blob whose source is one static import of the exact URL', async () => {
    const d = deps();
    const h = startModuleWorker('https://app.test/dockit/app/pdf.worker.js', {
      policyName: 'dockit-pdf',
      ...d.opts,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(d.created).toHaveLength(1);
    expect(d.sources).toEqual(['import "https://app.test/dockit/app/pdf.worker.js";']);
    expect(d.workers[0]!.options).toMatchObject({ type: 'module' });
    h.terminate();
    expect(d.workers[0]!.terminated).toBe(true);
    expect(d.revoked).toEqual(d.created);
    h.terminate(); // idempotent
    expect(d.revoked).toHaveLength(1);
  });

  it('resolves a relative URL against baseURI and still requires it to be same-origin', () => {
    const d = deps();
    startModuleWorker('app/pdf.worker.js', { policyName: 'dockit-pdf', ...d.opts });
    expect(d.workers[0]!.url).toMatch(/^blob:/);
  });

  it('refuses anything but a clean same-origin URL before URL.createObjectURL is called', () => {
    const d = deps();
    const bad = [
      'https://evil.test/w.js',
      'http://app.test/dockit/app/w.js',
      'https://app.test/dockit/app/w.js?x=1',
      'https://app.test/dockit/app/w.js#h',
      'https://app.test/dockit/app/w".js',
      'https://app.test/dockit/app/w\\.js',
      'https://app.test/dockit/app/w js',
      'data:text/javascript,alert(1)',
      'javascript:alert(1)',
      'blob:https://app.test/1',
      '',
      'x'.repeat(3000),
    ];
    for (const url of bad)
      expect(() => startModuleWorker(url, { policyName: 'dockit-pdf', ...d.opts }), url).toThrow(
        AdapterError,
      );
    expect(d.created).toEqual([]);
    expect(d.workers).toEqual([]);
  });

  it('with Trusted Types the blob URL goes through a policy named policyName that hands out only its own URLs', () => {
    const d = deps();
    const policies: Record<string, (u: string) => string> = {};
    const trustedTypes = {
      createPolicy: vi.fn((name: string, o: { createScriptURL(u: string): string }) => {
        policies[name] = (u) => o.createScriptURL(u);
        return { createScriptURL: (u: string) => `TT(${o.createScriptURL(u)})` };
      }),
    };
    const h = startModuleWorker('https://app.test/dockit/app/analysis.worker.js', {
      policyName: 'dockit-analysis',
      ...d.opts,
      trustedTypes,
    });
    expect(trustedTypes.createPolicy).toHaveBeenCalledWith('dockit-analysis', expect.anything());
    expect(d.workers[0]!.url).toBe('TT(blob:1)');
    expect(() => policies['dockit-analysis']!('blob:evil')).toThrow(TypeError);
    h.terminate();
    expect(() => policies['dockit-analysis']!('blob:1')).toThrow(TypeError);
  });

  it('a bad policyName is a TypeError (it must be a Trusted Types policy name)', () => {
    const d = deps();
    for (const name of ['', 'a b', 'a,b', 'default', '*', 'x'.repeat(100), 5])
      expect(() =>
        startModuleWorker('https://app.test/dockit/app/w.js', {
          policyName: name as string,
          ...d.opts,
        }),
      ).toThrow(TypeError);
  });
});
