/**
 * A thin, dependency-free client that mirrors the OpenAI Agents API session surface closely enough
 * that showcase-style code runs against a rethink base URL. The one line a sample changes is the
 * baseURL (and the apiKey becomes a rethink principal token). No cloud SDK, no vendor lock.
 */
export type ToolHandler = (args: any) => unknown | Promise<unknown>;

export interface StreamEvent {
  type: string;
  session_id: string;
  output_text_delta?: string;
  delta?: string;
  function_call?: { call_id: string; name: string; arguments: any; turn_id?: string };
  required_action?: { turn_id: string; call_id: string; type: string; name: string; arguments: any };
  item?: any;
  stop_reason?: string;
  [k: string]: unknown;
}

export interface AgentSpec { model: string; instructions?: string; reasoning?: { effort?: string }; multi_agent?: { enabled?: boolean; max_concurrent_subagents?: number }; tools?: any[] }
export interface EnvSpec { type?: string; environment_id?: string; workspace_directory?: string; capability_directories?: string[] }

async function* parseSse(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) { try { yield JSON.parse(dataLine.slice(5).trim()) as StreamEvent; } catch { /* skip */ } }
    }
  }
}

export function createClient(opts: { baseURL: string; apiKey?: string }) {
  const base = opts.baseURL.replace(/\/$/, "");
  const headers = (json = true): Record<string, string> => ({ ...(json ? { "content-type": "application/json" } : {}), ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const req = (method: string, path: string) => fetch(`${base}${path}`, { method, headers: headers(false) });
  /** A non-2xx response is an error (with the status and body), never an empty result. */
  const ok = async (what: string, res: Response): Promise<Response> => {
    if (!res.ok) throw new Error(`${what} failed ${res.status}: ${await res.text().catch(() => "")}`);
    return res;
  };

  function makeSession(id: string) {
    const session = {
      id,
      info: { environment: { environment_id: "" }, required_actions: [] as any[] },
      async retrieve() { const s = await (await ok("retrieve", await req("GET", `/sessions/${id}`))).json(); session.info = s.info; (session as any).status = s.status; return session; },
      async delete() { await ok("delete", await req("DELETE", `/sessions/${id}`)); },
      async tool_result(p: { turn_id?: string; call_id: string; success: boolean; output: unknown }) { await ok("tool_result", await post(`/sessions/${id}/tool_result`, p)); },
      /** Send input and yield events; auto-runs any function_call whose name is in tool_handlers, posting the result. */
      async *stream(p: { input?: string; tool_handlers?: Record<string, ToolHandler> } = {}): AsyncGenerator<StreamEvent> {
        const res = await ok("stream", await post(`/sessions/${id}`, { input: p.input, stream: true }));
        for await (const ev of parseSse(res)) {
          yield ev;
          const call = ev.function_call ?? (ev.type === "agent.session.action_required" ? ev.required_action : undefined);
          const handler = call && p.tool_handlers?.[call.name];
          if (call && handler) {
            try { const output = await handler(call.arguments); await session.tool_result({ call_id: call.call_id, turn_id: call.turn_id, success: true, output }); }
            catch (e) { await session.tool_result({ call_id: call.call_id, turn_id: call.turn_id, success: false, output: { error: String(e) } }); }
          }
        }
      },
    };
    return session;
  }

  return {
    beta: {
      agents: {
        sessions: {
          async create(body: { agent: AgentSpec; environment?: EnvSpec; input?: string; stream?: boolean }) {
            const res = await post(`/sessions`, { ...body, stream: false });
            if (!res.ok) throw new Error(`create failed ${res.status}: ${await res.text()}`);
            const s = await res.json();
            const session = makeSession(s.id);
            session.info = s.info;
            return session;
          },
          async retrieve(id: string) { return makeSession(id).retrieve(); },
        },
      },
    },
  };
}
