import { Hono } from "hono";
import { memories } from "../../infra/db.ts";
import { invalid, notFound, readJson } from "../errors.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Memory stores: persistent directories mounted into sessions at .memory/<name>. */
export const memoriesRoute = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; description?: string }>(c);
    if (!body.name || !NAME_RE.test(body.name)) throw invalid(`name must match ${NAME_RE}`);
    return c.json(await memories.create({ name: body.name, description: body.description }), 201);
  })
  .get("/", async (c) => c.json({ data: await memories.list() }))
  .get("/:id", async (c) => {
    const m = await memories.get(c.req.param("id"));
    if (!m) throw notFound("memory", c.req.param("id"));
    return c.json(m);
  })
  .delete("/:id", async (c) => {
    if (!(await memories.delete(c.req.param("id")))) throw notFound("memory", c.req.param("id"));
    return c.json({ id: c.req.param("id"), deleted: true });
  });
