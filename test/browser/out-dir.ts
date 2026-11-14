// Where the browser specs write their results (S1-096, fix round 2).
//
// Every default used to be a parent-relative path (two levels up, then test-results) resolved against the
// WORKING directory, which is the repository root under `npm run`, so the results landed in the parent
// Projects folder, outside the
// repository and untracked in the parent git repository. The default is now runtime/test-results/
// (git-ignored), computed from this file's own directory, so it never depends on the cwd. Nothing is
// written outside the repository unless a RUNTIME_*_OUT variable says so.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: two levels above test/browser/, from this file's location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** runtime/test-results (git-ignored). */
export const DEFAULT_RESULTS_DIR = resolve(REPO_ROOT, 'test-results');

/**
 * The folder a spec writes into: the value of the environment variable `envName` (resolved against the
 * working directory, as a path the caller typed), or DEFAULT_RESULTS_DIR when the variable is unset or empty.
 */
export function resultsDir(
  envName?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = envName === undefined ? undefined : env[envName];
  return value === undefined || value === '' ? DEFAULT_RESULTS_DIR : resolve(value);
}
