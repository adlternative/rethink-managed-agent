import { Hono } from "hono";
import { skills } from "../../infra/db.ts";
import { invalid, notFound, readJson } from "../errors.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Parse a SKILL.md (frontmatter name/description + body) or explicit fields. */
function parse(body: { name?: string; description?: string; body?: string; markdown?: string }) {
  let { name, description, body: text } = body;
  if (body.markdown) {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(body.markdown);
    if (m) {
      for (const line of m[1]!.split("\n")) { const i = line.indexOf(":"); if (i > 0) { const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, ""); if (k === "name") name ??= v; if (k === "description") description ??= v; } }
      text ??= m[2]!.trim();
    } else text ??= body.markdown.trim();
  }
  if (!name || !NAME_RE.test(name)) throw invalid(`name must match ${NAME_RE}`);
  if (!description) throw invalid("description is required (tells the model when to load the skill)");
  if (!text) throw invalid("body (or markdown) is required");
  return { name, description, body: text };
}

export const skillsRoute = new Hono()
  .post("/", async (c) => c.json(await skills.upsert(parse(await readJson(c))), 201))
  .get("/", async (c) => c.json({ data: await skills.list() }))
  .get("/:id", async (c) => {
    const s = await skills.get(c.req.param("id"));
    if (!s) throw notFound("skill", c.req.param("id"));
    return c.json(s);
  })
  .patch("/:id", async (c) => {
    const existing = await skills.get(c.req.param("id"));
    if (!existing) throw notFound("skill", c.req.param("id"));
    const body = await readJson<{ name?: string; description?: string; body?: string; markdown?: string }>(c);
    return c.json(await skills.upsert({ id: existing.id, ...parse({ name: body.name ?? existing.name, description: body.description ?? existing.description, body: body.body ?? existing.body, markdown: body.markdown }) }));
  })
  .delete("/:id", async (c) => {
    if (!(await skills.delete(c.req.param("id")))) throw notFound("skill", c.req.param("id"));
    return c.json({ id: c.req.param("id"), deleted: true });
  });
