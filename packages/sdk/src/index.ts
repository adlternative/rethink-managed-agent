/**
 * pma-sdk — dependency-free client for rethink-managed-agent's native `/v1` API.
 *
 * ```ts
 * import { createClient } from "pma-sdk";
 * const pma = createClient({ baseURL: "http://localhost:8080", apiKey: process.env.PMA_API_KEY });
 * const session = await pma.sessions.create({ agent: "agent_…", environment_id: "env_…" });
 * await pma.sessions.send(session.id, "list files");
 * for await (const ev of pma.sessions.stream(session.id)) { … }
 * ```
 *
 * OpenAPI: `openapi/v1.yaml` in the rethink-managed-agent repo (also `GET /openapi/v1.yaml`).
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "file"; file_id: string } }
  | { type: "document"; source: { type: "file"; file_id: string } };

export type UserEvent =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" }
  | { type: "tool_result"; tool_use_id: string; content: ContentBlock[]; is_error?: boolean }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string };

export interface SessionEvent {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface Session {
  id: string;
  agent_id: string;
  environment_id: string;
  workspace_id: string;
  status: "idle" | "running" | "terminated" | string;
  agent?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  model: { provider: string; id: string };
  system: string | null;
  tools: string[];
  packages?: string[];
  created_at: string;
  [k: string]: unknown;
}

export interface Environment {
  id: string;
  name: string;
  provider: string;
  workspace: unknown;
  created_at: string;
  [k: string]: unknown;
}

export interface Vault {
  id: string;
  name: string;
  metadata?: Record<string, string>;
  created_at: string;
  [k: string]: unknown;
}

export interface StreamFrame {
  /** SSE `event:` field (session event type or live delta type). */
  type: string;
  /** Parsed JSON from `data:`. */
  data: any;
}

export class PmaError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "PmaError";
  }
}

export interface ClientOptions {
  /** API origin, e.g. http://localhost:8080 (no trailing slash required). */
  baseURL: string;
  /** Bearer token (`pma_…`). Optional when the server has AUTH_REQUIRED=false. */
  apiKey?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

function describeError(status: number, text: string): { type: string; message: string; body?: unknown } {
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (e && typeof e.message === "string") return { type: e.type ?? "http_error", message: e.message, body: j };
  } catch { /* not JSON */ }
  return { type: "http_error", message: text.replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${status}` };
}

async function* parseSse(res: Response): AsyncGenerator<StreamFrame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // heartbeat / comment
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (!dataLines.length) continue;
      try {
        yield { type, data: JSON.parse(dataLines.join("\n")) };
      } catch { /* skip non-JSON */ }
    }
    if (done) break;
  }
}

export function createClient(opts: ClientOptions) {
  const base = opts.baseURL.replace(/\/+$/, "");
  const f = opts.fetch ?? fetch;

  const headers = (json = true): Record<string, string> => ({
    ...(json ? { "content-type": "application/json" } : {}),
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    ...opts.headers,
  });

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await f(`${base}${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      const d = describeError(res.status, text);
      throw new PmaError(res.status, d.type, d.message, d.body);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new PmaError(res.status, "api_error", `response is not JSON: ${text.slice(0, 200)}`);
    }
  }

  const sessions = {
    async create(body: {
      agent: string | Record<string, unknown>;
      environment_id?: string;
      workspace?: unknown;
      workspace_id?: string;
      environments?: unknown[];
      memory_stores?: unknown;
      vault_ids?: string[];
      initial_events?: UserEvent[];
      [k: string]: unknown;
    }): Promise<Session> {
      return request("POST", "/v1/sessions", body);
    },
    async get(id: string): Promise<Session> {
      return request("GET", `/v1/sessions/${encodeURIComponent(id)}`);
    },
    async list(query: { limit?: number; cursor?: string; status?: string } = {}): Promise<{ data: Session[]; has_more?: boolean; next_cursor?: string | null }> {
      const q = new URLSearchParams();
      if (query.limit != null) q.set("limit", String(query.limit));
      if (query.cursor) q.set("cursor", query.cursor);
      if (query.status) q.set("status", query.status);
      const qs = q.toString();
      return request("GET", `/v1/sessions${qs ? `?${qs}` : ""}`);
    },
    async delete(id: string): Promise<void> {
      await request("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
    },
    async archive(id: string): Promise<unknown> {
      return request("POST", `/v1/sessions/${encodeURIComponent(id)}/archive`);
    },
    async appendEvents(id: string, events: UserEvent[]): Promise<{ events: SessionEvent[] }> {
      return request("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, { events });
    },
    /** Convenience: append a user.message with plain text. */
    async send(id: string, text: string): Promise<{ events: SessionEvent[] }> {
      return sessions.appendEvents(id, [{ type: "user.message", content: [{ type: "text", text }] }]);
    },
    async listEvents(id: string, opts: { since?: number; limit?: number } = {}): Promise<{ data: SessionEvent[]; has_more?: boolean }> {
      const q = new URLSearchParams();
      if (opts.since != null) q.set("since", String(opts.since));
      if (opts.limit != null) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return request("GET", `/v1/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`);
    },
    /**
     * Async iterate SSE frames from `since` (exclusive seq). Does not auto-reconnect;
     * callers that need reconnect can loop with the last seen `data.seq`.
     */
    async *stream(id: string, opts: { since?: number; signal?: AbortSignal } = {}): AsyncGenerator<StreamFrame> {
      const since = opts.since ?? 0;
      const res = await f(`${base}/v1/sessions/${encodeURIComponent(id)}/events/stream?since=${since}`, {
        headers: { ...headers(false), accept: "text/event-stream" },
        signal: opts.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const d = describeError(res.status, text);
        throw new PmaError(res.status, d.type, d.message, d.body);
      }
      yield* parseSse(res);
    },
  };

  const agents = {
    list: () => request("GET", "/v1/agents") as Promise<{ data: Agent[] }>,
    get: (id: string) => request("GET", `/v1/agents/${encodeURIComponent(id)}`) as Promise<Agent>,
    create: (body: { name: string; model: { provider: string; id: string }; system?: string; tools?: string[]; packages?: string[]; skills?: unknown }) =>
      request("POST", "/v1/agents", body) as Promise<Agent>,
    update: (id: string, body: Record<string, unknown>) => request("PATCH", `/v1/agents/${encodeURIComponent(id)}`, body) as Promise<Agent>,
    delete: (id: string) => request("DELETE", `/v1/agents/${encodeURIComponent(id)}`),
  };

  const environments = {
    list: () => request("GET", "/v1/environments") as Promise<{ data: Environment[] }>,
    get: (id: string) => request("GET", `/v1/environments/${encodeURIComponent(id)}`) as Promise<Environment>,
    create: (body: { name: string; provider: string; image?: string; network?: string; plugin_host?: string; workspace?: unknown }) =>
      request("POST", "/v1/environments", body) as Promise<Environment>,
    delete: (id: string) => request("DELETE", `/v1/environments/${encodeURIComponent(id)}`),
  };

  const vaults = {
    list: () => request("GET", "/v1/vaults") as Promise<{ object?: string; data: Vault[] }>,
    get: (id: string) => request("GET", `/v1/vaults/${encodeURIComponent(id)}`) as Promise<Vault>,
    create: (body: { name?: string; metadata?: Record<string, string> } = {}) => request("POST", "/v1/vaults", body) as Promise<Vault>,
    delete: (id: string) => request("DELETE", `/v1/vaults/${encodeURIComponent(id)}`),
    putCredential: (vaultId: string, body: Record<string, unknown>) =>
      request("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`, body),
    listCredentials: (vaultId: string) => request("GET", `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`),
    deleteCredential: (vaultId: string, name: string) =>
      request("DELETE", `/v1/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(name)}`),
  };

  return {
    baseURL: base,
    request,
    me: () => request("GET", "/v1/me"),
    sessions,
    agents,
    environments,
    vaults,
  };
}

export type PmaClient = ReturnType<typeof createClient>;
