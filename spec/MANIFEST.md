# Manifest spec v0.1

The open, signed model-asset manifest of Airplane Mode Labs. This document is normative and standalone:
an implementation can be written from it, the schema and the vectors alone. It is the plan's "manifest
spec v0.1": the manifest contract on the wire string `airplanemode.manifest/0.1`, published as manifest
0.1.1 in spec release 0.4.0, status: published (committed; public after the owner's push). Published
means frozen on its wire string: later changes are additive patches that change no accepted or refused
input, or a new wire string.

Files: `manifest.schema.json` (JSON Schema 2020-12, `$id urn:airplanemode:spec:manifest:0.1.1`),
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

1. Test keys: a trust set holding any RFC 8032 test key is refused with `test_key_refused`, before the
   manifest is parsed (see Test keys). This is the only reason that is raised as an exception.
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
   - a `publicKey` present and different from the trusted bytes is `key_mismatch`; it is never silently accepted;
   - the `keyId` recomputed from the trusted key must equal the `keyId`, else `key_mismatch`;
   - S < L and the Ed25519 verification over `signedBytes` must both pass, else `bad_signature`.

   `malformed_key_id` (a `keyId` that is not 64 lowercase hex characters) and `malformed_sig` (a `sig`
   that does not decode to exactly 64 bytes) remain defined for an implementation that is handed a
   signature object that did not pass the schema stage, for example a library call on a typed object.
   A verifier that applies step 3 never reports them, because the same faults are `schema` there.

6. At least one valid signature, else `no_valid_signature`. One signature is enough.
7. The downgrade rule (see Downgrade).
8. Every entry's bytes are hashed in full and compared to `sha256` before any consumer can read them; no
   partial file is ever exposed.

Malformed input never throws out of a verifier: it is a rejection with a reason. The reasons are
`invalid_json`, `float`, `bigint`, `digit_key`, `invalid_key`, `lone_surrogate`, `bad_spec`, `bad_url`,
`schema`, `unsorted_entries`, `duplicate_entries`, `expired`, `no_valid_signature`, `downgrade`, `state`
and `test_key_refused`. A verifier reports the per-signature reasons (`unknown_alg`, `malformed_key_id`,
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
9. `downgrade` or `state`.

A missing "spec" key is bad_spec, never schema. A missing or non-array "signatures" member is schema,
judged after the parse stage: a document with such a member and a parse-stage fault (a digit-leading key, a
float, a lone surrogate, a repeated member) reports the parse-stage reason, and the parse stage covers
signatures[] as well as the body. Where a document has several faults, a conforming verifier reports the
earliest listed. Shared vectors never combine two parse-stage faults, so the order inside the first group
is not tested; every other pair is.

`stage` in the vector tables is `parse` for reasons 1 to 6 (the manifest is refused before any signature
is examined) and `verify` for reasons 7 to 9.

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
  product verifies like any other (mix-and-match). A runtime expectId option is Sprint 5; until then the
  application checks `manifest.id` itself.
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
- Small-order public keys in a trust set are a configuration error (informative): the trust set is
  application configuration and is not validated against a list of weak points.
- Bytes are hashed in full before a consumer reads them; a mismatch, a truncation or an extension is
  refused and no partial file is exposed.

## Conformance

An implementation conforms to manifest spec v0.1 when it accepts the 5 positive vectors byte-for-byte,
rejects every row of vectors/negative.json (32) with its reason and stage, and gives every row of
vectors/tamper/tamper.json (15) its expected result, skipping only requiresState rows if it keeps no
downgrade state. tamper-assets is runtime-specific: its normative fields apply to any implementation that
fetches assets.

"Accepts the 5 positive vectors byte-for-byte" means: `canonical()` of each `vectors/0n-*.json` equals its
`.canonical.txt`, and the Ed25519 signature of those bytes under the TEST 1 seed equals its `.sig.txt`.
The runtime (`@airplanemode/runtime`) runs the full set in `test/spec-0.4.test.ts` and
`test/tamper-vectors.test.ts`.
