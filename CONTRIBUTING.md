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
- Contributions are accepted under the repository licence (Apache-2.0).

## Workflow

```sh
npm ci
npm run ci            # fmt:check, typecheck, vitest, build
npm run test:browser  # Playwright on the installed Chrome (channel "chrome"), no download
```

Commit subjects are imperative and at most 72 characters. Do not create tags; the maintainer tags
after review.

## Reporting security issues

See `SECURITY.md`.
