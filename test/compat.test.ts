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

  it("splits tools into builtins, client tools, and accepted-and-ignored types", () => {
    const s = splitTools([
      { type: "function", name: "get_incident", parameters: { type: "object", properties: {} } },
      { type: "bash" },
      { type: "web_search" },
      { type: "mcp", server_label: "github" },
      { type: "programmatic_tool_calling", enabled: true },
    ]);
    expect(s.builtins).toEqual(["bash"]);
    expect(s.clientTools.map((t) => t.name)).toEqual(["get_incident"]);
    expect(s.ignored.map((i) => i.type).sort()).toEqual(["mcp", "programmatic_tool_calling", "web_search"]);
  });

  it("rejects an unknown tool type and a nameless function tool", () => {
    expect(() => splitTools([{ type: "nonsense" }])).toThrow();
    expect(() => splitTools([{ type: "function" }])).toThrow(/name/);
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

describe("required actions", () => {
  const pending = ev(3, { type: "agent.client_tool_pending", tool_use_id: "call_1", name: "propose_rollback", input: { service: "checkout" }, turn_id: "turn_2" });

  it("surfaces a pending client-tool call with no matching result", () => {
    const ra = requiredActions([pending]);
    expect(ra).toEqual([{ turn_id: "turn_2", call_id: "call_1", type: "function_call", name: "propose_rollback", arguments: { service: "checkout" } }]);
  });

  it("clears once a matching tool_result exists", () => {
    const answered = ev(5, { type: "agent.tool_result", tool_use_id: "call_1", content: [], is_error: false, pi: {} });
    expect(requiredActions([pending, answered])).toEqual([]);
  });

  it("status is requires_action while pending, terminated when terminated", () => {
    expect(openaiStatus({ status: "running" } as any, [pending])).toBe("requires_action");
    expect(openaiStatus({ status: "idle" } as any, [])).toBe("idle");
    expect(openaiStatus({ status: "terminated" } as any, [pending])).toBe("terminated");
    const s = toOpenAiSession({ id: "sess_1", status: "running" } as any, [pending], "env_1");
    expect(s.status).toBe("requires_action");
    expect(s.info.environment.environment_id).toBe("env_1");
    expect(s.info.required_actions).toHaveLength(1);
  });
});

describe("sse mapping", () => {
  it("maps text deltas, tool calls, pending, and turn end to OpenAI event names", () => {
    expect(toOpenAiEvent({ type: "agent.message_delta", session_id: "s", stream_id: "x", text: "hi" }, "s")!.event).toBe("response.output_text.delta");
    expect(toOpenAiEvent({ type: "event", event: ev(1, { type: "agent.tool_use", tool_use_id: "c1", name: "f", input: {} }) }, "s")!.event).toBe("session.turn.item.added");
    expect(toOpenAiEvent({ type: "event", event: ev(2, { type: "agent.client_tool_pending", tool_use_id: "c1", name: "f", input: {}, turn_id: "t" }) }, "s")!.event).toBe("agent.session.action_required");
    expect(toOpenAiEvent({ type: "event", event: ev(3, { type: "session.status_idle", stop_reason: "end_turn" }) }, "s")!.event).toBe("agent.session.turn.completed");
    expect(toOpenAiEvent({ type: "event", event: ev(4, { type: "session.status_idle", stop_reason: "error" }) }, "s")!.event).toBe("turn.failed");
  });
});
