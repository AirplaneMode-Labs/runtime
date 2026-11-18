// The build id shown in the demo's status line (S1-052). It is the first 12 characters of GITHUB_SHA
// only when that is a full 40-character lowercase hex commit id; anything else (unset, empty, a short
// or malformed value, a trailing newline) is 'local'. Same rule as pagetriage's build-site.sh and
// glyphsift's build-demo.sh.

const COMMIT_ID = /^[0-9a-f]{40}$/;

export function buildId(githubSha: string | undefined): string {
  return githubSha !== undefined && COMMIT_ID.test(githubSha) ? githubSha.slice(0, 12) : 'local';
}

// D1-FIX1-02 (BUG-T1-S5-04): the build label shown on index.html and models.html, in the convention form.
// - CI on main (GITHUB_SHA is 40 lowercase hex and GITHUB_REF is refs/heads/main, or unset): 'Built from main at <sha12>'.
// - Otherwise the checkout's git HEAD: 'Local build <sha12>' with '-dirty' when `git status --porcelain` is non-empty.
// - 'local' only when there is no usable .git, and the label says so: 'Local build local (no .git checkout)'.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface GitInfo {
  head: string;
  dirty: boolean;
}

export interface BuildLabelInput {
  githubSha: string | undefined;
  githubRef?: string | undefined;
  git: GitInfo | undefined;
}

export function buildLabel(input: BuildLabelInput): string {
  const { githubSha, githubRef, git } = input;
  const onMain = githubRef === undefined || githubRef === '' || githubRef === 'refs/heads/main';
  if (githubSha !== undefined && COMMIT_ID.test(githubSha) && onMain) {
    return `Built from main at ${githubSha.slice(0, 12)}`;
  }
  if (git !== undefined && COMMIT_ID.test(git.head)) {
    return `Local build ${git.head.slice(0, 12)}${git.dirty ? '-dirty' : ''}`;
  }
  return 'Local build local (no .git checkout)';
}

/** Reads HEAD and the dirty flag of the checkout at `repoDir`; undefined when there is no usable .git. */
export function readGitInfo(repoDir: string): GitInfo | undefined {
  try {
    const run = (args: string[]): string =>
      execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const head = run(['rev-parse', 'HEAD']).trim();
    if (!COMMIT_ID.test(head)) return undefined;
    // 'git rev-parse --show-toplevel' must be repoDir itself: a runtime folder copied under another
    // repository (for example the parent workspace) is not a checkout of this repo.
    const top = run(['rev-parse', '--show-toplevel']).trim();
    if (top.length === 0 || realpathSync(top) !== realpathSync(repoDir)) return undefined;
    const dirty = run(['status', '--porcelain']).trim().length > 0;
    return { head, dirty };
  } catch {
    return undefined;
  }
}
