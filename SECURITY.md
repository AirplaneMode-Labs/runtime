# Security policy

## Supported versions

| Version | Supported                                             |
| ------- | ----------------------------------------------------- |
| none    | Nothing has been released yet (0.3.0-beta.2, no tag). |

## Reporting a vulnerability

Email **jtushar53@gmail.com** with a description, reproduction steps and the commit you tested.
You will get an acknowledgement within 7 days. We follow a **90-day coordinated disclosure window**:
we aim to fix and publish within 90 days of the report and ask reporters to hold details until a fix
is available or the window ends, whichever comes first. Credit is given unless you prefer otherwise.

Report vulnerabilities privately, by email as above, and never in a public issue, a pull request or a discussion. The issue forms
link here for that reason. (GitHub private vulnerability reporting is an owner setting that is not enabled yet; until it is, email.)

## Test key material

The Ed25519 key material that appears in this repository (`spec/examples/TEST-KEY.md`, the signed
example, `spec/vectors/*.sig.txt` and the test files) is the **RFC 8032 section 7.1 test vector**,
public data that anyone can reproduce. It is not a secret and must never be trusted outside tests;
`verifyManifest` refuses a trust set containing it unless `allowTestKeys` is set.

## Release path

A release manifest is signed offline by the owner with a key that this repository never holds; the verifier refuses the published RFC
8032 test keys for a release id, and the publish workflow runs only by hand, on `main`, after the owner approves it
(`docs/RELEASING.md`, `spec/MANIFEST.md` section "Release manifests"). A finding in that path is a vulnerability: report it as above.

## Telemetry

This library collects no telemetry and makes no network requests other than the asset and manifest
URLs the application passes it, so there is nothing to opt out of.

## Threat model and findings

`docs/security/` (written by the security consultant) holds the threat model, the findings log with
accepted risks and target sprints, and the pre-pilot checklist.
