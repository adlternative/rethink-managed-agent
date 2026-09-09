import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import { appendEvents } from "../../infra/events.ts";
import type { AgentResource, SessionResource, WorkspaceRef, WorkspaceResource, WorkspaceSpec } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { validateModel, validateTools } from "./agents.ts";
import { validateWorkspaceSpec } from "./environments.ts";
import { events, sendUserEvents, validateUserEvents } from "./events.ts";

type AgentInput = string | { type: "agent_with_overrides"; id: string; model?: unknown; system?: string; tools?: unknown };

export function initialRef(spec: WorkspaceSpec): WorkspaceRef {
  if (spec.kind === "git") return { kind: "git", remote: spec.remote, base: spec.ref ?? "HEAD" };
  if (spec.kind === "local") return { kind: "local", path: spec.path };
  return { kind: "empty" };
}

async function resolveAgent(input: AgentInput | undefined): Promise<SessionResource["agent"]> {
  const id = typeof input === "string" ? input : input?.type === "agent_with_overrides" ? input.id : undefined;
  if (!id) throw invalid("agent must be an id or {type:'agent_with_overrides', id, ...}");
  const base = await repos.agents.get(id);
  if (!base) throw notFound("agent", id);
  const { created_at: _c, ...snap } = base as AgentResource;
  if (typeof input === "string" || input === undefined) return snap;
  return {
    ...snap,
    model: input.model !== undefined ? validateModel(input.model) : snap.model,
    system: input.system !== undefined ? input.system : snap.system,
    tools: input.tools !== undefined ? validateTools(input.tools) : snap.tools,
  };
}

export const sessions = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ agent?: AgentInput; environment_id?: string; workspace?: unknown; workspace_id?: string; initial_events?: unknown }>(c);
    const agent = await resolveAgent(body.agent);
    if (!body.environment_id) throw invalid("environment_id is required");
    const environment = await repos.environments.get(body.environment_id);
    if (!environment) throw notFound("environment", body.environment_id);

    let workspace: WorkspaceResource | null;
    if (body.workspace_id) {
      workspace = await repos.workspaces.get(body.workspace_id);
      if (!workspace) throw notFound("workspace", body.workspace_id);
    } else {
      const spec = body.workspace !== undefined ? validateWorkspaceSpec(body.workspace) : environment.workspace;
      workspace = await repos.workspaces.create(spec, initialRef(spec));
    }
    const session = await repos.sessions.create({
      agent_id: agent.id,
      environment_id: environment.id,
      workspace_id: workspace.id,
      agent,
    });
    if (Array.isArray(body.initial_events) && body.initial_events.length > 0) {
      await sendUserEvents(session, validateUserEvents(body.initial_events));
    }
    return c.json(session, 201);
  })
  .get("/", async (c) => c.json({ data: await repos.sessions.list() }))
  .get("/:id", async (c) => {
    const s = await repos.sessions.get(c.req.param("id"));
    if (!s) throw notFound("session", c.req.param("id"));
    return c.json(s);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await repos.sessions.get(id))) throw notFound("session", id);
    await repos.sessions.delete(id);
    return c.json({ id, deleted: true });
  })
  .post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const s = await repos.sessions.get(id);
    if (!s) throw notFound("session", id);
    if (s.status !== "terminated") {
      await appendEvents(id, [{ type: "session.status_terminated", reason: "archived" }], { status: "terminated" });
    }
    return c.json({ ...s, status: "terminated" });
  })
  .route("/:id/events", events);
