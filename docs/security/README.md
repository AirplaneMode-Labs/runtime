# Security documentation

Written and maintained by the security consultant (lane S1) only; nobody else edits files here.
Sprint 1 review date: 9 November 2026; fix rounds 1 and 2 re-verified the same day (see `FINDINGS.md`, "Fix round 1 re-verification" and "Fix round 2 re-verification"). Sprint 2 review: 9 November 2026 (`FINDINGS.md`, "Sprint 2 review"; `THREAT-MODEL.md` section 7); Sprint 2 fix rounds 1 and 2 re-verified the same day (`FINDINGS.md`, "Sprint 2 fix round 1 re-verification", "Sprint 2 fix round 2 re-verification" and "Sprint 2 final close-out").

| File                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `THREAT-MODEL.md`        | Assets, trust boundaries (browser origin, OPFS/IndexedDB, manifest publisher, asset host, trust-root configuration, control plane), attacker models and a STRIDE table per component; section 7 (Sprint 2) covers engines, descriptors, the verified-file shim, the fallback chain and consent, the Chrome built-in model, model hosting on the shared Pages origin, the Sprint 3 WebLLM staging rules and the prompt-injection row.                                                                                                                                                                                                                                                                                           |
| `FINDINGS.md`            | Register S1-001 to S1-067 (Sprint 1, the demos amendment S1-039 to S1-050, the Sprint 2 review S1-051 to S1-063 and its fix round 1 S1-064 to S1-067, re-verified in fix round 2), the two fix-round verification tables and the Sprint 1 and Sprint 2 close-out tables (Fixed / Open / Deferred / Noted per finding): severity, component, repo, file:line, description, repro, recommendation, owning lane, status and target sprint. Includes the accepted risks the spec points at (no revocation, no transparency log, no Sigstore, single-signature threshold, browser-clock trust, same-origin co-tenant trust, IndexedDB on the 8 GB laptop, TS/Rust number asymmetry, the two-tab race and its Web Locks mitigation). |
| `PRE-PILOT-CHECKLIST.md` | What must be true before a customer laptop runs a build: real key and custody, TLS, hosting headers, audit retention, DPDP statement, dependency review, offline verification procedure, incident contact, disk encryption; since Sprint 2 also the pilot model licence bundle, COOP/COEP, model hosting limits, the 8 GB memory peak, Trusted Types and the Chrome built-in model policy (rows 17 to 22).                                                                                                                                                                                                                                                                                                                     |

Related: `../../SECURITY.md` (disclosure policy), `../../spec/README.md` (signing scheme,
verification order, trust roots, downgrade rule), `../../README.md` Security and privacy.

Review evidence (commands and raw outputs) is not part of the published package. It lives in the
workspace that holds the seven repositories: Sprint 1 under `evidence/sprint-1/S1/` (round 1),
`evidence/sprint-1/S1/round2/` (fix round 1), `evidence/sprint-1/S1/round3/` (fix round 2) and
`evidence/sprint-1-demos/S1/` (demos amendment); Sprint 2 under `evidence/sprint-2/S1/` (fix round 1
under `evidence/sprint-2/S1/r1/`, fix round 2 under `evidence/sprint-2/S1/r2/`), copied there by the architect at wrap-up.

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

**Tagging pagetriage v1.0.0: NO-GO today.** `docs/release.md` rows 1 (CI on Windows has never run),
2 (8 GB laptop benchmark), 4 (signed artefacts and manifest with a real key), 5 (publication), 6 and
7 (write-up) are Open; only row 3 is Done. A 1.0.0 tag would assert a definition of done the evidence
does not support. Honest alternatives: close rows 1, 2, 4, 6 and 7 after the push and tag 1.0.0 then,
or tag 0.9.0 as an explicit pre-release now. Version stays 0.1.0 and the 1.0.0 notes stay under
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

**Tags and releases: none this sprint**, as planned; pagetriage v1.0.0 stays NO-GO for the Sprint 1
reasons (`docs/release.md` rows still open).

**Pilot on a customer laptop: not before `PRE-PILOT-CHECKLIST.md` rows 1 to 22 are Done or
explicitly accepted**, in particular the real signing key and custody, the hosting headers, the
pilot model licence bundle (row 17), the 8 GB memory measurement of the chosen model (row 20) and a
written policy on the Chrome built-in model (row 22).

### Sprint 2 final verdict (9 November 2026)

| Decision                                         | Verdict            | Conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Make the six public repos and their demos public | GO-WITH-CONDITIONS | (1) Before the push, the architect copies the S1, D1, D3 and T1 evidence into `evidence/sprint-2/` so every citation here and in the READMEs resolves. (2) After the first push, the owner checks that Pages deploys the 182 MB test model and answers Range requests with 206 (checklist row 19); a failure fails closed. (3) The owner lets the Windows CI legs and the `model-wasm (ubuntu-latest)` job run once and reads them before announcing the demos; they are configured, not yet executed. |
| control-plane                                    | Stays private      | FSL-1.1-Apache-2.0, no server and no production key yet (checklist rows 1 and 2).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tag pagetriage v1.0.0                            | NO-GO              | `docs/release.md` rows 1, 2, 4, 5, 6 and 7 are open and the Windows determinism leg has never run. Close those rows after the push, then tag; or tag a 0.9.0 pre-release. No tag was cut this sprint.                                                                                                                                                                                                                                                                                                  |
| Pilot on a customer laptop                       | NO-GO              | Not before `PRE-PILOT-CHECKLIST.md` rows 1 to 22 are Done or explicitly accepted.                                                                                                                                                                                                                                                                                                                                                                                                                      |

Open and not blocking publication: S1-055 (Low, Sprint 3), S1-053 (Mitigated, Sprint 3), S1-066
(Info, next spec touch). No open finding is reachable through a hosted demo.
