// Fix round 2 (TD-29): the last amendment of manifest 0.1.1 before the first push.
//
//   BUG-T2-S4-11 (high)   a member named __proto__, constructor, toString, ... is not declared by any schema
//                         and is therefore `schema`; before the fix `k in props` counted inherited
//                         Object.prototype names as declared, and canonicalisation dropped an own
//                         "__proto__" key, so unsigned data rode inside a manifest that verified;
//   BUG-T2-S4-14 (medium) one accepted encoding per signature and per public key (canonical padded base64);
//   BUG-T2-S4-15 (low)    the forbidden url characters are one explicit set, not \s.
//
// Written before any source or spec file changed (red run: evidence/sprint-4/D1/red-fix2-D1.log).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_URL_PATTERN,
  SIGNATURE_PUBLIC_KEY_PATTERN,
  SIGNATURE_SIG_PATTERN,
  type Manifest,
} from '../spec/manifest';
import { parseDescriptor } from '../src/backends/descriptor';
import { canonicalize, signedBytes } from '../src/canonical';
import {
  ManifestError,
  decodeBase64,
  parseManifest,
  verifyManifest,
  type VerifyResult,
} from '../src/manifest';
import { SCHEMAS, validateSchema } from '../src/schema';
import {
  RFC8032_KEY_ID,
  RFC8032_PUBLIC,
  makeEntry,
  makeManifest,
  readJson,
  readText,
  repoDir,
  signManifest,
  specDir,
} from './helpers';

const NOW = Date.parse('2026-11-14T00:00:00Z');
const vectorsDir = resolve(specDir, 'vectors');
const tamperDir = resolve(vectorsDir, 'tamper');
const trust = () => new Map([[RFC8032_KEY_ID, RFC8032_PUBLIC]]);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const verify = (input: unknown): Promise<VerifyResult> =>
  verifyManifest(input, trust(), { allowTestKeys: true, now: NOW });

/** Adds an OWN data member (also for the name __proto__, which plain assignment would turn into a prototype). */
function addMember(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------------------------
// BUG-T2-S4-11 (1): an undeclared member of any name is schema, in every object of the manifest
// ---------------------------------------------------------------------------------------------

/** Every name an object inherits from Object.prototype, plus the special __proto__. */
const NAMES = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

const signedBase = (): Manifest =>
  signManifest(
    makeManifest({
      id: 'proto-test',
      expiresAt: '2027-01-01T00:00:00Z',
      entries: [makeEntry('a'), makeEntry('b')],
    }),
  );

const PLACES: Record<string, (m: Manifest) => object> = {
  top: (m) => m,
  'entries[0]': (m) => m.entries[0]!,
  'entries[0].minProfile': (m) => m.entries[0]!.minProfile,
  'signatures[0]': (m) => m.signatures[0]!,
};

describe('BUG-T2-S4-11: an undeclared member of any name is schema (top level, entries, minProfile, signatures)', () => {
  it('the control (the signed base, no extra member) verifies', async () => {
    const r = await verify(JSON.stringify(signedBase()));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  for (const [place, pick] of Object.entries(PLACES)) {
    for (const name of NAMES) {
      it(`${name} in ${place}: schema from text, from an object and from parseManifest`, async () => {
        const m = JSON.parse(JSON.stringify(signedBase())) as Manifest;
        addMember(pick(m), name, { pin: true, chunkSize: 1048576, url: 'https://evil.example/x' });
        const text = JSON.stringify(m);
        expect(text).toContain(`"${name}":`);

        const fromText = await verify(text);
        expect(fromText.ok, `text ${name}@${place}`).toBe(false);
        if (!fromText.ok) expect(fromText.reason).toBe('schema');

        const fromObject = await verify(m);
        expect(fromObject.ok, `object ${name}@${place}`).toBe(false);
        if (!fromObject.ok) expect(fromObject.reason).toBe('schema');

        expect(() => parseManifest(text)).toThrowError(ManifestError);
        try {
          parseManifest(text);
        } catch (e) {
          expect((e as ManifestError).reason).toBe('schema');
        }
      });
    }
  }

  it('a required member is judged by Object.hasOwn: a member inherited from Object.prototype does not satisfy it', () => {
    Object.defineProperty(Object.prototype, 'publisher', {
      value: 'inherited',
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const m = JSON.parse(JSON.stringify(signedBase())) as Record<string, unknown>;
      delete m['publisher'];
      const res = validateSchema(SCHEMAS.manifest, m);
      expect(res.ok).toBe(false);
      expect(
        res.errors.some((e) => e.keyword === 'required' && e.message.includes('publisher')),
      ).toBe(true);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['publisher'];
    }
  });

  it('an undeclared member is additionalProperties, and the message names the member', () => {
    const m = JSON.parse(JSON.stringify(signedBase())) as Manifest;
    addMember(m.entries[0]!.minProfile, 'toString', 1);
    const res = validateSchema(SCHEMAS.manifest, m);
    expect(res.errors).toContainEqual({
      path: '/entries/0/minProfile', // the pointer of the object that carries the member
      keyword: 'additionalProperties',
      message: 'unexpected property toString',
    });
  });

  it('an object that does not have the plain Object prototype is schema: an inherited pin never reaches a consumer', async () => {
    const m = JSON.parse(JSON.stringify(signedBase())) as Manifest;
    const entry = Object.create({ pin: true, chunkSize: 1048576 }) as Record<string, unknown>;
    Object.assign(entry, m.entries[0]);
    m.entries[0] = entry as unknown as Manifest['entries'][number];
    expect(entry['pin']).toBe(true); // inherited, not an own member: not covered by the signature
    const r = await verify(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema');
    expect(() => parseManifest(m)).toThrowError(ManifestError);
  });

  it('a parsed manifest keeps plain objects: every entry has Object.prototype and no inherited pin or chunkSize', async () => {
    const r = await verify(JSON.stringify(signedBase()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const obj of [
      r.manifest,
      ...r.manifest.entries,
      ...r.manifest.entries.map((e) => e.minProfile),
    ]) {
      const proto = Object.getPrototypeOf(obj) as unknown;
      expect(proto === Object.prototype || proto === null).toBe(true);
    }
    for (const e of r.manifest.entries) {
      expect(Object.hasOwn(e, 'pin')).toBe(false);
      expect(e.pin).toBeUndefined();
      expect(e.chunkSize).toBeUndefined();
    }
  });
});

describe('BUG-T2-S4-11: the model descriptor parser agrees (schema for any undeclared member)', () => {
  const base = readJson<Record<string, unknown>>(
    resolve(specDir, 'examples/model-descriptor.example.json'),
  );
  const PLACES_D: Record<string, (d: Record<string, unknown>) => object> = {
    top: (d) => d,
    'files[0]': (d) => (d['files'] as object[])[0]!,
    generation: (d) => d['generation'] as object,
    source: (d) => d['source'] as object,
  };
  const reasonOf = (text: string): string => {
    try {
      parseDescriptor(text);
    } catch (e) {
      return (e as { reason: string }).reason;
    }
    return 'accepted';
  };

  it('the control parses', () => {
    expect(reasonOf(JSON.stringify(base))).toBe('accepted');
  });

  for (const [place, pick] of Object.entries(PLACES_D)) {
    for (const name of NAMES) {
      it(`${name} in ${place}: schema`, () => {
        const d = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
        addMember(pick(d), name, 'x');
        expect(reasonOf(JSON.stringify(d))).toBe('schema');
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// BUG-T2-S4-11 (2): canonicalisation serialises an own "__proto__" member and never sets a prototype
// ---------------------------------------------------------------------------------------------

describe('BUG-T2-S4-11: canonical() keeps an own __proto__ member', () => {
  it('canonicalize of a parsed object with an own "__proto__" key contains that key, sorted in byte order', () => {
    const parsed = JSON.parse('{"b":2,"__proto__":{"a":1},"a":0}') as object;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(canonicalize(parsed)).toBe('{"__proto__":{"a":1},"a":0,"b":2}');
  });

  it('the member survives at any depth, inside arrays too', () => {
    const parsed = JSON.parse('{"list":[{"__proto__":true,"x":1}],"n":{"m":{"__proto__":"v"}}}');
    expect(canonicalize(parsed)).toBe(
      '{"list":[{"__proto__":true,"x":1}],"n":{"m":{"__proto__":"v"}}}',
    );
  });

  it('signedBytes covers it: a manifest body with an own __proto__ member signs differently from the body without', () => {
    const plain = JSON.parse(JSON.stringify(signedBase())) as Manifest;
    const tainted = JSON.parse(JSON.stringify(signedBase())) as Manifest;
    addMember(tainted.entries[0]!, '__proto__', { pin: true });
    expect(sha(Buffer.from(signedBytes(tainted)))).not.toBe(sha(Buffer.from(signedBytes(plain))));
    expect(Buffer.from(signedBytes(tainted)).toString('utf8')).toContain(
      '"__proto__":{"pin":true}',
    );
  });

  it('canonicalisation never touches Object.prototype or the prototype of its output', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    canonicalize(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// BUG-T2-S4-14: one accepted encoding per signature and per public key
// ---------------------------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

describe('BUG-T2-S4-14: canonical padded base64 for sig and publicKey', () => {
  it('the exported pattern constants are the patterns of manifest.schema.json', () => {
    const sigSchema = (
      SCHEMAS.manifest as {
        $defs: { Signature: { properties: Record<string, { pattern: string }> } };
      }
    ).$defs.Signature.properties;
    expect(sigSchema['sig']!.pattern).toBe(SIGNATURE_SIG_PATTERN);
    expect(sigSchema['publicKey']!.pattern).toBe(SIGNATURE_PUBLIC_KEY_PATTERN);
    expect(SIGNATURE_SIG_PATTERN).toBe('^[A-Za-z0-9+/]{85}[AQgw]==$');
    expect(SIGNATURE_PUBLIC_KEY_PATTERN).toBe('^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$');
  });

  it('the last character before the padding is canonical exactly when its unused low bits are zero (all 64 characters)', () => {
    const sig = new RegExp(SIGNATURE_SIG_PATTERN, 'u');
    const key = new RegExp(SIGNATURE_PUBLIC_KEY_PATTERN, 'u');
    ALPHABET.split('').forEach((c, v) => {
      // 64 bytes: the last base64 character carries 2 data bits, 4 pad bits; 32 bytes: 4 data, 2 pad
      expect(sig.test(`${'A'.repeat(85)}${c}==`), `sig ${c}`).toBe(v % 16 === 0);
      expect(key.test(`${'A'.repeat(42)}${c}=`), `publicKey ${c}`).toBe(v % 4 === 0);
    });
  });

  it('decodeBase64 refuses an input whose re-encoding differs, and accepts the canonical form', () => {
    expect([...decodeBase64('QQ==')!]).toEqual([0x41]);
    expect(decodeBase64('QR==')).toBeUndefined(); // same byte, non-zero pad bits
    expect(decodeBase64('QUI=')).toBeDefined();
    expect(decodeBase64('QUJ=')).toBeUndefined();
    expect(decodeBase64('QUJD')).toBeDefined();
    expect(decodeBase64('QUJ')).toBeUndefined(); // unpadded
    expect(decodeBase64('QUJD====')).toBeUndefined();
    expect(decodeBase64('QU-D')).toBeUndefined(); // URL-safe alphabet
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
    // round trip over many lengths
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = Buffer.from(bytes).toString('base64');
      expect([...decodeBase64(text)!]).toEqual([...bytes]);
    }
  });

  /** The last character of a base64 string (before padding) with the unused low bits set. */
  const dirty = (s: string, at: number): string =>
    s.slice(0, at) + ALPHABET[ALPHABET.indexOf(s[at]!) | 1] + s.slice(at + 1);

  it('a validly signed manifest whose sig has non-zero pad bits is schema, not valid (rotation vector, valid signature at index 1)', async () => {
    const m = readJson<Manifest>(resolve(tamperDir, 'tamper-11-rotation-ok.json'));
    expect((await verify(m)).ok).toBe(true);
    const bad = structuredClone(m);
    bad.signatures[1]!.sig = dirty(bad.signatures[1]!.sig, 85);
    // lenient decoding (what atob does) still gives the original signature bytes
    expect(Buffer.from(bad.signatures[1]!.sig, 'base64')).toEqual(
      Buffer.from(m.signatures[1]!.sig, 'base64'),
    );
    const r = await verify(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema');
  });

  it('the same for publicKey', async () => {
    const m = readJson<Manifest>(resolve(tamperDir, 'tamper-11-rotation-ok.json'));
    const bad = structuredClone(m);
    const pk = bad.signatures[1]!.publicKey!;
    bad.signatures[1]!.publicKey = dirty(pk, 42);
    expect(Buffer.from(bad.signatures[1]!.publicKey, 'base64')).toEqual(Buffer.from(pk, 'base64'));
    const r = await verify(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema');
  });
});

// ---------------------------------------------------------------------------------------------
// BUG-T2-S4-15: the forbidden url characters are one explicit set
// ---------------------------------------------------------------------------------------------

/** The set of MANIFEST.md Shape, written out independently of the pattern under test. */
const FORBIDDEN_URL: ReadonlySet<number> = (() => {
  const s = new Set<number>([0x3f, 0x23, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
  for (let c = 0x0000; c <= 0x0020; c++) s.add(c);
  for (let c = 0x007f; c <= 0x00a0; c++) s.add(c);
  for (let c = 0x2000; c <= 0x200a; c++) s.add(c);
  return s;
})();

const urlManifest = (url: string): Manifest => makeManifest({ entries: [makeEntry('a', { url })] });
const urlFault = (url: string): string | undefined => {
  try {
    parseManifest(urlManifest(url));
    return undefined;
  } catch (e) {
    return (e as ManifestError).reason;
  }
};

describe('BUG-T2-S4-15: the entry url forbidden set is explicit', () => {
  it('ENTRY_URL_PATTERN is the url pattern of manifest.schema.json and has no \\s', () => {
    const url = (
      SCHEMAS.manifest as {
        $defs: { ManifestEntry: { properties: Record<string, { pattern: string }> } };
      }
    ).$defs.ManifestEntry.properties['url']!.pattern;
    expect(url).toBe(ENTRY_URL_PATTERN);
    expect(ENTRY_URL_PATTERN).not.toContain('\\s');
    expect(ENTRY_URL_PATTERN).toContain('\\u0000-\\u0020');
    expect(ENTRY_URL_PATTERN).toContain('\\u007f-\\u00a0');
    expect(ENTRY_URL_PATTERN).toContain('\\u1680');
    expect(ENTRY_URL_PATTERN).toContain('\\u2000-\\u200a');
    expect(ENTRY_URL_PATTERN).toContain('\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff');
  });

  it('every BMP code point: forbidden exactly when it is in the set (relative reference)', () => {
    const re = new RegExp(ENTRY_URL_PATTERN, 'u');
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogate halves are not code points
      const accepted = re.test(`assets/a${String.fromCodePoint(cp)}b`);
      if (accepted === FORBIDDEN_URL.has(cp)) wrong.push(cp.toString(16));
    }
    expect(wrong).toEqual([]);
  });

  it('astral code points are allowed (a regular-expression engine with and without the unicode flag agrees)', () => {
    expect(new RegExp(ENTRY_URL_PATTERN, 'u').test('assets/a\u{1f600}b')).toBe(true);
    expect(urlFault('assets/a\u{1f600}b')).toBeUndefined();
  });

  it('the set applies to the https, loopback http and relative branches alike', () => {
    for (const ch of ['\u0001', '\u007f', '\u0085', ' ', ' ', '　', '﻿', ' ', '?', '#']) {
      for (const u of [
        `https://example.com/a${ch}b`,
        `http://localhost:8080/a${ch}b`,
        `http://127.0.0.1/a${ch}b`,
        `assets/a${ch}b`,
      ])
        expect(urlFault(u), JSON.stringify(u)).toBe('bad_url');
    }
    for (const u of [
      'https://example.com/a%20b',
      'http://localhost:8080/a-b',
      'assets/ऀb', // Devanagari
      'assets/a​b', // zero width space is not in the set
      'assets/a‪b', // nor is a bidi control
      'assets/a᠎b', // nor is the Mongolian vowel separator
      'assets/a¡b',
    ])
      expect(urlFault(u), JSON.stringify(u)).toBeUndefined();
  });

  it('MANIFEST.md Shape lists the set and says both verifiers implement exactly this list, reason bad_url', () => {
    const md = flat(readText(resolve(specDir, 'MANIFEST.md')));
    for (const s of [
      'U+0000 to U+0020',
      'U+007F to U+00A0',
      'U+1680',
      'U+2000 to U+200A',
      'U+2028',
      'U+2029',
      'U+202F',
      'U+205F',
      'U+3000',
      'U+FEFF',
      'both verifiers implement exactly this list',
    ])
      expect(md, s).toContain(s);
  });
});

// ---------------------------------------------------------------------------------------------
// The shared vectors of fix round 2
// ---------------------------------------------------------------------------------------------

describe('fix round 2 vectors: nine manifest negatives and one descriptor negative, each with one fault', () => {
  const rows = readJson<{ file: string; reason: string; stage: string }[]>(
    resolve(vectorsDir, 'negative.json'),
  );
  const NEW = [
    ['neg-proto-member-entry.json', 'schema'],
    ['neg-sig-proto-member.json', 'schema'],
    ['neg-sig-malformed-keyid-rotation.json', 'schema'],
    ['neg-sig-malformed-sig-rotation.json', 'schema'],
    ['neg-sig-malformed-pubkey-rotation.json', 'schema'],
    ['neg-sig-noncanonical-base64.json', 'schema'],
    ['neg-pubkey-noncanonical-base64.json', 'schema'],
    ['neg-url-control-char.json', 'bad_url'],
    ['neg-url-unicode-space.json', 'bad_url'],
  ] as const;

  it('negative.json has 32 rows; the nine new ones come last, in this order', () => {
    expect(rows).toHaveLength(32);
    expect(rows.slice(23).map((r) => [r.file, r.reason])).toEqual(NEW.map((n) => [...n]));
    for (const r of rows.slice(23)) expect(r.stage).toBe('parse');
  });

  for (const [file, reason] of NEW) {
    it(`${file} is refused with ${reason}, from text and from the object JSON.parse builds`, async () => {
      const text = readText(resolve(vectorsDir, file));
      const r = await verify(text);
      expect(r.ok, file).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
      const o = await verify(JSON.parse(text));
      expect(o.ok, file).toBe(false);
      if (!o.ok) expect(o.reason).toBe(reason);
    });
  }

  it('the body of every signed vector verifies once the single fault is removed (validly signed apart from the fault)', async () => {
    // the five rotation-derived vectors differ from tamper-11 in exactly one signature member
    const t11 = readJson<Manifest>(resolve(tamperDir, 'tamper-11-rotation-ok.json'));
    const diff = (file: string): string[] => {
      const v = readJson<Manifest>(resolve(vectorsDir, file));
      const { signatures: sa, ...ra } = v;
      const { signatures: sb, ...rb } = t11;
      expect(ra).toEqual(rb);
      expect(sa).toHaveLength(2);
      expect(sa[1]).toEqual(sb[1]); // the valid signature of key 1 is untouched
      const out: string[] = [];
      const ma = sa[0] as unknown as Record<string, unknown>;
      const mb = sb[0] as unknown as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)]))
        if (JSON.stringify(ma[k]) !== JSON.stringify(mb[k])) out.push(k);
      return out;
    };
    expect(diff('neg-sig-malformed-keyid-rotation.json')).toEqual(['keyId']);
    expect(diff('neg-sig-malformed-sig-rotation.json')).toEqual(['sig']);
    expect(diff('neg-sig-malformed-pubkey-rotation.json')).toEqual(['publicKey']);
    const keyId = readJson<Manifest>(resolve(vectorsDir, 'neg-sig-malformed-keyid-rotation.json'))
      .signatures[0]!.keyId;
    expect(keyId).toBe(t11.signatures[0]!.keyId.toUpperCase());
    const sig63 = readJson<Manifest>(resolve(vectorsDir, 'neg-sig-malformed-sig-rotation.json'))
      .signatures[0]!.sig;
    expect(Buffer.from(sig63, 'base64')).toHaveLength(63);
    expect(
      readJson<Manifest>(resolve(vectorsDir, 'neg-sig-malformed-pubkey-rotation.json'))
        .signatures[0]!.publicKey,
    ).toBe('AAAA');
  });

  it('neg-sig-noncanonical-base64 and neg-pubkey-noncanonical-base64: a lenient decoder gives the CORRECT signature and key, so only the encoding is wrong', async () => {
    for (const [file, member] of [
      ['neg-sig-noncanonical-base64.json', 'sig'],
      ['neg-pubkey-noncanonical-base64.json', 'publicKey'],
    ] as const) {
      const m = readJson<Manifest>(resolve(vectorsDir, file));
      expect(m.signatures).toHaveLength(1);
      const s = m.signatures[0]!;
      const value = s[member]!;
      // not canonical: re-encoding the decoded bytes differs
      const lenient = Buffer.from(value, 'base64');
      expect(lenient.toString('base64')).not.toBe(value);
      // repair the pad bits: the manifest then verifies, so the encoding is the one and only fault
      const repaired = structuredClone(m);
      repaired.signatures[0]![member] = lenient.toString('base64');
      const r = await verify(JSON.stringify(repaired));
      expect(r.ok, `${file} repaired`).toBe(true);
      // the pad bits are the low bits of the last character before the padding
      const at = value.indexOf('=') - 1;
      expect(ALPHABET.indexOf(value[at]!) % (member === 'sig' ? 16 : 4)).not.toBe(0);
    }
  });

  it('neg-proto-member-entry: the signature covers the body WITHOUT the __proto__ member, so only the member makes it invalid', async () => {
    const text = readText(resolve(vectorsDir, 'neg-proto-member-entry.json'));
    expect(text).toContain('"__proto__"');
    const parsed = JSON.parse(text) as Manifest;
    const entry0 = parsed.entries[0] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(entry0, '__proto__')).toBe(true);
    expect(entry0['__proto__']).toEqual({ pin: true });
    const repaired = JSON.parse(text) as Manifest;
    delete (repaired.entries[0] as unknown as Record<string, unknown>)['__proto__'];
    expect((await verify(JSON.stringify(repaired))).ok).toBe(true);
  });

  it('neg-sig-proto-member: signatures[0] gains "constructor":"x" and nothing else', async () => {
    const parsed = readJson<Manifest>(resolve(vectorsDir, 'neg-sig-proto-member.json'));
    expect((parsed.signatures[0] as unknown as Record<string, unknown>)['constructor']).toBe('x');
    expect(Object.hasOwn(parsed.signatures[0]!, 'constructor')).toBe(true);
    const repaired = structuredClone(parsed);
    delete (repaired.signatures[0] as unknown as Record<string, unknown>)['constructor'];
    expect((await verify(JSON.stringify(repaired))).ok).toBe(true);
  });

  it('neg-url-control-char and neg-url-unicode-space: signed with the faulty url, so bad_url is decided before any signature', async () => {
    const ctl = readJson<Manifest>(resolve(vectorsDir, 'neg-url-control-char.json'));
    expect(ctl.entries[0]!.url).toBe('assets/a\u0001b');
    const spc = readJson<Manifest>(resolve(vectorsDir, 'neg-url-unicode-space.json'));
    expect(spc.entries[0]!.url).toContain(' ');
    for (const m of [ctl, spc]) {
      expect(m.signatures).toHaveLength(1);
      // the signature is correct for the body as written (it would verify were the url allowed)
      const sig = Buffer.from(m.signatures[0]!.sig, 'base64');
      const ok = await crypto.subtle.verify(
        { name: 'Ed25519' },
        await crypto.subtle.importKey(
          'raw',
          RFC8032_PUBLIC as BufferSource,
          { name: 'Ed25519' },
          false,
          ['verify'],
        ),
        sig as BufferSource,
        signedBytes(m) as BufferSource,
      );
      expect(ok).toBe(true);
    }
  });

  it('the descriptor vector neg-proto-member carries an own "__proto__" member at the top level (reason schema)', () => {
    const text = readText(resolve(vectorsDir, 'descriptor/neg-proto-member.json'));
    expect(text).toContain('"__proto__"');
    expect(Object.hasOwn(JSON.parse(text) as object, '__proto__')).toBe(true);
    let reason = 'accepted';
    try {
      parseDescriptor(text);
    } catch (e) {
      reason = (e as { reason: string }).reason;
    }
    expect(reason).toBe('schema');
  });
});

describe('fix round 2: everything the brief names stays byte-identical (the sha fixture of the state before the round)', () => {
  const fixture = readText(resolve(repoDir, 'test/fixtures/spec-frozen-before-fix2.sha256.txt'))
    .trim()
    .split('\n')
    .map((l) => l.split(/\s+/) as [string, string]);

  it('the fixture lists the 6 TD-26 negatives, every tamper and tamper-assets file, storage-api.ts and event.ts', () => {
    const files = fixture.map(([, f]) => f);
    expect(files.filter((f) => /^vectors\/neg-/.test(f))).toHaveLength(6);
    expect(files.filter((f) => f.startsWith('vectors/tamper/'))).toHaveLength(17);
    expect(files.filter((f) => f.startsWith('vectors/tamper-assets/'))).toHaveLength(8);
    expect(files).toContain('storage-api.ts');
    expect(files).toContain('event.ts');
    expect(files).toHaveLength(33);
  });

  it('no file under tamper/ or tamper-assets/ was added or removed', () => {
    for (const d of ['tamper', 'tamper-assets']) {
      const onDisk = readdirSync(resolve(vectorsDir, d)).sort();
      const listed = fixture
        .map(([, f]) => f)
        .filter((f) => f.startsWith(`vectors/${d}/`))
        .map((f) => f.slice(`vectors/${d}/`.length))
        .sort();
      expect(onDisk).toEqual(listed);
    }
  });

  it('every listed file hashes exactly as before the round', () => {
    for (const [hash, file] of fixture)
      expect(sha(readFileSync(resolve(specDir, file))), file).toBe(hash);
  });

  it('the 15 tamper rows keep their tabled result under the tightened patterns', async () => {
    const rowsT = readJson<
      {
        file: string;
        trust: string[];
        allowTestKeys: boolean;
        now: string;
        state: { version: string; createdAt: string } | null;
        requiresState: boolean;
        expect: { valid: boolean; reason?: string; signatures?: string[] };
      }[]
    >(resolve(tamperDir, 'tamper.json'));
    expect(rowsT).toHaveLength(15);
    const { RFC8032_TEST2_PUBLIC, keyIdOf } = await import('./helpers');
    const keys: Record<string, Uint8Array> = {
      'rfc8032-1': RFC8032_PUBLIC,
      'rfc8032-2': RFC8032_TEST2_PUBLIC,
    };
    for (const row of rowsT) {
      const t = new Map(row.trust.map((n) => [keyIdOf(keys[n]!), keys[n]!]));
      const text = readText(resolve(tamperDir, row.file));
      if (row.expect.reason === 'test_key_refused') {
        await expect(
          verifyManifest(text, t, { allowTestKeys: row.allowTestKeys, now: Date.parse(row.now) }),
        ).rejects.toMatchObject({ reason: 'test_key_refused' });
        continue;
      }
      const seeded = row.state ? { ...row.state } : undefined;
      const r = await verifyManifest(text, t, {
        allowTestKeys: row.allowTestKeys,
        now: Date.parse(row.now),
        state: {
          get: async () => (seeded ? { ...seeded } : undefined),
          set: async () => undefined,
        },
      });
      expect(r.ok, row.file).toBe(row.expect.valid);
      if (!r.ok) expect(r.reason, row.file).toBe(row.expect.reason);
      if (row.expect.signatures)
        expect(
          r.signatures.map((c) => (c.valid ? 'valid' : c.reason)),
          row.file,
        ).toEqual(row.expect.signatures);
    }
  });

  it('the generators agree with the files: make-vectors --check and make-tamper-vectors --check exit 0', () => {
    for (const script of [
      'make-vectors.mjs',
      'make-tamper-vectors.mjs',
      'make-descriptor-vectors.mjs',
    ]) {
      const r = spawnSync(process.execPath, [resolve(repoDir, 'test/tools', script), '--check'], {
        encoding: 'utf8',
      });
      expect(r.stderr, `${script}: ${r.stderr}`).toBe('');
      expect(r.status, script).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

describe('fix round 2: the documents say it (TD-29)', () => {
  const manifestMd = flat(readText(resolve(specDir, 'MANIFEST.md')));
  const changelog = flat(readText(resolve(specDir, 'CHANGELOG.md')));
  const specReadme = flat(readText(resolve(specDir, 'README.md')));
  const vectorsReadme = flat(readText(resolve(vectorsDir, 'README.md')));
  const descReadme = flat(readText(resolve(vectorsDir, 'descriptor/README.md')));
  const readme = flat(readText(resolve(repoDir, 'README.md')));
  const runtimeChangelog = flat(readText(resolve(repoDir, 'CHANGELOG.md')));

  it('MANIFEST.md Shape: an undeclared member of any name is schema, tested by own property', () => {
    const shape = manifestMd.slice(
      manifestMd.indexOf('## Shape'),
      manifestMd.indexOf('## Canonicalisation'),
    );
    expect(shape).toContain('Unknown members');
    expect(shape).toContain('__proto__');
    expect(shape).toContain('constructor');
    expect(shape).toContain('own property');
    expect(shape).toContain('is `schema`');
  });

  it('MANIFEST.md Signing: sig and publicKey MUST be canonical padded base64 (RFC 4648 section 3.5)', () => {
    const signing = manifestMd.slice(
      manifestMd.indexOf('## Signing'),
      manifestMd.indexOf('## Trust roots'),
    );
    expect(signing).toContain(
      'sig and publicKey MUST be canonical padded base64 (RFC 4648 section 3.5: pad bits zero); anything else is schema',
    );
    expect(manifestMd).toContain('^[A-Za-z0-9+/]{85}[AQgw]==$');
    expect(manifestMd).toContain('^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$');
  });

  it('MANIFEST.md Duplicate members: member names are ordinary strings, no name is special', () => {
    const dup = manifestMd.slice(
      manifestMd.indexOf('## Duplicate members'),
      manifestMd.indexOf('## Signing'),
    );
    expect(dup).toContain('__proto__');
    expect(dup).toContain('canonical form');
  });

  it('MANIFEST.md Conformance counts 32 negative vectors', () => {
    const c = manifestMd.slice(manifestMd.indexOf('## Conformance'));
    expect(c).toContain('vectors/negative.json (32)');
    expect(c).not.toContain('(23)');
  });

  it('spec/README.md, vectors/README.md and the descriptor README carry the new counts and files', () => {
    expect(specReadme).toContain('thirty-two negative');
    expect(vectorsReadme).toContain('Thirty-two negative vectors');
    for (const [f] of [
      ['neg-proto-member-entry.json'],
      ['neg-sig-proto-member.json'],
      ['neg-sig-malformed-keyid-rotation.json'],
      ['neg-sig-malformed-sig-rotation.json'],
      ['neg-sig-malformed-pubkey-rotation.json'],
      ['neg-sig-noncanonical-base64.json'],
      ['neg-pubkey-noncanonical-base64.json'],
      ['neg-url-control-char.json'],
      ['neg-url-unicode-space.json'],
    ])
      expect(vectorsReadme, f).toContain(f!);
    expect(descReadme).toContain('neg-proto-member');
    expect(descReadme).toContain('20 in all');
  });

  it('spec/CHANGELOG.md extends the TD-26 section with this round (TD-29) and names every bug', () => {
    const entry = changelog.slice(changelog.indexOf('## [0.4.0]'), changelog.indexOf('## [0.3.0]'));
    expect(entry).toContain('Amended in place before the first push');
    expect(entry).toContain('TD-26');
    expect(entry).toContain('TD-29');
    for (const id of ['BUG-T2-S4-11', 'BUG-T2-S4-13', 'BUG-T2-S4-14', 'BUG-T2-S4-15', 'S1-095'])
      expect(entry, id).toContain(id);
    expect(entry).toContain('32');
    expect(entry).toContain('20');
  });

  it('the runtime README and CHANGELOG record the round, and the README carries the Sprint 4 process sentence', () => {
    expect(readme).toContain(
      "tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push",
    );
    expect(runtimeChangelog).toContain('BUG-T2-S4-11');
    expect(runtimeChangelog).toContain('BUG-T2-S4-14');
    expect(runtimeChangelog).toContain('BUG-T2-S4-15');
    expect(runtimeChangelog).toContain('S1-096');
    expect(runtimeChangelog).toContain('T3-S4-OBS-01b');
    expect(readme).toContain('thirty-two');
  });

  it('LANDED bookkeeping: the generators cover every file of negative.json', () => {
    for (const r of readJson<{ file: string }[]>(resolve(vectorsDir, 'negative.json')))
      expect(existsSync(resolve(vectorsDir, r.file)), r.file).toBe(true);
  });
});
