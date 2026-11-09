// A fake HTTP origin for the asset manager tests. It speaks just enough HTTP: Range / If-Range,
// 200 / 206 / 416, strong or weak ETags, Last-Modified, and a set of hostile-host knobs
// (Content-Range tampering, oversize bodies, missing Content-Length with an endless body,
// redirects, mid-stream failures). Every request is recorded so tests can assert exact behaviour.

export interface FakeServerOptions {
  /** Origin served, default https://assets.test */
  origin?: string | undefined;
  /** Answer every request with the whole body and status 200, ignoring Range. */
  ignoreRange?: boolean | undefined;
  /** ETag kind for assets. Default strong. */
  etag?: 'strong' | 'weak' | 'none' | undefined;
  /** Send Last-Modified. Default true. */
  lastModified?: boolean | undefined;
  /** Tamper: override the start in Content-Range of 206 responses. */
  contentRangeStart?: number | undefined;
  /** Tamper: override the total in Content-Range of 206 and 416 responses. */
  contentRangeTotal?: number | undefined;
  /** Hostile: append this many garbage bytes beyond the declared body. */
  extraBytes?: number | undefined;
  /** Hostile: omit Content-Length. */
  omitContentLength?: boolean | undefined;
  /** Hostile: body never ends (implies omitContentLength). */
  endless?: boolean | undefined;
  /** Override Content-Length with a wrong value. */
  contentLengthOverride?: number | undefined;
  /** Send this Content-Encoding header, as a host that compresses on the fly would; Content-Length then counts encoded bytes. */
  contentEncoding?: string | undefined;
  /** Simulate a redirect: throws TypeError when init.redirect === 'error', else 302. */
  redirect?: boolean | undefined;
  /** Error the body stream after this many bytes of the response. */
  failAfterBytes?: number | undefined;
  /** Force this status on the next request only. */
  statusOnce?: number | undefined;
  /** Serve this different byte content for /assets/<name> while the manifest still lists the real hash. */
  corruptAssets?: boolean | undefined;
  /** Stream piece size. Default 64 KiB. */
  pieceSize?: number | undefined;
}

export interface FakeRequest {
  url: string;
  method: string;
  range: string | undefined;
  ifRange: string | undefined;
  init: RequestInit;
  status: number;
  bytesSent: number;
}

export class FakeServer {
  readonly assets = new Map<string, Uint8Array>();
  readonly requests: FakeRequest[] = [];
  options: FakeServerOptions;
  /** Text served at /manifest.json (set by tests). */
  manifestText: string | undefined;
  readonly fetch: typeof fetch;
  private fetchCalls = 0;

  constructor(options: FakeServerOptions = {}) {
    this.options = { ...options };
    this.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
  }

  get origin(): string {
    return this.options.origin ?? 'https://assets.test';
  }

  get calls(): number {
    return this.fetchCalls;
  }

  addAsset(name: string, bytes: Uint8Array): string {
    this.assets.set(name, bytes);
    return `${this.origin}/assets/${name}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.fetchCalls = 0;
  }

  private async handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    this.fetchCalls++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init.headers ?? {});
    const rec: FakeRequest = {
      url,
      method: init.method ?? 'GET',
      range: headers.get('range') ?? undefined,
      ifRange: headers.get('if-range') ?? undefined,
      init,
      status: 0,
      bytesSent: 0,
    };
    this.requests.push(rec);
    const o = this.options;

    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');

    if (o.redirect) {
      if (init.redirect === 'error') throw new TypeError('Failed to fetch: redirect refused');
      rec.status = 302;
      return new Response(null, { status: 302, headers: { location: `${this.origin}/elsewhere` } });
    }

    const u = new URL(url);
    if (u.origin !== this.origin) {
      rec.status = 404;
      return new Response('wrong origin', { status: 404 });
    }

    if (u.pathname === '/manifest.json') {
      if (this.manifestText === undefined) {
        rec.status = 404;
        return new Response('no manifest', { status: 404 });
      }
      rec.status = 200;
      rec.bytesSent = this.manifestText.length;
      return new Response(this.manifestText, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const m = /^\/assets\/(.+)$/.exec(u.pathname);
    const name = m?.[1];
    let bytes = name ? this.assets.get(name) : undefined;
    if (!bytes) {
      rec.status = 404;
      return new Response('not found', { status: 404 });
    }
    if (o.corruptAssets) {
      bytes = bytes.map((b) => b ^ 0x5a);
    }
    const total = bytes.length;
    const etag =
      o.etag === 'none'
        ? undefined
        : o.etag === 'weak'
          ? `W/"${name}-${total}"`
          : `"${name}-${total}"`;
    const common: Record<string, string> = { 'accept-ranges': 'bytes' };
    if (etag) common['etag'] = etag;
    if (o.lastModified !== false) common['last-modified'] = 'Mon, 09 Nov 2026 00:00:00 GMT';

    if (o.statusOnce !== undefined) {
      const status = o.statusOnce;
      delete o.statusOnce;
      rec.status = status;
      const h = { ...common };
      if (status === 416) h['content-range'] = `bytes */${o.contentRangeTotal ?? total}`;
      return new Response(null, { status, headers: h });
    }

    let start = 0;
    let end = total - 1;
    let status = 200;
    if (rec.range && !o.ignoreRange) {
      const rm = /^bytes=(\d+)-(\d*)$/.exec(rec.range);
      if (!rm) {
        rec.status = 400;
        return new Response('bad range', { status: 400 });
      }
      start = Number(rm[1]);
      if (rm[2]) end = Math.min(Number(rm[2]), total - 1);
      // If-Range: a mismatching validator means "send the whole thing".
      const validatorOk =
        !rec.ifRange || rec.ifRange === etag || rec.ifRange === common['last-modified'];
      if (!validatorOk) {
        start = 0;
        end = total - 1;
        status = 200;
      } else if (start >= total) {
        rec.status = 416;
        return new Response(null, {
          status: 416,
          headers: { ...common, 'content-range': `bytes */${o.contentRangeTotal ?? total}` },
        });
      } else {
        status = 206;
      }
    }

    const body = bytes.subarray(start, end + 1);
    const h: Record<string, string> = { ...common, 'content-type': 'application/octet-stream' };
    if (status === 206) {
      h['content-range'] =
        `bytes ${o.contentRangeStart ?? start}-${end}/${o.contentRangeTotal ?? total}`;
    }
    if (!(o.omitContentLength || o.endless)) {
      h['content-length'] = String(o.contentLengthOverride ?? body.length);
    }
    if (o.contentEncoding) h['content-encoding'] = o.contentEncoding;
    rec.status = status;
    return new Response(this.stream(body, rec), { status, headers: h });
  }

  private stream(body: Uint8Array, rec: FakeRequest): ReadableStream<Uint8Array> {
    const o = this.options;
    const piece = o.pieceSize ?? 65536;
    let off = 0;
    let extraLeft = o.extraBytes ?? 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (o.failAfterBytes !== undefined && rec.bytesSent >= o.failAfterBytes) {
          controller.error(new TypeError('network error: connection reset'));
          return;
        }
        if (off < body.length) {
          const len = Math.min(piece, body.length - off);
          const chunk = body.slice(off, off + len);
          off += len;
          rec.bytesSent += len;
          controller.enqueue(chunk);
          return;
        }
        if (extraLeft > 0) {
          const len = Math.min(piece, extraLeft);
          extraLeft -= len;
          rec.bytesSent += len;
          controller.enqueue(new Uint8Array(len).fill(0xee));
          return;
        }
        if (o.endless) {
          rec.bytesSent += piece;
          controller.enqueue(new Uint8Array(piece).fill(0xee));
          return;
        }
        controller.close();
      },
    });
  }
}
