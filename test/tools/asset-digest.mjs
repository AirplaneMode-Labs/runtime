#!/usr/bin/env node
// Prints the SHA-256 of the synthetic asset stream for <name> truncated to <bytes>,
// independently of the browser code. Used to fill spec examples and by T1 to check the hash the
// asset manager records.
//
//   node test/tools/asset-digest.mjs <name> <bytes>

import { createHash } from 'node:crypto';
import { AssetStream } from './xorshift.mjs';

const [name, bytesArg] = process.argv.slice(2);
if (!name || !bytesArg || !/^\d+$/.test(bytesArg)) {
  console.error('usage: node test/tools/asset-digest.mjs <name> <bytes>');
  process.exit(2);
}
const total = Number(bytesArg);
const hash = createHash('sha256');
const stream = new AssetStream(name);
const buf = new Uint8Array(1 << 20);
let left = total;
while (left > 0) {
  const n = Math.min(left, buf.length);
  const chunk = n === buf.length ? buf : buf.subarray(0, n);
  stream.fill(chunk);
  hash.update(chunk);
  left -= n;
}
process.stdout.write(hash.digest('hex') + '\n');
