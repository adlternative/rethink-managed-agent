import { Hono } from "hono";
import { repos, toolOutputs } from "../../infra/db.ts";
import { appendEvents } from "../../infra/events.ts";
import type { AgentResource, SessionEnvironment, SessionResource, WorkspaceRef, WorkspaceResource, WorkspaceSpec } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { validateIds, validateModel, validatePackages, validateTools } from "./agents.ts";
import { validateWorkspaceSpec } from "./environments.ts";
import { events, sendUserEvents, validateUserEvents } from "./events.ts";

type AgentInput = string | { type: "agent_with_overrides"; id: string; model?: unknown; system?: string; tools?: unknown; packages?: unknown; skills?: unknown };

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
    packages: input.packages !== undefined ? validatePackages(input.packages) : (snap.packages ?? []),
    skills: input.skills !== undefined ? validateIds(input.skills, "skill") : (snap.skills ?? []),
  };
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

interface EnvInput { key?: string; environment_id?: string; workspace?: unknown; workspace_id?: string; fork_from?: string }

/** Resolve one environment attachment: existing workspace, a fork of another attachment's workspace, or a fresh one from a spec. */
async function resolveEnvironment(input: EnvInput, existing: SessionEnvironment[]): Promise<SessionEnvironment> {
  const key = input.key ?? "main";
  if (!KEY_RE.test(key)) throw invalid(`environment key ${JSON.stringify(key)} must match ${KEY_RE}`);
  if (existing.some((e) => e.key === key)) throw invalid(`environment key ${key} is already attached`);
  if (!input.environment_id) throw invalid(`environments[${key}].environment_id is required`);
  const environment = await repos.environments.get(input.environment_id);
  if (!environment) throw notFound("environment", input.environment_id);

  let workspace: WorkspaceResource | null;
  if (input.workspace_id) {
    workspace = await repos.workspaces.get(input.workspace_id);
    if (!workspace) throw notFound("workspace", input.workspace_id);
  } else if (input.fork_from) {
    const src = existing.find((e) => e.key === input.fork_from);
    if (!src) throw invalid(`fork_from ${input.fork_from}: no such attached environment`);
    const parent = await repos.workspaces.get(src.workspace_id);
    if (!parent) throw notFound("workspace", src.workspace_id);
    // Only metadata refs fork here; `dir` refs are runner-side copies (see ctx.agent.run isolated).
    if (parent.ref.kind === "dir" || parent.ref.kind === "local") throw invalid(`workspace ${parent.id} (${parent.ref.kind}) can only be forked by the runner; attach with workspace_id or a workspace spec instead`);
    workspace = await repos.workspaces.create(parent.spec, parent.ref);
  } else {
    const spec = input.workspace !== undefined ? validateWorkspaceSpec(input.workspace) : environment.workspace;
    workspace = await repos.workspaces.create(spec, initialRef(spec));
  }
  return { key, environment_id: environment.id, workspace_id: workspace.id };
}

export const sessions = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ agent?: AgentInput; environment_id?: string; workspace?: unknown; workspace_id?: string; environments?: EnvInput[]; parent_id?: string; memories?: unknown; initial_events?: unknown }>(c);
    const agent = await resolveAgent(body.agent);
    // Either the classic single-environment shape, or an explicit list whose first entry is "main".
    const inputs: EnvInput[] = Array.isArray(body.environments) && body.environments.length > 0
      ? body.environments.map((e, i) => ({ ...e, key: e.key ?? (i === 0 ? "main" : undefined) }))
      : [{ key: "main", environment_id: body.environment_id, workspace: body.workspace, workspace_id: body.workspace_id }];
    if (inputs[0]!.key !== "main") throw invalid("environments[0] must be the main environment");
    const envs: SessionEnvironment[] = [];
    for (const input of inputs) envs.push(await resolveEnvironment(input, envs));
    if (body.parent_id && !(await repos.sessions.get(body.parent_id))) throw notFound("session", body.parent_id);
    const session = await repos.sessions.create({
      agent_id: agent.id,
      environment_id: envs[0]!.environment_id,
      workspace_id: envs[0]!.workspace_id,
      agent,
      environments: envs,
      parent_id: body.parent_id ?? null,
      memories: validateIds(body.memories, "mem"),
    });
    if (Array.isArray(body.initial_events) && body.initial_events.length > 0) {
      await sendUserEvents(session, validateUserEvents(body.initial_events));
    }
    return c.json(session, 201);
  })
  /** Attach another environment (own sandbox) to an existing session; takes effect on the next turn. */
  .post("/:id/environments", async (c) => {
    const id = c.req.param("id");
    const s = await repos.sessions.get(id);
    if (!s) throw notFound("session", id);
    if (s.status === "terminated") throw invalid("session is terminated");
    const body = await readJson<EnvInput>(c);
    if (!body.key || body.key === "main") throw invalid("key is required and cannot be 'main'");
    const e = await resolveEnvironment(body, s.environments);
    await repos.sessions.attachEnvironment(id, e);
    return c.json({ ...s, environments: [...s.environments, e] }, 201);
  })
  .get("/", async (c) => c.json({ data: await repos.sessions.list() }))
  /** Full text of a tool result that was truncated for the model. */
  .get("/:id/tool-outputs/:toolUseId", async (c) => {
    const rec = await toolOutputs.get(c.req.param("id"), c.req.param("toolUseId"));
    if (!rec) throw notFound("tool output", c.req.param("toolUseId"));
    return c.text(rec.content, 200, { "content-type": "text/plain; charset=utf-8", "x-tool-name": rec.tool_name });
  })
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
