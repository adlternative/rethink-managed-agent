import { resolveConfig, buildHeaders } from "./config.ts";

// ---- API resource shapes (mirror src/shared/types.ts on the server) ----
export interface ContentBlock { type: "text"; text: string }
export interface Agent { id: string; name: string; model: { provider: string; id: string }; system: string | null; tools: string[]; packages?: string[]; created_at: string }
export interface Environment { id: string; name: string; provider: string; image: string | null; network?: "none" | "bridge"; plugin_host?: "runner" | "sandbox"; workspace: unknown; created_at: string }
export interface Session { id: string; agent_id: string; environment_id: string; workspace_id: string; environments?: { key: string; environment_id: string; workspace_id: string }[]; parent_id?: string | null; status: "idle" | "running" | "terminated"; agent: Omit<Agent, "created_at">; created_at: string; updated_at: string }
export interface SessionEvent { id: string; session_id: string; seq: number; type: string; payload: any; created_at: string }
export interface SandboxRow { id: string; provider: string; status: string; workspace_id: string | null; affinity: string | null; external_ref: string | null; last_used_at: string; created_at: string }
export interface ModelInfo { provider: string; id: string; name: string; context_window: number }

export class ApiError extends Error {
  constructor(public status: number, public type: string, message: string) { super(message); }
}

export async function apiRequest(method: string, path: string, body?: unknown): Promise<any> {
  const cfg = resolveConfig();
  const res = await fetch(`${cfg.host}/v1${path}`, {
    method,
    headers: { ...buildHeaders(cfg), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.type ?? "http_error", json?.error?.message ?? res.statusText);
  return json;
}
export const apiGet = (p: string) => apiRequest("GET", p);
export const apiPost = (p: string, b?: unknown) => apiRequest("POST", p, b);
export const apiDelete = (p: string) => apiRequest("DELETE", p);

export const textOf = (content: ContentBlock[] | undefined) => (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");

export function sendMessage(sessionId: string, text: string): Promise<{ events: SessionEvent[] }> {
  return apiPost(`/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
}
export function interrupt(sessionId: string): Promise<unknown> {
  return apiPost(`/sessions/${sessionId}/events`, { events: [{ type: "user.interrupt" }] });
}

export type StreamItem =
  | { type: "agent.message_delta"; text: string }
  | { type: "agent.thinking_delta"; text: string }
  | { type: "agent.tool_use_start"; index: number; name: string }
  | { type: "agent.tool_use_delta"; index: number; text: string }
  | { type: "event"; event: SessionEvent };

/**
 * Follow a session's SSE stream from `since` (exclusive seq). Reconnects on network errors until
 * aborted; `onItem` returning true ends the stream. Resolves the last seq seen.
 */
export async function streamEvents(
  sessionId: string,
  since: number,
  onItem: (item: StreamItem) => boolean | void,
  signal?: AbortSignal,
): Promise<number> {
  const cfg = resolveConfig();
  let last = since;
  while (!signal?.aborted) {
    try {
      const res = await fetch(`${cfg.host}/v1/sessions/${sessionId}/events/stream?since=${last}`, {
        headers: { ...buildHeaders(cfg), accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) throw new ApiError(res.status, "stream_error", `stream failed: ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = "";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data);
          const item: StreamItem = type === "agent.message_delta" || type === "agent.thinking_delta" ? { type, text: parsed.text }
            : type === "agent.tool_use_start" ? { type, index: parsed.index, name: parsed.name }
            : type === "agent.tool_use_delta" ? { type, index: parsed.index, text: parsed.text }
            : { type: "event", event: parsed };
          if (item.type === "event") last = Math.max(last, item.event.seq);
          if (onItem(item)) { await reader.cancel().catch(() => {}); return last; }
        }
      }
      // server closed (e.g. session terminated): stop
      return last;
    } catch (e) {
      if (signal?.aborted) return last;
      if (e instanceof ApiError && e.status === 404) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return last;
}
