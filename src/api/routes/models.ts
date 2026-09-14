import { Hono } from "hono";
import { repos } from "../../infra/db.ts";
import { isOperatorOwner } from "../../harness/models.ts";
import { ownerId } from "../auth.ts";

/** Flat model list across the enabled providers the caller may use (its own plus operator-shared ones). */
export const models = new Hono().get("/", async (c) => {
  const owner = ownerId(c);
  const data = (await repos.providers.list())
    .filter((p) => p.enabled && (p.owner_id === owner || isOperatorOwner(p.owner_id)))
    .flatMap((p) => p.models.map((m) => ({ provider: p.id, id: m.id, name: m.name ?? `${p.id}/${m.id}`, context_window: m.context_window })));
  return c.json({ data });
});
