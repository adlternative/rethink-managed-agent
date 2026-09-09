import { Hono } from "hono";
import path from "node:path";
import { repos } from "../../infra/db.ts";
import { env } from "../../shared/env.ts";
import type { WorkspaceSpec } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";

// These strings end up as git / docker argv on the runner host, so they are validated at the edge
// (and re-checked in workspace.ts / docker.ts). Remote: network URL forms only, never a host path
// or something git would parse as an option. Ref: git-check-ref-format-ish, no leading '-'.
const GIT_REMOTE = /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)[^\s]+$/;
const GIT_REF = /^(?!-)(?!.*(\.\.|@\{|\/\/|\/$|\.lock$))[\w./@+-]+$/;
// OCI reference: [host[:port]/]path[:tag][@sha256:hex]
const DOCKER_IMAGE = /^[a-z0-9]+([._-]+[a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-]+[a-z0-9]+)*)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

export function validateWorkspaceSpec(spec: unknown): WorkspaceSpec {
  if (spec === undefined) return { kind: "empty" };
  const s = spec as Record<string, unknown>;
  if (s?.kind === "empty") return { kind: "empty" };
  if (s?.kind === "git" && typeof s.remote === "string") {
    if (!GIT_REMOTE.test(s.remote)) throw invalid("workspace.remote must be an https://, ssh://, git:// or user@host: URL");
    if (s.ref !== undefined && (typeof s.ref !== "string" || !GIT_REF.test(s.ref))) throw invalid("workspace.ref is not a valid git ref");
    return { kind: "git", remote: s.remote, ...(typeof s.ref === "string" ? { ref: s.ref } : {}) };
  }
  if (s?.kind === "local" && typeof s.path === "string") {
    if (!env.LOCAL_WORKSPACE_ALLOW_ROOT) throw invalid("workspace kind 'local' is disabled (set LOCAL_WORKSPACE_ALLOW_ROOT on the api to allow it)");
    const root = path.resolve(env.LOCAL_WORKSPACE_ALLOW_ROOT);
    const p = path.resolve(root, s.path);
    if (p !== root && !p.startsWith(root + path.sep)) throw invalid(`workspace.path must be under ${root}`);
    return { kind: "local", path: p };
  }
  throw invalid("workspace must be {kind:'empty'} | {kind:'git',remote,ref?} | {kind:'local',path}");
}

export function validateImage(image: unknown): string | null {
  if (image === undefined || image === null) return null;
  if (typeof image !== "string" || !DOCKER_IMAGE.test(image)) throw invalid("image must be a docker image reference like node:22-alpine or ghcr.io/org/img@sha256:...");
  return image;
}

export const environments = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; provider?: string; image?: string; workspace?: unknown }>(c);
    if (!body.name) throw invalid("name is required");
    if (body.provider !== "local" && body.provider !== "docker" && body.provider !== "e2b") throw invalid("provider must be 'local' | 'docker' | 'e2b'");
    const env = await repos.environments.create({
      name: body.name,
      provider: body.provider,
      image: validateImage(body.image),
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
