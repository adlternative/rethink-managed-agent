import { describe, it, expect } from "vitest";

process.env.COMPAT_DEFAULT_PROVIDER = "qoder";
process.env.COMPAT_MODEL_MAP = JSON.stringify({ "sev-astra": "local/qwen2.5" });

const { mapModel, splitTools, openaiAgentToRethink, openaiEnvToEnvironmentId } = await import("../src/api/routes/compat/translate.ts");
const { requiredActions, openaiStatus, toOpenAiSession } = await import("../src/api/routes/compat/required-actions.ts");
const { toOpenAiEvent } = await import("../src/api/routes/compat/sse.ts");

const ev = (seq: number, payload: any) => ({ id: `evt_${seq}`, session_id: "sess_1", seq, type: payload.type, payload, created_at: "" }) as any;

describe("translate", () => {
  it("maps model strings via the map, then provider/id split, then default provider", () => {
    expect(mapModel("sev-astra")).toEqual({ provider: "local", id: "qwen2.5" }); // via COMPAT_MODEL_MAP
    expect(mapModel("anthropic/claude-sonnet-4-6")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
    expect(mapModel("ultimate")).toEqual({ provider: "qoder", id: "ultimate" }); // default provider
  });

  it("splits tools into builtins, client tools, mcp servers, web_search, and ignored", () => {
    const s = splitTools([
      { type: "function", name: "get_incident", parameters: { type: "object", properties: {} } },
      { type: "bash" },
      { type: "web_search" },
      { type: "mcp", server_label: "github", transport: { type: "http", server_url: "https://api.example/mcp", authorization: "Bearer x" }, allowed_tools: ["list_commits"] },
      { type: "programmatic_tool_calling", enabled: true },
    ]);
    expect(s.builtins).toEqual(["bash"]);
    expect(s.clientTools.map((t) => t.name)).toEqual(["get_incident"]);
    expect(s.webSearch).toBe(true);
    expect(s.mcpServers).toEqual([{ label: "github", url: "https://api.example/mcp", authorization: "Bearer x", headers: undefined, allowed_tools: ["list_commits"] }]);
    expect(s.ignored.map((i) => i.type)).toEqual(["programmatic_tool_calling"]);
  });

  it("rejects an unknown tool type, a nameless function tool, and an mcp tool without server_url", () => {
    expect(() => splitTools([{ type: "nonsense" }])).toThrow();
    expect(() => splitTools([{ type: "function" }])).toThrow(/name/);
    expect(() => splitTools([{ type: "mcp", server_label: "x", transport: { type: "http" } }])).toThrow(/server_url/);
  });

  it("carries mcp_servers into the agent draft; web_search with no package falls to ignored", () => {
    const d = openaiAgentToRethink({ model: "x", tools: [{ type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://developers.openai.com/mcp" } }, { type: "web_search" }] });
    expect(d.mcp_servers).toEqual([{ label: "docs", url: "https://developers.openai.com/mcp", authorization: undefined, headers: undefined, allowed_tools: undefined }]);
    expect(d.ignored.map((i) => i.type)).toContain("web_search"); // COMPAT_WEBSEARCH_PACKAGE unset in tests
  });

  it("builds an agent draft: instructions->system, function tools->client_tools", () => {
    const d = openaiAgentToRethink({ model: "sev-astra", instructions: "be careful", tools: [{ type: "function", name: "f", parameters: {} }, { type: "read" }] });
    expect(d.system).toBe("be careful");
    expect(d.model).toEqual({ provider: "local", id: "qwen2.5" });
    expect(d.tools).toEqual(["read"]);
    expect(d.client_tools.map((t) => t.name)).toEqual(["f"]);
  });

  it("resolves environment: explicit id wins; else requires config", () => {
    expect(openaiEnvToEnvironmentId({ environment_id: "env_9" })).toBe("env_9");
    expect(() => openaiEnvToEnvironmentId({ type: "self_hosted" })).toThrow(/environment_id/);
  });
});

describe("required actions (derived from the log; no engine 'pending' concept)", () => {
  const sess = (status: string) => ({ id: "sess_1", status, agent: { client_tools: [{ type: "function", name: "propose_rollback", parameters: {} }] } }) as any;
  // a client-tool call is just an ordinary agent.tool_use whose name is one of the session's client tools
  const call = ev(3, { type: "agent.tool_use", tool_use_id: "call_1", name: "propose_rollback", input: { service: "checkout" } });
  const names = ["propose_rollback"];

  it("surfaces a client-tool call with no matching result", () => {
    expect(requiredActions([call], names)).toEqual([{ turn_id: "turn_3", call_id: "call_1", type: "function_call", name: "propose_rollback", arguments: { service: "checkout" } }]);
  });

  it("ignores a sandbox tool call (name not in client tools)", () => {
    expect(requiredActions([ev(3, { type: "agent.tool_use", tool_use_id: "b1", name: "bash", input: {} })], names)).toEqual([]);
  });

  it("clears once a matching tool_result exists", () => {
    const answered = ev(5, { type: "agent.tool_result", tool_use_id: "call_1", content: [], is_error: false, pi: {} });
    expect(requiredActions([call, answered], names)).toEqual([]);
  });

  it("status is requires_action while pending, terminated when terminated", () => {
    expect(openaiStatus(sess("running"), [call])).toBe("requires_action");
    expect(openaiStatus(sess("idle"), [])).toBe("idle");
    expect(openaiStatus(sess("terminated"), [call])).toBe("terminated");
    const s = toOpenAiSession(sess("running"), [call], "env_1");
    expect(s.status).toBe("requires_action");
    expect(s.info.required_actions).toHaveLength(1);
  });
});

describe("sse mapping", () => {
  const ct = new Set(["propose_rollback"]);
  it("maps text deltas, client vs sandbox tool calls, and turn end to OpenAI event names", () => {
    expect(toOpenAiEvent({ type: "agent.message_delta", session_id: "s", stream_id: "x", text: "hi" }, "s", ct)!.event).toBe("response.output_text.delta");
    // sandbox tool call -> item.added; client tool call -> action_required
    expect(toOpenAiEvent({ type: "event", event: ev(1, { type: "agent.tool_use", tool_use_id: "c1", name: "bash", input: {} }) }, "s", ct)!.event).toBe("session.turn.item.added");
    expect(toOpenAiEvent({ type: "event", event: ev(2, { type: "agent.tool_use", tool_use_id: "c2", name: "propose_rollback", input: {} }) }, "s", ct)!.event).toBe("agent.session.action_required");
    expect(toOpenAiEvent({ type: "event", event: ev(3, { type: "session.status_idle", stop_reason: "end_turn" }) }, "s", ct)!.event).toBe("agent.session.turn.completed");
    expect(toOpenAiEvent({ type: "event", event: ev(4, { type: "session.status_idle", stop_reason: "error" }) }, "s", ct)!.event).toBe("turn.failed");
  });
});
