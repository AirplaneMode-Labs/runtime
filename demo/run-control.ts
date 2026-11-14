// The Stop control of the backend demo (models.html), as a small state machine around one generate()
// call. It owns the AbortController: Stop is enabled only while generate() runs, pressing it fires the
// abort, and the read-out says 'Stopped' with the time from the press to the moment generate() settled.
// The DOM stays in backend-panel.ts: this module only talks to the RunControlUi it is given, so the
// button states and the timing are tested without a browser (test/run-control.test.ts) and with a real
// model in Chrome (test/browser/stop.spec.ts).
//
// Abort is the library's existing one (backend-adapter.md R8): on the worker host the adapter asks the
// engine to stop, waits up to 250 ms for the answer, and terminates the worker if there is none, so the
// time to stop is a few tens of milliseconds, never more than about a quarter of a second plus the
// message round trip.

export interface RunControlUi {
  setRunEnabled(on: boolean): void;
  setStopEnabled(on: boolean): void;
  setAnswer(text: string): void;
  appendAnswer(text: string): void;
  setTiming(text: string): void;
  /**
   * Called once when a run ended because Stop was pressed, after the buttons are restored. The Stop may
   * have terminated the worker (the 250 ms backstop), so the page uses this to offer the reload from the
   * stored files (T1-S4-02).
   */
  onStopped?(): void;
}

export interface RunOutcome {
  stopped: boolean;
  timeToStopMs?: number;
}

export interface RunControl {
  readonly running: boolean;
  run<T extends { finishReason: string }>(
    generate: (signal: AbortSignal) => Promise<T>,
    onError?: (e: unknown) => void,
    onResult?: (result: T) => void,
  ): Promise<RunOutcome>;
  /** Fires the abort of the generation in flight; does nothing when none runs or Stop was pressed already. */
  stop(): void;
}

const isAbort = (e: unknown): boolean =>
  e !== null &&
  typeof e === 'object' &&
  ((e as { name?: unknown }).name === 'AbortError' || (e as { code?: unknown }).code === 'aborted');

export function createRunControl(
  ui: RunControlUi,
  clock: () => number = () => performance.now(),
): RunControl {
  let controller: AbortController | undefined;
  let stopPressedAt: number | undefined;
  let stopEnabled = false;
  const setStop = (on: boolean): void => {
    if (stopEnabled === on) return;
    stopEnabled = on;
    ui.setStopEnabled(on);
  };

  const finishStopped = (): RunOutcome => {
    const timeToStopMs = Math.max(0, clock() - (stopPressedAt ?? clock()));
    ui.setTiming(
      `Stopped. Time to stop: ${Math.round(timeToStopMs)} ms. The answer so far stays above.`,
    );
    return { stopped: true, timeToStopMs };
  };

  return {
    get running(): boolean {
      return controller !== undefined;
    },
    async run<T extends { finishReason: string }>(
      generate: (signal: AbortSignal) => Promise<T>,
      onError?: (e: unknown) => void,
      onResult?: (result: T) => void,
    ): Promise<RunOutcome> {
      if (controller) return { stopped: false };
      const own = new AbortController();
      controller = own;
      stopPressedAt = undefined;
      ui.setRunEnabled(false);
      setStop(true);
      try {
        const result = await generate(own.signal);
        if (stopPressedAt !== undefined && result.finishReason === 'abort') return finishStopped();
        onResult?.(result);
        return { stopped: false };
      } catch (e) {
        if (stopPressedAt !== undefined && isAbort(e)) return finishStopped();
        onError?.(e);
        return { stopped: false };
      } finally {
        const wasStopped = stopPressedAt !== undefined;
        controller = undefined;
        setStop(false);
        ui.setRunEnabled(true);
        if (wasStopped) ui.onStopped?.();
      }
    },
    stop(): void {
      if (!controller || controller.signal.aborted) return;
      stopPressedAt = clock();
      setStop(false);
      controller.abort();
    },
  };
}
