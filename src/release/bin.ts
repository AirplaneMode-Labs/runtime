/**
 * Entry point of the bundled release tool (spec/tools/release-tool.mjs). The ONE environment read of the bundle is
 * here: SOURCE_DATE_EPOCH, used by `manifest` for createdAt so that a rehearsal is reproducible. Nothing else, and in
 * particular nothing that allows a test key (R3), is ever read from the environment.
 */

import process from 'node:process';
import { runCli } from './cli';

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  },
  { sourceDateEpoch: process.env['SOURCE_DATE_EPOCH'] },
);
