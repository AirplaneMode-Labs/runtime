#!/usr/bin/env node
// Produces spec/examples/manifest.signed.example.json from manifest.unsigned.example.json by
// signing with the RFC 8032 section 7.1 test seed (public, non-secret test data). The body is
// byte-identical to the unsigned example and carries no expiresAt, so
// `cp-sign sign --allow-test-key --no-expiry` must reproduce the sig byte for byte.
//
//   node test/tools/sign-example.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RFC8032_PUBLIC_HEX, RFC8032_SEED_HEX, signManifest, verifySig } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '../../spec/examples');
const unsignedPath = resolve(examples, 'manifest.unsigned.example.json');
const signedPath = resolve(examples, 'manifest.signed.example.json');
const SIGNED_AT = '2026-11-09T00:00:00Z';

const unsigned = JSON.parse(readFileSync(unsignedPath, 'utf8'));
if (unsigned.expiresAt !== undefined) throw new Error('example must not carry expiresAt');
const signature = signManifest(unsigned, RFC8032_SEED_HEX, SIGNED_AT);
if (!verifySig(unsigned, signature.sig, RFC8032_PUBLIC_HEX)) throw new Error('self-check failed');
const signed = { ...unsigned, signatures: [signature] };
const text = JSON.stringify(signed, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = readFileSync(signedPath, 'utf8');
  if (current !== text) {
    console.error('manifest.signed.example.json is out of date; run without --check');
    process.exit(1);
  }
  console.log('manifest.signed.example.json is up to date');
} else {
  writeFileSync(signedPath, text);
  console.log(`wrote ${signedPath}\nkeyId ${signature.keyId}\nsig   ${signature.sig}`);
}
