// Sprint 7, D1-03 and D1-04 (B1, B2, B4; TD-105, TD-106, TD-118, TD-119; S1 conditions): the policy of the workflow
// files that carry the release path. ci.yml gains the job release-rehearsal (<os>); publish.yml is the owner-only
// publish workflow. These are text checks (no YAML library): they pin what a reader of the files must be able to
// rely on, and T3 reads the files line by line besides. Written before ci.yml changed and before publish.yml
// existed; the red run is D1/red/D1-03-*.log and D1/red/D1-04-*.log in the sprint scratch.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NPM_REGISTRY,
  // @ts-expect-error: plain ESM script
} from '../scripts/release/publish-guard.mjs';
import { readText, repoDir } from './helpers';

const wf = (name: string): string => {
  const p = resolve(repoDir, '.github/workflows', name);
  return existsSync(p) ? readText(p) : '';
};
const ci = wf('ci.yml');
const publish = wf('publish.yml');
const pages = wf('pages.yml');

/** The conventions table (Sprint 7 plan, actions): the only `uses:` lines any workflow may carry. */
const PINS: Record<string, { sha: string; tag: string }> = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', tag: 'v7.0.1' },
  'actions/setup-node': { sha: '949feb2413d6458794dcd2491c4babbbce0c15c1', tag: 'v7.1.0' },
  'actions/setup-python': { sha: '6d4fd22b20465ccc0f7354476588e8df7c9ca0e0', tag: 'v7.1.0' },
  'actions/cache': { sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', tag: 'v6.1.0' },
  'actions/cache/restore': { sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', tag: 'v6.1.0' },
  'actions/configure-pages': { sha: '45bfe0192ca1faeb007ade9deae92b16b8254a0d', tag: 'v6.0.0' },
  'actions/upload-pages-artifact': {
    sha: 'fc324d3547104276b827a68afc52ff2a11cc49c9',
    tag: 'v5.0.0',
  },
  'actions/deploy-pages': { sha: '368f82528645a54fb793d4d04e342629a3f51346', tag: 'v5.0.1' },
  'dtolnay/rust-toolchain': { sha: '683b588c487a69d01f6c6ddf40f036ff682cc2c8', tag: 'v1' },
  'Swatinem/rust-cache': { sha: 'd1527c8f67ef9af357290475d4af4b0fab8f12e0', tag: 'v2.9.3' },
  'actions/upload-artifact': { sha: 'cf430e030ddbb5b0abf93d22962f4752f3646cd9', tag: 'v7.0.2' },
  'actions/download-artifact': { sha: '9000827ccba6bdab643e8b6fd33ac0654aef8333', tag: 'v8.0.2' },
  'github/codeql-action/init': { sha: '33d7b85da1a04171e211befe2c739303b9a4c066', tag: 'v4' },
  'github/codeql-action/analyze': { sha: '33d7b85da1a04171e211befe2c739303b9a4c066', tag: 'v4' },
  'github/codeql-action/upload-sarif': {
    sha: '33d7b85da1a04171e211befe2c739303b9a4c066',
    tag: 'v4',
  },
  'ossf/scorecard-action': { sha: 'fa7117db83c52d787ae5a89f350999701505d78e', tag: 'v2.5.0' },
  'actions/attest-build-provenance': {
    sha: '4d101475d8b20a2381f78447822ac1eab6504dd8',
    tag: 'v4.2.2',
  },
  'pypa/gh-action-pypi-publish': {
    sha: '7245906fb61fa33a13554f9d5fb856fe61758086',
    tag: 'v1.14.3',
  },
};

const usesOf = (text: string): { action: string; sha: string; tag: string; line: string }[] =>
  text
    .split('\n')
    .filter((l) => /^\s*-?\s*uses:/.test(l))
    .map((line) => {
      const m = /^\s*-?\s*uses:\s*([^@\s]+)@([0-9a-f]{40})\s+#\s*(\S+)\s*$/.exec(line);
      return { action: m?.[1] ?? '', sha: m?.[2] ?? '', tag: m?.[3] ?? '', line };
    });

/** The text of one top-level job (from `  <name>:` to the next job or the end of the file). */
function job(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!) || /^\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  return lines.slice(start, end).join('\n');
}

/** The steps of a job block, each as its own text. */
function steps(block: string): string[] {
  const at = block.indexOf('\n    steps:\n');
  if (at < 0) return [];
  const body = block.slice(at + '\n    steps:\n'.length).split('\n');
  const out: string[] = [];
  for (const l of body) {
    if (/^ {6}- /.test(l)) out.push(l);
    else if (out.length) out[out.length - 1] += `\n${l}`;
  }
  return out;
}

const nonComment = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The lines of a YAML text outside comments and outside block scalars (a `run: |` body, a folded `>` text). */
function outsideScalars(text: string): string[] {
  const kept: string[] = [];
  let skipAbove = -1;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (skipAbove >= 0) {
      if (indent > skipAbove) continue;
      skipAbove = -1;
    }
    kept.push(raw);
    const m = /^(\s*)(- )?["']?[A-Za-z0-9_.-]+["']?:\s+[|>][+-]?\d*\s*$/.exec(raw);
    if (m) skipAbove = m[1]!.length + (m[2] ? 2 : 0);
  }
  return kept;
}

/** The mapping keys of a YAML text outside block scalars, each with its effective indent (a '- ' counts as two columns). */
function keysOf(text: string): { eff: number; key: string; value: string; line: string }[] {
  const out: { eff: number; key: string; value: string; line: string }[] = [];
  for (const line of outsideScalars(text)) {
    const m = /^(\s*)(- )?["']?([A-Za-z0-9_.-]+)["']?:(?:\s+(.*))?$/.exec(line);
    if (m)
      out.push({
        eff: m[1]!.length + (m[2] ? 2 : 0),
        key: m[3]!,
        value: (m[4] ?? '').trim(),
        line,
      });
  }
  return out;
}

/** A key written in flow style (`{ if: always() }`) anywhere outside a block scalar and a comment. */
const flowKey = (text: string, key: string): boolean =>
  outsideScalars(text).some((l) => new RegExp(`[{,]\\s*["']?${key}["']?\\s*:`).test(l));

describe('every workflow file: pins, triggers and secrets', () => {
  const dir = resolve(repoDir, '.github/workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));

  it('has ci.yml, pages.yml and publish.yml', () => {
    expect(files.sort()).toEqual(['ci.yml', 'pages.yml', 'publish.yml']);
  });

  it('every uses: line is owner/repo@<40-hex SHA> # <tag> from the conventions table', () => {
    for (const f of files) {
      for (const u of usesOf(readText(resolve(dir, f)))) {
        expect(u.action, `${f}: ${u.line}`).not.toBe('');
        const pin = PINS[u.action];
        expect(pin, `${f}: ${u.action} is not on the conventions table`).toBeDefined();
        expect({ sha: u.sha, tag: u.tag }, `${f}: ${u.action}`).toEqual(pin);
      }
    }
  });

  it('no pull_request_target and no workflow_run anywhere', () => {
    for (const f of files) {
      const t = nonComment(readText(resolve(dir, f)));
      expect(t, f).not.toMatch(/pull_request_target|workflow_run/);
    }
  });

  it("'secrets.' appears only as NPM_TOKEN inside a publish.yml step env (runtime has no CARGO_REGISTRY_TOKEN)", () => {
    for (const f of files) {
      const t = nonComment(readText(resolve(dir, f)));
      const hits = t.match(/secrets\.[A-Za-z_]+/g) ?? [];
      if (f === 'publish.yml') expect(hits, f).toEqual(['secrets.NPM_TOKEN']);
      else expect(hits, f).toEqual([]);
    }
  });

  it("id-token: write and attestations: write appear only in publish.yml's publish job (and pages.yml's deploy job for id-token)", () => {
    expect(nonComment(ci)).not.toMatch(/id-token|attestations/);
    const pub = job(publish, 'publish');
    expect(pub).toMatch(/id-token: write/);
    expect(pub).toMatch(/attestations: write/);
    expect(job(publish, 'build')).not.toMatch(/id-token|attestations/);
    expect(nonComment(publish.replace(pub, ''))).not.toMatch(/id-token: write|attestations: write/);
  });

  it('no new workflow reads inputs. or github.event.', () => {
    for (const t of [nonComment(publish), job(ci, 'release-rehearsal')])
      expect(t).not.toMatch(/\binputs\.|github\.event\./);
  });
});

describe('ci.yml: release-rehearsal (<os>) (B1, B2; TD-106, TD-118)', () => {
  const block = job(ci, 'release-rehearsal');
  const body = nonComment(block);

  it('exists, on the three operating systems with fail-fast false, named release-rehearsal (<os>)', () => {
    expect(block).not.toBe('');
    expect(block).toContain('name: release-rehearsal (${{ matrix.os }})');
    expect(block).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(block).toContain('fail-fast: false');
    expect(block).toContain('runs-on: ${{ matrix.os }}');
  });

  it('contents: read and nothing else: no secrets, no id-token, no attestations, no environment', () => {
    expect(block).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(body).not.toMatch(
      /secrets\.|id-token|attestations|environment:|packages: write|contents: write/,
    );
  });

  it('no cache of any kind: no cache input, no actions/cache, no rust-cache, no setup-python', () => {
    expect(body).not.toMatch(/cache:|actions\/cache|rust-cache|setup-python|restore-keys/);
  });

  it('every checkout is persist-credentials: false; node 22 is set up from the pin', () => {
    const co = steps(block).filter((s) => s.includes('actions/checkout@'));
    expect(co.length).toBeGreaterThan(0);
    for (const s of co) expect(s).toContain('persist-credentials: false');
    expect(block).toMatch(
      /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0/,
    );
    expect(block).toContain('node-version: 22');
  });

  it('every run step names its shell (bash), as every Windows step must', () => {
    const runSteps = steps(block).filter((s) => /\n\s+run:/.test(s) || /^ {6}- run:/.test(s));
    expect(runSteps.length).toBeGreaterThanOrEqual(4);
    for (const s of runSteps) expect(s, s).toMatch(/\n\s+shell: (bash|pwsh)\b/);
  });

  it('SOURCE_DATE_EPOCH comes from the commit; the self-test, the rehearsal and the quick-start test run in that order', () => {
    expect(block).toContain('SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)');
    expect(block).toContain('>> "$GITHUB_ENV"');
    const i = block.indexOf('run: npm ci --ignore-scripts');
    expect(i, 'the locked install comes first').toBeGreaterThan(0);
    expect(i).toBeLessThan(block.indexOf('npx vitest run'));
    const v = block.indexOf('npx vitest run test/release-tool.test.ts --reporter=verbose');
    expect(v).toBeGreaterThan(0);
    const a = block.indexOf('node scripts/release/rehearse.mjs --self-test');
    const b = block.indexOf('run: node scripts/release/rehearse.mjs\n');
    const c = block.indexOf('test/quickstart.test.ts');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(v);
    expect(c).toBeGreaterThan(b);
  });

  it('the upload is named REHEARSAL-test-key-NOT-A-RELEASE-runtime-<os>-<sha> and holds exactly the two directories', () => {
    const up = steps(block).find((s) => s.includes('actions/upload-artifact@'))!;
    expect(up).toBeDefined();
    expect(up).toContain(
      'name: REHEARSAL-test-key-NOT-A-RELEASE-runtime-${{ matrix.os }}-${{ github.sha }}',
    );
    const path = /path: \|\n((?: {12}\S.*\n?)+)/.exec(up)?.[1] ?? '';
    expect(
      path
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ).toEqual(['dist-release/', 'dist-release-report/']);
    expect(up).toContain('include-hidden-files: false');
    expect(up).toContain('retention-days: 3');
    expect(up).toContain('if-no-files-found: error');
  });

  it('the job uses only checkout, setup-node and upload-artifact', () => {
    const used = new Set(usesOf(block).map((u) => u.action));
    expect([...used].sort()).toEqual(
      ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'].sort(),
    );
  });

  it('wheels, caches and the older jobs are untouched: check (<os>) and model-wasm keep their names', () => {
    expect(ci).toContain('name: check (${{ matrix.os }})');
    expect(ci).toContain('name: model-wasm (ubuntu-latest)');
    expect(ci).toContain('name: Browser tests (Linux only)');
  });
});

describe('publish.yml: the owner-only publish workflow (B4; TD-105)', () => {
  const body = nonComment(publish);
  const build = job(publish, 'build');
  const pub = job(publish, 'publish');

  it('exists and says in its header that it is owner-only and never run by the team', () => {
    expect(publish).not.toBe('');
    expect(publish.split('\n').slice(0, 14).join('\n')).toMatch(/owner-only/i);
    expect(publish.split('\n').slice(0, 14).join('\n')).toMatch(
      /never run by (the team|any agent)/i,
    );
  });

  it('is triggered by workflow_dispatch only: no push, pull request, schedule, release, repository_dispatch, workflow_call or workflow_run', () => {
    const on = /\non:\n((?: {2}.*\n?|\n)+)/.exec(publish)?.[1] ?? '';
    const triggers = on
      .split('\n')
      .filter((l) => /^ {2}[a-z_]+:/.test(l))
      .map((l) => l.trim().replace(/:.*/, ''));
    expect(triggers).toEqual(['workflow_dispatch']);
    expect(on).not.toMatch(/inputs:/);
    expect(body).not.toMatch(
      /\b(workflow_run|pull_request|pull_request_target|push|schedule|release|repository_dispatch|workflow_call):/,
    );
  });

  it('no inputs., no github.event., and no test-key string of any kind', () => {
    expect(body).not.toMatch(/\binputs\.|github\.event\./);
    expect(body).not.toMatch(
      /test-key|allow-test-key|trust-test-key|-rehearsal|rehearse|allowTestKeys|rfc8032/i,
    );
  });

  it('permissions: {} at the top; each job sets its own; concurrency group publish never cancels; timeouts everywhere', () => {
    expect(publish).toMatch(/\npermissions: \{\}\n/);
    expect(publish).toMatch(/\nconcurrency:\n {2}group: publish\n {2}cancel-in-progress: false\n/);
    expect(build).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(pub).toMatch(
      /\n {4}permissions:\n {6}contents: read\n {6}id-token: write\n {6}attestations: write\n/,
    );
    for (const j of [build, pub]) expect(j).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });

  it('build job: ubuntu-latest, no environment, no secrets, no cache, ignore-scripts install, dry run, 1-day upload', () => {
    expect(build).toContain('runs-on: ubuntu-latest');
    expect(nonComment(build)).not.toMatch(
      /environment:|secrets\.|cache:|actions\/cache|rust-cache|vars\./,
    );
    expect(build).toContain('npm ci --ignore-scripts');
    expect(build).toContain('npm run build');
    expect(build).toContain('npm pack --ignore-scripts');
    expect(build).toContain('--id runtime-release');
    expect(build).toContain('--publisher release');
    expect(build).toContain('node scripts/release/publish-dry-run.mjs');
    const up = steps(build).find((s) => s.includes('actions/upload-artifact@'))!;
    expect(up).toContain('name: release-candidate-runtime-${{ github.sha }}');
    expect(up).toContain('retention-days: 1');
    expect(up).toContain('if-no-files-found: error');
    expect(up).toContain('include-hidden-files: false');
    expect(build).toMatch(/persist-credentials: false/);
  });

  it('the job-level if-guards (main, the repository) and the environment sit on the publish job; no vars. in any job-level if (TD-125)', () => {
    const ifLine = /\n {4}if: (.*)\n/.exec(pub)?.[1] ?? '';
    expect(ifLine).toContain("github.ref == 'refs/heads/main'");
    expect(ifLine).toContain("github.repository == 'AirplaneMode-Labs/runtime'");
    expect(ifLine).not.toContain('vars.');
    for (const l of nonComment(publish).split('\n'))
      if (/^ {4}if:/.test(l)) expect(l, 'a job-level if never reads vars.').not.toContain('vars.');
    expect(pub).toMatch(/\n {4}environment:\n {6}name: release\n/);
    expect(pub).toContain('needs: build');
    // the build job carries the first two guards as well, so nothing runs from another branch or another repository
    const buildIf = /\n {4}if: (.*)\n/.exec(build)?.[1] ?? '';
    expect(buildIf).toContain("github.ref == 'refs/heads/main'");
    expect(buildIf).toContain("github.repository == 'AirplaneMode-Labs/runtime'");
    expect(buildIf).not.toContain('vars.');
  });

  it('NPM_TOKEN is in the step env of the one publish step and nowhere else; no other secret, no repository secret reference', () => {
    const hits = [...body.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(hits).toEqual(['NPM_TOKEN']);
    const step = steps(pub).find((s) => s.includes('secrets.NPM_TOKEN'))!;
    expect(step).toMatch(/\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/);
    expect(step).toContain('npm publish');
    expect(nonComment(build)).not.toContain('secrets.');
  });

  it('the publish steps run in the specified order, every check before the attestation and the publish', () => {
    const at = (needle: string): number => {
      const i = pub.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('actions/download-artifact@'),
      at('node -p "require(\'./package.json\').version"'),
      at('publish-guard.mjs key-id'),
      at('gh release download'),
      at('mkdir verify'),
      at('release-tool.mjs verify'),
      at('publish-guard.mjs no-expiry'),
      at('MANIFEST_VERSION'),
      at('publish-guard.mjs tag'),
      at('publish-guard.mjs registry-absent'),
      at('publish-guard.mjs tarball'),
      at('actions/attest-build-provenance@'),
      at('npm publish'),
    ];
    for (let i = 1; i < order.length; i++)
      expect(order[i]!, `step ${i + 1} comes after step ${i}`).toBeGreaterThan(order[i - 1]!);
  });

  it('lock 3 (TD-125): the ARMED step is the first step after checkout, reads the environment variable through step env, and no job-level if reads vars.', () => {
    const st = steps(pub);
    expect(st[0]).toContain('actions/checkout@');
    const armed = st[1]!;
    expect(armed).toContain('RELEASE_PUBLISH_ARMED: ${{ vars.RELEASE_PUBLISH_ARMED }}');
    expect(armed).toContain('"true"');
    expect(armed).toContain('exit 1');
    expect(armed).not.toMatch(/secrets\./);
    // nothing but the checkout comes before it, and every other step comes after it
    expect(pub.indexOf('RELEASE_PUBLISH_ARMED: ${{ vars.')).toBeGreaterThan(
      pub.indexOf('actions/checkout@'),
    );
    expect(pub.indexOf('RELEASE_PUBLISH_ARMED: ${{ vars.')).toBeLessThan(
      pub.indexOf('actions/setup-node@'),
    );
    // vars. is read only in step env of the publish job, never in an if: of any level
    for (const l of nonComment(publish).split('\n'))
      if (/\bif:/.test(l)) expect(l, l).not.toContain('vars.');
    expect(nonComment(build)).not.toContain('vars.');
  });

  it('persist-credentials: false on EVERY checkout in publish.yml, the publish job included (S1-132)', () => {
    for (const j of [build, pub]) {
      const checkouts = steps(j).filter((x) => x.includes('actions/checkout@'));
      expect(checkouts.length, j.slice(0, 20)).toBeGreaterThan(0);
      for (const c of checkouts) expect(c).toContain('persist-credentials: false');
    }
    const all = usesOf(publish).filter((u) => u.action === 'actions/checkout').length;
    expect(publish.match(/persist-credentials: false/g)?.length).toBe(all);
  });

  it('a step after verify refuses a manifest that carries expiresAt (TD-121, R5)', () => {
    const s2 = steps(pub).find((x) => x.includes('publish-guard.mjs no-expiry'))!;
    expect(s2).toContain('--file verify/release-manifest.json');
    expect(pub.indexOf('publish-guard.mjs no-expiry')).toBeGreaterThan(
      pub.indexOf('release-tool.mjs verify'),
    );
    expect(s2).not.toMatch(/\bgrep\b|\bjq\b/);
  });

  it('VERSION is validated as strict SemVer before it is written to GITHUB_ENV', () => {
    const v = steps(pub).find((x) => x.includes('>> "$GITHUB_ENV"') && x.includes('VERSION='))!;
    expect(v).toContain('publish-guard.mjs semver "$VERSION"');
    expect(v.indexOf('publish-guard.mjs semver')).toBeLessThan(v.indexOf('>> "$GITHUB_ENV"'));
  });

  it('every npm publish argument that names a file starts with ./ or / (S1-130: a bare path is read as a GitHub shorthand)', () => {
    const cmds = nonComment(publish)
      .split('\n')
      .filter((l) => /\bnpm publish\b/.test(l));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      const args = c.trim().split(/\s+/).slice(2);
      const files: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        if (a === '--access' || a === '--tag' || a === '--registry' || a === '--otp') k++;
        else if (!a.startsWith('--')) files.push(a);
      }
      expect(files.length, c).toBeGreaterThan(0);
      for (const a of files) expect(a.replace(/^"/, ''), c).toMatch(/^(\.\/|\/)/);
    }
  });

  it('the tag binding is made by scripts/release/publish-guard.mjs with the commit passed as an argument, never the ref', () => {
    const t = steps(pub).find((x) => x.includes('publish-guard.mjs tag'))!;
    expect(t).toContain('--sha "$GITHUB_SHA"');
    expect(t).toContain('--version "$VERSION"');
    expect(t).toContain('GH_TOKEN: ${{ github.token }}');
    expect(nonComment(publish)).not.toMatch(/GITHUB_REF|github\.ref_name|github\.head_ref/);
  });

  it('lock 6: RELEASE_KEY_ID must equal the single key in docs/release-keys.json at this commit (the comparison is publish-guard.mjs key-id, unit-tested)', () => {
    const s = steps(pub).find((x) => x.includes('RELEASE_KEY_ID'))!;
    expect(s).toContain('RELEASE_KEY_ID: ${{ vars.RELEASE_KEY_ID }}');
    // the step is the env mapping and one call: the id goes in as an argument, the file is the committed one, no inline logic
    expect(s).toBe(
      [
        '      - name: The release key the owner set equals the single key committed here',
        '        env:',
        '          RELEASE_KEY_ID: ${{ vars.RELEASE_KEY_ID }}',
        '        run: node scripts/release/publish-guard.mjs key-id --keys docs/release-keys.json --id "$RELEASE_KEY_ID"',
      ].join('\n'),
    );
    expect(nonComment(publish)).not.toMatch(/JSON\.parse|node -e/);
  });

  it('the signed manifest comes from the GitHub release and is verified with --trust-file and the expected id, with no test-key flag', () => {
    const v = steps(pub).find((x) => x.includes('release-tool.mjs verify'))!;
    expect(v).toContain('--trust-file docs/release-keys.json');
    expect(v).toContain('--expect-id runtime-release');
    expect(v).not.toMatch(/--allow-test-key|--trust-test-key/);
    const dl = steps(pub).find((x) => x.includes('gh release download'))!;
    expect(dl).toContain('-p release-manifest.json');
    expect(dl).toContain('GH_TOKEN: ${{ github.token }}');
    expect(dl).toContain('"v$VERSION"');
  });

  it('the verify directory is the candidate files plus the signed manifest plus the candidate SHA256SUMS', () => {
    const a = steps(pub).find((x) => x.includes('mkdir verify'))!;
    expect(a).toContain('candidate/');
    expect(a).toContain('signed/release-manifest.json');
    expect(a).toMatch(/release-manifest\.json/);
  });

  it('the version, the tag and the registry are bound: manifest version, tag peels to the commit, registry answers 404', () => {
    const t = steps(pub).find((x) => x.includes('publish-guard.mjs tag'))!;
    expect(t).toContain('GH_TOKEN: ${{ github.token }}');
    expect(t).toContain('--repo "$GITHUB_REPOSITORY"');
    const n = steps(pub).find((x) => x.includes('publish-guard.mjs registry-absent'))!;
    expect(n).toBe(
      [
        '      - name: The registry does not already hold this version (a 404 is the pass)',
        '        run: node scripts/release/publish-guard.mjs registry-absent --package @airplanemode/runtime --version "$VERSION"',
      ].join('\n'),
    );
    expect(publish).not.toMatch(/npm view/);
    const m = steps(pub).find((x) => x.includes('MANIFEST_VERSION'))!;
    expect(m).toMatch(/"\$MANIFEST_VERSION" = "\$VERSION"|\$MANIFEST_VERSION.*\$VERSION/);
  });

  it('the download is from the same run only: no run-id, no github-token, no repository or workflow input', () => {
    const d = steps(pub).find((x) => x.includes('actions/download-artifact@'))!;
    expect(d).not.toMatch(/run-id|github-token|repository:|merge-multiple|pattern:/);
    expect(d).toContain('name: release-candidate-runtime-${{ github.sha }}');
  });

  it('publish uses the exact tarball path from the verified manifest: no glob, no ${{ }} of the version inside run:', () => {
    const p = steps(pub).find((x) => x.includes('npm publish'))!;
    expect(p).toContain('npm publish "./$TARBALL"');
    expect(p).toContain('--provenance');
    expect(p).toContain('--access public');
    expect(p).toContain('--ignore-scripts');
    expect(p).toContain('--tag "$DIST_TAG"');
    // the command line itself names one variable (a relative path needs the ./ or npm reads it as a GitHub shorthand) and no glob
    const cmd = p.split('\n').find((l) => l.trim().startsWith('npm publish'))!;
    expect(cmd.trim()).toBe(
      'npm publish "./$TARBALL" --provenance --access public --ignore-scripts --tag "$DIST_TAG"',
    );
    expect(cmd).not.toMatch(/[*?[\]]|candidate\/|verify\//);
    for (const s of steps(pub)) {
      const run = /\n\s+run: ([\s\S]*)$/.exec(s)?.[1] ?? '';
      expect(run, s).not.toMatch(/\$\{\{/);
    }
    const a = steps(pub).find((x) => x.includes('attest-build-provenance'))!;
    expect(a).toContain('subject-path: ${{ env.TARBALL }}');
    expect(a).not.toMatch(/\*/);
  });

  it('the dist-tag is derived in shell from the prerelease identifier (alpha, beta, rc), never from an input', () => {
    const p = steps(pub).find((x) => x.includes('npm publish'))!;
    expect(p).toMatch(/alpha\|beta\|rc/);
    expect(p).toContain('latest');
  });

  it('install and tool setup in the publish job are hashed: npm ci --ignore-scripts, no cache, node 22 with the registry url only here', () => {
    expect(pub).not.toMatch(/cache:|actions\/cache/);
    expect(pub).toContain('node-version: 22');
    expect(pub).toContain("registry-url: 'https://registry.npmjs.org'");
    expect(build).not.toContain('registry-url');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 2 (BUG-T3-S7-17): a policy test that only pins what a check says lets a mutation through that leaves the text
// in place and defeats it (continue-on-error, an always() condition, a check that can never fail). These tests pin the
// absence of every way a step can be skipped or its failure ignored, pin the calls to the unit-tested guard
// (scripts/release/publish-guard.mjs; test/publish-guard.test.ts), and pin the whole non-comment text of the file.
// ---------------------------------------------------------------------------------------------------------------------
describe('publish.yml: no step can be skipped or have its failure ignored (BUG-T3-S7-17)', () => {
  const GUARD =
    "github.ref == 'refs/heads/main' && github.repository == 'AirplaneMode-Labs/runtime'";
  const build = job(publish, 'build');
  const pub = job(publish, 'publish');

  it('the scanner itself: finds if and continue-on-error as keys at any level and in flow style, and ignores them in comments and in run scripts', () => {
    const doc = [
      '    # if: always()',
      '    steps:',
      '      - name: a',
      '        run: |',
      '          echo "if: always() continue-on-error: true"',
      '          if: nothing',
      '      - name: b',
      '        if: always()',
      '        run: echo b',
      '      - uses: x/y@abc',
      '        with:',
      '          if: 1',
      '      - { name: c, continue-on-error: true, run: echo c }',
      "      - 'if': failure()",
      '        run: echo d',
    ].join('\n');
    const keys = keysOf(doc);
    expect(keys.filter((k) => k.key === 'if').map((k) => [k.eff, k.value])).toEqual([
      [8, 'always()'],
      [10, '1'],
      [8, 'failure()'],
    ]);
    expect(flowKey(doc, 'continue-on-error')).toBe(true);
    expect(flowKey(doc, 'if')).toBe(false);
    expect(flowKey('        run: |\n          x: { if: 1 }\n', 'if')).toBe(false);
    expect(
      keysOf('      - run: |\n          if: hidden\n      - name: z').map((k) => k.key),
    ).toEqual(['run', 'name']);
  });

  it('no continue-on-error anywhere: not on a step, not on a job, not in flow style', () => {
    expect(nonComment(publish)).not.toMatch(/continue-on-error/);
    expect(keysOf(publish).filter((k) => k.key === 'continue-on-error')).toEqual([]);
    expect(flowKey(publish, 'continue-on-error')).toBe(false);
  });

  it('the only if: in the file are the two job-level guards, each exactly the main-and-repository condition; no step has an if: of any kind', () => {
    const ifs = keysOf(publish).filter((k) => k.key === 'if');
    expect(ifs.map((k) => [k.eff, k.value])).toEqual([
      [4, GUARD],
      [4, GUARD],
    ]);
    expect(flowKey(publish, 'if')).toBe(false);
    for (const [name, block] of [
      ['build', build],
      ['publish', pub],
    ] as const) {
      const own = keysOf(block).filter((k) => k.key === 'if');
      expect(
        own.map((k) => [k.eff, k.value]),
        `${name}: one job-level if, exactly the guard`,
      ).toEqual([[4, GUARD]]);
      for (const st of steps(block))
        expect(
          keysOf(st).filter((k) => k.key === 'if'),
          st,
        ).toEqual([]);
    }
  });

  it('no step-level or job-level override of the shell: the one shell: is defaults.run (bash, which runs with -e and pipefail)', () => {
    expect(
      keysOf(publish)
        .filter((k) => k.key === 'shell')
        .map((k) => [k.eff, k.value]),
    ).toEqual([[4, 'bash']]);
    expect(publish).toMatch(/\ndefaults:\n {2}run:\n {4}shell: bash\n/);
  });

  it('no run script neutralises a failure: no || true, no || :, no || exit 0, no set +e, no exit 0, no trap, no errexit switch', () => {
    const body = nonComment(publish);
    expect(body).not.toMatch(/\|\|\s*(true|:|exit\s+0)\b/);
    expect(body).not.toMatch(/\bset\s+\+[A-Za-z]/);
    expect(body).not.toMatch(/\bset\s+\+o\b|\bexit\s+0\b|\btrap\b/);
  });

  it('the three checks that used to be inline are one call each to publish-guard.mjs, and no step runs inline node or JSON.parse', () => {
    expect(nonComment(publish)).not.toMatch(/node -e|JSON\.parse/);
    const t = steps(pub).find((x) => x.includes('publish-guard.mjs tarball'))!;
    expect(t).toBe(
      [
        '      - name: The exact tarball named by the verified manifest',
        '        run: |',
        '          TARBALL=$(node scripts/release/publish-guard.mjs tarball --manifest verify/release-manifest.json --dir verify)',
        '          echo "TARBALL=$TARBALL" >> "$GITHUB_ENV"',
      ].join('\n'),
    );
    // the assignment is not prefixed by export, local or declare, which would hide a failing command substitution
    expect(t).not.toMatch(/\b(export|local|declare|readonly)\b/);
  });

  it('the guard calls name the package and the registry that the publish step uses', () => {
    const pkg = JSON.parse(readText(resolve(repoDir, 'package.json'))) as { name: string };
    expect(pkg.name).toBe('@airplanemode/runtime');
    expect(pub).toContain(`--package ${pkg.name} --version "$VERSION"`);
    expect(/registry-url: '([^']+)'/.exec(pub)?.[1]?.replace(/\/?$/, '/')).toBe(NPM_REGISTRY);
  });

  it('the publish job is exactly the committed golden: every non-comment line of publish.yml equals test/fixtures/publish.yml.golden', () => {
    // A deliberate change to publish.yml is a change to an owner-only, never-run workflow: it must change this file in the
    // same commit, where a reviewer sees both. Regenerate the golden with
    //   node -e 'const fs=require("fs");fs.writeFileSync("test/fixtures/publish.yml.golden",fs.readFileSync(".github/workflows/publish.yml","utf8").split("\n").filter(l=>!/^\s*#/.test(l)).join("\n"))'
    const golden = readText(resolve(repoDir, 'test/fixtures/publish.yml.golden')).replace(
      /\r\n?/g,
      '\n',
    );
    expect(nonComment(publish.replace(/\r\n?/g, '\n')).trimEnd()).toBe(golden.trimEnd());
  });
});
