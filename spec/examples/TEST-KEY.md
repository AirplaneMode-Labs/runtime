# Test keys used by the signed examples and vectors

Manifest 0.1.1 (spec release 0.4.0): the verification rules treat **all five** RFC 8032 section 7.1 test
keys as test keys (see the table at the end). `manifest.signed.example.json` and every `vectors/*.sig.txt`
are signed with **TEST 1** (named `rfc8032-1` in the tamper vectors), a published, non-secret Ed25519 key
pair:

| Field      | Value                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------- |
| seed       | `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`                                  |
| public key | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`                                  |
| keyId      | `21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9` (sha256 of the public key bytes) |
| publicKey  | `11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=` (standard padded base64)                             |

This is the RFC 8032 test vector; anyone can sign with it. It exists so that the TypeScript runtime
and the Rust `cp-sign` tool can prove they produce byte-identical signatures. **It must never be
trusted outside tests.** Two refusal rules enforce that:

1. `verifyManifest(manifest, trust, opts)` throws when the trust set contains the keyId above, or any
   trusted key whose 32 bytes equal this public key, unless `opts.allowTestKeys === true` (a strict
   boolean: `'true'` does not count).
2. `cp-sign sign` exits 1 with `refusing RFC 8032 test key` when given this seed unless
   `--allow-test-key` is passed. `cp-sign keygen` never produces it.

The signed example carries no `expiresAt` and its body is byte-identical to
`manifest.unsigned.example.json`, so `cp-sign sign --allow-test-key --no-expiry` over the unsigned
example must reproduce `sig` byte for byte:

```
L7rMMYgtumVlLZFXW1fvs0ArbGmg/r00Cl/Z2C6J4V3WZP1iJ8ds/CxvfpCOSj3HdgCEBG6iolpChYjRDsOCDg==
```

Regenerate with `node test/tools/sign-example.mjs` (or `--check` to verify).

## TEST 2: the second key of the tamper vectors

`vectors/tamper/` and `vectors/tamper-assets/` use **RFC 8032 section 7.1 test vector 2** as the second
key (`rfc8032-2`): a different keyId for the swapped-key, untrusted-key and rotation cases.

| Field      | Value                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------- |
| seed       | `4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb`                                  |
| public key | `3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c`                                  |
| keyId      | `39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f` (sha256 of the public key bytes) |

## All five RFC 8032 test keys

Manifest spec v0.1 refuses a trust set that holds any of these public keys (matched by keyId AND by the
raw public-key bytes, whatever keyId the entry is filed under) unless `allowTestKeys === true`. The
seeds of TEST 3, TEST 1024 and TEST SHA(abc) are not repeated here: they are in RFC 8032 section 7.1,
and no vector is signed with them.

| Test          | Public key                                                         | keyId                                                              |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| TEST 1        | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a` | `21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9` |
| TEST 2        | `3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c` | `39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f` |
| TEST 3        | `fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025` | `dac073e0123bdea59dd9b3bda9cf6037f63aca82627d7abcd5c4ac29dd74003e` |
| TEST 1024     | `278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e` | `91384c411e5af29648f17f922b402655b11ecaec1b33fc45796241963f95f202` |
| TEST SHA(abc) | `ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf` | `5f9b247e2a654719f198e4f241d6b0df9a1a937a13ef5ef899f64d9285fce224` |

`test/spec-0.4.test.ts` derives each public key and keyId from the RFC seeds with Node crypto; the RFC
text wins on any mismatch.
