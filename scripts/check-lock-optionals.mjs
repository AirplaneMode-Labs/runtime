#!/usr/bin/env node
// Fails when `npm ci` would need an unlocked fetch (Sprint 7, D1-05; S1 supply-chain condition).
//
// Native packages (esbuild, rolldown, lightningcss, ...) ship one optional package per platform. `npm ci` installs the one
// that matches the machine, and it can only do that from the lockfile if the entry has `resolved` and `integrity`. A
// lockfile written on one operating system can lack the others (a known npm failure), so CI on another OS would silently
// resolve and fetch without an integrity check. This script checks the lockfile text:
//   - every package entry that is optional has `resolved` (an https URL on registry.npmjs.org) and a sha512 `integrity`;
//   - every package that lists three or more platform-specific optional dependencies (a native family) has a build for
//     linux-x64 (glibc), darwin-arm64 and win32-x64 (msvc), the three CI runner images.
// `--install-scripts` also lists the packages whose lockfile entry says hasInstallScript. Nothing is fetched.
//
//   node scripts/check-lock-optionals.mjs [--lock <package-lock.json>] [--install-scripts]
//
// Exit 0 when the lockfile is complete, 1 with a list of problems otherwise.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const lockPath = resolve(
  args.includes('--lock') ? args[args.indexOf('--lock') + 1] : `${root}/package-lock.json`,
);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const packages = lock.packages ?? {};

const PLATFORMS = [
  { label: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { label: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { label: 'win32-x64-msvc', os: 'win32', cpu: 'x64' },
];

const problems = [];
const name = (key) => key.replace(/^.*node_modules\//, '');
const isPlatformSpecific = (p) => Array.isArray(p.os) || Array.isArray(p.cpu);

/** True when a lock entry with os, cpu and libc lists can be installed on the platform. */
function matches(p, plat) {
  const has = (list, v) => !Array.isArray(list) || (list.includes(v) && !list.includes(`!${v}`));
  const excluded = (list, v) => Array.isArray(list) && list.includes(`!${v}`);
  if (excluded(p.os, plat.os) || excluded(p.cpu, plat.cpu)) return false;
  if (Array.isArray(p.os) && !p.os.some((o) => !o.startsWith('!')) ? false : !has(p.os, plat.os))
    return false;
  if (!has(p.cpu, plat.cpu)) return false;
  if (plat.libc && Array.isArray(p.libc) && !p.libc.includes(plat.libc)) return false;
  return true;
}

const lockedProblems = (key, p) => {
  const out = [];
  if (typeof p.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved))
    out.push(`${name(key)}@${p.version}: no \`resolved\` on registry.npmjs.org`);
  if (typeof p.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity))
    out.push(`${name(key)}@${p.version}: no sha512 \`integrity\``);
  return out;
};

// 1. every optional entry is locked
for (const [key, p] of Object.entries(packages)) {
  if (key === '' || p.link) continue;
  if (
    p.optional === true ||
    (isPlatformSpecific(p) && p.optional !== false && p.dev !== true && p.peer !== true)
  )
    problems.push(...lockedProblems(key, p));
}

// 2. every native family covers the three CI platforms
const families = [];
for (const [key, p] of Object.entries(packages)) {
  const opt = p.optionalDependencies ?? {};
  const children = Object.keys(opt)
    .map((n) => {
      // the nearest node_modules/<n> entry: nested first, then hoisted
      const nested = `${key}/node_modules/${n}`;
      const k = packages[nested] ? nested : `node_modules/${n}`;
      return packages[k] ? { n, k, p: packages[k] } : undefined;
    })
    .filter((c) => c !== undefined && isPlatformSpecific(c.p));
  if (children.length < 3) continue;
  const fam = {
    parent: `${name(key) || 'root'}@${p.version}`,
    children: children.length,
    covered: {},
  };
  for (const plat of PLATFORMS) {
    // prefer the msvc build on win32 and the glibc build on linux: the ones the CI runner images use
    const hits = children.filter((c) => matches(c.p, plat));
    const hit =
      hits.find((c) => (plat.os === 'win32' ? /msvc/.test(c.n) : /gnu/.test(c.n))) ?? hits[0];
    if (!hit)
      problems.push(
        `${fam.parent}: no optional build for ${plat.label} among its ${children.length} platform packages`,
      );
    else fam.covered[plat.label] = `${hit.n}@${hit.p.version}`;
  }
  families.push(fam);
}

console.log(
  `${lockPath.replace(/\\/g, '/').split('/').pop()}: ${Object.keys(packages).length - 1} packages, ${families.length} native families`,
);
for (const f of families) {
  console.log(`  ${f.parent} (${f.children} platform packages)`);
  for (const plat of PLATFORMS)
    console.log(`    ${plat.label}: ${f.covered[plat.label] ?? 'MISSING'}`);
}
if (args.includes('--install-scripts')) {
  const withScript = Object.entries(packages)
    .filter(([, p]) => p.hasInstallScript)
    .map(([k, p]) => `${name(k)}@${p.version}`)
    .sort();
  console.log(`packages with install scripts (${withScript.length}):`);
  for (const s of withScript) console.log(`  ${s}`);
}
if (problems.length) {
  console.error(
    `\n${problems.length} problem(s): npm ci would need an unlocked fetch on some operating system`,
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  'every native optional is locked with resolved and integrity; linux-x64, darwin-arm64 and win32-x64 are covered',
);
