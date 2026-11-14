// D1-04: the worker bootstrap (R3w). A workerUrl is validated before anything is created, the source is
// exactly 'import ' + JSON.stringify(abs) + ';', and the blob URL passes the singleton Trusted Types
// policy 'airplanemode-worker'. Written before src/backends/worker-bootstrap.ts.

import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import {
  WORKER_POLICY_NAME,
  bootstrapSource,
  createBootstrapUrl,
  getWorkerUrlPolicy,
  resolveWorkerUrl,
  type TrustedTypesLike,
} from '../src/backends/worker-bootstrap';

const BASE = 'https://app.test/app/models.html';
const ORIGIN = 'https://app.test';

describe('resolveWorkerUrl', () => {
  it('resolves a relative path against the base and accepts a same-origin http(s) module URL', () => {
    expect(resolveWorkerUrl('./worker/engine-worker.js', BASE, ORIGIN)).toBe(
      'https://app.test/app/worker/engine-worker.js',
    );
    expect(resolveWorkerUrl('/app/app/engine-worker-abc123.js', BASE, ORIGIN)).toBe(
      'https://app.test/app/app/engine-worker-abc123.js',
    );
    expect(resolveWorkerUrl('https://app.test/w.js', BASE, ORIGIN)).toBe('https://app.test/w.js');
    expect(
      resolveWorkerUrl(
        'http://127.0.0.1:8790/w.js',
        'http://127.0.0.1:8790/x.html',
        'http://127.0.0.1:8790',
      ),
    ).toBe('http://127.0.0.1:8790/w.js');
  });

  const refuses = (input: string) => {
    try {
      resolveWorkerUrl(input, BASE, ORIGIN);
    } catch (e) {
      expect(e, input).toBeInstanceOf(AdapterError);
      expect(['egress_refused', 'bad_descriptor'], input).toContain((e as AdapterError).code);
      expect((e as AdapterError).message).not.toContain(input.slice(0, 20) + '"');
      return;
    }
    throw new Error(`expected a refusal for ${JSON.stringify(input)}`);
  };

  it('refuses a double quote, a newline, a backslash, a space, an angle bracket and a backtick', () => {
    for (const bad of [
      './w".js',
      './w\n.js',
      './w\r.js',
      './w\\.js',
      './w .js',
      './w<.js',
      './w`.js',
      "./w'.js",
      './w\u0000.js',
      './w%22.js',
      './w%0a.js',
    ])
      refuses(bad);
  });

  it('refuses javascript:, data:, blob:, file:, ws: and other schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/javascript,alert(1)',
      'blob:https://app.test/1',
      'file:///etc/passwd',
      'ws://app.test/w.js',
      'ftp://app.test/w.js',
      'chrome-extension://abc/w.js',
    ])
      refuses(bad);
  });

  it('refuses a cross-origin host (also a look-alike, a userinfo trick and a protocol-relative URL)', () => {
    for (const bad of [
      'https://evil.test/w.js',
      'https://app.test.evil.test/w.js',
      'https://app.test@evil.test/w.js',
      '//evil.test/w.js',
      'http://app.test/w.js',
      'https://app.test:8443/w.js',
    ])
      refuses(bad);
  });

  it('refuses a query string or a fragment, empty input and non-strings', () => {
    for (const bad of ['./w.js?x=1', './w.js?', './w.js#frag', './w.js#', '']) refuses(bad);
    expect(() => resolveWorkerUrl(undefined as never, BASE, ORIGIN)).toThrow(AdapterError);
    expect(() => resolveWorkerUrl(5 as never, BASE, ORIGIN)).toThrow(AdapterError);
  });
});

describe('bootstrapSource', () => {
  it("is exactly 'import ' + JSON.stringify(abs) + ';'", () => {
    const abs = 'https://app.test/app/w.js';
    expect(bootstrapSource(abs)).toBe(`import ${JSON.stringify(abs)};`);
    expect(bootstrapSource(abs)).toBe('import "https://app.test/app/w.js";');
  });

  it('refuses anything that is not a clean absolute URL, so the source can contain nothing else', () => {
    for (const bad of [
      'https://app.test/w".js',
      'https://app.test/w\n.js',
      'javascript:1',
      'https://app.test/w.js;alert(1)//',
      'https://app.test/w.js?x=1',
      '/relative.js',
    ])
      expect(() => bootstrapSource(bad), bad).toThrow(AdapterError);
  });
});

function fakeTrustedTypes() {
  const created: { name: string; options: { createScriptURL(u: string): string } }[] = [];
  const tt: TrustedTypesLike = {
    createPolicy(name, options) {
      created.push({ name, options: options as never });
      return {
        name,
        createScriptURL: (u: string) => options.createScriptURL(u) as never,
      } as never;
    },
  };
  return { tt, created };
}

describe('the Trusted Types policy', () => {
  it('is created once per page under the name airplanemode-worker, and accepts only the URLs it was given', () => {
    const { tt, created } = fakeTrustedTypes();
    expect(WORKER_POLICY_NAME).toBe('airplanemode-worker');
    const a = getWorkerUrlPolicy({ trustedTypes: tt });
    const b = getWorkerUrlPolicy({ trustedTypes: tt });
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('airplanemode-worker');
    expect(() =>
      created[0]!.options.createScriptURL('blob:https://app.test/never-registered'),
    ).toThrow(TypeError);
    a.allow('blob:https://app.test/1');
    expect(created[0]!.options.createScriptURL('blob:https://app.test/1')).toBe(
      'blob:https://app.test/1',
    );
    a.revoke('blob:https://app.test/1');
    expect(() => created[0]!.options.createScriptURL('blob:https://app.test/1')).toThrow(TypeError);
  });

  it('feature-detects: without trustedTypes the URL passes through as a string', () => {
    const p = getWorkerUrlPolicy({ trustedTypes: undefined });
    p.allow('blob:x');
    expect(p.wrap('blob:x')).toBe('blob:x');
  });

  it('falls back to the raw string when the browser refuses to create the policy', () => {
    const p = getWorkerUrlPolicy({
      trustedTypes: {
        createPolicy() {
          throw new TypeError('Policy with name "airplanemode-worker" disallowed');
        },
      },
    });
    p.allow('blob:y');
    expect(p.wrap('blob:y')).toBe('blob:y');
  });
});

describe('createBootstrapUrl', () => {
  it('builds the Blob from the exact source with type text/javascript, registers the URL with the policy and revokes it', () => {
    const { tt } = fakeTrustedTypes();
    const policy = getWorkerUrlPolicy({ trustedTypes: tt });
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const b = createBootstrapUrl('https://app.test/app/w.js', {
      policy,
      createObjectURL: (blob) => {
        blobs.push(blob);
        return 'blob:https://app.test/abc';
      },
      revokeObjectURL: (u) => revoked.push(u),
    });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('text/javascript');
    expect(b.url).toBe('blob:https://app.test/abc');
    expect(b.trusted).toBe('blob:https://app.test/abc');
    b.revoke();
    b.revoke(); // idempotent
    expect(revoked).toEqual(['blob:https://app.test/abc']);
  });

  it('refuses a bad URL before URL.createObjectURL is ever called', () => {
    const create = vi.fn(() => 'blob:never');
    for (const bad of ['javascript:alert(1)', 'https://x/w".js', 'data:text/javascript,1'])
      expect(
        () =>
          createBootstrapUrl(bad, {
            policy: getWorkerUrlPolicy({ trustedTypes: undefined }),
            createObjectURL: create,
            revokeObjectURL: () => {},
          }),
        bad,
      ).toThrow(AdapterError);
    expect(create).not.toHaveBeenCalled();
  });

  it('the policy refuses a URL it did not create', () => {
    const { tt, created } = fakeTrustedTypes();
    getWorkerUrlPolicy({ trustedTypes: tt });
    expect(() => created[0]!.options.createScriptURL('blob:https://app.test/forged')).toThrow(
      TypeError,
    );
  });
});
