// A minimal flat-session CDP client over Node's global WebSocket, for the DevTools panel proof. It
// talks to Chrome's browser endpoint (--remote-debugging-port) so it can attach to targets
// Playwright does not expose: the DevTools front-end (devtools://) and extension pages.

export interface CdpClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  close(): void;
}

export async function connectCdp(port: number): Promise<CdpClient> {
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket error'));
  });
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (v: never) => void; reject: (e: Error) => void; method: string }
  >();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as {
      id?: number;
      result?: never;
      error?: { message: string };
    };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result as never);
  };
  return {
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      const i = ++id;
      return new Promise<T>((resolve, reject) => {
        pending.set(i, { resolve: resolve as (v: never) => void, reject, method });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => ws.close(),
  };
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

export async function listTargets(cdp: CdpClient): Promise<TargetInfo[]> {
  return (await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')).targetInfos;
}

export async function attach(cdp: CdpClient, targetId: string): Promise<string> {
  return (
    await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  ).sessionId;
}

export async function evaluate<T>(
  cdp: CdpClient,
  sessionId: string,
  expression: string,
): Promise<T> {
  const r = await cdp.send<{
    result: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails)
    throw new Error(
      `evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  return r.result.value as T;
}
