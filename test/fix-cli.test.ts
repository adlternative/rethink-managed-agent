import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authHeaders, makePrinter, parse, waitOutcome } from "../src/cli/main.ts";

afterEach(() => { vi.unstubAllGlobals(); });

describe("cli parse", () => {
  it("a boolean flag before positionals does not swallow them; --flag=value is supported", () => {
    expect(parse(["send", "--wait", "sess_x", "hello", "world"])).toEqual({ positional: ["send", "sess_x", "hello", "world"], flags: { wait: true } });
    expect(parse(["agent", "create", "--name=dev", "--provider", "qoder", "--model=m=1"]).flags).toEqual({ name: "dev", provider: "qoder", model: "m=1" });
  });
});

describe("cli auth and api", () => {
  it("sends a bearer token from PMA_TOKEN (or PMA_API_KEY)", () => {
    expect(authHeaders({ PMA_TOKEN: "pma_t" })).toEqual({ authorization: "Bearer pma_t" });
    expect(authHeaders({ PMA_API_KEY: "pma_k" })).toEqual({ authorization: "Bearer pma_k" });
    expect(authHeaders({})).toEqual({});
  });

  it("a non-JSON error body keeps the HTTP status; an empty success body is null", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(api("GET", "/v1/agents")).rejects.toThrow(/^HTTP 502: <html>bad gateway/);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await api("DELETE", "/v1/x")).toBeNull();
  });
});

describe("send --wait outcome", () => {
  const idle = (extra: Record<string, unknown>) => ({ payload: { type: "session.status_idle", stop_reason: "end_turn", ...extra } });

  it("ignores the idle of an earlier run that did not consume the message", () => {
    expect(waitOutcome("session.status_idle", idle({ consumed_seq: 4 }), 5)).toBeNull();
    expect(waitOutcome("session.status_idle", idle({ consumed_seq: 5 }), 5)).toEqual({ ok: true, reason: "end_turn" });
  });

  it("an error idle or a terminated session is a failure", () => {
    expect(waitOutcome("session.status_idle", idle({ stop_reason: "error", consumed_seq: 9 }), 5)?.ok).toBe(false);
    expect(waitOutcome("session.status_terminated", { payload: { type: "session.status_terminated", reason: "archived" } }, 5)).toEqual({ ok: false, reason: "session terminated (archived)" });
    expect(waitOutcome("agent.message", {}, 5)).toBeNull();
  });
});

describe("cli event printer", () => {
  it("hides tool/thinking deltas, does not reprint a streamed message, and tolerates missing content", () => {
    const lines: string[] = [];
    const print = makePrinter({ write: (s) => lines.push(s), log: (s) => lines.push(s) });
    print("agent.thinking_delta", { text: "hmm" });
    print("agent.tool_use_delta", { text: "{\"pa" });
    print("agent.message_delta", { stream_id: "st1", text: "hi" });
    print("agent.message", { payload: { type: "agent.message", stream_id: "st1", content: [{ type: "text", text: "hi" }] } });
    print("agent.tool_result", { payload: { type: "agent.tool_result" } });
    print("agent.message", { payload: { type: "agent.message" } });
    expect(lines).toEqual(["hi", "\n", "[tool_result] ", "\n[agent] "]);
  });
});
