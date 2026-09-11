import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { worker } from "./worker.ts";
import path from "node:path";
import { repos } from "../../infra/db.ts";
import { env } from "../../shared/env.ts";
import type { WorkspaceSpec } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";

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

/** Never return the worker key after creation. */
function mask<T extends { worker_key?: string | null }>(e: T): T & { worker_key_set: boolean } {
  const { worker_key, ...rest } = e;
  return { ...(rest as T), worker_key_set: !!worker_key };
}

export const environments = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; provider?: string; image?: string; workspace?: unknown; network?: string; plugin_host?: string }>(c);
    if (body.network !== undefined && body.network !== "none" && body.network !== "bridge") throw invalid("network must be 'none' | 'bridge'");
    if (body.plugin_host !== undefined && body.plugin_host !== "runner" && body.plugin_host !== "sandbox") throw invalid("plugin_host must be 'runner' | 'sandbox'");
    if (body.plugin_host === "sandbox" && body.provider === "local") throw invalid("plugin_host 'sandbox' needs an isolating provider (docker | e2b)");
    if (!body.name) throw invalid("name is required");
    if (body.provider !== "local" && body.provider !== "docker" && body.provider !== "e2b" && body.provider !== "byoc") throw invalid("provider must be 'local' | 'docker' | 'e2b' | 'byoc'");
    if (body.provider === "byoc" && body.plugin_host === "sandbox") throw invalid("plugin_host 'sandbox' is not available for byoc yet");
    const env = await repos.environments.create({
      owner_id: ownerId(c),
      name: body.name,
      provider: body.provider,
      image: validateImage(body.image),
      network: (body.network as "none" | "bridge") ?? "none",
      plugin_host: (body.plugin_host as "runner" | "sandbox") ?? "runner",
      // byoc: a per-environment key the worker authenticates with; shown once, in this response only
      worker_key: body.provider === "byoc" ? `wk_${randomBytes(24).toString("base64url")}` : null,
      workspace: validateWorkspaceSpec(body.workspace),
    });
    return c.json(env, 201);
  })
  .get("/", async (c) => c.json({ data: (await repos.environments.list(scope(c))).map(mask) }))
  .route("/:id/worker", worker)
  .get("/:id", async (c) => {
    const e = await repos.environments.get(c.req.param("id"), scope(c));
    if (!e) throw notFound("environment", c.req.param("id"));
    return c.json(mask(e));
  });
