import { describe, it, expect } from "vitest";
import { toAgentSession, toItems, toTurns, toSubagent } from "../src/api/routes/compat/openai-agents.ts";
import { projectDelta, newTurnCtx } from "../src/api/routes/compat/openai-stream.ts";
import { requiredActions, clientToolNames } from "../src/api/routes/compat/required-actions.ts";
import { toOpenAiEvent } from "../src/api/routes/compat/sse.ts";

/**
 * Pure projections of the compat surface: the AgentSession object (status precedence, error text),
 * items/turns attribution against the event order the engine really produces (user.message is
 * appended BEFORE claimRun's session.status_running), required_actions turn ids, and every branch of
 * the official stream projection and the legacy SSE mapping.
 */

const session = (over: Record<string, unknown> = {}): any => ({
  id: "sess_p", owner_id: "prc_x", agent_id: "agent_1", environment_id: "env_1", workspace_id: "ws_1", status: "idle", vault_ids: [],
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:05:00.000Z",
  agent: { id: "agent_1", name: null, model: { provider: "qoder", id: "ultimate" }, system: null, tools: [], packages: [], skills: [], client_tools: [{ type: "function", name: "lookup", parameters: {} }], mcp_servers: [] },
  ...over,
});
const ev = (seq: number, payload: any, created_at = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`): any => ({ id: `evt_${seq}`, session_id: "sess_p", seq, type: payload.type, payload, created_at });
const running = (seq: number) => ev(seq, { type: "session.status_running" });
const idle = (seq: number, stop_reason = "end_turn") => ev(seq, { type: "session.status_idle", stop_reason });
const userMsg = (seq: number, text = "hi") => ev(seq, { type: "user.message", content: [{ type: "text", text }] });
const agentMsg = (seq: number, text = "ok", extra: Record<string, unknown> = {}) => ev(seq, { type: "agent.message", content: [{ type: "text", text }], pi: {}, ...extra });
const toolUse = (seq: number, name = "lookup", id = `call_${seq}`) => ev(seq, { type: "agent.tool_use", tool_use_id: id, name, input: { q: 1 } });
const toolResult = (seq: number, id: string, is_error = false) => ev(seq, { type: "agent.tool_result", tool_use_id: id, content: [{ type: "text", text: "r" }], is_error, pi: {} });
const sessError = (seq: number, type: string, message: string) => ev(seq, { type: "session.error", error: { type, message } });
const deltaOf = (e: any) => ({ type: "event", event: e }) as any;

describe("toAgentSession: error extraction and status precedence", () => {
  it("a session.error projects status failed", () => {
    expect(toAgentSession(session(), [sessError(1, "model_error", "boom")], "env_1").status).toBe("failed");
  });

  // Regression: the message is read from payload.message, but the engine shape is payload.error.message.
  it("carries the engine's error.message text (payload.error.message)", () => {
    expect(toAgentSession(session(), [sessError(1, "model_error", "boom")], "env_1").error).toBe("boom");
  });

  // Regression: claimRun appends a non-fatal run_lost session.error then resumes; the session must not stay failed.
  it("a recovered run_lost error followed by a completed turn projects idle, not failed", () => {
    const log = [sessError(1, "run_lost", "previous runner stopped heartbeating; resuming"), running(2), idle(3)];
    const s = toAgentSession(session({ status: "idle" }), log, "env_1");
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("a session.error followed by a later completed turn does not pin the session as failed", () => {
    const log = [userMsg(1), running(2), sessError(3, "model_error", "transient"), idle(4, "error"), userMsg(5), running(6), agentMsg(7), idle(8)];
    expect(toAgentSession(session({ status: "idle" }), log, "env_1").status).toBe("idle");
  });

  it("(a) a terminated row with no events projects idle with no actions or error", () => {
    const s = toAgentSession(session({ status: "terminated" }), [], "env_1");
    expect(s.status).toBe("idle");
    expect(s.required_actions).toEqual([]);
    expect(s.error).toBeNull();
  });

  it("(b) a running row with a pending client tool call projects requires_action", () => {
    const s = toAgentSession(session({ status: "running" }), [userMsg(1), running(2), toolUse(3)], "env_1");
    expect(s.status).toBe("requires_action");
    expect(s.required_actions).toEqual([expect.objectContaining({ type: "function_call", call_id: "call_3", name: "lookup", arguments: { q: 1 } })]);
  });

  it("(c) a pending client call AND an environment disconnect list both actions", () => {
    const log = [userMsg(1), running(2), toolUse(3), ev(4, { type: "session.environment_disconnected", environment_id: "env_byoc" })];
    const s = toAgentSession(session({ status: "running" }), log, "env_1");
    expect(s.status).toBe("requires_action");
    expect(s.required_actions.map((a: any) => a.type)).toEqual(["function_call", "environment_connection"]);
    expect(s.required_actions[1]).toEqual({ type: "environment_connection", environment_id: "env_byoc" });
  });

  it("(d) an error plus a pending call projects failed while still listing the required action", () => {
    const s = toAgentSession(session({ status: "running" }), [running(1), toolUse(2), sessError(3, "model_error", "x")], "env_1");
    expect(s.status).toBe("failed");
    expect(s.required_actions).toHaveLength(1);
  });

  it("(e) an unanswered sandbox tool (not a client tool) is not requires_action", () => {
    const s = toAgentSession(session({ status: "running" }), [running(1), toolUse(2, "bash")], "env_1");
    expect(s.status).toBe("in_progress");
    expect(s.required_actions).toEqual([]);
  });

  it("an answered client call clears requires_action; the agent snapshot is projected", () => {
    const s = toAgentSession(session({ status: "idle", vault_ids: ["vault_1"] }), [running(1), toolUse(2), toolResult(3, "call_2"), idle(4)], "env_9");
    expect(s.status).toBe("idle");
    expect(s.environment).toEqual({ type: "reference", environment_id: "env_9" });
    expect(s.vault_ids).toEqual(["vault_1"]);
    expect(s.agent).toMatchObject({ id: "agent_1", model: "qoder/ultimate", instructions: null, name: null });
    expect(s.created_at).toBe(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000));
  });

  it("an unparseable created_at falls back to now instead of NaN", () => {
    const s = toAgentSession(session({ created_at: "" }), [], "env_1");
    expect(Number.isFinite(s.created_at)).toBe(true);
    expect(Math.abs(s.created_at - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe("turn_id consistency across required_actions, turns, items and the stream", () => {
  const log = [userMsg(1), running(2), toolUse(3)];

  it("turns, items and the stream projection agree on turn_2 for the running turn", () => {
    expect(toTurns(session(), log).map((t) => t.id)).toEqual(["turn_2"]);
    expect(toItems(session(), log).find((i) => i.type === "function_call")!.turn_id).toBe("turn_2");
    const ctx = newTurnCtx();
    const out = log.flatMap((e) => projectDelta(deltaOf(e), session(), ctx));
    const added = out.find((e) => e.type === "agent.session.turn.item.added") as any;
    expect(added.turn_id).toBe("turn_2");
    expect(added.item.turn_id).toBe("turn_2");
  });

  // Regression: requiredActions uses turn_<tool_use seq> so a turns.retrieve on it 404s.
  it("required_actions[].turn_id references the turn that exists (turn_2)", () => {
    const turnId = toTurns(session(), log)[0]!.id;
    expect(requiredActions(log, clientToolNames(session()))[0]!.turn_id).toBe(turnId);
  });
});

describe("toItems turn attribution (engine order: user.message precedes status_running)", () => {
  const log = [userMsg(1, "first"), running(2), agentMsg(3), idle(4), userMsg(5, "second"), running(6), agentMsg(7), idle(8)];

  it("projects message items with roles, text and completed status", () => {
    const items = toItems(session(), log);
    expect(items.map((i) => [i.id, i.role])).toEqual([["item_1", "user"], ["item_3", "assistant"], ["item_5", "user"], ["item_7", "assistant"]]);
    expect(items[0]!.content).toEqual([{ type: "input_text", text: "first" }]);
    expect(items[1]).toMatchObject({ phase: "final_answer", content: [{ type: "output_text", text: "ok" }] });
    expect(items[1]!.turn_id).toBe("turn_2");
    expect(items[3]!.turn_id).toBe("turn_6");
  });

  // Regression: turnCursor only switches on status_running, so each user message lands in the previous turn.
  it("a user message carries the turn it triggered", () => {
    const items = toItems(session(), log);
    expect(items[0]!.turn_id).toBe("turn_2");
    expect(items[2]!.turn_id).toBe("turn_6");
  });

  it("function_call_output carries error text only when is_error", () => {
    const items = toItems(session(), [running(1), toolUse(2, "bash", "c1"), toolResult(3, "c1", true), toolUse(4, "bash", "c2"), toolResult(5, "c2", false)]);
    expect(items[1]).toMatchObject({ type: "function_call_output", call_id: "c1", output: "r", error: "r" });
    expect(items[3]).toMatchObject({ type: "function_call_output", call_id: "c2", error: null });
  });

  it("skips non-item events (usage, sandbox, status)", () => {
    const items = toItems(session(), [running(1), ev(2, { type: "sandbox.acquired", sandbox_id: "sb", provider: "local" }), ev(3, { type: "session.usage", usage: {}, context: null }), idle(4)]);
    expect(items).toEqual([]);
  });
});

describe("toTurns edge cases", () => {
  it("(a) status_running without idle is one in_progress turn with completed_at null", () => {
    const turns = toTurns(session(), [userMsg(1), running(2), agentMsg(3)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "turn_2", status: "in_progress", completed_at: null, session_id: "sess_p", agent_id: "agent_1", subagent_id: null });
  });

  // Regression: a run_lost resume emits a second status_running; the first turn is never closed.
  it("(b) two status_running in a row (run_lost resume) do not leave the first turn in_progress forever", () => {
    const turns = toTurns(session(), [userMsg(1), running(2), sessError(3, "run_lost", "resuming"), running(4), idle(5)]);
    expect(turns.filter((t) => t.status === "in_progress")).toEqual([]);
  });

  it("(c) stop reasons map interrupted->cancelled, error->failed, max_turns->completed", () => {
    const turns = toTurns(session(), [running(1), idle(2, "interrupted"), running(3), idle(4, "error"), running(5), idle(6, "max_turns"), running(7), idle(8, "end_turn")]);
    expect(turns.map((t) => [t.id, t.status])).toEqual([["turn_1", "cancelled"], ["turn_3", "failed"], ["turn_5", "completed"], ["turn_7", "completed"]]);
    expect(turns[0]!.completed_at).toBe(Math.floor(Date.parse("2026-01-01T00:00:02Z") / 1000));
  });

  it("(d) events with an empty created_at fall back to now without NaN", () => {
    const turns = toTurns(session(), [ev(1, { type: "session.status_running" }, ""), ev(2, { type: "session.status_idle", stop_reason: "end_turn" }, "")]);
    for (const k of ["created_at", "started_at", "completed_at"]) expect(Number.isFinite(turns[0]![k])).toBe(true);
  });

  it("an idle without a preceding running is ignored", () => {
    expect(toTurns(session(), [idle(1)])).toEqual([]);
  });
});

describe("toSubagent", () => {
  it("running -> active with closed_at null", () => {
    const s = toSubagent(session({ status: "running", agent: { ...session().agent, name: "worker", system: "do it" } }));
    expect(s).toMatchObject({ status: "active", closed_at: null, name: "worker", instructions: [{ type: "output_text", text: "do it" }] });
  });
  it("idle -> idle, system null -> instructions null", () => {
    const s = toSubagent(session({ status: "idle" }));
    expect(s).toMatchObject({ status: "idle", closed_at: null, instructions: null, name: null });
  });
  it("terminated -> closed with closed_at from updated_at", () => {
    const s = toSubagent(session({ status: "terminated" }));
    expect(s.status).toBe("closed");
    expect(s.closed_at).toBe(Math.floor(Date.parse("2026-01-01T00:05:00Z") / 1000));
  });
});

describe("projectDelta: full mapping", () => {
  const sess = session();
  const run = (deltas: any[]) => { const ctx = newTurnCtx(); return deltas.flatMap((d) => projectDelta(d, sess, ctx)); };

  it("message and thinking deltas carry the current turn id and stream id", () => {
    const out = run([deltaOf(running(4)), { type: "agent.message_delta", session_id: "sess_p", stream_id: "st_1", text: "he" }, { type: "agent.thinking_delta", session_id: "sess_p", stream_id: "st_2", text: "hm" }]);
    expect(out[1]).toMatchObject({ type: "agent.session.turn.output_text.delta", turn_id: "turn_4", item_id: "st_1", delta: "he" });
    expect(out[2]).toMatchObject({ type: "agent.session.turn.reasoning_summary_text.delta", turn_id: "turn_4", item_id: "st_2", delta: "hm", summary_index: 0 });
  });

  it("deltas before any turn carry turn_id null", () => {
    const out = run([{ type: "agent.message_delta", session_id: "sess_p", stream_id: "s", text: "x" }]);
    expect(out[0]!.turn_id).toBeNull();
  });

  it("tool_use_start / tool_use_delta produce nothing", () => {
    expect(run([{ type: "agent.tool_use_start", session_id: "sess_p", stream_id: "s", index: 0, name: "bash" }, { type: "agent.tool_use_delta", session_id: "sess_p", stream_id: "s", index: 0, text: "{" }])).toEqual([]);
  });

  it("status_running -> turn.created with an in_progress root turn", () => {
    const [e] = run([deltaOf(running(7))]);
    expect(e).toMatchObject({ type: "agent.session.turn.created", turn_id: "turn_7", turn: { id: "turn_7", status: "in_progress", subagent_id: null, session_id: "sess_p" } });
  });

  it("agent.message: empty text -> nothing; stream_id -> item_id; else item_<seq>", () => {
    expect(run([deltaOf(agentMsg(2, ""))])).toEqual([]);
    expect(run([deltaOf(agentMsg(2, "hello", { stream_id: "st_9" }))])[0]).toMatchObject({ type: "agent.session.turn.output_text.done", item_id: "st_9", text: "hello" });
    expect(run([deltaOf(agentMsg(3, "hello"))])[0]).toMatchObject({ item_id: "item_3" });
  });

  it("status_idle end_turn -> [turn.completed, session.idle]", () => {
    const out = run([deltaOf(running(1)), deltaOf(idle(2))]);
    expect(out.slice(1).map((e) => e.type)).toEqual(["agent.session.turn.completed", "agent.session.idle"]);
    expect(out[1]).toMatchObject({ turn_id: "turn_1", turn: { status: "completed" } });
  });

  it("status_idle interrupted -> [turn.cancelled, session.idle]", () => {
    expect(run([deltaOf(running(1)), deltaOf(idle(2, "interrupted"))]).slice(1).map((e) => e.type)).toEqual(["agent.session.turn.cancelled", "agent.session.idle"]);
  });

  it("status_idle error -> [turn.failed, session.failed]", () => {
    expect(run([deltaOf(running(1)), deltaOf(idle(2, "error"))]).slice(1).map((e) => e.type)).toEqual(["agent.session.turn.failed", "agent.session.failed"]);
  });

  it("status_idle without a turn falls back to turn_<seq>", () => {
    expect(run([deltaOf(idle(5))])[0]!.turn_id).toBe("turn_5");
  });

  it("sandbox.acquired -> environment.ready", () => {
    expect(run([deltaOf(ev(1, { type: "sandbox.acquired", sandbox_id: "sb", provider: "local" }))])).toEqual([
      expect.objectContaining({ type: "agent.session.environment.ready", environment: { id: "env_1", status: "ready", error: null } }),
    ]);
  });

  it("environment_disconnected -> [environment.failed, requires_action(environment_connection)]", () => {
    const out = run([deltaOf(ev(1, { type: "session.environment_disconnected", environment_id: "env_b" }))]);
    expect(out.map((e) => e.type)).toEqual(["agent.session.environment.failed", "agent.session.requires_action"]);
    expect((out[1] as any).session.required_actions).toEqual([{ type: "environment_connection", environment_id: "env_b" }]);
  });

  it("session.error -> session.failed carrying error.message", () => {
    const out = run([deltaOf(sessError(1, "model_error", "kaput"))]);
    expect(out).toEqual([expect.objectContaining({ type: "agent.session.failed", session: expect.objectContaining({ status: "failed", error: "kaput" }) })]);
  });

  // Regression: run_lost is recoverable (claimRun resumes right after it) but is projected as terminal session.failed.
  it("a run_lost session.error is not projected as terminal agent.session.failed", () => {
    const out = run([deltaOf(sessError(1, "run_lost", "previous runner stopped heartbeating; resuming")), deltaOf(running(2))]);
    expect(out.map((e) => e.type)).not.toContain("agent.session.failed");
  });

  // Regression: status_terminated projects to nothing, so the SSE never sees a terminal event.
  it("session.status_terminated produces a terminal event (idle or failed)", () => {
    const out = run([deltaOf(ev(1, { type: "session.status_terminated", reason: "archived" }))]);
    expect(out.some((e) => e.type === "agent.session.idle" || e.type === "agent.session.failed")).toBe(true);
  });

  it("unknown / non-projected event types produce nothing", () => {
    expect(run([deltaOf(ev(1, { type: "session.usage", usage: {}, context: null })), deltaOf(toolResult(2, "c")), deltaOf(userMsg(3)), deltaOf(ev(4, { type: "plugin.message", plugin: "p", content: [] }))])).toEqual([]);
  });

  it("event_id is unique and monotonic within one ctx", () => {
    const out = run([deltaOf(running(1)), { type: "agent.message_delta", session_id: "sess_p", stream_id: "s", text: "a" }, deltaOf(toolUse(2)), deltaOf(agentMsg(3)), deltaOf(idle(4))]);
    const ids = out.map((e) => e.event_id as string);
    expect(new Set(ids).size).toBe(ids.length);
    const n = ids.map((id) => Number(id.split("_").pop()));
    expect(n).toEqual([...n].sort((a, b) => a - b));
    expect(ids.every((id) => id.startsWith("evt_sess_p_"))).toBe(true);
  });
});

describe("legacy sse.ts toOpenAiEvent remaining branches", () => {
  const ct = new Set(["lookup"]);
  const map = (e: any) => toOpenAiEvent(deltaOf(e), "sess_p", ct);

  it("agent.message -> session.turn.item.done with text", () => {
    expect(map(agentMsg(1, "final"))).toEqual({ event: "session.turn.item.done", data: { type: "session.turn.item.done", session_id: "sess_p", item: { type: "message", role: "assistant", text: "final" } } });
  });
  it("agent.tool_result -> item.done with is_error", () => {
    expect(map(toolResult(1, "c9", true))!.data.item).toEqual({ type: "function_call_output", call_id: "c9", is_error: true });
  });
  it("status_idle interrupted -> turn.cancelled; end_turn carries stop_reason", () => {
    expect(map(idle(1, "interrupted"))!.event).toBe("turn.cancelled");
    expect(map(idle(1, "max_turns"))!.data.stop_reason).toBe("max_turns");
  });
  it("status_terminated -> session.completed with reason", () => {
    expect(map(ev(1, { type: "session.status_terminated", reason: "archived" }))).toMatchObject({ event: "session.completed", data: { reason: "archived" } });
  });
  it("session.error -> session.failed with the error object", () => {
    expect(map(sessError(1, "model_error", "m"))).toMatchObject({ event: "session.failed", data: { error: { type: "model_error", message: "m" } } });
  });
  it("thinking_delta -> response.reasoning.delta; running -> session.turn.created", () => {
    expect(toOpenAiEvent({ type: "agent.thinking_delta", session_id: "s", stream_id: "x", text: "t" }, "sess_p", ct)).toMatchObject({ event: "response.reasoning.delta", data: { delta: "t" } });
    expect(map(running(3))).toMatchObject({ event: "session.turn.created", data: { turn_id: "turn_3" } });
  });
  it("client tool call carries the required_action; unknown types map to null", () => {
    expect(map(toolUse(4))!.data.required_action).toEqual({ turn_id: "turn_4", call_id: "call_4", type: "function_call", name: "lookup", arguments: { q: 1 } });
    expect(map(ev(1, { type: "session.usage", usage: {}, context: null }))).toBeNull();
    expect(toOpenAiEvent({ type: "agent.tool_use_start", session_id: "s", stream_id: "x", index: 0, name: "n" }, "sess_p", ct)).toBeNull();
  });
});
