import { Hono } from "hono";
import { repos } from "../../infra/db.ts";

/** Flat model list across enabled providers (what agent.model may reference). */
export const models = new Hono().get("/", async (c) => {
  const data = (await repos.providers.list())
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ provider: p.id, id: m.id, name: m.name ?? `${p.id}/${m.id}`, context_window: m.context_window })));
  return c.json({ data });
});
