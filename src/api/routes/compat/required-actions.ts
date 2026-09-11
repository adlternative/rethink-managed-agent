import type { SessionEvent, SessionResource } from "../../../shared/types.ts";

/** One pending client/function tool call the caller must fulfill (OpenAI required_action shape). */
export interface RequiredAction {
  turn_id: string;
  call_id: string;
  type: "function_call";
  name: string;
  arguments: unknown;
}

/**
 * Fold the event log into pending required actions: a client_tool_pending call with no later
 * agent.tool_result for the same id is still awaiting the caller's tool_result.
 */
export function requiredActions(events: SessionEvent[]): RequiredAction[] {
  const answered = new Set<string>();
  for (const e of events) if (e.payload.type === "agent.tool_result") answered.add(e.payload.tool_use_id);
  const out: RequiredAction[] = [];
  for (const e of events) {
    if (e.payload.type === "agent.client_tool_pending" && !answered.has(e.payload.tool_use_id)) {
      out.push({ turn_id: e.payload.turn_id, call_id: e.payload.tool_use_id, type: "function_call", name: e.payload.name, arguments: e.payload.input });
    }
  }
  return out;
}

export type OpenAiStatus = "idle" | "running" | "requires_action" | "terminated";

/** OpenAI-facing session status: required_action takes precedence over running while a call is pending. */
export function openaiStatus(session: SessionResource, events: SessionEvent[]): OpenAiStatus {
  if (session.status === "terminated") return "terminated";
  if (requiredActions(events).length > 0) return "requires_action";
  return session.status === "running" ? "running" : "idle";
}

/** The OpenAI-shaped session object returned by create/retrieve. */
export function toOpenAiSession(session: SessionResource, events: SessionEvent[], environmentId: string) {
  return {
    id: session.id,
    object: "agent.session",
    status: openaiStatus(session, events),
    info: {
      environment: { environment_id: environmentId },
      required_actions: requiredActions(events),
    },
  };
}
