import { Hono } from "hono";
import { createModelRegistry } from "../../harness/models.ts";

/** Models the runner can resolve; lets clients populate a picker without hardcoding ids. */
let cache: { provider: string; id: string; name: string; context_window: number }[] | null = null;
export const models = new Hono().get("/", (c) => {
  cache ??= createModelRegistry()
    .getModels()
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name, context_window: m.contextWindow }));
  return c.json({ data: cache });
});
