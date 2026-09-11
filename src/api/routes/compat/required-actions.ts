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
 * Derive pending required actions purely from the log — the engine has no "pending"/"approval"
 * concept. A required action is a client/function tool call (an agent.tool_use whose name is one of
 * the session's client tools) with no later agent.tool_result for the same id.
 */
export function requiredActions(events: SessionEvent[], clientToolNames: Iterable<string>): RequiredAction[] {
  const clientTools = new Set(clientToolNames);
  const answered = new Set<string>();
  for (const e of events) if (e.payload.type === "agent.tool_result") answered.add(e.payload.tool_use_id);
  const out: RequiredAction[] = [];
  for (const e of events) {
    if (e.payload.type === "agent.tool_use" && clientTools.has(e.payload.name) && !answered.has(e.payload.tool_use_id)) {
      out.push({ turn_id: `turn_${e.seq}`, call_id: e.payload.tool_use_id, type: "function_call", name: e.payload.name, arguments: e.payload.input });
    }
  }
  return out;
}

/** Names of a session's client/function tools (used to tell them apart from sandbox tools in the log). */
export function clientToolNames(session: SessionResource): string[] {
  return (session.agent.client_tools ?? []).map((t) => t.name);
}

export type OpenAiStatus = "idle" | "running" | "requires_action" | "terminated";

/** OpenAI-facing session status: required_action takes precedence over running while a call is pending. */
export function openaiStatus(session: SessionResource, events: SessionEvent[]): OpenAiStatus {
  if (session.status === "terminated") return "terminated";
  if (requiredActions(events, clientToolNames(session)).length > 0) return "requires_action";
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
      required_actions: requiredActions(events, clientToolNames(session)),
    },
  };
}
