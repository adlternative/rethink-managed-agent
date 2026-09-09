import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import type { BuiltinToolName, ModelRef } from "../../shared/types.ts";
import { invalid, notFound, readJson } from "../errors.ts";

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

export const agents = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; model?: unknown; system?: string; tools?: unknown }>(c);
    if (!body.name) throw invalid("name is required");
    const agent = await repos.agents.create({
      name: body.name,
      model: validateModel(body.model),
      system: body.system ?? null,
      tools: validateTools(body.tools),
    });
    return c.json(agent, 201);
  })
  .get("/", async (c) => c.json({ data: await repos.agents.list() }))
  .get("/:id", async (c) => {
    const a = await repos.agents.get(c.req.param("id"));
    if (!a) throw notFound("agent", c.req.param("id"));
    return c.json(a);
  });
