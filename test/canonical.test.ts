import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalError, canonicalize, signedBytes } from '../src/canonical';
import { readJson, readText, specDir, testDir } from './helpers';

const vectors = resolve(specDir, 'vectors');
const dec = new TextDecoder();

describe('canonicalize: shared vectors', () => {
  const names = readdirSync(vectors)
    .filter((f) => /^\d\d-.*\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));

  it('finds the five positive vectors', () => {
    expect(names).toEqual([
      '01-unsigned-example',
      '02-escapes',
      '03-devanagari',
      '04-minprofile-full',
      '05-four-entries',
    ]);
  });

  for (const name of names) {
    it(`${name}: signedBytes equals ${name}.canonical.txt byte for byte`, () => {
      const doc = readJson<Record<string, unknown>>(resolve(vectors, `${name}.json`));
      const expected = readText(resolve(vectors, `${name}.canonical.txt`));
      expect(dec.decode(signedBytes(doc))).toBe(expected);
      expect(Buffer.from(signedBytes(doc))).toEqual(Buffer.from(expected, 'utf8'));
    });
  }

  it('test/fixtures/canonical.expected.txt equals the unsigned example canonical bytes', () => {
    const fixture = readText(resolve(testDir, 'fixtures/canonical.expected.txt'));
    expect(fixture).toBe(readText(resolve(vectors, '01-unsigned-example.canonical.txt')));
    const doc = readJson(resolve(specDir, 'examples/manifest.unsigned.example.json'));
    expect(dec.decode(signedBytes(doc))).toBe(fixture);
  });
});

describe('canonicalize: rules', () => {
  it('sorts members by key in byte order recursively and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: true, c: null }, Z: [3, { y: 1, x: 2 }] })).toBe(
      '{"Z":[3,{"x":2,"y":1}],"a":{"c":null,"d":true},"b":1}',
    );
  });

  it('upper-case keys sort before lower-case (ASCII byte order), underscore between', () => {
    expect(canonicalize({ a: 1, _x: 2, B: 3 })).toBe('{"B":3,"_x":2,"a":1}');
  });

  it('escapes only quote, backslash and U+0000..U+001F; slash and <>& are literal', () => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
    const out = canonicalize({ s: `"\\/<>&${controls}` });
    expect(out).toBe(
      '{"s":"\\"\\\\/<>&\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f"}',
    );
  });

  it('emits non-ASCII (Devanagari) raw, never as \\u escapes', () => {
    expect(canonicalize({ p: 'एयरप्लेन' })).toBe('{"p":"एयरप्लेन"}');
    expect(canonicalize({ p: '  ' })).toBe('{"p":"  "}');
  });

  it('keeps arrays in order and nested objects sorted', () => {
    expect(
      canonicalize({
        entries: [
          { id: 'b', a: 1 },
          { id: 'a', a: 2 },
        ],
      }),
    ).toBe('{"entries":[{"a":1,"id":"b"},{"a":2,"id":"a"}]}');
  });

  it('integers as plain decimal up to 2^53-1', () => {
    expect(canonicalize({ n: 0, m: 9007199254740991 })).toBe('{"m":9007199254740991,"n":0}');
  });

  it('rejects floats with reason float', () => {
    expect(() => canonicalize({ n: 1.5 })).toThrow(CanonicalError);
    try {
      canonicalize({ n: 1.5 });
    } catch (e) {
      expect((e as CanonicalError).reason).toBe('float');
    }
    expect(() => canonicalize({ n: -0 })).toThrow(CanonicalError);
    expect(() => canonicalize({ n: NaN })).toThrow(CanonicalError);
    expect(() => canonicalize({ n: Infinity })).toThrow(CanonicalError);
  });

  it('rejects integers above 2^53-1 and negatives with reason bigint', () => {
    for (const n of [9007199254740992, 2 ** 60, -1]) {
      try {
        canonicalize({ n });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalError);
        expect((e as CanonicalError).reason).toBe('bigint');
      }
    }
  });

  it('rejects digit-leading keys {"b","10","a"} with reason digit_key', () => {
    try {
      canonicalize({ b: 1, '10': 2, a: 3 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalError);
      expect((e as CanonicalError).reason).toBe('digit_key');
    }
  });

  it('rejects keys outside ^[A-Za-z_][A-Za-z0-9_]{0,63}$ with reason invalid_key', () => {
    for (const k of ['a-b', 'a.b', '', 'x'.repeat(65), 'héllo', 'a b']) {
      try {
        canonicalize({ [k]: 1 });
        expect.unreachable(k);
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalError);
        expect((e as CanonicalError).reason).toBe('invalid_key');
      }
    }
    expect(canonicalize({ ['x'.repeat(64)]: 1 })).toBe(`{"${'x'.repeat(64)}":1}`);
  });

  it('rejects lone surrogates with reason lone_surrogate', () => {
    for (const s of ['\ud800', 'a\udc00b', '\ud83d']) {
      try {
        canonicalize({ s });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalError);
        expect((e as CanonicalError).reason).toBe('lone_surrogate');
      }
    }
    expect(canonicalize({ s: '😀' })).toBe('{"s":"😀"}');
  });

  it('rejects undefined, functions, symbols and bigint values with reason invalid_type', () => {
    for (const v of [undefined, () => 1, Symbol('x'), 10n]) {
      try {
        canonicalize({ v });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalError);
        expect((e as CanonicalError).reason).toBe('invalid_type');
      }
    }
  });

  it('signedBytes removes the signatures member and prepends the prefix', () => {
    const doc = { b: 1, signatures: [{ alg: 'none' }], a: 2 };
    expect(dec.decode(signedBytes(doc))).toBe('airplanemode-manifest-v1\n{"a":2,"b":1}');
  });
});
