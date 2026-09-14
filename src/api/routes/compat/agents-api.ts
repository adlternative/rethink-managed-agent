import { Hono } from "hono";
import { hasMcpCredentials, sealMcpServers, secretsConfigured } from "../../../infra/mcp-credentials.ts";
import { repos } from "../../../infra/db.ts";
import { stateEvents } from "./openai-agents.ts";
import { lastSeq } from "../../../infra/events.ts";
import type { SessionResource, WorkspaceRef } from "../../../shared/types.ts";
import { invalid, notFound, queryInt, readJson } from "../../errors.ts";
import { scope, ownerId } from "../../auth.ts";
import { sendUserEvents } from "../events.ts";
import { initialRef } from "../sessions.ts";
import { openaiAgentToRethink, openaiEnvToEnvironmentId, type OpenAiAgentSpec, type OpenAiEnvSpec } from "./translate.ts";
import { toOpenAiSession, clientToolNames } from "./required-actions.ts";
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
    if (body.input !== undefined && typeof body.input !== "string") throw invalid("input must be a string");
    // the stream follows the turn the input triggers; without one it would never end
    if (body.stream && !body.input) throw invalid("stream:true needs a non-empty input");
    const owner = ownerId(c);
    const draft = openaiAgentToRethink(body.agent);
    const environmentId = openaiEnvToEnvironmentId(body.environment);
    const environment = await repos.environments.get(environmentId, scope(c));
    if (!environment) throw notFound("environment", environmentId);

    // MCP credentials are sealed before anything is stored (they would otherwise live in plaintext in the snapshot)
    if (hasMcpCredentials(draft.mcp_servers) && !secretsConfigured()) throw invalid("MCP server credentials need PMA_SECRET_KEY to be stored encrypted; set it on the api and runner");
    const mcpServers = sealMcpServers(draft.mcp_servers);
    const spec = environment.workspace;
    const workspace = await repos.workspaces.create(spec, initialRef(spec) as WorkspaceRef, owner);
    const agentRow = await repos.agents.create({ owner_id: owner, name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages, skills: [] });
    const { created_at: _c, ...snapshot } = { ...agentRow, client_tools: draft.client_tools, mcp_servers: mcpServers };
    const session = await repos.sessions.create({ owner_id: owner, agent_id: agentRow.id, environment_id: environmentId, workspace_id: workspace.id, agent: snapshot });

    const since = 0;
    if (typeof body.input === "string" && body.input.length > 0) {
      await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text: body.input }] }]);
    }
    if (body.stream) return streamOpenAiEvents(c, session.id, since, { synthCreated: { environment: { environment_id: environmentId }, ignored: draft.ignored }, clientTools: draft.client_tools.map((t) => t.name) });
    return c.json(toOpenAiSession(session, await stateEvents(session), environmentId), 201);
  })
  .get("/sessions/:id", async (c) => {
    const session = await loadSession(c);
    return c.json(toOpenAiSession(session, await stateEvents(session), envIdOf(session)));
  })
  /** Continue the turn / add input (session.stream(input=...)). */
  .post("/sessions/:id", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ input?: unknown; stream?: boolean }>(c);
    if (body.input !== undefined && typeof body.input !== "string") throw invalid("input must be a string");
    // reattaching to a running turn needs no input; on an idle session nothing would ever end the stream
    if (body.stream && !body.input && session.status !== "running") throw invalid("stream:true on an idle session needs a non-empty input");
    const since = await lastSeq(session.id);
    if (typeof body.input === "string" && body.input.length > 0) {
      await sendUserEvents(session, [{ type: "user.message", content: [{ type: "text", text: body.input }] }]);
    }
    if (body.stream) return streamOpenAiEvents(c, session.id, since, { clientTools: clientToolNames(session) });
    return c.json(toOpenAiSession(await loadSession(c), await stateEvents(session), envIdOf(session)));
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
    return streamOpenAiEvents(c, session.id, queryInt(c, "since", 0, 0), { clientTools: clientToolNames(session) });
  });
