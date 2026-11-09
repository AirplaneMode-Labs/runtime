import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import {
  createVerifiedFetch,
  egressOrigin,
  registerVerifiedFiles,
  verifiedRegistrySize,
  type VerifiedFileSet,
} from '../src/backends/verified-files';
import { EventBus } from '../src/events';
import { PAGE_HREF, PAGE_ORIGIN, PREFIX, eventsNamed, installLocation } from './backends-helpers';

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CONFIG = enc.encode('{"hidden_size":4}');
const OTHER = enc.encode('{"hidden_size":8}');
const file = (path: string, bytes: Uint8Array) => ({
  path,
  blob: new Blob([bytes as BlobPart], { type: 'application/json' }),
  sha256: sha(bytes),
});
const abs = (path: string) => `${PAGE_ORIGIN}${PREFIX}${path}`;

let restoreLocation: () => void;
let sets: VerifiedFileSet[] = [];
let events: EventBus;
let verifiedFetch: ReturnType<typeof createVerifiedFetch>;

beforeEach(() => {
  restoreLocation = installLocation();
  events = new EventBus();
  verifiedFetch = createVerifiedFetch({ adapterId: 'transformers-js', events });
  sets = [];
});
afterEach(() => {
  for (const s of sets) s.release();
  restoreLocation();
  vi.restoreAllMocks();
});

const register = (entryId: string, files = [file('config.json', CONFIG)]) => {
  const s = registerVerifiedFiles(PREFIX, entryId, files);
  sets.push(s);
  return s;
};

async function refused(p: Promise<unknown>): Promise<AdapterError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe('egress_refused');
    return e as AdapterError;
  }
  throw new Error('expected egress_refused');
}

describe('verified-files shim: what it serves', () => {
  it('serves a registered file for GET with the exact bytes, a content-length and the blob type', async () => {
    register('m.descriptor');
    const res = await verifiedFetch(abs('m.descriptor/config.json'));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONFIG);
    expect(res.headers.get('content-length')).toBe(String(CONFIG.length));
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('answers HEAD with the headers and an empty body', async () => {
    register('m.descriptor');
    const res = await verifiedFetch(abs('m.descriptor/config.json'), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(CONFIG.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('resolves a relative path against location.href', async () => {
    register('m.descriptor');
    const res = await verifiedFetch(`${PREFIX}m.descriptor/config.json`);
    expect(res.status).toBe(200);
    const rel = await verifiedFetch('__airplanemode/verified/m.descriptor/config.json');
    expect(rel.status).toBe(200);
  });

  it('accepts a URL object and a Request object', async () => {
    register('m.descriptor');
    expect((await verifiedFetch(new URL(abs('m.descriptor/config.json')))).status).toBe(200);
    expect((await verifiedFetch(new Request(abs('m.descriptor/config.json')))).status).toBe(200);
    // a Request carries its own method: POST is refused
    await refused(
      verifiedFetch(new Request(abs('m.descriptor/config.json'), { method: 'POST', body: 'x' })),
    );
  });

  it('an unlisted path under the prefix is a 404, not an error and not an event', async () => {
    register('m.descriptor');
    const res = await verifiedFetch(abs('m.descriptor/added_tokens.json'));
    expect(res.status).toBe(404);
    const res2 = await verifiedFetch(abs('nobody/config.json'));
    expect(res2.status).toBe(404);
    expect(eventsNamed(events, 'backend.egress.refused')).toHaveLength(0);
  });

  it('lookup is exact equality after WHATWG parsing: dot segments that stay inside the prefix normalise to a listed key', async () => {
    register('m.descriptor');
    const res = await verifiedFetch(abs('m.descriptor/./config.json'));
    expect(res.status).toBe(200);
    // a prefix-sharing sibling is never served by prefix matching
    const near = await verifiedFetch(abs('m.descriptor/config.json.bak'));
    expect(near.status).toBe(404);
  });
});

describe('verified-files shim: what it refuses (egress_refused + backend.egress.refused)', () => {
  it('rejects path traversal that leaves the verified prefix: ".." and "%2e%2e"', async () => {
    register('m.descriptor');
    for (const path of [
      `${PREFIX}m.descriptor/../../../etc/passwd`,
      `${PREFIX}m.descriptor/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
      `${PREFIX}%2E%2E/%2E%2E/x`,
      '/app/../../etc/passwd',
    ]) {
      await refused(verifiedFetch(`${PAGE_ORIGIN}${path}`));
    }
    expect(eventsNamed(events, 'backend.egress.refused').length).toBe(4);
  });

  it('rejects a query string and a fragment, even on a listed path', async () => {
    register('m.descriptor');
    await refused(verifiedFetch(abs('m.descriptor/config.json?download=true')));
    await refused(verifiedFetch(abs('m.descriptor/config.json#frag')));
    await refused(verifiedFetch(abs('m.descriptor/config.json?')));
    await refused(verifiedFetch(abs('m.descriptor/config.json#')));
  });

  it('rejects every method except GET and HEAD', async () => {
    register('m.descriptor');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      await refused(verifiedFetch(abs('m.descriptor/config.json'), { method }));
    }
  });

  it('rejects a cross-origin absolute URL; the event attrs are exactly {adapter, origin} with the origin only', async () => {
    register('m.descriptor');
    await refused(
      verifiedFetch(
        'https://huggingface.co/onnx-community/x/resolve/main/model.onnx?token=SECRET-Q',
      ),
    );
    const [e] = eventsNamed(events, 'backend.egress.refused');
    expect(e!.attrs).toEqual({ adapter: 'transformers-js', origin: 'https://huggingface.co' });
    expect(e!.kind).toBe('error');
    const wire = JSON.stringify(e);
    expect(wire).not.toContain('SECRET-Q');
    expect(wire).not.toContain('/resolve/main');
  });

  it('keeps the port in the origin and uses http(s) form for same-scheme hosts', () => {
    expect(egressOrigin(new URL('http://127.0.0.1:8787/models/x'))).toBe('http://127.0.0.1:8787');
    expect(egressOrigin(new URL('https://cdn.jsdelivr.net/npm/a'))).toBe(
      'https://cdn.jsdelivr.net',
    );
    expect(egressOrigin(undefined)).toBe('');
  });

  it('reports the scheme only for data:, blob:, file: and other schemes', async () => {
    const cases: [string, string][] = [
      ['data:text/plain;base64,aGk=', 'data:'],
      ['blob:https://app.test/0b7e6f1e-0000-4000-8000-000000000000', 'blob:'],
      ['file:///etc/passwd', 'file:'],
      ['javascript:alert(1)', 'javascript:'],
      ['chrome-extension://abc/x.js', 'chrome-extension:'],
    ];
    for (const [input, origin] of cases) {
      await refused(verifiedFetch(input));
      const last = eventsNamed(events, 'backend.egress.refused').at(-1)!;
      expect(last.attrs, input).toEqual({ adapter: 'transformers-js', origin });
    }
  });

  it('reports an empty origin for an unparsable URL', async () => {
    await refused(verifiedFetch('http://'));
    expect(eventsNamed(events, 'backend.egress.refused').at(-1)!.attrs['origin']).toBe('');
  });

  it('rejects a same-origin path outside the verified prefix', async () => {
    register('m.descriptor');
    await refused(verifiedFetch(`${PAGE_ORIGIN}/app/models/manifest.json`));
    await refused(verifiedFetch('/models/other.onnx'));
    const e = eventsNamed(events, 'backend.egress.refused').at(-1)!;
    expect(e.attrs['origin']).toBe(PAGE_ORIGIN);
    expect(JSON.stringify(e)).not.toContain('manifest.json');
  });

  it('never calls globalThis.fetch for any input, hit or refusal', async () => {
    const spy = vi.fn(async () => new Response('real network'));
    vi.stubGlobal('fetch', spy);
    register('m.descriptor');
    await verifiedFetch(abs('m.descriptor/config.json'));
    await verifiedFetch(abs('m.descriptor/nope'));
    await refused(verifiedFetch('https://huggingface.co/x'));
    await refused(verifiedFetch(abs('m.descriptor/config.json?x=1')));
    await refused(verifiedFetch('data:text/plain,hi'));
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('the refusal message carries no URL, path or engine text', async () => {
    const err = await refused(verifiedFetch('https://huggingface.co/secret/path?q=1'));
    expect(err.message).not.toContain('huggingface');
    expect(err.message).not.toContain('secret');
    expect(err.message).not.toContain('q=1');
  });
});

describe('verified-files registry', () => {
  it("keys files by descriptor ENTRY id: two descriptors sharing a logical id never serve each other's files", async () => {
    register('smollm2.tjs-wasm', [file('config.json', CONFIG)]);
    register('smollm2.tjs-webgpu', [file('config.json', OTHER)]);
    const a = await (await verifiedFetch(abs('smollm2.tjs-wasm/config.json'))).arrayBuffer();
    const b = await (await verifiedFetch(abs('smollm2.tjs-webgpu/config.json'))).arrayBuffer();
    expect(new Uint8Array(a)).toEqual(CONFIG);
    expect(new Uint8Array(b)).toEqual(OTHER);
    // the logical id ("smollm2") is not a key
    expect((await verifiedFetch(abs('smollm2/config.json'))).status).toBe(404);
  });

  it('a conflicting sha256 for an already-held key throws bad_descriptor and registers nothing', () => {
    register('m.descriptor');
    const before = verifiedRegistrySize();
    expect(() =>
      registerVerifiedFiles(PREFIX, 'm.descriptor', [
        file('extra.json', CONFIG),
        file('config.json', OTHER),
      ]),
    ).toThrow(expect.objectContaining({ code: 'bad_descriptor' }));
    expect(verifiedRegistrySize()).toBe(before);
  });

  it('the same key with the same sha256 is shared and survives the first release', async () => {
    const a = register('m.descriptor');
    const b = register('m.descriptor');
    a.release();
    expect((await verifiedFetch(abs('m.descriptor/config.json'))).status).toBe(200);
    b.release();
    expect((await verifiedFetch(abs('m.descriptor/config.json'))).status).toBe(404);
  });

  it('release() removes exactly its own keys and is idempotent', async () => {
    const base = verifiedRegistrySize();
    const a = register('a.descriptor');
    const b = register('b.descriptor', [file('config.json', OTHER), file('x/y.json', OTHER)]);
    expect(verifiedRegistrySize()).toBe(base + 3);
    b.release();
    b.release();
    expect(verifiedRegistrySize()).toBe(base + 1);
    expect((await verifiedFetch(abs('a.descriptor/config.json'))).status).toBe(200);
    a.release();
    expect(verifiedRegistrySize()).toBe(base);
  });

  it('refuses entry ids and paths that could escape the key space', () => {
    for (const id of ['', 'a/b', '..', 'a b', 'A', '.hidden']) {
      expect(() => registerVerifiedFiles(PREFIX, id, [file('config.json', CONFIG)]), id).toThrow(
        expect.objectContaining({ code: 'bad_descriptor' }),
      );
    }
    for (const path of ['../x', '/x', 'a//b', 'a\\b', '%2e%2e/x', '.x']) {
      expect(
        () => registerVerifiedFiles(PREFIX, 'm.descriptor', [file(path, CONFIG)]),
        path,
      ).toThrow(expect.objectContaining({ code: 'bad_descriptor' }));
    }
    expect(() =>
      registerVerifiedFiles('https://evil.test/', 'm.descriptor', [file('a', CONFIG)]),
    ).toThrow(expect.objectContaining({ code: 'bad_descriptor' }));
  });

  it('the location used is the page location at call time', async () => {
    register('m.descriptor');
    restoreLocation();
    restoreLocation = installLocation('https://other.test/app/models.html');
    await refused(verifiedFetch(abs('m.descriptor/config.json')));
    expect(PAGE_HREF).toContain('app.test');
  });
});
