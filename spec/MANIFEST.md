# Manifest spec v0.1

The open, signed model-asset manifest of Airplane Mode Labs. This document is normative and standalone:
an implementation can be written from it, the schema and the vectors alone. It is the plan's "manifest
spec v0.1": the manifest contract on the wire string `airplanemode.manifest/0.1`, published as manifest
0.1.4 in spec release 0.6.1, status: published (committed; public after the owner's push; manifest 0.1.1
was pushed on 15 Nov 2026). Published means frozen on its wire string: later changes are additive patches
that change no accepted or refused input, or a new wire string. Manifest 0.1.2, 0.1.3 and 0.1.4 are such
patches (see Manifest 0.1.2, Manifest 0.1.3 and Manifest 0.1.4 below): the wire format of manifest 0.1.1 is
unchanged.

Files: `manifest.schema.json` (JSON Schema 2020-12, `$id urn:airplanemode:spec:manifest:0.1.4`),
`manifest.ts` (the TypeScript mirror and the shared constants), `vectors/` (positive, negative and
tamper vectors), `examples/` (a signed and an unsigned example, `TEST-KEY.md`). The key words MUST,
MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Scope

A manifest lists each model or data file a browser application may load: its URL, SHA-256, size,
version, licence and the minimum capability profile that can run it. It is signed with Ed25519. A
consumer verifies the signature, then hashes every file in full before any byte reaches an engine. The
manifest is the unit of governance: it says which bytes an application may use, and who vouched for them.

The spec covers the wire shape, the canonical byte form that is signed, the signing and verification
rules, the downgrade rule and the rule for which reason a refusal reports. It does not cover where a
trust root comes from (application configuration), how a manifest is distributed, key generation or
custody, or revocation.

## Shape

A manifest is one JSON object, UTF-8, at most 4 MiB. Every object key matches
`^[A-Za-z_][A-Za-z0-9_]{0,63}$`.

Manifest:

| Member       | Rule                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| `spec`       | exactly `airplanemode.manifest/0.1`; consumers reject any other value                      |
| `id`         | `^[a-z0-9][a-z0-9.-]{2,127}$`; stable across versions; keys the downgrade state            |
| `version`    | strict SemVer 2.0, no build metadata; the grammar is under the tables                      |
| `publisher`  | 1 to 200 characters; informational, trust comes from the signing key                       |
| `createdAt`  | RFC 3339 UTC `YYYY-MM-DDTHH:MM:SSZ`, calendar-valid; the tie-breaker of the downgrade rule |
| `expiresAt`  | optional, same format; a verifier refuses the manifest at or after this instant            |
| `entries`    | at least 1; entry ids unique; sorted by `id` in byte order                                 |
| `signatures` | 0 or more; an unsigned draft has none                                                      |

Entry (`ManifestEntry`):

| Member       | Rule                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `^[a-z0-9][a-z0-9._-]{0,127}$`; unique within the manifest                                                                                                                                                                                                                                                           |
| `kind`       | `model`, `tokenizer`, `data`, `wasm` or `other`                                                                                                                                                                                                                                                                      |
| `url`        | `https://` absolute; or `http://` to `127.0.0.1`, `[::1]` or `localhost` only (tests); or a scheme-less relative reference resolved against the manifest URL; no query, no fragment, none of the forbidden characters below; every other scheme (`data:`, `blob:`, `file:`, `javascript:`) is refused with `bad_url` |
| `sha256`     | `^[0-9a-f]{64}$`, over the complete file                                                                                                                                                                                                                                                                             |
| `size`       | integer 0 to 2^53-1, the exact byte length                                                                                                                                                                                                                                                                           |
| `version`    | strict SemVer 2.0, the same grammar as the manifest `version`                                                                                                                                                                                                                                                        |
| `licence`    | SPDX expression, at least 1 character                                                                                                                                                                                                                                                                                |
| `minProfile` | `{ gpu?, ramGb?, storageFreeGb?, cores?, backendTier? }`; `{}` means any device; integers only                                                                                                                                                                                                                       |
| `mediaType`  | optional IANA media type                                                                                                                                                                                                                                                                                             |
| `chunkSize`  | optional, 1048576 to 67108864, default 8388608                                                                                                                                                                                                                                                                       |
| `pin`        | optional, default false; a pinned entry is never evicted by a size-limited cache                                                                                                                                                                                                                                     |

Signature:

| Member      | Rule                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `alg`       | `^[a-z0-9][a-z0-9-]{0,31}$`. Only `ed25519` is verified; any other token is ignored, and `none` is never valid   |
| `keyId`     | lowercase hex SHA-256 of the raw 32-byte public key                                                              |
| `publicKey` | optional, canonical padded base64 of the 32 raw bytes (see Signing); informational only, never a source of trust |
| `sig`       | canonical padded base64 of 64 bytes (see Signing)                                                                |
| `signedAt`  | RFC 3339 UTC, calendar-valid                                                                                     |

Unauthenticated fields: `signedAt`, `alg`, `keyId` and `publicKey` are NOT covered by the signature,
because the `signatures` member is removed before canonicalisation. A verifier MUST NOT use `signedAt`
for any decision. `createdAt` and `expiresAt` are the only authenticated times.

Version grammar. Both `version` members (the manifest's and every entry's) are strict SemVer 2.0 with no
build metadata: the three numeric parts and every numeric prerelease identifier have no leading zeros, an
identifier is never empty, and a `+build` suffix is refused. The grammar is one regular expression, the
`pattern` of both members in `manifest.schema.json`, and the same one reads the downgrade state, so a
version that is accepted can always be stored and read back:

```
^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$
```

Here `\d` means an ASCII digit 0 to 9, whatever the regular-expression engine (a Unicode-aware engine must
not match other scripts' digits). Numeric identifiers are compared exactly, as arbitrary-size integers
(Downgrade); a version such as `1.0.0-9007199254740993` is valid and orders above `...992`.

Optional members are absent or have their type: an explicit `null` for `expiresAt`, `publicKey`,
`mediaType`, `chunkSize` or `pin` is a `schema` fault, not "absent".

Unknown members. A member that no table above declares is `schema`, under ANY name and at every level:
the manifest, an entry, `minProfile` and a signature. That includes `__proto__`, `constructor`,
`toString`, `hasOwnProperty`, `valueOf` and every other name that an object inherits from its prototype
in some languages. A verifier MUST decide which members are declared, and which required members are
present, by testing for an own property only (in JavaScript `Object.hasOwn`, never the `in` operator or a
plain lookup), so that an inherited name is never "declared" and an inherited member never satisfies a
`required` rule. Otherwise a validly signed manifest could carry unsigned data under such a name: the
signature covers the members that canonicalisation serialises, and nothing else. A consumer that is handed
an already-parsed object MUST also refuse an object that is not a plain object (its prototype is neither
`Object.prototype` nor null): a member inherited through a custom prototype is not an own member, so no
signature covers it, yet a consumer reading `entry.pin` or `entry.chunkSize` would see it.

Forbidden url characters. The characters below are named one by one; no regular-expression class such as
`\s` is used, because engines disagree about what it contains. A url contains none of: `?`, `#`,
U+0000 to U+0020 (every ASCII control character and the space), U+007F to U+00A0 (DEL, the C1 controls
and the no-break space), U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
Any other code point is allowed (U+200B, bidirectional controls and characters outside the Basic
Multilingual Plane included). A url that contains one is refused with `bad_url`; both verifiers implement
exactly this list. It is written out as explicit `\uXXXX` ranges in the `url` pattern of
`manifest.schema.json`, which is also `ENTRY_URL_PATTERN` in `manifest.ts`.

## Canonicalisation

The bytes that are signed are built from a canonical JSON form, RFC 8785 (JCS) restricted to this
profile:

- object members sorted by key in ASCII byte order, no insignificant whitespace;
- strings exactly as `JSON.stringify` writes them: escape only `"`, `\` and U+0000 to U+001F (as `\b`
  `\t` `\n` `\f` `\r`, else `\u00xx` in lowercase); `/` is not escaped; everything else is raw UTF-8;
- integers as plain decimal, only within 0 to 2^53-1; no floats, no exponent form, no `-0`;
- literals `true`, `false` and `null`;
- every object key matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. Digit-leading keys are refused because
  JavaScript enumerates array-index-like keys in numeric order before string keys whatever the sort, so
  a key such as `"10"` would canonicalise differently in `JSON.stringify` and in a Rust `BTreeMap`;
- strings are well-formed Unicode: a lone surrogate (JavaScript `String.prototype.isWellFormed()` is
  false) is refused.

Implementation limit (informative): no valid manifest is nested deeper than five levels. The runtime
refuses a document nested deeper than 32 levels with reason `schema` instead of recursing without bound;
no shared vector covers it.

Accepted asymmetry: `JSON.parse` cannot tell `1.0` or `1e3` from `1`, so a TypeScript parser accepts
those spellings while a serde_json parser rejects them. Canonical output is identical whenever both accept,
so signatures still interoperate.

## Duplicate members

An object with a repeated member name, at any depth, is `invalid_json`, at the parse stage. JSON.parse
cannot detect a repeated member (the last one wins silently), so a parser that works on text MUST scan the
text for repeated names before, or while, building the value. A signature check over the parsed value
would otherwise pass for a document whose first `sha256` differs from the one the signature covers,
and two parsers would act on two different values. Member names are compared after unescaping
(`"a"` and `"a"` are the same name). A consumer that is handed an already-parsed object cannot
check this and MUST say so in its documentation.

Member names are ordinary strings and no name is special. An own member named `__proto__` (JSON.parse
creates one from the text `"__proto__": ...`) is a member like any other: it is `schema` by Shape
(Unknown members), and a canonicaliser MUST serialise it as a member instead of letting it set a
prototype. A canonical form that silently dropped it would let unsigned data ride inside a signed
manifest: the signature would match the bytes without the member, while a consumer still reaches the data
through the parsed value.

## Signing

```
signedBytes = UTF-8("airplanemode-manifest-v1\n") || canonical(manifest without its "signatures" member)
```

The signature is pure Ed25519 (RFC 8032: no prehash, no context). Ed25519 is deterministic, so the same
key and the same canonical bytes give the same signature in every implementation; identical signatures
across repositories are the interoperability check (`vectors/*.sig.txt`).

S MUST be < L, where L = 2^252 + 27742317777372353535851937790883648493 is the order of the base point and S is
the second 32 bytes of the signature read as a little-endian integer (RFC 8032 section 5.1.7). A signature
with S >= L is `bad_signature`. The runtime checks this explicitly before it calls WebCrypto, so the
outcome does not depend on the browser engine; `cp-manifest` uses `verify_strict`.

A signature is `bad_signature` when it does not verify under the trusted key, whatever the reason.

Encoding: sig and publicKey MUST be canonical padded base64 (RFC 4648 section 3.5: pad bits zero); anything else is schema. The
alphabet is the standard one (`A-Z a-z 0-9 + /`, no URL-safe variant), the padding is mandatory, and the
unused low bits of the last character are zero. For `sig` (64 bytes) that is the pattern
`^[A-Za-z0-9+/]{85}[AQgw]==$`, for `publicKey` (32 bytes) `^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`
(`SIGNATURE_SIG_PATTERN` and `SIGNATURE_PUBLIC_KEY_PATTERN` in `manifest.ts`). A decoder that ignores the
pad bits (JavaScript `atob` does) would accept several spellings of one signature or key; a verifier
therefore also refuses, when it decodes, any input whose re-encoding differs from the input. One signature
and one key have exactly one accepted encoding.

## Trust roots

The trust set is a map from `keyId` to the raw 32-byte public key. It is application configuration
compiled into, or installed with, the application. It MUST NOT be fetched from the same origin or URL as
the manifest or alongside it, and the embedded `publicKey` of a signature is never added to it. Where a
pilot configures its trust root is the owner's decision, not part of this spec.

A trust entry is well formed when `keyId` equals the lowercase hex SHA-256 of the 32 key bytes. A
verifier that finds an entry whose key does not hash to its `keyId` reports the signature as
`key_mismatch`.

## Verification order

1. Trust-set checks, both before the manifest is parsed and over the whole iterated trust set:
   - 1a. Test keys: a trust set holding any RFC 8032 test key is refused with `test_key_refused` (see Test
     keys). It is skipped only with `allowTestKeys === true`.
   - 1b. Weak keys: a trust set holding any key that is not the canonical encoding of a prime-order point other
     than the identity is refused with `weak_key_refused` (see Weak keys). It always runs; there is no
     opt-out.

   `test_key_refused` and `weak_key_refused` are the only reasons that are raised as an exception.

2. Parse. The parse stage runs over the whole text, signatures[] included: repeated members, the
   digit-key rule, floats, integers above 2^53-1 and lone surrogates are refused wherever they occur, in
   a signature as well as in the body.
3. Schema: `spec`, `entries[*].url` scheme rule and forbidden characters, every pattern and range (the
   strict SemVer grammar of both versions among them, the canonical base64 of `sig` and `publicKey`),
   members that no table declares (any name, `__proto__` and `constructor` included), calendar-valid
   timestamps, entries sorted and unique. The published
   Signature schema is applied to every signatures[] item: additionalProperties false, the required members
   (`alg`, `keyId`, `sig`, `signedAt`), the `alg`, `keyId`, `publicKey`, `sig` and `signedAt` patterns and a
   calendar-valid `signedAt`; a fault is reason schema, and so is a `signatures` member that is missing
   or not an array. An `alg` that is a token but not `ed25519` stays schema-valid and is ignored in step 5
   (`unknown_alg`); a string such as `ED25519` that is not a token is a schema fault.
4. `expiresAt`, when present, must be later than `now` (the verifier's clock), else `expired`.
5. For each signature, which has already passed the schema:
   - an `alg` other than `ed25519` is ignored (`unknown_alg`);
   - a `keyId` not in the trust set is `untrusted_key`;
   - a trusted key that is one of the five RFC 8032 test keys, by `keyId` or by its raw bytes, is refused
     with `test_key_refused` unless `allowTestKeys === true`: the check of the Test keys section, repeated
     here for the key that is actually used, so a trust object that hides keys from iteration cannot
     smuggle one in;
   - a trusted key that is weak (see Weak keys) is refused with `weak_key_refused`, whatever its `keyId`
     and whether or not `allowTestKeys` is true: the check of step 1b, repeated for the key that is actually
     used. A key that is not 32 bytes keeps its 0.1.2 outcome (`key_mismatch`);
   - a `publicKey` present and different from the trusted bytes is `key_mismatch`; it is never silently accepted;
   - the `keyId` recomputed from the trusted key must equal the `keyId`, else `key_mismatch`;
   - S < L and the Ed25519 verification over `signedBytes` must both pass, else `bad_signature`.

   `malformed_key_id` (a `keyId` that is not 64 lowercase hex characters) and `malformed_sig` (a `sig`
   that does not decode to exactly 64 bytes) remain defined for an implementation that is handed a
   signature object that did not pass the schema stage, for example a library call on a typed object.
   A verifier that applies step 3 never reports them, because the same faults are `schema` there.

6. At least one valid signature, else `no_valid_signature`. One signature is enough.
7. When the caller passed `expectId`: the manifest `id` must equal it, else `unexpected_id` (see Manifest
   0.1.2). The downgrade state is not read for a manifest refused here.
8. The downgrade rule (see Downgrade).
9. Every entry's bytes are hashed in full and compared to `sha256` before any consumer can read them; no
   partial file is ever exposed.

Malformed input never throws out of a verifier: it is a rejection with a reason. The reasons are
`invalid_json`, `float`, `bigint`, `digit_key`, `invalid_key`, `lone_surrogate`, `bad_spec`, `bad_url`,
`schema`, `unsorted_entries`, `duplicate_entries`, `expired`, `no_valid_signature`, `unexpected_id`,
`downgrade`, `state`, `test_key_refused` and `weak_key_refused`. A verifier reports the per-signature reasons (`unknown_alg`, `malformed_key_id`,
`untrusted_key`, `key_mismatch`, `malformed_sig`, `bad_signature`, or `valid`) in signature order.

## Reason precedence

The reason is the first stage that fails, in this order (`MANIFEST_REJECT_PRECEDENCE` in `manifest.ts`):

1. the parse stage: `invalid_json` (including a repeated member name), `lone_surrogate`, `float`,
   `bigint`, `digit_key`, `invalid_key`;
2. `bad_spec` (the `spec` member missing, not a string, or unknown);
3. `bad_url`;
4. `schema` (every other schema fault, including calendar-invalid timestamps);
5. `unsorted_entries`;
6. `duplicate_entries`;
7. `expired`;
8. `no_valid_signature`;
9. `unexpected_id` (only when the caller passed `expectId`);
10. `downgrade` or `state`.

A missing "spec" key is bad_spec, never schema. A missing or non-array "signatures" member is schema,
judged after the parse stage: a document with such a member and a parse-stage fault (a digit-leading key, a
float, a lone surrogate, a repeated member) reports the parse-stage reason, and the parse stage covers
signatures[] as well as the body. Where a document has several faults, a conforming verifier reports the
earliest listed. Shared vectors never combine two parse-stage faults, so the order inside the first group
is not tested; every other pair is.

`stage` in the vector tables is `parse` for reasons 1 to 6 (the manifest is refused before any signature
is examined) and `verify` for reasons 7 to 10.

## Downgrade

State is keyed by manifest `id` and holds `{ version, createdAt }` of the last accepted manifest.
Versions compare per SemVer 2.0 section 11: numeric major.minor.patch; a prerelease is lower than the
release; prerelease identifiers compare numerically when numeric, lexically otherwise, numeric lower than
alphanumeric, fewer identifiers lower when all preceding ones are equal. A manifest is refused with
`downgrade` when its `version` is lower than `state.version`, or the versions are equal and its `createdAt`
is earlier than `state.createdAt`, unless the caller passes `allowDowngrade`. `allowDowngrade` is an
explicit rollback: it accepts the manifest and replaces the state, so the stored state is lowered to the
older manifest and any manifest at or above that lower version is accepted again. It must be reachable only
from an authenticated admin action (Security considerations). Numeric identifiers are compared as
exact integers of any size, never as floating-point numbers, so a patch above 2^53 still orders correctly.

If the state store cannot be read, or holds anything but `{ version: valid SemVer, createdAt:
calendar-valid }`, the verifier fails closed with `state`. `allowDowngrade` bypasses an unreadable store too.

The state store is written ONLY after at least one valid signature and a passed downgrade check, never
for a refused manifest. A manifest that fails any earlier stage leaves the state untouched.

## Test keys

The five Ed25519 key pairs of RFC 8032 section 7.1 are published, non-secret test data: anyone can sign
with them. A trust set is refused with `test_key_refused`, before parsing, if any of its `keyId` values
is in the table below OR any trusted key's 32 bytes equal one of the public keys, whatever `keyId` the
entry is filed under. The only exception is `allowTestKeys === true`: any other value, including the string
`'true'`, counts as false. The library default is false. A signing tool refuses to sign with a test
seed unless it is given an explicit test-key option.

| Test          | Public key                                                         | keyId                                                              |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| TEST 1        | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a` | `21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9` |
| TEST 2        | `3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c` | `39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f` |
| TEST 3        | `fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025` | `dac073e0123bdea59dd9b3bda9cf6037f63aca82627d7abcd5c4ac29dd74003e` |
| TEST 1024     | `278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e` | `91384c411e5af29648f17f922b402655b11ecaec1b33fc45796241963f95f202` |
| TEST SHA(abc) | `ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf` | `5f9b247e2a654719f198e4f241d6b0df9a1a937a13ef5ef899f64d9285fce224` |

The keyIds are the SHA-256 of the public key bytes. Both were derived from the RFC seeds with a
cryptography library (`test/spec-0.4.test.ts` repeats the derivation); the RFC text wins on any
mismatch. The vectors name TEST 1 `rfc8032-1` and TEST 2 `rfc8032-2` (`examples/TEST-KEY.md` lists
their seeds). Every signed example and vector is signed with one of these two keys.

## Tamper vectors

`vectors/tamper/` holds one base manifest (id `tamper-base`, version 1.1.0, `createdAt`
2026-11-01T00:00:00Z, `expiresAt` 2027-11-01T00:00:00Z, the four entries of vector 05, signed with
`rfc8032-1`) and fifteen files that change it in one way each, plus `tamper.json`, the table every
implementation runs. Each row of `tamper.json` is `{ file, trust, allowTestKeys, now, state, requiresState,
expect: { valid, stage?, reason?, signatures? } }`: `trust` names keys (`rfc8032-1`, `rfc8032-2`), `now`
is the verifier's clock for the row (always `2026-11-14T00:00:00Z`), `state` is the stored downgrade state
(or `null`), and `signatures` lists the per-signature results in order. The rows:

| File                                  | Change                                                         | Expected                              |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| tamper-01-entry-sha-byte.json         | one hex character of `entries[1].sha256` changed after signing | `no_valid_signature`, `bad_signature` |
| tamper-02-entry-size.json             | `entries[0].size` plus one                                     | `no_valid_signature`, `bad_signature` |
| tamper-03-sig-bitflip.json            | one bit of `sig` flipped                                       | `no_valid_signature`, `bad_signature` |
| tamper-04-swapped-key.json            | `keyId` and `publicKey` of key 2, `sig` made by key 1          | `no_valid_signature`, `bad_signature` |
| tamper-05-publickey-mismatch.json     | `keyId` of key 1, `publicKey` of key 2                         | `no_valid_signature`, `key_mismatch`  |
| tamper-06-untrusted-key.json          | validly signed by key 2, trust is key 1 only                   | `no_valid_signature`, `untrusted_key` |
| tamper-07-truncated.txt               | the signed file cut at floor(length / 2)                       | `invalid_json`, parse stage           |
| tamper-08-rollback.json               | version 1.0.0, validly signed, state is 1.1.0                  | `downgrade` (needs state)             |
| tamper-09-replay-older-createdAt.json | version 1.1.0, earlier `createdAt`, validly signed, same state | `downgrade` (needs state)             |
| tamper-10-expired.json                | `expiresAt` 2026-11-10T00:00:00Z                               | `expired`                             |
| tamper-11-rotation-ok.json            | signatures: key 2 (untrusted), key 1 (trusted)                 | VALID, `untrusted_key` then `valid`   |
| tamper-12-stripped.json               | `signatures` is empty                                          | `no_valid_signature`                  |
| tamper-13-alg-none.json               | key 1's signature labelled `none`                              | `no_valid_signature`, `unknown_alg`   |
| tamper-14-test-key-refused.json       | the base manifest, trust is key 2, `allowTestKeys` false       | throws `test_key_refused`             |
| tamper-15-noncanonical-s.json         | S replaced by S + L (little-endian), still 64 bytes            | `no_valid_signature`, `bad_signature` |

An implementation without a downgrade store skips the rows with `requiresState` (tamper-08 and tamper-09)
and says so. `vectors/tamper-assets/` is runtime-specific: three signed manifests over one 4096-byte
asset (intact, one byte flipped, one byte short) that check what an implementation that fetches assets
does with bytes that do not match the signed hash. Its `expect.json` separates normative fields
(refused, zero bytes to the consumer, `getBlob` rejects, no blob URL) from informative ones (the error
code this runtime returns).

## Security considerations

- There is no revocation and no transparency log: a signed manifest stays valid until `expiresAt`, and
  a compromised key is replaced only by shipping a new trust set with the application.
- One signature is enough. There is no threshold and no co-signing.
- The browser clock is trusted for expiresAt: a client with a wrong clock accepts an expired manifest
  or refuses a fresh one.
- signedAt is unauthenticated, as are `alg`, `keyId` and `publicKey`; only `createdAt` and `expiresAt` are authenticated.
- sha256 proves integrity against the signed manifest only: it proves a file is the file the manifest
  names, not that the manifest names a safe file. The trust root is application configuration; whoever
  controls it controls what is accepted.
- Consumers MUST check that manifest.id equals the id they expect: a validly signed manifest for another
  product verifies like any other (mix-and-match). Since 0.1.2 the verifier does it for the caller: pass
  the expectId option (see Manifest 0.1.2).
- A consumer MUST resolve every entry url against the manifest URL and re-check the resolved URL's scheme
  (https, or http to a loopback host in tests) and origin against its allowed origins before any request; a
  network-path reference (//host/...) or a backslash form that the WHATWG URL parser treats as one can leave
  the manifest's origin. (S1-097, normative since 0.1.2.) Informative: on a shared origin, a consumer SHOULD
  also require each resolved pathname to start with its own model directory.
- Implementations MUST key the downgrade state so that no id (for example constructor or prototype) collides
  with an inherited member of the host language's map or object type. (S1-102, normative since 0.1.2.)
- The downgrade state is first-use and per-profile: a fresh profile, or cleared site data, accepts any
  validly signed older version.
- A manifest without `expiresAt` can be replayed indefinitely on a fresh profile, so publishers SHOULD set expiresAt.
- The downgrade state is written only after a valid signature: a refused or forged manifest never moves it.
- allowDowngrade is an explicit rollback that lowers the stored state: after it, the state holds the older
  version, and a replay of anything at or above it is accepted again. It must be reachable only from an
  authenticated admin action. An application never derives it from a page parameter, stored data or any
  message the visitor, the manifest or a peer can send; it is a decision of whoever may roll the
  product back.
- Duplicate members are refused, so every parser acts on the same value.
- A member that no table declares is refused under any name (`__proto__`, `constructor`, ...), and sig and
  publicKey have one accepted encoding each: the bytes a human reads, the value a verifier checks and the
  value a consumer uses are the same value, and no unsigned member or spelling rides along.
- A weak public key in a trust set (the identity, any small-order point, a mixed-order point, or bytes that
  are not a canonical curve point) is refused with `weak_key_refused` before anything is parsed (normative
  since 0.1.3; see Weak keys). The identity key, for example, verifies the signature R = identity, S = 0 for
  every message.
- Bytes are hashed in full before a consumer reads them; a mismatch, a truncation or an extension is
  refused and no partial file is exposed.

## Conformance

An implementation conforms to manifest spec v0.1 when it accepts the 5 positive vectors byte-for-byte,
rejects every row of vectors/negative.json (32) with its reason and stage, and gives every row of
vectors/tamper/tamper.json (15) its expected result, skipping only requiresState rows if it keeps no
downgrade state. tamper-assets is runtime-specific: its normative fields apply to any implementation that
fetches assets. Since 0.1.3 it also gives every row of `vectors/weak-keys/weak-keys.json` its verdict
(`weak_key_refused` for every refused class, accepted for every `ok` row) and every row of
`vectors/weak-keys/verify.json` its expected throw. A tool that verifies or signs release directories (see
Release manifests) also gives every case of `vectors/release/release.json` its exit code and reason, and
every row of `vectors/release/ids.json` its answer for the two id patterns; a signer or verifier that takes a
manifest file runs the cases marked `level: manifest`.

"Accepts the 5 positive vectors byte-for-byte" means: `canonical()` of each `vectors/0n-*.json` equals its
`.canonical.txt`, and the Ed25519 signature of those bytes under the TEST 1 seed equals its `.sig.txt`.
The runtime (`@airplanemode/runtime`) runs the full set in `test/spec-0.4.test.ts` and
`test/tamper-vectors.test.ts`.

## Manifest 0.1.2

Manifest 0.1.2 is an additive patch of 0.1.1 (spec release 0.5.0). The wire string, the shape, the canonical
bytes, every vector verdict and every input a verifier accepted or refused are unchanged: a verifier
that is not given `expectId` behaves exactly as at 0.1.1. The `$id` of the schema moves to
`urn:airplanemode:spec:manifest:0.1.2`; its body is byte-identical.

**expectId.** A verifier takes an optional `expectId`, the manifest id the application expects.

- When present it must match the manifest id grammar `^[a-z0-9][a-z0-9.-]{2,127}$`. Otherwise
  `verifyManifest` throws a TypeError with the exact message 'invalid expectId' before it parses
  anything. This is a caller error: it has no `ManifestRejectReason`, and cp-manifest reports it as a usage
  error with exit status 2.
- After at least one valid signature and BEFORE the downgrade state is read, a manifest whose `id` differs
  from `expectId` is rejected with the reason 'unexpected_id' (stage 'verify'). The state store is neither
  read nor written for that manifest. The stages before it keep their precedence: a manifest that is
  expired, or has no valid signature, reports that reason, not `unexpected_id`.
- The runtime asset manager takes the same option as `expectManifestId`, passes it to the verifier and
  reports a refusal as `manifest.verify.failed` with `reason` 'unexpected_id'. cp-manifest takes
  `verify --expect-id <id>`.
- Vectors: `vectors/expect-id/` (eight rows; file names are relative to `vectors/`). Rows 07 and 08 expect
  `throws: 'TypeError'` with `message: 'invalid expectId'`; T2 parity compares on the `throws` field.
  `vectors/state-ids/` (four rows with ids `constructor` and `prototype`) pins the S1-102 rule. An
  implementation with no state store skips the rows with `requiresState` and says why.

**S1-097 and S1-102.** The two sentences in Security considerations (resolve and re-check every entry url;
key the downgrade state so that no id collides with an inherited member) are normative from 0.1.2. They
describe what a conforming consumer already had to do; no verdict of the verifier changes.

## Demo bundles

The demo builds of this repository write manifests that other repositories verify. These rules are
normative for the files `scripts/bundle-models.mjs` writes; they do not change the manifest wire format.

- The id is 'dev.airplanemode.dockit-models' (the dockit model set) or 'dev.airplanemode.runtime-demo-models'
  (the runtime demo model set). Each consumer pins its own id with `expectId` / `expectManifestId`, so a
  validly signed bundle of the other product is refused with 'unexpected_id'.
- The version is the consumer's package.json version. The publisher is 'AirplaneMode-Labs demo build'.
  `createdAt` is the build time in UTC to the second. There is no expiresAt: the demo must keep working
  offline, and the trust root changes with every build, so an old manifest cannot verify against a new
  bundle.
- EVERY file the engine can read is an entry with `sha256`, `size` and `licence`: the .onnx graph, the ORT
  .wasm and its .mjs factory, tokenizer.json, tokenizer_config.json, config.json, generation_config.json,
  chat_template.jinja and special_tokens_map.json.
- Entry urls are relative paths under the manifest directory: no leading '/', no '..', no backslash, no '//'
  and no scheme. A consumer still applies the S1-097 rule above to each resolved url.
- The dockit entries carry pin: true.
- The manifest carries one ed25519 signature, made with a key generated in memory per build and never
  exported (no file, no log line, no serialised form). The public half is compiled into the consumer as its
  trust root: trust-root.ts exports exactly one { keyId, publicKeyB64 }. The signature proves only that the
  manifest and the bundle came from the same build, not who published it.

## Manifest 0.1.3

Manifest 0.1.3 is an additive patch of 0.1.2 (spec release 0.6.0; team decisions TD-68 and TD-82, finding
S1-113). The wire string stays `airplanemode.manifest/0.1`, the shape and the canonical bytes are unchanged,
and the verdict of every document under every trust set of honestly generated keys is unchanged. The `$id`
of the schema moves to `urn:airplanemode:spec:manifest:0.1.3`; its body is byte-identical. What it adds:

- the reason `weak_key_refused` and the constant `WEAK_KEY_REFUSED_MESSAGE` in `manifest.ts`, with the
  normative rule in Weak keys below, and the vectors `vectors/weak-keys/`;
- the informative Pinned entries note;
- an informative sentence on `minProfile.ramGb`: capability profile 0.1.1 clamps ramGb to at most 8, so a
  minProfile.ramGb above 8 is schema-valid but can never be satisfied; producers MUST NOT emit it, and the
  reference bundler refuses it;
- the `minProfile.ramGb` rule wording (TD-84): a consumer that compares `ramGb` with a minimum treats a profile
  `ramGb` of 0 as unknown, never as too small; only a reported value below `minProfile.ramGb` fails. The
  schema is unchanged.

Every manifest that 0.1.2 accepted still verifies under 0.1.3 with a trust set of honestly generated keys:
the published 0.1.2 wire format stays readable.

### Pinned entries (informative)

The optional `pin` member of an entry is a storage hint (TD-54): pin is a storage hint that tells a consumer
not to evict the file to make room. In the reference runtime evictToFit skips pinned rows, and runtime
evict() refuses a pinned row unless { force: true } is passed. A pin is not covered by any check of this
spec beyond the signature over the manifest that carries it: pin is not a security property, it does not make
a file trusted, and a consumer that stores a file with its own policy is free to ignore it.

## Weak keys

A trusted key of exactly 32 bytes MUST satisfy every one of the following, else the trust set is refused with
`weak_key_refused`:

1. decode per RFC 8032 section 5.1.3: the 255-bit little-endian y is below p = 2^255 - 19 (a canonical y (y <
   p)), the x coordinate is recovered by the square-root rule and the point lies on the curve; an encoding with
   no such x is refused, and so is x = 0 with the sign bit set;
2. not be the identity (0, 1);
3. not be small order: [8]P must not be the identity;
4. be torsion-free: [L]P must be the identity, where L is the order of the base point. This refuses the
   mixed-order points (a point of the prime-order subgroup plus a small-order point), which pass the previous
   two rules but are not in the prime-order subgroup that key generation produces.

A key that is not 32 bytes keeps its 0.1.2 outcome. The rule is exactly this, nothing is added:

- (a) The predicate takes only the 32 raw key bytes, never the keyId, so a weak key filed under any keyId
  (including 64 zero characters) is refused before key_mismatch is evaluated.
- (b) A key made by RFC 8032 key generation is always in the prime-order subgroup, so the rule cannot refuse a
  correctly generated key.
- (c) The rule does not replace S < L or verify_strict; both stay.
- (d) The check is a pure function of the bytes: no cache keyed by keyId, and no result stored on the trust-set
  object.
- (e) Manifest 0.1.3 has no document-level marker and the check lives in the verifier, so no 0.1.2 document can
  downgrade it.

Order. Step 1 of Verification order is now 1a (test keys, skipped only with `allowTestKeys === true`) and 1b
(weak keys, always); both run over the iterated trust set before the manifest is parsed. A trust set that holds
a test key and a weak key reports `test_key_refused` unless `allowTestKeys` is true, and `weak_key_refused`
after that. A malformed manifest with a weak trust key is `weak_key_refused`, not `invalid_json`. Step 5
repeats the weak check for the key a signature actually uses (the entry the verifier reads for its `keyId`), so
a trust Map whose iterator hides a key is still caught. A trust set that cannot be iterated is not checked at step 1b; step 5 still checks every key a signature uses. There is no option to skip the check.

Vectors: `vectors/weak-keys/weak-keys.json` rows `{ id, publicKeyHex, keyIdHex, class, expect }` with class
`identity`, `identity_sign_bit`, `small_order`, `small_order_noncanonical`, `mixed_order`, `not_on_curve`,
`noncanonical_y` or `valid`, and expect `weak_key_refused` or `ok`; and `vectors/weak-keys/verify.json` rows
`{ manifest, trust: [{ keyIdHex, publicKeyHex }], allowTestKeys, expect: { throws: 'weak_key_refused' } }`,
among them `forged-identity.manifest.json` (a signature with R = identity and S = 0 under the identity key).
Every hex value is derived by computation in `test/tools/make-weak-key-vectors.mjs`, which asserts each class
(for `ok` rows [L]P = O and P is not O; for `mixed_order` [8]P is not O and [L]P is not O). The libsodium
blocklist of small-order points is informative only.

## Manifest 0.1.4

Manifest 0.1.4 is an additive patch of 0.1.3 (spec release 0.6.1; team decisions TD-103 and TD-121, findings
S1-127 and S1-129). The wire string stays `airplanemode.manifest/0.1`, the shape and the canonical bytes are
unchanged, the schema body is byte-identical, and `verifyManifest` gives the same verdict as before on every
input. The `$id` of the schema moves to `urn:airplanemode:spec:manifest:0.1.4`. What it adds is the normative
section Release manifests below and the constants of `release.ts` (re-exported from `index.ts`): the two id
patterns, the two publisher strings, the release-keys file format, the reason tokens of a release tool and its
exit codes. The vectors are `vectors/release/`.

## Release manifests

A release manifest is an ordinary manifest that lists the artefacts of one package release. It has the id
`<package>-release`, and a rehearsal manifest, which proves the release path in CI and is signed with a published
RFC 8032 test key, has the id `<package>-rehearsal`. `<package>` is one of runtime, localdata, glyphsift,
pagetriage and control-plane (`PACKAGE_IDS`). The patterns are `RELEASE_ID_PATTERN`
(`^[a-z0-9][a-z0-9-]{0,118}-release$`) and `REHEARSAL_ID_PATTERN` (`^[a-z0-9][a-z0-9-]{0,116}-rehearsal$`). They
use `$` without the multiline flag: a trailing line feed never matches (`x-release` followed by a line feed is
neither id), whatever the regular-expression engine; in Rust that is `\z`. `vectors/release/ids.json` is the shared
table.

**Body.** `id` is `<package>-release` or `<package>-rehearsal`. `version` is the package version. `publisher` is
`RELEASE_PUBLISHER` ('Airplane Mode Labs') for a -release id and `REHEARSAL_PUBLISHER` for a -rehearsal id; any other
pairing is `publisher_mismatch`. `createdAt` comes from SOURCE_DATE_EPOCH (a decimal integer, 0 to 253402300799)
when it is set and from the clock otherwise, so a rehearsal is reproducible. There is no `expiresAt` (R5).
Entries: one per artefact, `id` and `url` both the file's basename, which must already be lowercase and match the
entry id grammar; `kind` is 'other'; `version` is the package version; `licence` is the repository's SPDX
expression (pagetriage 'MIT OR Apache-2.0', control-plane 'FSL-1.1-ALv2'); `minProfile` is `{}`; `mediaType` is
application/gzip for .tgz, .tar.gz and .crate, application/zip for .whl and .zip and application/octet-stream
otherwise (`RELEASE_MEDIA_TYPES`). Entries are sorted by id and `signatures` is `[]` until the manifest is signed.

**Release directory.** One flat directory (`dist-release/`) holds only the artefacts, `release-manifest.json`
(`RELEASE_MANIFEST_NAME`; 2-space JSON with a final line feed) and `SHA256SUMS`. Reports go to the sibling
`dist-release-report/` (`RELEASE_REPORT_DIR`), never inside.

**SHA256SUMS.** ASCII, one line per manifest entry, `<64 lowercase hex>`, two spaces, the basename and a line feed.
Lines are sorted by basename in byte order; the line ending is LF only and there is a final line feed.
SHA256SUMS covers the artefacts only, never the manifest itself. It is authenticated only through the signed
manifest: a verifier regenerates it from the manifest entries and requires the bytes to be equal
(`sums_mismatch`). It is `-text` wherever it is committed, and so are `spec/vectors/**` and
`spec/tools/**` (a checkout must never convert line endings of a hashed file).

**The release-keys file** (`docs/release-keys.json` in each repository) is
`{"spec":"airplanemode.release-keys/0.1","keys":[{"keyId":"<hex>","publicKey":"<canonical padded base64>"}]}`. It has exactly
the members `spec` and `keys`, each key has exactly `keyId` and `publicKey`, and there are at most 8 keys
(`RELEASE_KEYS_MAX`). A reader parses it with the strict scan of the manifest parser (no repeated member, no lone
surrogate, no float), never with a bare JSON.parse. Each `publicKey` is normalised to its 32 bytes, then
checked against the test keys (`test_key_refused`), then against the weak-key rule (`weak_key_refused`); then a
`keyId` that is not the SHA-256 of the key, a repeated `keyId`, a bad encoding, an unknown member or more than 8 keys
is `bad_release_keys`. A file with no keys is `no_trusted_key`. It is committed with `keys: []` until the owner adds
the real public key.

**R1: an RFC 8032 test key never signs an id that matches RELEASE_ID_PATTERN.** The reference tool refuses with
usage error `test_key_release_id` (exit 2). cp-sign sign refuses with exit 1 and the stderr line
`test_key_release_id: refusing to sign a release id with a published RFC 8032 test key`. cp-sign recognises the test
key from the public key derived from the seed, whatever the key file is called and with or without --allow-test-key.

**R2: a release verification never allows test keys, and --expect-id is mandatory.** A release tool refuses to verify
without an expected id (`expect_id_required`, exit 2). The flag that allows a test key (--allow-test-key, or
--trust-test-key, which puts TEST 1 in the trust set) is accepted only together with an --expect-id that matches
REHEARSAL_ID_PATTERN, and --allow-test-key never together with a trust file: anything else is
`test_key_flag_misuse` (exit 2). cp-sign verify with --allow-test-key and a release-pattern --expect-id is
`test_key_flag_misuse` too.

**R3: the allow flag exists only as a command-line flag.** It is never read from the environment, a manifest, a URL,
a file or stored state.

**R4: a release key signs only -release ids and is never placed in an application trust set.** Applications that
verify model or data bundles (dockit, the runtime demo, the asset manager configurations) always pass expectId,
and the release key is a separate key from any bundle-signing key.

**R5: release manifests carry no expiresAt.** The owner signs a -release id with `cp-sign sign --no-expiry`, and a
rehearsal has none either. The artefact hashes bind the manifest to one version, the registry refuses a
republish, and the publish job refuses a version that is already there, so an expiry adds nothing; an expiring
manifest would stop verifying in an archive.

**The reference tool** is runtime's own verifier, bundled as `spec/tools/release-tool.mjs` by
`npm run spec:release-tool` from `src/release/` (it imports the real `verifyManifest`, `canonical` and weak-key
code, so a verdict can never differ from the library's). It is committed with its `.sha256` and is not in the npm
package. Public CI never checks out the private control-plane: the rehearsal signs and verifies with this tool,
the owner signs the real release with cp-sign offline, and the two are checked against each other on the shared
vectors. The commands are `manifest`, `sums`, `sign` (only `--test-key rfc8032-1`) and `verify`. A command refuses a
symlinked `--dir`, and refuses any member of the directory that is not a regular file (a symbolic link, a junction or
other reparse point, a directory, a FIFO): every directory and member is checked with lstat, a file is opened
afterwards, and its identity and size are re-checked on the open handle.

**Verify, in order.** (0) usage: `expect_id_required`, then `bad_trust_source` (exactly one of --trust-file and
--trust-test-key), then `test_key_flag_misuse`, then `bad_release_id` (the expected id matches neither pattern); then
the `--dir` check. (1) `manifest_missing`, then `sums_missing`. (2) the trust source: `bad_release_keys`,
`no_trusted_key`, after the keys file's own `test_key_refused` and `weak_key_refused`. (3) `verifyManifest` with
`expectId`: every manifest reason passes through unchanged, including `test_key_refused` when the trust set holds a
test key and the flag was not given. (4) after acceptance: `test_key_release_id` if the signature that verified
belongs to a test key and the id does not match REHEARSAL_ID_PATTERN (unreachable from the command line by
construction, covered by a unit test), then `publisher_mismatch`. (5) the members: `not_regular_file`; then, entry by
entry, `artifact_missing`, `artifact_size_mismatch`, `artifact_hash_mismatch`; then `artifact_extra`. (6)
`sums_mismatch`. The first stderr line of a refusal is `refused: <reason>`. A run keeps no state.

**Exit codes.** 0 accepted: stdout `{"verdict":"ok","id","version","entries","testKey"}`, where `testKey` comes from
the keyId of the signature that verified, never from a flag, and stderr carries
`VERIFIED WITH THE PUBLISHED RFC 8032 TEST KEY: rehearsal only, not a release` when it is true. 3 refused: stdout
`{"verdict":"refused","reason"}`, stderr `refused: <reason>` first; the reasons are `RELEASE_REJECT_REASONS`
(`manifest_missing`, `sums_missing`, `not_regular_file`, `bad_release_keys`, `no_trusted_key`,
`test_key_release_id`, `publisher_mismatch`, `artifact_missing`, `artifact_extra`, `artifact_size_mismatch`,
`artifact_hash_mismatch`, `sums_mismatch`) and the manifest reasons. 2 usage error: `usage: <token>: <message>` on
stderr; the tokens are `RELEASE_USAGE_REASONS` (`expect_id_required`, `test_key_flag_misuse`,
`test_key_release_id`, `bad_release_id`, `bad_artifact_name`, `not_regular_file`, `publisher_mismatch`,
`already_signed`, `bad_trust_source`) and `bad_arguments` for command-line syntax. 1 an I/O error: an I/O error is
exit 1 and never counts as a refusal, and neither does a crash, a signal or a missing tool.

**Signing a rehearsal.** `sign --dir D --test-key rfc8032-1` accepts only that literal value, an id that matches
REHEARSAL_ID_PATTERN and a manifest with no signature (`already_signed`). It prints
`TEST KEY SIGNATURE (RFC 8032 TEST 1, published): rehearsal only, NOT A RELEASE` on stderr and adds one signature
with `signedAt` equal to `createdAt`; Ed25519 is deterministic, so the output is. It reads no key file and has no
option to name one.

**Conformance (release).** `vectors/release/release.json` lists every case with its directory, mutation, arguments,
exit code and reason; the vocabulary of mutations is in `vectors/release/README.md`.
