# Security documentation

Written and maintained by the security consultant (lane S1) only; nobody else edits files here.
Sprint 1 review date: 9 November 2026; fix rounds 1 and 2 re-verified the same day (see `FINDINGS.md`, "Fix round 1 re-verification" and "Fix round 2 re-verification").

| File                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THREAT-MODEL.md`        | Assets, trust boundaries (browser origin, OPFS/IndexedDB, manifest publisher, asset host, trust-root configuration, control plane), attacker models and a STRIDE table per component.                                                                                                                                                                                                                                                                                                                                                                    |
| `FINDINGS.md`            | Register S1-001 to S1-038, the two fix-round verification tables and the Sprint 1 close-out table (Fixed / Open / Deferred / Noted per finding): severity, component, repo, file:line, description, repro, recommendation, owning lane, status and target sprint. Includes the accepted risks the spec points at (no revocation, no transparency log, no Sigstore, single-signature threshold, browser-clock trust, same-origin co-tenant trust, IndexedDB on the 8 GB laptop, TS/Rust number asymmetry, the two-tab race and its Web Locks mitigation). |
| `PRE-PILOT-CHECKLIST.md` | What must be true before a customer laptop runs a build: real key and custody, TLS, hosting headers, audit retention, DPDP statement, dependency review, offline verification procedure, incident contact, disk encryption.                                                                                                                                                                                                                                                                                                                              |

Related: `../../SECURITY.md` (disclosure policy), `../../spec/README.md` (signing scheme,
verification order, trust roots, downgrade rule), `../../README.md` Security and privacy.

Review evidence for Sprint 1 (commands and raw outputs) lives outside the repo under
`/private/tmp/airplanemode-team/S1/` (round 1), `/private/tmp/airplanemode-team/S1/round2/` (fix round 1) and
`/private/tmp/airplanemode-team/S1/round3/` (fix round 2) and is not part of the published package.

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
