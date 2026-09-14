/** HTTP access to the pma API: base URL and auth from the environment, readable errors, SSE following. */

export interface CliConfig { base: string; token?: string }

/** Base URL from PMA_API (PMA_HOST and the legacy PI_API are fallbacks); bearer key from PMA_API_KEY (or PMA_TOKEN). */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const base = (env.PMA_API || env.PMA_HOST || env.PI_API || "http://localhost:8080").replace(/\/+$/, "");
  const token = env.PMA_API_KEY || env.PMA_TOKEN || undefined;
  return { base, ...(token ? { token } : {}) };
}

export function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { token } = resolveConfig(env);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** A non-2xx API response; the message carries the status and the server's error message (or the raw body). */
export class HttpError extends Error {
  constructor(public status: number, public body: string) { super(describeError(status, body)); }
}

export function describeError(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const e = j?.error;
    if (e && typeof e.message === "string") return `HTTP ${status}${e.type ? ` ${e.type}` : ""}: ${e.message}`;
  } catch { /* not JSON: fall through to the raw body */ }
  const text = body.replace(/\s+/g, " ").trim();
  return `HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ""}`;
}

const STALE_SOCKET = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);

export class Client {
  constructor(public cfg: CliConfig) {}

  async fetch(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = { ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}), ...init.headers };
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(this.cfg.base + path, { method, headers, body: init.body, signal: init.signal });
      } catch (e) {
        if (init.signal?.aborted) throw e;
        if (!(e instanceof TypeError && (e as { cause?: unknown }).cause)) throw e; // not a network failure (e.g. an invalid header value)
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        // A pooled keep-alive socket the server already closed fails before the request is sent: retry an
        // idempotent GET once on a fresh connection. Writes are never retried (they may have been applied).
        if (attempt === 0 && method === "GET" && STALE_SOCKET.has(cause?.code ?? "")) continue;
        throw new Error(`cannot reach the API at ${this.cfg.base} (${cause?.code ?? cause?.message ?? (e as Error).message}); set PMA_API to its URL`);
      }
    }
  }

  /** JSON request; a null result for an empty body. The body is read as text first so a proxy error page keeps its status. */
  async json(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetch(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return this.read(res);
  }

  async read(res: Response): Promise<any> {
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: response is not JSON: ${text.slice(0, 200)}`); }
  }

  /**
   * One SSE connection. Calls onEvent(type, data) per event (comments and non-JSON data are skipped);
   * resolves true when onEvent returned true (the connection is then cancelled), false when the server closed it.
   */
  async sse(path: string, onEvent: (type: string, data: any) => boolean | void, signal?: AbortSignal): Promise<boolean> {
    const res = await this.fetch("GET", path, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const dispatch = (block: string): boolean => {
      let type = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) return false;
      let parsed: unknown;
      try { parsed = JSON.parse(data.join("\n")); } catch { return false; }
      return !!onEvent(type, parsed);
    };
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      // normalize CRLF / CR line endings, but keep a trailing CR: its LF may be in the next chunk
      const hold = !done && buf.endsWith("\r") ? "\r" : "";
      buf = (hold ? buf.slice(0, -1) : buf).replace(/\r\n?/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (dispatch(block)) { await reader.cancel().catch(() => {}); return true; }
      }
      buf += hold;
      if (done) return buf.trim() ? dispatch(buf) : false; // a final event without the trailing blank line
    }
  }

  /**
   * Follow a session's event stream from `since`, reconnecting from the last seen seq when the connection
   * drops (up to `retries` consecutive failures). Resolves when onEvent returns true; rejects on an HTTP
   * error, when retries are exhausted, or after `timeoutMs`.
   */
  async follow(sessionId: string, since: number, onEvent: (type: string, data: any) => boolean | void, opts: { timeoutMs?: number; retries?: number; backoffMs?: number; onReconnect?: (last: number, why: string) => void } = {}): Promise<void> {
    const ctl = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ctl.abort(), opts.timeoutMs) : undefined;
    let last = since;
    let failures = 0;
    const retries = opts.retries ?? 5;
    try {
      for (;;) {
        let why: string;
        try {
          const ended = await this.sse(`/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?since=${last}`, (type, data) => {
            if (typeof data?.seq === "number" && data.seq > last) { last = data.seq; failures = 0; }
            return onEvent(type, data);
          }, ctl.signal);
          if (ended) return;
          why = "the server closed the stream";
        } catch (e) {
          if (ctl.signal.aborted) throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s waiting on session ${sessionId}`);
          if (e instanceof HttpError) throw e;
          why = (e as Error).message;
        }
        if (++failures > retries) throw new Error(`event stream lost (${why}); gave up after ${retries} reconnects`);
        opts.onReconnect?.(last, why);
        await new Promise((r) => setTimeout(r, Math.min((opts.backoffMs ?? 250) * 2 ** (failures - 1), 5000)));
        if (ctl.signal.aborted) throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s waiting on session ${sessionId}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
