#!/usr/bin/env node
// Writes spec/tools/release-tool.mjs.sha256 beside the bundle: '<64 lowercase hex>  release-tool.mjs' and one LF.
// Run by `npm run spec:release-tool` after tsup builds the bundle. Both files are '-text' (spec/tools/** in
// .gitattributes), so the bytes that are hashed are the bytes that are committed and vendored.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = resolve(dirname(fileURLToPath(import.meta.url)), '../../spec/tools');
const bundle = resolve(tools, 'release-tool.mjs');
const digest = createHash('sha256').update(readFileSync(bundle)).digest('hex');
writeFileSync(`${bundle}.sha256`, `${digest}  release-tool.mjs\n`);
console.log(`spec/tools/release-tool.mjs ${digest}`);
