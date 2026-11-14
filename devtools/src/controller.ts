/**
 * The panel's behaviour, with every browser dependency injected so it can be tested: poll the
 * inspected page only while the panel is shown, with at most one read outstanding, and turn each
 * answer into a model for the view.
 */

import { PAGE_EXPRESSION, MAX_SNAPSHOT_CHARS } from './page-expr';
import { buildPanelModel, buildPanelView, mountView, statusModel, type PanelModel } from './render';

export const POLL_MS = 1000;
/** After this long without an answer the panel says the page is not answering. */
export const WAITING_AFTER_MS = 5000;

export interface ControllerDeps {
  /** chrome.devtools.inspectedWindow.eval: the callback gets (result, exceptionInfo). */
  evalInPage(expr: string, cb: (result: unknown, exceptionInfo: unknown) => void): void;
  render(model: PanelModel): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
}

export interface Controller {
  shown(): void;
  hidden(): void;
  isPolling(): boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export function createController(deps: ControllerDeps): Controller {
  let timer: unknown;
  let polling = false;
  let inFlight = false;
  let startedAt = 0;
  let waitingShown = false;

  const handle = (result: unknown, exc: unknown): void => {
    inFlight = false;
    waitingShown = false;
    if (isObject(exc)) {
      if (exc['isException'] === true) return; // the page threw: nothing to show, polling goes on
      if (exc['isError'] === true) {
        const details = exc['details'];
        const denied = Array.isArray(details) && details[0] === 'Permission denied';
        deps.render(
          statusModel(
            denied ? 'denied' : 'error',
            denied
              ? 'Chrome did not let this extension read this page (permission denied). It cannot read internal pages, the Web Store or other restricted addresses.'
              : 'Chrome could not run the read in this page.',
          ),
        );
        return;
      }
    }
    if (result === null || result === undefined) {
      deps.render(buildPanelModel(null));
      return;
    }
    // the extension rechecks type and size itself, before JSON.parse (the page expression may lie)
    if (typeof result !== 'string' || result.length > MAX_SNAPSHOT_CHARS) {
      deps.render(buildPanelModel(typeof result === 'string' ? result : 0));
      return;
    }
    deps.render(buildPanelModel(result));
  };

  const poll = (): void => {
    if (inFlight) {
      if (!waitingShown && deps.now() - startedAt >= WAITING_AFTER_MS) {
        waitingShown = true;
        deps.render(statusModel('waiting', 'The page has not answered for 5 seconds.'));
      }
      return;
    }
    inFlight = true;
    startedAt = deps.now();
    deps.evalInPage(PAGE_EXPRESSION, handle);
  };

  return {
    shown() {
      if (polling) return;
      polling = true;
      poll();
      timer = deps.setInterval(poll, POLL_MS);
    },
    hidden() {
      if (!polling) return;
      polling = false;
      deps.clearInterval(timer);
      timer = undefined;
    },
    isPolling: () => polling,
  };
}

// ---- the panel page ---------------------------------------------------------------------------------

export interface InstallDeps {
  /** The panel page's window (an object that can carry two functions). */
  window: Record<string, unknown>;
  /** The chrome global, or undefined when the page is opened outside DevTools. */
  chrome: unknown;
  document: Parameters<typeof mountView>[0];
  render(model: PanelModel): void;
}

type ChromeDevtools = {
  devtools?: {
    inspectedWindow?: { eval: (e: string, cb: (r: unknown, x: unknown) => void) => void };
  };
};

/**
 * Wires the panel page. With chrome.devtools it builds the controller (polling is switched by
 * window.__airplanemodePanelVisible, which the DevTools page calls from the panel's onShown and
 * onHidden). Without it (the page opened as a plain tab, as the tests do) it exposes
 * window.__airplanemodePanelRender(json), which renders a snapshot string the caller hands in.
 */
export function installPanel(deps: InstallDeps): Controller | undefined {
  const devtools = (deps.chrome as ChromeDevtools | undefined)?.devtools;
  if (devtools === undefined) {
    deps.window['__airplanemodePanelRender'] = (json: unknown): void =>
      deps.render(buildPanelModel(json));
    return undefined;
  }
  const inspected = devtools.inspectedWindow;
  const controller = createController({
    evalInPage: (expr, cb) => inspected?.eval(expr, cb),
    render: deps.render,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    now: () => Date.now(),
  });
  deps.window['__airplanemodePanelVisible'] = (visible: unknown): void =>
    visible === true ? controller.shown() : controller.hidden();
  return controller;
}

export { buildPanelView, mountView };
