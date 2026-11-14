/**
 * The DevTools page (devtools.html): it only creates the 'Airplane Mode' panel. It never polls and
 * never reads the inspected page. The panel's shown and hidden events are handed to the panel page,
 * which decides when to read.
 */

interface ExtensionPanelLike {
  onShown: { addListener(l: (w?: unknown) => void): void };
  onHidden: { addListener(l: () => void): void };
}

export interface ChromeForDevtoolsPage {
  devtools: {
    panels: {
      create(
        title: string,
        iconPath: string,
        pagePath: string,
        callback: (panel: ExtensionPanelLike) => void,
      ): void;
    };
  };
}

type VisibleHook = { __airplanemodePanelVisible?: (visible: boolean) => void };

export function registerPanel(chromeApi: ChromeForDevtoolsPage): void {
  chromeApi.devtools.panels.create('Airplane Mode', '', 'panel.html', (panel) => {
    let panelWindow: VisibleHook | undefined;
    panel.onShown.addListener((w) => {
      panelWindow = w !== null && typeof w === 'object' ? (w as VisibleHook) : undefined;
      panelWindow?.__airplanemodePanelVisible?.(true);
    });
    panel.onHidden.addListener(() => {
      panelWindow?.__airplanemodePanelVisible?.(false);
    });
  });
}

const api = (globalThis as { chrome?: Partial<ChromeForDevtoolsPage> }).chrome;
if (api?.devtools?.panels) registerPanel(api as ChromeForDevtoolsPage);
