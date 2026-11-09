# Changelog (runtime/spec)

All notable changes to the open contracts. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the contracts follow
Semantic Versioning: the wire discriminator `airplanemode.<name>/<major>.<minor>` changes only on
major or minor, never on patch.

## [0.1.0] - 2026-11-22 (draft)

### Added

- Manifest 0.1.0: JSON Schema (`urn:airplanemode:spec:manifest:0.1.0`), TypeScript types, the
  restricted RFC 8785 canonicalisation profile, Ed25519 signing scheme with the
  `airplanemode-manifest-v1\n` prefix, verification order, trust-roots rule, SemVer downgrade rule
  and the RFC 8032 test-key refusal rule.
- Capability profile 0.1.0: `gpu`, `ramGb`, `storageFreeGb`, `cores`, `backendTier`, `features`,
  `measuredAt`, allow-listed `details`.
- Event 0.1.0: one event shape with enforced `attrs` privacy rules and the reserved runtime event
  names.
- Storage API 0.1.0 (TypeScript normative): `set/get/delete/query/usage/clear/list/close`,
  `StorageError`, `StorageDriver`; `query()` frozen and `not_implemented` until Sprint 4.
- Backend adapter 0.1.0 (TypeScript normative): `BackendAdapter`, `AssetSource`, `AssetHandle`,
  `AdapterError`.
- Examples (unsigned and signed manifest, capability profile, event), `TEST-KEY.md`, and the five
  positive plus twelve negative shared canonicalisation vectors (`negative.json` carries a `stage`,
  `parse` or `verify`, per vector).

### Changed

- Manifest `Signature.alg` is a token matching `^[a-z0-9][a-z0-9-]{0,31}$` instead of the enum
  `["ed25519"]`, so a manifest carrying `[unknown-alg, valid ed25519]` is schema-valid and verifies,
  while `[unknown-alg only]` fails at verify stage with `no_valid_signature` on both sides
  (S1-011). `ed25519` remains the only algorithm a 0.1 verifier verifies; `"none"` is never valid.
  New vector `neg-unknown-alg-only.json` (stage `verify`).
- `createdAt`, `expiresAt` and `signedAt` must be calendar-valid: the pattern alone no longer
  suffices and `2026-99-99T00:00:00Z` is rejected with `schema`, matching cp-manifest (S1-014). New
  vector `neg-bad-date.json`.
- New rejection reason `state`: a verifier whose downgrade-state store cannot be read or written
  fails closed instead of open (S1-013).
- `asset.quota` attrs documentation: `quota` is the browser estimate (or test override), not the
  enforced limit.
