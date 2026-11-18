// The exact attrs of a backend.egress.refused event, shared by the Node unit tests and the browser
// spec (test/browser/model.spec.ts), so the two can never drift apart again (D1-02: the browser spec
// kept the Event 0.1.2 attrs after Event 0.1.3 added `reporter`, and failed on ubuntu-latest).
//
// Event 0.1.3 (S1-074): the page's own guard (reporter 'main') records the page-computed origin only.
// A refusal reported by the engine worker (reporter 'worker') never carries the worker's text: the
// origin is the fixed string 'worker-reported' and `count` is the 1-based report number within the load.

export type EgressAttrs = Record<string, string | number>;

export function mainEgressAttrs(adapter: string, origin: string): EgressAttrs {
  return { adapter, origin, reporter: 'main' };
}

export function workerEgressAttrs(adapter: string, count: number): EgressAttrs {
  return { adapter, origin: 'worker-reported', reporter: 'worker', count };
}
