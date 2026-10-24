import { describe, it, expect, vi } from "vitest";
import { createClient, PmaError } from "../packages/sdk/src/index.ts";

function sseResponse(frames: string[]): Response {
  const body = frames.join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("pma-sdk createClient", () => {
  it("creates a session and iterates SSE events", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });
      if (method === "POST" && url.endsWith("/v1/sessions")) {
        return new Response(JSON.stringify({
          id: "sess_1",
          agent_id: "agent_1",
          environment_id: "env_1",
          workspace_id: "ws_1",
          status: "idle",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && url.includes("/events") && !url.includes("stream")) {
        return new Response(JSON.stringify({
          events: [{ id: "evt_1", session_id: "sess_1", seq: 1, type: "user.message", payload: { type: "user.message" }, created_at: "2026-01-01T00:00:00.000Z" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/events/stream")) {
        return sseResponse([
          "event: agent.message_delta\ndata: {\"text\":\"hi\",\"stream_id\":\"s1\"}\n\n",
          "event: session.status_idle\ndata: {\"id\":\"evt_2\",\"session_id\":\"sess_1\",\"seq\":2,\"type\":\"session.status_idle\",\"payload\":{\"type\":\"session.status_idle\",\"stop_reason\":\"end_turn\"},\"created_at\":\"2026-01-01T00:00:01.000Z\"}\n\n",
        ]);
      }
      return new Response("not found", { status: 404 });
    };

    const pma = createClient({ baseURL: "http://localhost:8080/", apiKey: "pma_test", fetch: fetchStub });
    const session = await pma.sessions.create({ agent: "agent_1", environment_id: "env_1" });
    expect(session.id).toBe("sess_1");
    expect(calls[0]?.body).toContain("agent_1");
    expect(calls[0]?.url).toBe("http://localhost:8080/v1/sessions");

    const sent = await pma.sessions.send(session.id, "hello");
    expect(sent.events[0]?.seq).toBe(1);

    const frames = [];
    for await (const frame of pma.sessions.stream(session.id, { since: 0 })) frames.push(frame);
    expect(frames.map((f) => f.type)).toEqual(["agent.message_delta", "session.status_idle"]);
    expect(frames[0]?.data.text).toBe("hi");
  });

  it("surfaces API error envelopes as PmaError", async () => {
    const pma = createClient({
      baseURL: "http://x",
      fetch: async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "nope" } }), { status: 401 }),
    });
    await expect(pma.me()).rejects.toMatchObject({ status: 401, type: "authentication_error", message: "nope" });
    await expect(pma.me()).rejects.toBeInstanceOf(PmaError);
  });

  it("agents / environments / vaults hit the expected paths", async () => {
    const seen: string[] = [];
    const pma = createClient({
      baseURL: "http://localhost:8080",
      fetch: async (input, init) => {
        seen.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response(JSON.stringify({ data: [], id: "x", object: "list" }), { status: 200 });
      },
    });
    await pma.agents.list();
    await pma.environments.create({ name: "local", provider: "local" });
    await pma.vaults.list();
    expect(seen).toEqual([
      "GET http://localhost:8080/v1/agents",
      "POST http://localhost:8080/v1/environments",
      "GET http://localhost:8080/v1/vaults",
    ]);
  });
});
