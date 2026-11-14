# Security documentation

Written and maintained by the security consultant (lane S1) only; nobody else edits files here.
Sprint 1 review date: 9 November 2026; fix rounds 1 and 2 re-verified the same day (see `FINDINGS.md`, "Fix round 1 re-verification" and "Fix round 2 re-verification"). Sprint 2 review: 9 November 2026 (`FINDINGS.md`, "Sprint 2 review"; `THREAT-MODEL.md` section 7); Sprint 2 fix rounds 1 and 2 re-verified the same day (`FINDINGS.md`, "Sprint 2 fix round 1 re-verification", "Sprint 2 fix round 2 re-verification" and "Sprint 2 final close-out"). Sprint 3 review: 14 November 2026 (`FINDINGS.md`, "Sprint 3 review"; `THREAT-MODEL.md` section 8; checklist rows 21 to 25); Sprint 3 fix round 1 re-verified the same day (`FINDINGS.md`, "Sprint 3 fix round 1 re-verification" and "Sprint 3 final close-out").

| File                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THREAT-MODEL.md`        | Assets, trust boundaries (browser origin, OPFS/IndexedDB, manifest publisher, asset host, trust-root configuration, control plane), attacker models and a STRIDE table per component; section 7 (Sprint 2) covers engines, descriptors, the verified-file shim, the fallback chain and consent, the Chrome built-in model, model hosting on the shared Pages origin, the Sprint 3 WebLLM staging rules and the prompt-injection row; section 8 (Sprint 3) covers the engine worker and its egress guard, the worker message boundary, the Trusted Types bootstrap, the DevTools hook and extension, packaging and the WebLLM staging design.                                                                                                                                                              |
| `FINDINGS.md`            | Register S1-001 to S1-080 (Sprint 1, the demos amendment S1-039 to S1-050, the Sprint 2 review S1-051 to S1-063 and its fix round 1 S1-064 to S1-067, re-verified in fix round 2, the Sprint 3 review S1-068 to S1-077 and its fix round 1 S1-078 to S1-080), the two fix-round verification tables and the Sprint 1 and Sprint 2 close-out tables (Fixed / Open / Deferred / Noted per finding): severity, component, repo, file:line, description, repro, recommendation, owning lane, status and target sprint. Includes the accepted risks the spec points at (no revocation, no transparency log, no Sigstore, single-signature threshold, browser-clock trust, same-origin co-tenant trust, IndexedDB on the 8 GB laptop, TS/Rust number asymmetry, the two-tab race and its Web Locks mitigation). |
| `PRE-PILOT-CHECKLIST.md` | What must be true before a customer laptop runs a build: real key and custody, TLS, hosting headers, audit retention, DPDP statement, dependency review, offline verification procedure, incident contact, disk encryption; since Sprint 2 also the pilot model licence bundle, COOP/COEP, model hosting limits, the 8 GB memory peak, Trusted Types and the Chrome built-in model policy (rows 17 to 22); since Sprint 3 also the CSP response header for the engine worker, WebLLM staging on a dedicated origin and the DevTools extension policy (rows 23 to 25).                                                                                                                                                                                                                                     |

Related: `../../SECURITY.md` (disclosure policy), `../../spec/README.md` (signing scheme,
verification order, trust roots, downgrade rule), `../../README.md` Security and privacy.

Review evidence (commands and raw outputs) is not part of the published package. It lives in the
workspace that holds the seven repositories: Sprint 1 under `evidence/sprint-1/S1/` (round 1),
`evidence/sprint-1/S1/round2/` (fix round 1), `evidence/sprint-1/S1/round3/` (fix round 2) and
`evidence/sprint-1-demos/S1/` (demos amendment); Sprint 2 under `evidence/sprint-2/S1/` (fix round 1
under `evidence/sprint-2/S1/r1/`, fix round 2 under `evidence/sprint-2/S1/r2/`); Sprint 3 under `evidence/sprint-3/S1/`;
all copied there by the architect at wrap-up.

## Sprint 1 security verdict (9 November 2026)

**Publishing the six public repos (pagetriage, glyphsift, localdata, runtime, dockit, site): GO-WITH-CONDITIONS.**
Conditions, all owner actions at or right after the first push: (1) the architect's wrap-up commits
land exactly as planned (explicit paths, tests before implementation, author Tushar
<jtushar53@gmail.com>, no tag, nothing staged in the parent repository), and T3 re-runs the git
checks it reported as blocked; (2) the first push is followed by a read of the Windows CI leg and the
CodeQL and Scorecard runs, and any red leg is fixed before the repos are announced; (3) the
`@airplanemode` npm scope and the crate names are reserved before any README is shared publicly, so
the placeholder handles cannot be squatted (checklist row 8); (4) `control-plane` stays private;
(5) the three documentation-only bugs (T1R2-01/T3-12, T1R2-02/T3-13, BUG-T2-5) are folded into the
wrap-up or the first Sprint 2 commit. Nothing published this sprint contains a secret, a real
document, a telemetry sink or a network egress other than the manifest and asset URLs the caller
passes in; the only key material is the public RFC 8032 vector, refused by default on both sides.

**Tagging pagetriage v1.0.0: NO-GO today.** `docs/release.md` rows 2 (8 GB laptop benchmark),
4 (signed artefacts and manifest with a real key), 5 (CHANGELOG and tag), 6 (installable from a clean
machine) and 7 (write-up) are Open. (Corrected 14 November 2026: the Sprint 1 text also cited row 1
because the Windows leg had never run; it has run green since 9 November 2026, CI run 42634433346 on
`e109ae7`, all nine jobs including `determinism + bench tests (windows-latest)` and
`fmt, clippy, test (windows-latest)` successful, `evidence/sprint-3/S1/pagetriage-ci-42634433346.json`.)
A 1.0.0 tag would assert a definition of done the evidence does not support. Honest alternatives:
close rows 2, 4, 5, 6 and 7 and tag 1.0.0 then, or tag 0.9.0 as an explicit pre-release now. Version stays 0.1.0 and the 1.0.0 notes stay under
`[Unreleased]`; no tag has been handed to the owner in this run.

**Pilot on a customer laptop: not before `PRE-PILOT-CHECKLIST.md` rows 1 to 13 are Done**, in
particular a real signing key with custody, TLS and the hosting headers, full-disk encryption on the
laptop, and the 8 GB Windows measurement of IndexedDB quota behaviour (S1-007, S1-035 residual).

## Sprint 2 security verdict (9 November 2026)

**Publishing the refreshed demos (pagetriage, glyphsift, localdata, runtime, dockit, site): GO-WITH-CONDITIONS.**
What was reviewed: the new runtime backend page `models.html` (strict meta CSP with
`connect-src 'self'`, `'wasm-unsafe-eval'`, no `blob:`; nothing fetched before the download click;
only same-origin `models/*` and `app/ort/*` afterwards; the bundled test model signed per build and
hashed in full before and again at hand-off; the Chrome built-in model off unless ticked, and its
availability not even queried while off), `index.html` with its Sprint 1 CSP unchanged, the
glyphsift validator demo (1 MiB input cap before the module, `textContent` only), the dockit plan
card (no request, no `availability()` call) and the CI and installer supply chain (every pinned
binary re-hashed from a fresh download). Conditions: (1) the architect copies the Sprint 2 evidence
folders to `evidence/sprint-2/` at wrap-up, so the citations in this directory and the READMEs
resolve; (2) D6 re-vendors `neg-bad-alg-token.json` and turns its negative test green (S1-057;
`cp-sign` already rejects it with the `schema` reason); (3) the fix-round Lows S1-051, S1-052 and
S1-056 land, or are carried with their owners, before the demos are announced (none of them is
reachable through a hosted demo today: glyphsift's demo caps input at 1 MiB, the build id is
rendered as text, and the install-script note concerns integrators); (4) after the first push the
owner checks that the 182 MB model file deploys and answers Range requests on Pages (checklist row
19); a failure there makes the download fail closed, it cannot serve unverified bytes. T1's
`/<repo>/` network checks remain the gate for each demo's "What this demo does not do yet" box.

**Sprint 2 fix round 1 re-verification (9 November 2026): verdict unchanged, GO-WITH-CONDITIONS, with
fewer conditions.** Condition (2) is met: S1-057 is Fixed, because the vector is vendored, the
negative test is green and `cp-sign` rejects the vector with `schema`. Condition (3) is met: S1-051,
S1-052 and S1-056 are Fixed and re-tested by S1. S1-054 and S1-058 are also Fixed, and S1-053 is
Mitigated. Conditions (1) evidence copy and (4) Pages Range check still stand. The new items do not
block publishing. S1-064 (Chrome install via apt in localdata and dockit CI) and S1-065 to S1-067
touch CI, an installer comment, an event name and README wording, and none of them is reachable from
a hosted demo. The fix round left the runtime demo's egress unchanged: `models.html` CSP is exact,
`index.html` CSP is byte-identical to Sprint 1, the click path keeps `allowTestKeys: false`, and the
built `dist` has 0 unattributed URL strings. The new WebGPU device probe makes no request.

**Sprint 2 fix round 2 re-verification (9 November 2026): verdict unchanged, GO-WITH-CONDITIONS
for publishing the six refreshed demos once the owner pushes.** S1-064 (localdata and dockit CI),
S1-065 (glyphsift installer drift) and S1-067 (README install-script wording) are Fixed and
re-tested by S1, and the full check list found no regression: the `models.html` CSP is exact, the
`index.html` CSP is byte-identical to Sprint 1, the click path keeps `allowTestKeys: false`, the
built `dist` has 0 unattributed URL strings, every CI binary re-hashes to its pin from a fresh
download, and every workflow keeps SHA pins and `persist-credentials: false`
(`evidence/sprint-2/S1/r2/`). The remaining conditions are (1) the architect copies the S1, D1 and
T1 evidence into `evidence/sprint-2/` so every cited path exists, and (4) the owner checks after the
first push that the 182 MB model file deploys and answers Range requests on Pages (checklist row
19). Still open and not blocking a demo: S1-055 (onnxruntime-web nightly, Sprint 3), S1-053
(Mitigated, Sprint 3) and S1-066 (Info, next spec touch).

**Tags and releases: none this sprint**, as planned; pagetriage v1.0.0 stays NO-GO because
`docs/release.md` rows 2, 4, 5, 6 and 7 are still open (the Windows leg is green since 9 November 2026
and is no longer a reason).

**Pilot on a customer laptop: not before `PRE-PILOT-CHECKLIST.md` rows 1 to 22 are Done or
explicitly accepted**, in particular the real signing key and custody, the hosting headers, the
pilot model licence bundle (row 17), the 8 GB memory measurement of the chosen model (row 20) and a
written policy on the Chrome built-in model (row 22).

### Sprint 2 final verdict (9 November 2026)

| Decision                                         | Verdict            | Conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make the six public repos and their demos public | GO-WITH-CONDITIONS | (1) Before the push, the architect copies the S1, D1, D3 and T1 evidence into `evidence/sprint-2/` so every citation here and in the READMEs resolves. (2) After the first push, the owner checks that Pages deploys the 182 MB test model and answers Range requests with 206 (checklist row 19); a failure fails closed. (3) The owner lets the Windows CI legs and the `model-wasm (ubuntu-latest)` job run once and reads them before announcing the demos; they are configured, not yet executed.                                                         |
| control-plane                                    | Stays private      | FSL-1.1-Apache-2.0, no server and no production key yet (checklist rows 1 and 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tag pagetriage v1.0.0                            | NO-GO              | `docs/release.md` rows 2, 4, 5, 6 and 7 are Open. The Windows leg is green since 9 November 2026 (CI run 42634433346) and is no longer a reason. Also before the tag and before any wheel publish: S1-082 (the wheel carries a `NOTICE` with the BSD-3-Clause and Unicode-3.0 texts of the crates it links, the demo `NOTICE.txt` names its MIT-only crates) and the owner's S1-085 decision on the params comment and the pushed history. The tag commit itself must still get one green CI read on all three OSes after the owner's push, as for any commit. |
| Pilot on a customer laptop                       | NO-GO              | Not before `PRE-PILOT-CHECKLIST.md` rows 1 to 22 are Done or explicitly accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Open and not blocking publication: S1-055 (Low, Sprint 3), S1-053 (Mitigated, Sprint 3), S1-066
(Info, next spec touch). No open finding is reachable through a hosted demo.

## Sprint 3 security verdict (14 November 2026)

What was reviewed: spec 0.3.0 (draft) with the manifest contract byte-identical; `cacheOnly` and the
integrity reason; descriptor 0.2.0 and its 17 shared vectors in TypeScript and Rust; the engine moved
into a dedicated module worker per load with an egress guard, strict message validation and a Trusted
Types bootstrap; the zero-permission DevTools extension and the opt-in hook; onnxruntime-web 1.31.1;
Trusted Types on `models.html` and dockit; the npm tarballs and wheels and their offline install proofs;
the release-manifest tools; every `pages.yml` and Actions pin. WebLLM did not land and is not reviewed
beyond its design (S1-071). Findings: 0 Critical, 0 High, 0 Medium; S1-053, S1-055 and S1-066 Fixed;
new S1-068 to S1-077 (6 Low, 4 Info), none reachable from a hosted demo as an egress or integrity break.

After fix round 1 (same day): S1-072 (own locked `fetch` on the worker scope) and S1-073 (unreadable
Blobs map to `integrity`) are Fixed, re-tested by S1 in Chrome 157 (`npm run ci` 955 tests, `test:worker`
8 of 8, a fresh in-worker probe). New: S1-078 (localdata README still says there are no storage events and
lacks the namespace note), S1-079 (glyphsift CI installs tools without hash pins) and S1-080 (a throwaway
dry-run signing key in scratch must not be copied into the evidence folder), all Info. Open after the
round: S1-071, S1-074 (Low); S1-075, S1-078, S1-079, S1-080 (Info).

After fix round 2 (same day): S1-078 is Fixed (the localdata README Status, Limitations and Security
and privacy sections describe the opt-in `storage.*` events and carry the Event 0.1.2 namespace note;
the re-packed tarball carries the same README) and S1-080 is Fixed (D1's dry-run key and signed
manifest are deleted; only the log remains). The stale `egress-guard.ts` comment is corrected with no
code change: the built `dist/` is byte-identical between the round 1 and round 2 tarballs. S1 re-ran
`npm run ci` (955 tests), `test:worker` (8 of 8), the DevTools renderer test, a byte-identical re-pack
and an offline install. New: S1-081 (Info): other lanes' scratch, and `evidence/sprint-1/` already,
hold throwaway cp-sign secret keys that the parent repository does not ignore. Open after round 2:
S1-071, S1-074 (Low); S1-075, S1-079, S1-081 (Info). Verdicts below are unchanged except the
architect's wrap-up conditions.

Close-out after the tester round 2 results (same day; final): T1 repeated the DevTools-window proof,
the egress probes, Trusted Types and the privacy sentinels independently, and T2 and T3 confirmed the
manifest contract byte-identical and the release artefacts byte-reproducible, so no control regressed.
New: S1-082 (Low: the pagetriage wheel ships no `NOTICE` for the BSD-3-Clause and Unicode-3.0 crates it
links, and the pagetriage demo `NOTICE.txt` omits its MIT-only crates), S1-083 (Low: the runtime demo's
`THIRD-PARTY-NOTICES.txt` quotes the digests of the replaced ORT pin, not the 1.31.1 files that
`ort-pins.ts` enforces), S1-084 (Info: the scratch path in two public test files) and S1-085 (Info:
clean-room wording in a pagetriage params comment and attribution trailers in already-pushed history;
owner decision). S1-081 stays Open: D3's dry-run key is still in scratch and `evidence/sprint-1/` holds
11 `*.secret` files. Open at Sprint 3 close: S1-071, S1-074, S1-082, S1-083 (Low); S1-075, S1-079,
S1-081, S1-084, S1-085 (Info). The table below is the final Sprint 3 verdict.

| Decision                                                             | Verdict                                                                                   | Conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh and publish the six demos (Sprint 3 state)                   | GO-WITH-CONDITIONS                                                                        | (1) The architect copies the S1, D1, D2, D3, D4, D5 and T1 Sprint 3 evidence into `evidence/sprint-3/` so every cited path resolves (it does not exist at close-out). (2) Every WebLLM sentence keeps reading "not yet" (LANDED.json `webllm: not landed`); dockit and site wording follows LANDED.json (worker, Trusted Types and the ORT override are green). (3) T1's `/<repo>/` checks remain the gate for each not-yet box. (4) S1-083: the runtime demo's `THIRD-PARTY-NOTICES.txt` quotes the `ort-pins.ts` digests for onnxruntime-web 1.31.1 (or drops the digest lines) before the push. (5) After the push, the owner reads CI on Linux, macOS and Windows and the Pages deploy of the runtime demo (checklist row 19). Recommended, not blocking: S1-082's MIT copyright lines in the pagetriage demo `NOTICE.txt`. |
| runtime 0.2.0-alpha.0 (alpha, local tarball only; no tag)            | GO-WITH-CONDITIONS                                                                        | As an untagged alpha proven from a local tarball: yes. Before the owner publishes it: reserve `@airplanemode` (row 8), publish with npm provenance or trusted publishing (row 15), S1-072 and S1-073 are Fixed (fix round 1), so nothing in the alpha's `./worker` waits on S1. S1-074 may follow at the next spec touch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DevTools panel v0 (unpacked extension, developer use)                | GO                                                                                        | Zero permissions and `connect-src 'none'` stay as they are; no Web Store listing; not for pilot machines without a policy (row 25).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tag glyphsift v0.1.0                                                 | NO-GO                                                                                     | Expected: `glyphsift/docs/release.md` rows for the 8 GB benchmark, signed artifacts and manifest (real key), the tag itself, the registry publish from a clean machine and the write-up are Open, and the CI row reads "pending the owner's push". Tag after the owner closes those rows; the release candidate is otherwise clean (no lifecycle scripts, licences in the wheel, no builder path, offline install proven). The wheel no longer embeds an SBOM (it held the builder's path); a path-free SBOM is part of checklist row 15 before publishing. Before the registry publish: BUG-T2-S3-19 (`scripts/package-npm.sh` fails on macOS with its default scratch) is fixed so the documented owner step runs as written, and S1-079 hash pins are in place if CI builds the published wheel.                             |
| Tag pagetriage v1.0.0                                                | NO-GO                                                                                     | `docs/release.md` rows 2, 4, 5, 6 and 7 are Open. The Windows leg is green since 9 November 2026 (CI run 42634433346) and is no longer a reason. Also before the tag and before any wheel publish: S1-082 (the wheel carries a `NOTICE` with the BSD-3-Clause and Unicode-3.0 texts of the crates it links, the demo `NOTICE.txt` names its MIT-only crates) and the owner's S1-085 decision on the params comment and the pushed history. The tag commit itself must still get one green CI read on all three OSes after the owner's push, as for any commit.                                                                                                                                                                                                                                                                  |
| Architect's wrap-up                                                  | GO-WITH-CONDITIONS                                                                        | S1-081: D3 deletes `D3/dry-run/keys/` and `D3/dry-run/manifest.signed.json`; copy the scratch evidence of every lane with all `keys/` directories, `*.secret` files and dry-run `*signed.json` excluded; delete the 11 `*.secret` files already under `evidence/sprint-1/` (nine keys, two malformed fixtures); `find evidence -name '*.secret'` prints nothing before anything in the parent repository is staged. Commit localdata from the final re-pack state (tarball sha256 `3a16038e...136b`); hash and copy only the artefacts in each `FINAL-ARTIFACTS.txt`; from `D1/release-dry` copy only `release-dry-run.log`; nothing staged in the parent repository; no tag, no push.                                                                                                                                          |
| Publish to npm, PyPI or crates.io (owner, after reserving the names) | GO-WITH-CONDITIONS for runtime 0.2.0-alpha.0; NO-GO for the pagetriage wheel until S1-082 | Reserve `@airplanemode`, `glyphsift` and `pagetriage` first (checklist row 8); publish only the artefacts whose sha256 is in `FINAL-ARTIFACTS.txt` and in an owner-signed release manifest (real key, checklist row 1); use npm provenance or trusted publishing (row 15); install with `--ignore-scripts`. glyphsift follows its tag (row above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| control-plane                                                        | Stays private                                                                             | FSL-1.1-Apache-2.0; `cp-sign check-descriptor` is authoring tooling only; S1-075 aligns one rejection reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| WebLLM rung (when it lands)                                          | Not reviewed                                                                              | S1-071 must be closed or accepted first (re-verify in the worker or dedicated origin; checklist row 24), plus the supply-chain checks in the Sprint 3 charter (tarball contents, lock sweep, model library pinned to an upstream-reachable commit, signed manifest with every file).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pilot on a customer laptop                                           | NO-GO                                                                                     | Not before `PRE-PILOT-CHECKLIST.md` rows 1 to 25 are Done or explicitly accepted (row 21 is Done as of this sprint).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
