# Airplane Mode DevTools panel (v0)

A real Chrome DevTools extension (Manifest V3) that adds an **Airplane Mode** tab to DevTools. For a
page that opts in, it shows the model-load timing (acquire, verify, hand-off, session, first token),
the memory figures Chrome exposes, and the last 50 runtime events. It is part of the runtime alpha; it
is **not** in the npm tarball and **not** on the Chrome Web Store.

## Install (from a clone)

1. `npm run devtools:build` (writes `devtools/dist`).
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Choose **Load unpacked** and pick `runtime/devtools/dist`.
4. Open DevTools on a page that calls `exposeDevtoolsHook(bus)` (the runtime demo `models.html` does)
   and choose the **Airplane Mode** tab. After a model load and one answer, the Loads table shows five
   phase durations under one load id and the Memory table shows the figures, each labelled with the API
   Chrome read them from.

If the tab says the page has no runtime events, the page did not call `exposeDevtoolsHook()`.

## What it reads, and how

The page opts in once:

```ts
import { EventBus, exposeDevtoolsHook } from '@airplanemode/runtime';
const bus = new EventBus();
const dispose = exposeDevtoolsHook(bus); // defines globalThis.__airplanemodeDevtools; nothing else does
```

The panel polls only while it is shown, every 1000 ms, with at most one read outstanding, by
evaluating one constant expression in the inspected page (`devtools/src/page-expr.ts`). The expression
reads the hook through property descriptors, so a getter the page defined is never invoked, and it
returns the string `snapshot()` produced if that is at most 2 MiB. The extension rechecks the type and
size, parses the JSON itself, validates every event against `event.schema.json` 0.1.2 and drops (and
counts) the invalid ones, and writes everything with `textContent`. The extension declares no
permissions, host permissions, content scripts, background page, web-accessible resources or external
connections, and its CSP is `default-src 'none'` with `connect-src 'none'`: it makes no network request.

The snapshot (`airplanemode.devtools/0.1`) carries at most 1000 events and at most 2 MiB. Events carry
the model entry id (attr `model`) and the storage namespace (attr `ns`): do not put personal data in
either. No prompt, output or document text is ever in an event.

## Limitations

- Memory figures are Chrome's non-standard `performance.memory`: coarse, quantised, Chrome-only and
  absent in workers, so worker figures may all be null. A dash means the browser did not expose it.
- The panel installs by Load unpacked from a clone only. Chrome shows a warning for unpacked
  extensions.
- Chrome refuses to let an extension read internal pages and the Web Store ("permission denied"); the
  panel says so.
- A page whose `snapshot()` never returns blocks that page's JavaScript; the panel shows "the page has
  not answered" after 5 seconds and does not start a second read.
- Tested on Chrome 157 on macOS (Apple silicon) only.
