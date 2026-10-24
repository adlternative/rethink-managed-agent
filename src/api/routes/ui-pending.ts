/**
 * Pure helpers for the operator console: derive pending tool confirmations and client-tool
 * results from a session event log. The browser page reimplements the same rules inline
 * (dependency-free); these exports keep the algorithm unit-tested.
 */

export type PendingConfirmation = {
  kind: "confirmation";
  tool_use_id: string;
  name: string;
  mcp_server?: string;
};

export type PendingClientTool = {
  kind: "client_tool";
  tool_use_id: string;
  name: string;
  input: unknown;
};

export type PendingAction = PendingConfirmation | PendingClientTool;

type EventLike = { payload: { type: string; [k: string]: unknown } };

/** Pending MCP always_ask confirmations and unanswered client/function tool calls. */
export function derivePendingActions(events: EventLike[], clientToolNames: Iterable<string> = []): PendingAction[] {
  const clientTools = new Set(clientToolNames);
  const answeredResults = new Set<string>();
  const answeredConfirm = new Set<string>();
  for (const e of events) {
    const p = e.payload;
    if (p.type === "agent.tool_result" && typeof p.tool_use_id === "string") answeredResults.add(p.tool_use_id);
    if (p.type === "user.tool_confirmation" && typeof p.tool_use_id === "string") answeredConfirm.add(p.tool_use_id);
  }
  const out: PendingAction[] = [];
  const seenConfirm = new Set<string>();
  const seenClient = new Set<string>();
  for (const e of events) {
    const p = e.payload;
    if (p.type === "agent.tool_confirmation_required" && typeof p.tool_use_id === "string" && !answeredConfirm.has(p.tool_use_id) && !seenConfirm.has(p.tool_use_id)) {
      seenConfirm.add(p.tool_use_id);
      out.push({
        kind: "confirmation",
        tool_use_id: p.tool_use_id,
        name: String(p.name ?? ""),
        ...(typeof p.mcp_server === "string" ? { mcp_server: p.mcp_server } : {}),
      });
    }
    if (p.type === "agent.tool_use" && typeof p.tool_use_id === "string" && typeof p.name === "string" && clientTools.has(p.name) && !answeredResults.has(p.tool_use_id) && !seenClient.has(p.tool_use_id)) {
      seenClient.add(p.tool_use_id);
      out.push({ kind: "client_tool", tool_use_id: p.tool_use_id, name: p.name, input: p.input });
    }
  }
  return out;
}
