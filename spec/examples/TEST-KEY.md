# Test key used by the signed examples and vectors

`manifest.signed.example.json` and every `vectors/*.sig.txt` are signed with **RFC 8032 section 7.1
test vector 1**, a published, non-secret Ed25519 key pair:

| Field      | Value                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------- |
| seed       | `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`                                  |
| public key | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`                                  |
| keyId      | `21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9` (sha256 of the public key bytes) |
| publicKey  | `11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=` (standard padded base64)                             |

This is the RFC 8032 test vector; anyone can sign with it. It exists so that the TypeScript runtime
and the Rust `cp-sign` tool can prove they produce byte-identical signatures. **It must never be
trusted outside tests.** Two refusal rules enforce that:

1. `verifyManifest(manifest, trust, opts)` throws when the trust set contains the keyId above unless
   `opts.allowTestKeys === true`.
2. `cp-sign sign` exits 1 with `refusing RFC 8032 test key` when given this seed unless
   `--allow-test-key` is passed. `cp-sign keygen` never produces it.

The signed example carries no `expiresAt` and its body is byte-identical to
`manifest.unsigned.example.json`, so `cp-sign sign --allow-test-key --no-expiry` over the unsigned
example must reproduce `sig` byte for byte:

```
L7rMMYgtumVlLZFXW1fvs0ArbGmg/r00Cl/Z2C6J4V3WZP1iJ8ds/CxvfpCOSj3HdgCEBG6iolpChYjRDsOCDg==
```

Regenerate with `node test/tools/sign-example.mjs` (or `--check` to verify).
