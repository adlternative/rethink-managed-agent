import { describe, it, expect } from "vitest";
import OpenAI from "openai7";
import { toAgentSession } from "../src/api/routes/compat/openai-agents.ts";

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
