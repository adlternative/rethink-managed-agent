import { describe, it, expect } from "vitest";
import OpenAI from "openai7";
import { toAgentSession } from "../src/api/routes/compat/openai-agents.ts";
import { projectDelta, newTurnCtx } from "../src/api/routes/compat/openai-stream.ts";
import { toItems, toTurns } from "../src/api/routes/compat/openai-agents.ts";

/**
 * Contract test against the REAL OpenAI SDK (openai@7.15.0, aliased as `openai7`). We do not boot the
 * DB here; instead we drive the SDK's own request builder and response parser against our route
 * contract with a capturing `fetch`, proving three things end to end:
 *   1. the SDK hits the exact paths our /openai/v1 routes serve,
 *   2. the AgentSession JSON our projection emits parses cleanly in the SDK, and
 *   3. the SDK-built request bodies are exactly what our route handlers consume.
 */

// A synthetic rethink session for the projection (shape only; no DB).
const session: any = {
  id: "sess_abc", owner_id: "prc_x", agent_id: "agent_1", environment_id: "env_1", workspace_id: "ws_1",
  status: "idle", created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
  agent: { id: "agent_1", name: null, model: { provider: "qoder", id: "ultimate" }, system: "be helpful", tools: [], client_tools: [{ type: "function", name: "run_bash", parameters: {} }], mcp_servers: [] },
};

// A pending client/function-tool call in the log => the session must project as requires_action.
const pendingEvents: any[] = [{ seq: 1, type: "agent.tool_use", payload: { type: "agent.tool_use", name: "run_bash", tool_use_id: "call_1", input: { cmd: "ls" } } }];

function client(capture: { req?: { url: string; method: string; body: any } }) {
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    capture.req = { url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    // Respond with our real projection so the SDK's parser exercises the AgentSession shape.
    const payload = toAgentSession(session, pendingEvents, "env_1");
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new OpenAI({ apiKey: "test", baseURL: "http://local/openai/v1", fetch: fetch as any });
}

describe("official OpenAI SDK contract (openai@7.15.0)", () => {
  it("sessions.create hits POST /openai/v1/agents/sessions and parses our AgentSession", async () => {
    const cap: { req?: any } = {};
    const s = await client(cap).beta.agents.sessions.create({
      environment: { type: "none" } as any,
      agent: { model: "gpt-x", instructions: "be helpful", tools: [{ type: "function", name: "run_bash", parameters: { type: "object", properties: {} } }] } as any,
      input: "fix the bug",
    });
    expect(new URL(cap.req.url).pathname).toBe("/openai/v1/agents/sessions");
    expect(cap.req.method).toBe("POST");
    expect(cap.req.body.agent.model).toBe("gpt-x");
    expect(cap.req.body.input).toBe("fix the bug");
    // The SDK parsed our projection into a typed AgentSession:
    expect(s.object).toBe("agent.session");
    expect(s.status).toBe("requires_action"); // synthetic session has a pending client-tool call
    expect(s.required_actions[0]).toMatchObject({ type: "function_call", call_id: expect.any(String), name: "run_bash" });
  });

  it("sessions.retrieve hits GET /openai/v1/agents/sessions/{id}", async () => {
    const cap: { req?: any } = {};
    await client(cap).beta.agents.sessions.retrieve("sess_abc");
    expect(new URL(cap.req.url).pathname).toBe("/openai/v1/agents/sessions/sess_abc");
    expect(cap.req.method).toBe("GET");
  });

  it("sessions.events.create hits POST .../events with the input-event union our mapper consumes", async () => {
    const cap: { req?: any } = {};
    await client(cap).beta.agents.sessions.events.create("sess_abc", {
      events: [{ type: "agent.session.input.tool_result", call_id: "call_1", output: "42" } as any],
    });
    expect(new URL(cap.req.url).pathname).toBe("/openai/v1/agents/sessions/sess_abc/events");
    expect(cap.req.method).toBe("POST");
    expect(cap.req.body.events[0]).toMatchObject({ type: "agent.session.input.tool_result", call_id: "call_1" });
  });
});

describe("items & turns projection (phase 1c)", () => {
  const evlog: any[] = [
    { seq: 1, type: "session.status_running", payload: { type: "session.status_running" }, created_at: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "user.message", payload: { type: "user.message", content: [{ type: "text", text: "hi" }] }, created_at: "2026-01-01T00:00:01Z" },
    { seq: 3, type: "agent.tool_use", payload: { type: "agent.tool_use", tool_use_id: "call_1", name: "run_bash", input: { cmd: "ls" } }, created_at: "2026-01-01T00:00:02Z" },
    { seq: 4, type: "agent.tool_result", payload: { type: "agent.tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "a.ts" }], is_error: false }, created_at: "2026-01-01T00:00:03Z" },
    { seq: 5, type: "agent.message", payload: { type: "agent.message", content: [{ type: "text", text: "done" }] }, created_at: "2026-01-01T00:00:04Z" },
    { seq: 6, type: "session.status_idle", payload: { type: "session.status_idle", stop_reason: "end_turn" }, created_at: "2026-01-01T00:00:05Z" },
  ];
  it("projects the event log into SDK items and one completed turn", () => {
    const items = toItems(session, evlog as any);
    expect(items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message"]);
    expect(items.every((i) => i.turn_id === "turn_1")).toBe(true); // all in the run's turn
    expect(items[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "run_bash" });
    const turns = toTurns(session, evlog as any);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "turn_1", object: "agent.session.turn", status: "completed" });
  });
});

describe("official SDK vaults (client.beta.agents.vaults.*)", () => {
  function vaultClient(capture) {
    const fetch = async (url, init = {}) => {
      capture.req = { url: url.toString(), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
      const path = new URL(url.toString()).pathname;
      const canned = path.endsWith("/credentials") ? { id: "cred_1", vault_id: "vault_1", name: "MY_SECRET", object: "vault.credential" } : { id: "vault_1", object: "vault", name: null, metadata: {}, created_at: 1 };
      return new Response(JSON.stringify(canned), { status: 200, headers: { "content-type": "application/json" } });
    };
    return new OpenAI({ apiKey: "x", baseURL: "http://local/openai/v1", fetch });
  }
  it("vaults.create hits POST /openai/v1/vaults", async () => {
    const cap = {};
    await vaultClient(cap).beta.agents.vaults.create({});
    expect(new URL(cap.req.url).pathname).toBe("/openai/v1/vaults");
    expect(cap.req.method).toBe("POST");
  });
  it("vaults.credentials.create hits POST .../credentials with the auth the route consumes", async () => {
    const cap = {};
    await vaultClient(cap).beta.agents.vaults.credentials.create("vault_1", { name: "MY_SECRET", auth: { type: "static_bearer", token: "s3cr3t" } });
    expect(new URL(cap.req.url).pathname).toBe("/openai/v1/vaults/vault_1/credentials");
    expect(cap.req.body).toMatchObject({ name: "MY_SECRET", auth: { type: "static_bearer", token: "s3cr3t" } });
  });
});

describe("official SDK streaming (sessions.stream drives our projection)", () => {
  it("yields our agent.session.turn.* projection, runs the tool handler, submits the result, and terminates", async () => {
    // Build the SSE body by running the REAL projection over synthetic native deltas.
    const ctx = newTurnCtx();
    const idleSession: any = { ...session, status: "idle", agent: { ...session.agent } };
    const natives: any[] = [
      { type: "event", event: { seq: 1, type: "session.status_running", payload: { type: "session.status_running" } } },
      { type: "event", event: { seq: 2, type: "agent.tool_use", payload: { type: "agent.tool_use", tool_use_id: "call_1", name: "run_bash", input: { cmd: "ls" } } } },
      { type: "event", event: { seq: 3, type: "session.status_idle", payload: { type: "session.status_idle", stop_reason: "end_turn" } } },
    ];
    const projected = natives.flatMap((d) => projectDelta(d, idleSession, ctx));
    const sseBody = projected.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

    const posts: any[] = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/events")) return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      if (method === "GET") return new Response(JSON.stringify(toAgentSession(idleSession, [], "env_1")), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "POST" && path.endsWith("/events")) { posts.push(init?.body ? JSON.parse(String(init.body)) : undefined); return new Response(null, { status: 204 }); }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OpenAI({ apiKey: "test", baseURL: "http://local/openai/v1", fetch: fetch as any });

    let toolArgs: any;
    const seen: string[] = [];
    const stream = client.beta.agents.sessions.stream("sess_abc", {
      input: "list files",
      toolHandlers: { run_bash: async (args) => { toolArgs = args; return "listed" as any; } },
    });
    for await (const ev of stream) seen.push(ev.type);

    // The projection drove the SDK's full loop:
    expect(seen).toContain("agent.session.turn.created");
    expect(seen).toContain("agent.session.turn.item.added");
    expect(seen).toContain("agent.session.idle"); // terminal reached (no "ended before idle" throw)
    expect(toolArgs).toEqual({ cmd: "ls" }); // our function_call item carried arguments the handler received
    // The handler's result was submitted back as an input.tool_result to POST .../events:
    const toolResult = posts.find((b) => b?.events?.[0]?.type === "agent.session.input.tool_result");
    expect(toolResult.events[0]).toMatchObject({ call_id: "call_1" });
  });
});
