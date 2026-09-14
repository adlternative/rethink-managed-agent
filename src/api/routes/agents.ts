import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import type { BuiltinToolName, ModelRef } from "../../shared/types.ts";
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

export function validateIds(v: unknown, prefix: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.startsWith(prefix + "_"))) throw invalid(`${prefix}s must be an array of ${prefix}_ ids`);
  return v as string[];
}

export const agents = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; model?: unknown; system?: string; tools?: unknown; packages?: unknown; skills?: unknown }>(c);
    if (!body.name) throw invalid("name is required");
    const agent = await repos.agents.create({
      owner_id: ownerId(c),
      name: body.name,
      model: await checkModelAccess(validateModel(body.model), ownerId(c)),
      system: body.system ?? null,
      tools: validateTools(body.tools),
      packages: validatePackages(body.packages),
      skills: await checkSkillAccess(validateSkillRefs(body.skills), scope(c)),
    });
    return c.json(agent, 201);
  })
  /** Edit an agent; existing sessions keep their snapshot (change a live one with PATCH /v1/sessions/:id). */
  .patch("/:id", async (c) => {
    const body = await readJson<{ name?: string; model?: unknown; system?: string | null; tools?: unknown; packages?: unknown; skills?: unknown }>(c);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.model !== undefined) patch.model = await checkModelAccess(validateModel(body.model), ownerId(c));
    if (body.system !== undefined) patch.system = body.system === null ? null : String(body.system);
    if (body.tools !== undefined) patch.tools = validateTools(body.tools);
    if (body.packages !== undefined) patch.packages = validatePackages(body.packages);
    if (body.skills !== undefined) patch.skills = await checkSkillAccess(validateSkillRefs(body.skills), scope(c));
    const a = await repos.agents.update(c.req.param("id"), patch, scope(c));
    if (!a) throw notFound("agent", c.req.param("id"));
    return c.json(a);
  })
  .get("/", async (c) => c.json({ data: await repos.agents.list(scope(c)) }))
  .get("/:id", async (c) => {
    const a = await repos.agents.get(c.req.param("id"), scope(c));
    if (!a) throw notFound("agent", c.req.param("id"));
    return c.json(a);
  });
