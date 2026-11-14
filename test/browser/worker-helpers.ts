// Shared by worker.spec.ts, guard-order.spec.ts, isolation.spec.ts and tt.spec.ts: a gated Chrome
// context (every request off the page origin is aborted and recorded, CSP violations are collected from
// the page) and the loopback hook of models.html.

import { expect, type Browser, type BrowserContext, type Page } from 'playwright/test';

export const PROMPT = 'What is the capital of France? Answer in one word.';
export const BASE = 'http://127.0.0.1:8790';
export const FORBIDDEN_HOSTS =
  /(^|\.)(huggingface\.co|hf\.co|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|github\.com|githubusercontent\.com|googleapis\.com|gstatic\.com)$/i;

export interface Gate {
  /** URLs the browser itself refused before they left (net::ERR_BLOCKED_BY_CSP): attempted, never sent. */
  cspBlocked: string[];
  aborted: string[];
  requests: { url: string; method: string; resourceType: string }[];
  workers: number;
}

export async function gatedContext(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page; gate: Gate }> {
  const context = await browser.newContext();
  const origin = new URL(BASE).origin;
  const gate: Gate = { cspBlocked: [], aborted: [], requests: [], workers: 0 };
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.origin === origin || u.protocol === 'data:' || u.protocol === 'blob:';
    } catch {
      ok = false;
    }
    if (ok) return route.continue();
    gate.aborted.push(url);
    return route.abort('blockedbyclient');
  });
  context.on('request', (r) =>
    gate.requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType() }),
  );
  context.on('requestfailed', (r) => {
    if (/BLOCKED_BY_CSP/i.test(r.failure()?.errorText ?? '')) gate.cspBlocked.push(r.url());
  });
  const page = await context.newPage();
  page.on('worker', () => gate.workers++);
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return { context, page, gate };
}

export interface HookEvent {
  name: string;
  kind: string;
  level: string;
  attrs: Record<string, string | number | boolean | null>;
  bytes?: number;
}

export interface WorkerHookReport {
  ok: boolean;
  rung?: string;
  adapter?: string;
  attempts?: {
    rung: string;
    adapter: string;
    model: string | null;
    outcome: string;
    reason: string;
  }[];
  text?: string;
  finishReason?: string;
  longTasksMs?: number[];
  timerAbort?: { latencyMs: number; finishReason: string; refcounts: number[]; loaded: boolean };
  events?: HookEvent[];
  userMessage?: string;
  executionProviders?: string[];
}

export async function runHook(
  page: Page,
  options: Record<string, unknown>,
): Promise<WorkerHookReport> {
  await page.waitForFunction(
    () => 'run' in ((window as unknown as { __models?: object }).__models ?? {}),
  );
  return (await page.evaluate(
    (o) =>
      (window as unknown as { __models: { run: (x: unknown) => Promise<unknown> } }).__models.run(
        o,
      ),
    options,
  )) as WorkerHookReport;
}

/**
 * Fails on any request outside the page origin. `blockedByCsp` lists URLs the browser reported as CSP
 * violations (securitypolicyviolation in the page or the worker): attempted, refused before they left.
 */
export function expectOnlyPageOrigin(gate: Gate, label: string, blockedByCsp: string[] = []): void {
  const origin = new URL(BASE).origin;
  expect(gate.aborted, `${label}: aborted non-origin requests`).toEqual([]);
  for (const r of gate.requests) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') continue;
    if (gate.cspBlocked.includes(r.url) || blockedByCsp.includes(r.url)) continue; // refused by the CSP before it left
    expect(u.origin, `${label}: ${r.url}`).toBe(origin);
    expect(FORBIDDEN_HOSTS.test(u.hostname), `${label}: ${r.url}`).toBe(false);
    expect(
      u.pathname.includes('__airplanemode/verified/'),
      `${label}: staging prefix ${r.url}`,
    ).toBe(false);
  }
}

export const phaseEvents = (events: HookEvent[]) =>
  events.filter((e) => e.name === 'model.load.phase');
