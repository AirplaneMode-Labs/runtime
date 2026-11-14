/**
 * The panel page (panel.html). With chrome.devtools it polls the inspected page, only while the panel
 * is shown, through the constant page expression; opened as a plain tab it exposes
 * window.__airplanemodePanelRender(json) for the tests. Everything shown is written as text.
 */

import { buildPanelView, installPanel, mountView } from './controller';
import type { PanelModel } from './render';

const root = document.getElementById('root');
if (!root) throw new Error('panel.html has no #root');

const render = (model: PanelModel): void => {
  mountView(document, root, buildPanelView(model));
};

const controller = installPanel({
  window: window as unknown as Record<string, unknown>,
  chrome: (globalThis as { chrome?: unknown }).chrome,
  document,
  render,
});
// The panel page loads when the panel is first shown; later changes arrive through
// __airplanemodePanelVisible from the DevTools page.
controller?.shown();
