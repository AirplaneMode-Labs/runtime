#!/usr/bin/env node
// The publish dry run (Sprint 7, D1-03/D1-04; TD-105): `npm publish <tarball> --dry-run --ignore-scripts` with the
// same flags the real publish uses, except --provenance (it needs the registry's OIDC identity). Nothing is published
// and no credential is read or needed. scripts/release/rehearse.mjs calls it on Linux, and the build job of
// .github/workflows/publish.yml runs it as a step, so the dry run that CI rehearses is the one the owner's dispatch
// will run first.
//
//   node scripts/release/publish-dry-run.mjs [--tarball <path>]    (default: the one .tgz in dist-release/)
//
// NOTE: a relative path with a slash and no leading ./ is read by npm as a GitHub shorthand (user/repo), so the tarball
// path is resolved to an absolute one before it is handed to npm.
//
// The dist-tag is derived from the prerelease identifier of the package version: alpha, beta or rc for
// 1.2.3-alpha.1 and its kin, latest for a version without a prerelease. Any other prerelease identifier is refused:
// publishing 1.2.3-foo.1 as "latest" would hand a prerelease to everyone who installs the package.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The dist-tag for a package version, derived the way publish.yml derives it in shell. */
export function distTagFor(version) {
  const m = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z.-]*)?)?$/.exec(version);
  if (!m)
    throw new Error(`not a SemVer version without build metadata: ${JSON.stringify(version)}`);
  const pre = m[1];
  if (pre === undefined) return 'latest';
  if (pre === 'alpha' || pre === 'beta' || pre === 'rc') return pre;
  throw new Error(
    `prerelease identifier ${JSON.stringify(pre)} has no dist-tag (alpha, beta and rc do)`,
  );
}

/** Runs the dry run. Returns a one-line summary; throws when npm fails or says anything but a dry run. */
export function publishDryRun({ tarball, repoRoot: root = repoRoot }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tag = distTagFor(pkg.version);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GITHUB_|RUNNER_|CI$|ACTIONS_|NODE_AUTH_TOKEN$|NPM_TOKEN$)/.test(k)) continue;
    env[k] = v;
  }
  env['npm_config_update_notifier'] = 'false';
  const r = spawnSync(
    NPM,
    [
      'publish',
      // cmd.exe (shell: true on Windows) joins the arguments without quoting: quote the path
      process.platform === 'win32' ? `"${resolve(tarball)}"` : resolve(tarball),
      '--dry-run',
      '--ignore-scripts',
      '--access',
      'public',
      '--tag',
      tag,
    ],
    { cwd: root, encoding: 'utf8', env, shell: process.platform === 'win32' },
  );
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.error || r.status !== 0)
    throw new Error(`npm publish --dry-run failed (status ${r.status}): ${text.slice(-600)}`);
  if (!/dry-run/i.test(text)) throw new Error('npm did not report a dry run: refusing to continue');
  // npm prints "+ name@version" at the end of a dry run too, so that line proves nothing: the flag and the notice do
  return `npm publish --dry-run --tag ${tag} --access public (exit 0, nothing published)`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const i = process.argv.indexOf('--tarball');
    let tarball = i >= 0 ? process.argv[i + 1] : undefined;
    if (tarball === undefined) {
      const dir = join(repoRoot, 'dist-release');
      const found = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.tgz')) : [];
      if (found.length !== 1)
        throw new Error(`expected exactly one .tgz in dist-release/, found ${found.length}`);
      tarball = join(dir, found[0]);
    }
    console.log(publishDryRun({ tarball: resolve(tarball) }));
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
