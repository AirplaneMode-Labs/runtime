# Releasing @airplanemode/runtime: the owner's steps

Status: 20 Nov 2026 (Sprint 7, D1-04; team decisions TD-103, TD-105, TD-122). Nothing below has been done: no name is
reserved, no key exists, no environment, variable or secret exists, nothing is published and nothing is tagged. Every step is
the owner's, in this order, and each one says why the team cannot do it (CLAUDE.md: nobody on the team pushes, tags,
publishes, reserves names, creates keys, changes GitHub settings or handles a credential). `<run-id>`, `<sha>` and the other
angle-bracket values are filled in by the owner. The version in these commands is `0.3.0-beta.2`; use the version of
`package.json` at the commit you release.

The workflow is `.github/workflows/publish.yml`. It can only be started by hand, on `main`, in this repository; it builds a
candidate, and its publish job waits for the owner's approval of the `release` environment. Its locks and bindings are listed
in its header; `test/workflows-release.test.ts` pins them.

## The steps

### 1. Reserve the `@airplanemode` npm scope, with two-factor authentication on

Create the organisation `airplanemode` on npmjs.com (Organizations, Create), then:

```sh
npm profile enable-2fa auth-and-writes
npm org ls airplanemode
```

Why not the team: creating an account, an organisation or a registry name is an identity act of the owner, and the account's
second factor is the owner's. Until this is done `npm publish` cannot succeed, and the README says the names are placeholders.

### 2. Generate the release key offline, separate from any bundle key (R4), and decide custody

On the offline machine of `control-plane/docs/key-custody.md` section 2, from a clean clone of `control-plane` at a commit you
have read:

```sh
cargo install --locked --path crates/cp-sign --root <an empty directory>
<that directory>/bin/cp-sign keygen --out <KEYDIR>
<that directory>/bin/cp-sign keyid --pub <KEYDIR>/key.pub
```

Record the keyId, the date, the machine and the two backup locations in the private notes of that document. The release key
signs only `-release` manifests and is a different key from every key that signs a model or data bundle; it is never put in an
application trust set. Why not the team: no agent handles a real signing key, and the key must not exist anywhere a CI job or an
agent can reach.

### 3. Commit the public key to `docs/release-keys.json`

The file is `{"spec":"airplanemode.release-keys/0.1","keys":[{"keyId":"<hex>","publicKey":"<base64>"}]}` with exactly one key
at release time (the publish job refuses any other count). The `publicKey` is the canonical padded base64 of the 32 raw
public-key bytes, which are the hex after `ed25519-public` on the second line of `key.pub` (the first line is a comment). The
command below picks that line, refuses (exit 1) unless the hex is exactly 32 bytes, and prints the base64:

```sh
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split(/\r?\n/).find(s=>s.startsWith("ed25519-public "));const b=l&&Buffer.from(l.split(/\s+/)[1],"hex");if(!b||b.length!==32){console.error("not a cp-sign public key file");process.exit(1)}console.log(b.toString("base64"))' <KEYDIR>/key.pub
```

Check the result with the release tool, which refuses a test key, a weak key, a keyId that is not the SHA-256 of the key and
more than eight keys:

```sh
node spec/tools/release-tool.mjs verify --dir spec/vectors/release/vk-release --expect-id example-release --trust-file docs/release-keys.json
```

(That command is expected to be refused with `no_valid_signature`: the file parsed, and the vector was not signed with your key.
A refusal with `bad_release_keys`, `test_key_refused` or `weak_key_refused` is a mistake in the file.) Commit it on `main`.
Why not the team: a trust root is the owner's decision; the team commits `keys: []` only.

### 4. Create the `release` environment, the variables and the branch policy

Reviewer: the owner. Branch policy: `main` only. Administrators cannot bypass. Replace `<owner-login>` with your GitHub login:

```sh
OWNER_ID=$(gh api users/<owner-login> --jq .id)
gh api -X PUT repos/AirplaneMode-Labs/runtime/environments/release --input - <<EOF
{
  "reviewers": [{ "type": "User", "id": $OWNER_ID }],
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
gh api -X POST repos/AirplaneMode-Labs/runtime/environments/release/deployment-branch-policies -f name=main -f type=branch
gh variable set RELEASE_KEY_ID --env release --repo AirplaneMode-Labs/runtime --body <the keyId of step 2>
```

Both variables are variables of the `release` environment (`RELEASE_KEY_ID` now, `RELEASE_PUBLISH_ARMED` in step 12), set with
`--env release`, never repository variables (TD-125). A job condition is evaluated before the job is attached to its
environment and cannot read an environment's variables, so no job-level `if:` reads them: the publish job reads each one in a
step `env:`, where the environment's variables are visible, and its first step after checkout refuses unless
`RELEASE_PUBLISH_ARMED` is `true`. `RELEASE_PUBLISH_ARMED` is the arming lock: you set it only for the release you are doing,
just before you approve the waiting job (step 12), and remove it right after the publish (step 13). Recommended repository settings, also
yours: a tag ruleset for `v*` (only the owner may create or move a release tag), branch protection on `main`, secret-scanning
push protection, private vulnerability reporting (SECURITY.md says to use it), and a CODEOWNERS entry for
`docs/release-keys.json`. Why not the team: environments, variables, rulesets and organisation settings are GitHub settings; the
team changes none (gh is read-only for agents).

### 5. Run the 8 GB runbook and fill the README cells

The runbook is in `PLAN.md` (step 5): the model proof on the 8 GB Windows no-GPU laptop, then replace "not measured on 8 GB"
in the README Benchmarks tables with the figures. The figures are published like every other benchmark: the raw output goes
into a new file in `docs/benchmarks/` (date, commit, `machine.label` of the laptop as model and RAM, method, command, indexed in
`docs/benchmarks/README.md`) and the README cell is written from that file; `scripts/bench-readme.mjs` and the 8 GB column test
in `test/package-meta.test.ts` pin the phrase "not measured on 8 GB" today and change in the same commit. Why not the team: the
laptop is the owner's, and an emulated figure never fills a laptop cell (TD-51).

### 6. Commit the dated CHANGELOG heading

Change `## [0.3.0-beta.2] - 2026-11-20 (untagged)` to the date you tag, without `(untagged)`. Why not the team: the date of a
release is the date the owner decides it; the team writes `(untagged)` until then.

### 7. Dispatch the publish workflow

```sh
gh workflow run publish.yml --repo AirplaneMode-Labs/runtime --ref main
gh run list --workflow publish.yml --repo AirplaneMode-Labs/runtime --limit 1
```

The build job runs, rebuilds the candidate (tarball, unsigned `release-manifest.json`, `SHA256SUMS`), runs the dry run and uploads
it for one day under `release-candidate-runtime-<sha>`. The publish job then waits for your approval (step 12). Steps 8 to 11
must be done within a day, or the candidate expires and you dispatch again. Why not the team: nobody on the team runs a
publish workflow, and the dispatch is the first act that can end in a publish.

### 8. Check the candidate before you sign anything

```sh
gh run view <run-id> --repo AirplaneMode-Labs/runtime --json event,headBranch,headSha,workflowName,conclusion,jobs
```

It must show `workflow_dispatch`, `main`, the workflow `publish`, a successful `build` job and the `headSha` you mean to tag.
Then download the candidate and rebuild it yourself at that commit:

```sh
gh run download <run-id> --repo AirplaneMode-Labs/runtime -n release-candidate-runtime-<sha> -D candidate
git -C <runtime clone> checkout <sha>
(cd <runtime clone> && npm run release:rehearse)
```

Compare the `.tgz` line of `candidate/SHA256SUMS` with the `.tgz` line of `<runtime clone>/dist-release/SHA256SUMS`. If they differ,
extract both tarballs (`tar -xzf`) and compare them with `diff -r`: the same contents under a different gzip stream (another zlib)
is the same artefact, and the signature will bind the candidate's bytes. Re-hash every file in `candidate/` with
`shasum -a 256` against `SHA256SUMS`. Why not the team: a signature says "I vouch for these bytes", and this check is what makes
the owner's vouching informed.

### 9. Sign `release-manifest.json` offline, never with a test key, and verify it twice

On the offline machine, with the candidate directory copied over:

```sh
cp-sign canonical candidate/release-manifest.json
cp-sign sign --no-expiry --key <KEYDIR>/key.secret candidate/release-manifest.json --out release-manifest.signed.json
cp-sign verify --pub <KEYDIR>/key.pub --expect-id runtime-release release-manifest.signed.json
mkdir verify-copy && cp candidate/* verify-copy/ && cp release-manifest.signed.json verify-copy/release-manifest.json
node spec/tools/release-tool.mjs verify --dir verify-copy --expect-id runtime-release --trust-file docs/release-keys.json
```

Read the canonical bytes first: the id is `runtime-release`, the publisher is exactly `Airplane Mode Labs`, the version is the
package version, there is no `expiresAt`, one entry per artefact. Sign with `--no-expiry` (R5; the tool's default adds an expiry,
look for `expiresAt` in the signed file and sign again if it is there) and never pass `--allow-test-key`. The last command also
re-hashes every artefact and checks `SHA256SUMS`; it must print `{"verdict":"ok",...,"testKey":false}`. `SHA256SUMS` is
authenticated only through the signed manifest. Why not the team: the signature is the owner's vouching, made with the key of
step 2, and no agent handles that key.

### 10. Tag exactly that run's commit and create the GitHub release

```sh
git -C <runtime clone> tag -a v0.3.0-beta.2 <sha> -m "runtime 0.3.0-beta.2"
git -C <runtime clone> push origin v0.3.0-beta.2
mkdir release-assets && cp release-manifest.signed.json release-assets/release-manifest.json
cp candidate/SHA256SUMS candidate/airplanemode-runtime-0.3.0-beta.2.tgz release-assets/
gh release create v0.3.0-beta.2 release-assets/* --repo AirplaneMode-Labs/runtime --verify-tag --prerelease \
  --title "runtime 0.3.0-beta.2" --notes-file <your release notes>
```

The asset must be named `release-manifest.json`: the publish job downloads that name. The publish job refuses a tag that does
not resolve to the commit it runs on, so the tag must point at the run's `headSha`. Why not the team: tags and releases are
public acts of the owner after review; a tag ruleset (step 4) makes them yours alone.

### 11. Create a short-lived npm token as an environment secret

On npmjs.com, Access Tokens, Generate New Token, Granular Access Token: read and write on the scope `@airplanemode` only, expiry
7 days or less, no other permission. Then store it as a secret of the `release` environment only; `gh secret set` reads the
value from its prompt, so it never appears on a command line or in your shell history:

```sh
gh secret set NPM_TOKEN --env release --repo AirplaneMode-Labs/runtime
```

Never a repository secret and never an organisation secret: the workflow reads `NPM_TOKEN` in one step of the publish job
only. Why not the team: creating a credential and a secret is a money-and-identity act, and the team creates none. npm trusted
publishing needs npm 11.5.1 or later and Node 22 ships an older npm (TD-122), so the first publish uses this token; moving to
trusted publishing is decided after it.

### 12. Arm the workflow and approve the deployment

Arm the workflow only now, after the dispatch (step 7), the candidate check (step 8), signing (step 9) and the GitHub release
(step 10), and immediately before you approve the waiting job:

```sh
gh variable set RELEASE_PUBLISH_ARMED --env release --body true --repo AirplaneMode-Labs/runtime
```

Then open the waiting run of step 7 (`gh run view <run-id> --web`) and approve the `release` environment. The publish job
reads the variable only after your approval, in its first step after checkout, so a run that waits unarmed fails closed. It
checks, in order: the arming variable, the key id against `docs/release-keys.json`, your signed manifest from the GitHub release
against that file (no test key is ever accepted), that the manifest carries no `expiresAt` (TD-121: the job refuses a manifest
that carries an `expiresAt`, so sign with `cp-sign sign --no-expiry`, step 9), the manifest version against `package.json` (a
strict SemVer without build metadata), the tag against the run's commit, and that
npm does not already hold the version; then it attests the tarball's provenance and runs one `npm publish` of that exact file with
`--provenance --access public --ignore-scripts` and the dist-tag from the prerelease identifier (`beta` for `0.3.0-beta.2`). Any
failed check stops it before the registry is touched. Why not the team: approving a deployment is the owner's decision.

### 13. Revoke the token and disarm the workflow

```sh
npm token list
npm token revoke <id of the token of step 11>
gh secret delete NPM_TOKEN --env release --repo AirplaneMode-Labs/runtime
gh variable delete RELEASE_PUBLISH_ARMED --env release --repo AirplaneMode-Labs/runtime
```

Why not the team: the token is the owner's credential.

### 14. Publish the write-up

`docs/writeup-0.3.0-beta.2-draft.md` is a draft with every figure traced to a committed file. Finish it with the 8 GB figure of
step 5, remove the draft marker, publish it and link it from the README. Why not the team: publishing and announcing are the
owner's, and the draft cannot be finished until the 8 GB figure exists.
