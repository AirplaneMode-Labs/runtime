// The build id shown in the demo's status line (S1-052). It is the first 12 characters of GITHUB_SHA
// only when that is a full 40-character lowercase hex commit id; anything else (unset, empty, a short
// or malformed value, a trailing newline) is 'local'. Same rule as pagetriage's build-site.sh and
// glyphsift's build-demo.sh.

const COMMIT_ID = /^[0-9a-f]{40}$/;

export function buildId(githubSha: string | undefined): string {
  return githubSha !== undefined && COMMIT_ID.test(githubSha) ? githubSha.slice(0, 12) : 'local';
}
