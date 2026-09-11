import { Hono } from "hono";
import { repos } from "../../../infra/db.ts";
import { listEvents } from "../../../infra/events.ts";
import type { SessionResource, WorkspaceRef } from "../../../shared/types.ts";
import { invalid, notFound, readJson } from "../../errors.ts";
import { scope, ownerId } from "../../auth.ts";
import { sendUserEvents } from "../events.ts";
import { initialRef } from "../sessions.ts";
import { openaiAgentToRethink, openaiEnvToEnvironmentId, type OpenAiAgentSpec, type OpenAiEnvSpec } from "./translate.ts";
import { toOpenAiSession } from "./required-actions.ts";
import { streamOpenAiEvents } from "./sse.ts";

/**
 * OpenAI Agents API-compatible surface, mounted at /agents-api/v1. A pure adapter over rethink's
 * native engine (events-as-truth, sandbox leases, principals) — the only novelty in the engine is
 * client/function tools (results supplied by the caller). Vendor-neutral: model resolves to a
 * rethink provider row, environment to a pluggable sandbox provider.
 */
async function loadSession(c: import("hono").Context): Promise<SessionResource> {
  const s = await repos.sessions.get(c.req.param("id"), scope(c));
  if (!s) throw notFound("session", c.req.param("id"));
  return s;
}
const envIdOf = (s: SessionResource) => s.environment_id;

export const agentsApi = new Hono()
  .post("/sessions", async (c) => {
    const body = await readJson<{ agent?: OpenAiAgentSpec; environment?: OpenAiEnvSpec; input?: unknown; stream?: boolean }>(c);
    if (!body.agent) throw invalid("agent is required");
    const owner = ownerId(c);
    const draft = openaiAgentToRethink(body.agent);
    const environmentId = openaiEnvToEnvironmentId(body.environment);
    const environment = await repos.environments.get(environmentId, scope(c));
    if (!environment) throw notFound("environment", environmentId);

    const spec = environment.workspace;
    const workspace = await repos.workspaces.create(spec, initialRef(spec) as WorkspaceRef, owner);
    const agentRow = await repos.agents.create({ owner_id: owner, name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages, skills: [] });
    const { created_at: _c, ...snapshot } = { ...agentRow, client_tools: draft.client_tools };
    const session = await repos.sessions.create({ owner_id: owner, agent_id: agentRow.id, environment_id: environmentId, workspace_id: workspace.id, agent: snapshot });

    const since = 0;
    if (typeof body.input === "string" && body.input.length > 0) {
      await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text: body.input }] }]);
    }
    if (body.stream) return streamOpenAiEvents(c, session.id, since, { synthCreated: { environment: { environment_id: environmentId }, ignored: draft.ignored } });
    return c.json(toOpenAiSession(session, await listEvents(session.id), environmentId), 201);
  })
  .get("/sessions/:id", async (c) => {
    const session = await loadSession(c);
    return c.json(toOpenAiSession(session, await listEvents(session.id), envIdOf(session)));
  })
  /** Continue the turn / add input (session.stream(input=...)). */
  .post("/sessions/:id", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ input?: unknown; stream?: boolean }>(c);
    const before = await listEvents(session.id);
    const since = before.length ? before[before.length - 1]!.seq : 0;
    if (typeof body.input === "string" && body.input.length > 0) {
      await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text: body.input }] }]);
    } else if (body.input !== undefined) {
      throw invalid("input must be a string");
    }
    if (body.stream) return streamOpenAiEvents(c, session.id, since);
    return c.json(toOpenAiSession(await loadSession(c), await listEvents(session.id), envIdOf(session)));
  })
  /** Submit a client/function tool result (or a human approval decision). */
  .post("/sessions/:id/tool_result", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ call_id?: string; turn_id?: string; success?: boolean; output?: unknown }>(c);
    if (!body.call_id) throw invalid("call_id is required");
    const text = typeof body.output === "string" ? body.output : JSON.stringify(body.output ?? {});
    await sendUserEvents(session, [{ type: "tool_result", tool_use_id: body.call_id, content: [{ type: "text", text }], is_error: body.success === false }]);
    return c.json({ session_id: session.id, call_id: body.call_id, turn_id: body.turn_id, accepted: true }, 202);
  })
  .delete("/sessions/:id", async (c) => {
    const session = await loadSession(c);
    await repos.sessions.delete(session.id);
    return c.json({ id: session.id, object: "agent.session", deleted: true });
  })
  /** Reattach an SSE stream (resume after action_required), from a cursor. */
  .get("/sessions/:id/events/stream", async (c) => {
    const session = await loadSession(c);
    return streamOpenAiEvents(c, session.id, Number(c.req.query("since") ?? 0));
  });
