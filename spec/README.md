# Airplane Mode Labs open contracts (runtime/spec)

The five contracts that let the AirplaneMode-Labs libraries evolve independently and let the paid
control plane plug in later without touching the open code. This directory is the source of truth;
every other repo vendors a copy under `src/contracts/` (TypeScript) or mirrors the shapes in serde
structs (Rust) with the header `Vendored from AirplaneMode-Labs/runtime spec/<file> @ 0.1.0; source
of truth is runtime/spec; do not edit here`. Mismatches are fixed on the consumer side.

The contracts are published under Apache-2.0 and never move behind the control-plane licence.

| Contract           | Files                                                     | Version | Status |
| ------------------ | --------------------------------------------------------- | ------- | ------ |
| Manifest           | `manifest.schema.json`, `manifest.ts`                     | 0.1.0   | draft  |
| Capability profile | `capability-profile.schema.json`, `capability-profile.ts` | 0.1.0   | draft  |
| Event              | `event.schema.json`, `event.ts`                           | 0.1.0   | draft  |
| Storage API        | `storage-api.ts` (normative), `storage-api.md`            | 0.1.0   | draft  |
| Backend adapter    | `backend-adapter.ts` (normative), `backend-adapter.md`    | 0.1.0   | draft  |

`index.ts` re-exports everything and carries `SPEC_VERSIONS`. Examples live in `examples/`, the
shared canonicalisation vectors in `vectors/`, and the change history in `CHANGELOG.md`.

## Versioning

Each schema has `"$schema": "https://json-schema.org/draft/2020-12/schema"` and
`"$id": "urn:airplanemode:spec:<name>:0.1.0"`; each instance carries a `spec` discriminator
`airplanemode.<name>/0.1` (major.minor; patch never changes the wire format). Consumers reject
unknown spec strings. All object keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (never digit-leading;
see canonicalisation); `additionalProperties: false` everywhere except `Event.attrs` and
`CapabilityProfile.details`, whose keys are constrained by the same pattern via `propertyNames`.

The `$id` URNs become `https://` URLs once a domain is reserved; the URN form stays valid as an
alias.

## Manifest 0.1.0

A `Manifest` lists each model or data file with its SHA-256, size, version, licence and minimum
capability profile, and is signed with Ed25519. The runtime verifies the signature and every hash
before any consumer can read a byte. Shapes: `manifest.ts`; validation: `manifest.schema.json`.
Entry ids are unique and the `entries` array is sorted by id in byte order (checked by code, not by
the schema). `ManifestEntry.url` is an absolute `https://` URL, an absolute `http://` URL whose
host is exactly `127.0.0.1`, `[::1]` or `localhost` (tests only), or a relative reference without a
scheme resolved against the manifest URL; no query string, no fragment; `data:`, `blob:`, `file:`,
`javascript:` and every other scheme are schema-invalid.

### Unauthenticated fields

signedAt, alg, keyId and publicKey are NOT covered by the signature, because the signatures member
is removed before canonicalisation; a verifier MUST NOT use signedAt for any decision; createdAt and
expiresAt in the body are the only authenticated timestamps.

### Signing scheme

signedBytes = UTF-8("airplanemode-manifest-v1\n") || canonical(Manifest with the "signatures"
member removed). canonical() = RFC 8785 JCS restricted to our profile: members sorted by key in
ASCII byte order, no whitespace, strings exactly as JSON.stringify (escape only `"` `\` and
U+0000..U+001F using `\b` `\t` `\n` `\f` `\r` else `\u00xx` lowercase; `/` not escaped), integers as
plain decimal, floats forbidden, literals true/false/null.

KEY RULE: every object key MUST match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`;
digit-leading keys are rejected because JavaScript enumerates array-index-like keys ("0", "10") in
numeric order before string keys regardless of sorting, so a key such as "123" would canonicalise
differently in JSON.stringify and serde_json BTreeMap; `canonicalize()` throws and cp-manifest
`canonical_bytes()` returns Err; both repos carry a test vector with keys {"b","10","a"} asserting
rejection.

STRING RULE: string values MUST be well-formed Unicode (no lone surrogates); TS checks
`String.prototype.isWellFormed()` and rejects, serde_json rejects lone surrogate escapes natively
(the request for a lone-surrogate vector is therefore a NEGATIVE vector on both sides, not a
canonical output vector).

NUMBER RULE: integers only, and only within 0..2^53-1 (u64 above 2^53-1 rejected by Rust; JS cannot
round-trip them); any f64 anywhere rejected before canonicalisation. Negative zero is rejected as a
float on both sides.

ACCEPTED ASYMMETRY: JavaScript's JSON.parse cannot distinguish 1.0 or 1e3 from 1, so TS accepts
those spellings while Rust rejects them; since canonical output is identical whenever both accept,
signatures still interoperate. serde_json with default features (BTreeMap, preserve_order OFF) and
JavaScript JSON.stringify over recursively key-sorted objects produce exactly this form; no JCS
library is needed on either side.

Signature = pure Ed25519 (RFC 8032, no prehash, no context). Ed25519 is deterministic, so identical
key + canonical bytes => identical sig; this is the cross-repo interop check (`vectors/`).

`keyId` = lowercase hex SHA-256 of the raw 32-byte Ed25519 public key. `publicKey` (standard
padded base64 of the raw key) is informational only and never a source of trust. `alg` is any token
matching `^[a-z0-9][a-z0-9-]{0,31}$` at the schema level so a manifest can carry signatures made
with future algorithms; `ed25519` is the only value a 0.1 verifier verifies. Verifiers IGNORE
signatures with an unknown `alg` and reject the manifest if none remaining verifies (reason
`no_valid_signature`, at verify stage, not parse stage); `"none"` is never valid.

### Trust roots

The trust set (Map keyId -> raw 32-byte public key) is application configuration compiled into or
installed with the app; it MUST never be fetched from the same origin or URL as the manifest or
alongside it, and the embedded publicKey is never added to the trust set. dockit contains no
trust-set loading code this sprint beyond a typed constant.

### Verification order

parse (reject lone surrogates, floats, integers > 2^53-1, digit-leading keys) -> schema validation
(spec const, patterns, url scheme rule, calendar-valid `createdAt`/`expiresAt`/`signedAt`
timestamps, entries sorted and unique) -> if expiresAt present require expiresAt > now -> for each
signature: if alg != "ed25519" ignore; if keyId malformed or not in the
trust set, invalid; if publicKey present and != trusted key bytes for that keyId, invalid (reason
key_mismatch), never silently accepted; recompute keyId from the trusted key and require equality;
decode sig and require exactly 64 bytes, else invalid; verify over signedBytes. Malformed inputs
count as invalid signatures and never throw out of verifyManifest. Require >= 1 valid -> downgrade
rule (below) -> only then are entries usable; every entry's bytes are hashed in full and compared
to sha256 before any consumer can read them; no partial file is ever exposed.

Test-key rule: a trust set containing keyId sha256(d75a98...511a) (the RFC 8032 vector) is refused
unless `opts.allowTestKeys === true`.

### Downgrade rule

State is keyed by manifest id and holds {version, createdAt} of the last accepted manifest. Compare
versions per SemVer 2.0: numeric major.minor.patch; a prerelease is lower than the corresponding
release; prerelease identifiers compared per SemVer section 11 (numeric identifiers numerically,
alphanumeric lexically, numeric lower than alphanumeric, fewer identifiers lower when all preceding
are equal). A candidate is refused with reason 'downgrade' if version < state.version, or
version == state.version and createdAt < state.createdAt, unless {allowDowngrade: true}, which
accepts and replaces the state. If the state store cannot be read (or written after acceptance)
the verifier fails closed with reason `state` (event `manifest.verify.failed` with attrs.reason
`state_unavailable`); `{allowDowngrade: true}` bypasses an unavailable state store as well.

Rejection reasons (`ManifestRejectReason`): parse stage `invalid_json`, `float`, `bigint`,
`digit_key`, `invalid_key`, `lone_surrogate`; schema stage `bad_spec`, `bad_url`, `schema`
(including calendar-invalid timestamps), `unsorted_entries`, `duplicate_entries`; verify stage
`expired`, `no_valid_signature`, `downgrade`, `state`; and `test_key_refused`, the only one that
throws. `verifyManifest` re-runs the parse and schema stages on its input, so an unparsed or
hostile object is a rejection with one of these reasons, never an exception.

Accepted risks recorded by the security consultant in `runtime/docs/security/FINDINGS.md` with
target sprints: no revocation, no transparency log, no Sigstore, single-signature threshold,
browser clock trusted for expiresAt.

### Test key

`examples/TEST-KEY.md` documents that the signed example uses RFC 8032 section 7.1 test vector 1
(seed 9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60, public key
d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a), a published non-secret vector
that must never be trusted outside tests; keyId = sha256(public key bytes); verifyManifest refuses
it unless allowTestKeys, cp-sign refuses it unless --allow-test-key. The resulting sig is published
in `examples/manifest.signed.example.json` (body identical to the unsigned example, no expiresAt,
so cp-sign reproduces it with `sign --allow-test-key --no-expiry`); cp-sign must reproduce it byte
for byte.

### Shared canonicalisation vectors

`vectors/` holds five positive vectors (`01-unsigned-example`, `02-escapes`, `03-devanagari`,
`04-minprofile-full`, `05-four-entries`), each as `<n>.json` with `<n>.canonical.txt` (expected
signed bytes including the prefix) and `<n>.sig.txt` (Ed25519 signature under the RFC 8032 seed),
plus twelve negative vectors `neg-*.json` with their rejection reasons and stage (`parse` or
`verify`) in `vectors/negative.json`; `neg-unknown-alg-only` is schema-valid and is rejected at
verify stage with `no_valid_signature`.
They are generated by `test/tools/make-vectors.mjs` and vendored byte for byte into
`control-plane/crates/cp-manifest/tests/fixtures/vectors/`.

## Capability profile 0.1.0

`{ gpu, ramGb, storageFreeGb, cores, backendTier, features, measuredAt, details? }`, computed once
per page load by `detectCapabilities()`. `BackendTier` ranks `webgpu-f16` (4) > `webgpu-f32` (3) >
`wasm-simd` (2) > `wasm` (1) > `none` (0). `details` carries only the allow-listed keys `vendor`,
`architecture`, `maxBufferSize`, `maxStorageBufferBindingSize`, `maxComputeWorkgroupStorageSize`
and `maxComputeInvocationsPerWorkgroup`; adapter description and device strings are dropped
(driver-version fingerprint); `navigator.userAgent` and `navigator.userAgentData` are never read;
no personal data. `satisfies(profile, minProfile)` implements the MinProfile rule above.

## Event 0.1.0

One JSON shape for logs, timings, memory, model-load and asset records. `attrs` is flat, at most
32 keys matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, string values at most 1024 UTF-16 units, never
URLs with query strings, document text, prompts or user identifiers. The runtime's `newEvent()`
enforces these rules in code: key regex, 32-key cap (TypeError), truncation to 1024, query-string
stripping after `://`, and a TypeError for any key matching `/prompt|text|content|document|ua|userAgent/i`.
`EventSink { emit(e) }`; the runtime's default sink is an in-memory ring buffer of 1000 with
`subscribe()`. No library ever has a network sink. Reserved runtime event names and their attrs are
listed in `event.ts` (`RUNTIME_EVENT_NAMES`).

## Storage API 0.1.0

See `storage-api.md` and the normative `storage-api.ts`.

## Backend adapter 0.1.0

See `backend-adapter.md` and the normative `backend-adapter.ts`.
