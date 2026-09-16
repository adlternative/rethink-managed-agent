import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import type { BuiltinToolName, McpServerDecl, ModelRef } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { validateSkillRefs } from "./skills.ts";
import { disallowedEverywhere } from "../../plugins/allow.ts";
import { scope, ownerId } from "../auth.ts";
import { isOperatorOwner } from "../../harness/models.ts";
import type { Scope } from "../../infra/db.ts";
import { skills as skillsRepo } from "../../infra/db.ts";
import type { SkillRef } from "../../shared/types.ts";

const TOOLS: BuiltinToolName[] = ["bash", "read", "write", "edit"];

export function validateTools(tools: unknown): BuiltinToolName[] {
  if (tools === undefined) return TOOLS;
  if (!Array.isArray(tools) || !tools.every((t) => TOOLS.includes(t))) throw invalid(`tools must be a subset of ${TOOLS.join(",")}`);
  return tools as BuiltinToolName[];
}
export function validateModel(model: unknown): ModelRef {
  const m = model as Partial<ModelRef> | undefined;
  if (!m || typeof m.provider !== "string" || typeof m.id !== "string") throw invalid("model {provider,id} is required");
  return { provider: m.provider, id: m.id };
}

/** A model may only name a provider the caller owns or an operator-shared one (never another tenant's BYOK row). */
export async function checkModelAccess(model: ModelRef, owner: string): Promise<ModelRef> {
  const p = await repos.providers.get(model.provider);
  if (p && p.owner_id !== owner && !isOperatorOwner(p.owner_id)) throw notFound("provider", model.provider);
  return model;
}

/** Skill refs must name skills owned by the caller (the runner injects their bodies into the prompt). */
export async function checkSkillAccess(refs: SkillRef[], sc: Scope): Promise<SkillRef[]> {
  const ids = [...new Set(refs.map((r) => r.skill_id))];
  const found = new Set((await skillsRepo.getMany(ids, sc)).map((s) => s.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw notFound("skill", missing);
  return refs;
}

/** Package sources pi understands: npm:<pkg>, git:<url>, or a local path on the runner. */
export function validatePackages(packages: unknown): string[] {
  if (packages === undefined || packages === null) return [];
  if (!Array.isArray(packages) || !packages.every((p) => typeof p === "string" && p.trim() && !/\s/.test(p))) {
    throw invalid("packages must be an array of package sources (npm:<pkg>, git:<url>, or a path)");
  }
  const blocked = disallowedEverywhere(packages as string[]);
  if (blocked.length) throw invalid(`these plugin packages are not allowed in any placement (PLUGIN_ALLOW/PLUGIN_ALLOW_SANDBOX): ${blocked.join(", ")}`);
  return packages as string[];
}

/**
 * Remote MCP servers of a reusable agent. Credentials are deliberately NOT accepted here: a reusable
 * definition stays secret-free and each session authenticates from its own vaults (`credential_id`, or a
 * credential matched by URL) — the split both Claude Managed Agents and the OpenAI Agents API make.
 */
export function validateMcpServers(v: unknown): McpServerDecl[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid("mcp_servers must be an array");
  if (v.length > 20) throw invalid("at most 20 mcp_servers");
  const out: McpServerDecl[] = [];
  for (const raw of v) {
    const s = raw as Partial<McpServerDecl> & { authorization?: unknown; headers?: unknown };
    const label = s.label;
    if (typeof label !== "string" || !label) throw invalid("each mcp_servers entry needs a label");
    if (out.some((m) => m.label === label)) throw invalid(`mcp server label ${JSON.stringify(label)} is used more than once`);
    if (typeof s.url !== "string" || !s.url) throw invalid(`mcp server ${label} needs a url`);
    try { new URL(s.url); } catch { throw invalid(`mcp server ${label}: url ${JSON.stringify(s.url)} is not a valid URL`); }
    if (s.authorization !== undefined) throw invalid(`mcp server ${label}: an agent stores no credentials; put the token in a vault and reference it with credential_id`);
    if (s.headers !== undefined && (typeof s.headers !== "object" || Array.isArray(s.headers) || Object.values(s.headers as object).some((x) => typeof x !== "string"))) {
      throw invalid(`mcp server ${label}: headers must be a string map (non-secret headers only)`);
    }
    if (s.allowed_tools !== undefined && (!Array.isArray(s.allowed_tools) || s.allowed_tools.some((t) => typeof t !== "string"))) throw invalid(`mcp server ${label}: allowed_tools must be an array of tool names`);
    if (s.credential_id !== undefined && s.credential_id !== null && typeof s.credential_id !== "string") throw invalid(`mcp server ${label}: credential_id must be a vault credential id`);
    out.push({ label, url: s.url, headers: s.headers as Record<string, string> | undefined, allowed_tools: s.allowed_tools, credential_id: s.credential_id ?? undefined });
  }
  return out;
}

export function validateIds(v: unknown, prefix: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.startsWith(prefix + "_"))) throw invalid(`${prefix}s must be an array of ${prefix}_ ids`);
  return v as string[];
}

export const agents = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; model?: unknown; system?: string; tools?: unknown; packages?: unknown; skills?: unknown; mcp_servers?: unknown }>(c);
    if (!body.name) throw invalid("name is required");
    const agent = await repos.agents.create({
      owner_id: ownerId(c),
      name: body.name,
      model: await checkModelAccess(validateModel(body.model), ownerId(c)),
      system: body.system ?? null,
      tools: validateTools(body.tools),
      packages: validatePackages(body.packages),
      skills: await checkSkillAccess(validateSkillRefs(body.skills), scope(c)),
      mcp_servers: validateMcpServers(body.mcp_servers),
    });
    return c.json(agent, 201);
  })
  /** Edit an agent; existing sessions keep their snapshot (change a live one with PATCH /v1/sessions/:id). */
  .patch("/:id", async (c) => {
    const body = await readJson<{ name?: string; model?: unknown; system?: string | null; tools?: unknown; packages?: unknown; skills?: unknown; mcp_servers?: unknown }>(c);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.model !== undefined) patch.model = await checkModelAccess(validateModel(body.model), ownerId(c));
    if (body.system !== undefined) patch.system = body.system === null ? null : String(body.system);
    if (body.tools !== undefined) patch.tools = validateTools(body.tools);
    if (body.packages !== undefined) patch.packages = validatePackages(body.packages);
    if (body.skills !== undefined) patch.skills = await checkSkillAccess(validateSkillRefs(body.skills), scope(c));
    if (body.mcp_servers !== undefined) patch.mcp_servers = validateMcpServers(body.mcp_servers);
    const a = await repos.agents.update(c.req.param("id"), patch, scope(c));
    if (!a) throw notFound("agent", c.req.param("id"));
    return c.json(a);
  })
  .get("/", async (c) => c.json({ data: await repos.agents.list(scope(c)) }))
  .get("/:id", async (c) => {
    const a = await repos.agents.get(c.req.param("id"), scope(c));
    if (!a) throw notFound("agent", c.req.param("id"));
    return c.json(a);
  })
  /** Removed outright when unused; archived (hidden, not usable for new sessions) when sessions still reference it. */
  .delete("/:id", async (c) => {
    const r = await repos.agents.delete(c.req.param("id"), scope(c));
    if (!r) throw notFound("agent", c.req.param("id"));
    return c.json({ id: c.req.param("id"), object: "agent.deleted", deleted: true, archived: r.archived });
  });
