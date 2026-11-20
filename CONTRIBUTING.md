# Contributing

Thank you for considering a contribution to `@airplanemode/runtime`.

## Ground rules

- **Tests first.** Write or extend the Vitest (or Playwright) test that fails, then the code that
  makes it pass. Pull requests whose history shows implementation before tests are asked to reorder.
- **Zero runtime dependencies.** Dev-only dependencies are pinned exactly (`save-exact=true`). Any
  new dependency needs a one-line justification in `CHANGELOG.md`.
- **No network egress.** Library code never calls `fetch`, `XMLHttpRequest`, `WebSocket`,
  `sendBeacon` or `importScripts` outside `src/asset-manager.ts`; `test/no-egress.test.ts` enforces
  it. No telemetry, ever.
- **Contracts are owned by the architect.** Changes under `spec/` need a `spec/CHANGELOG.md` entry
  and a version bump; consumers vendor from here and never edit their copies.
- **British spelling, no emojis** in docs and messages.
- **The README quick start is a test.** The blocks under "Try it in two minutes" are extracted and run by
  `test/quickstart.test.ts` against a tarball built from a copy of the checkout; if you change a command or its output
  there, the test tells you. No quick start downloads a model, uses a test key or weakens a control.
- **The release path is rehearsed, never run.** `npm run release:rehearse` builds the artefacts and rehearses signing with a
  published test key; only the owner ever tags, signs a real release or runs `publish.yml` (`docs/RELEASING.md`).
- Contributions are accepted under the repository licence (Apache-2.0).

## Workflow

```sh
npm ci
npm run ci            # fmt:check, typecheck, vitest, build
npm run test:browser  # Playwright on the installed Chrome (channel "chrome"), no download
```

Commit subjects are imperative and at most 72 characters. Do not create tags; the maintainer tags
after review.

Use the issue forms in `.github/ISSUE_TEMPLATE/` and never attach a real, confidential or personal document to an issue or a
pull request (bank, legal, medical, identity): every sample is synthetic or public.

## Reporting security issues

See `SECURITY.md`.
