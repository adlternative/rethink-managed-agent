import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import type { WorkspaceSpec } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";

export function validateWorkspaceSpec(spec: unknown): WorkspaceSpec {
  if (spec === undefined) return { kind: "empty" };
  const s = spec as Record<string, unknown>;
  if (s?.kind === "empty") return { kind: "empty" };
  if (s?.kind === "git" && typeof s.remote === "string") return { kind: "git", remote: s.remote, ...(typeof s.ref === "string" ? { ref: s.ref } : {}) };
  if (s?.kind === "local" && typeof s.path === "string") return { kind: "local", path: s.path };
  throw invalid("workspace must be {kind:'empty'} | {kind:'git',remote,ref?} | {kind:'local',path}");
}

export const environments = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; provider?: string; image?: string; workspace?: unknown }>(c);
    if (!body.name) throw invalid("name is required");
    if (body.provider !== "local" && body.provider !== "docker") throw invalid("provider must be 'local' | 'docker'");
    const env = await repos.environments.create({
      name: body.name,
      provider: body.provider,
      image: body.image ?? null,
      workspace: validateWorkspaceSpec(body.workspace),
    });
    return c.json(env, 201);
  })
  .get("/", async (c) => c.json({ data: await repos.environments.list() }))
  .get("/:id", async (c) => {
    const e = await repos.environments.get(c.req.param("id"));
    if (!e) throw notFound("environment", c.req.param("id"));
    return c.json(e);
  });
