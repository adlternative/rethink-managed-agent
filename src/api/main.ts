import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { migrate } from "../infra/migrate.ts";
import { env } from "../shared/env.ts";
import { ApiError, errorResponse } from "./errors.ts";
import { agents } from "./routes/agents.ts";
import { environments } from "./routes/environments.ts";
import { sessions } from "./routes/sessions.ts";
import { sandboxes } from "./routes/sandboxes.ts";
import { models } from "./routes/models.ts";

export const app = new Hono()
  .onError((err, c) => errorResponse(c, err))
  .notFound((c) => errorResponse(c, new ApiError(404, "not_found_error", `no route ${c.req.method} ${c.req.path}`)))
  .get("/healthz", (c) => c.json({ ok: true }))
  .route("/v1/agents", agents)
  .route("/v1/environments", environments)
  .route("/v1/sessions", sessions)
  .route("/v1/sandboxes", sandboxes)
  .route("/v1/models", models);

await migrate();
serve({ fetch: app.fetch, port: env.API_PORT }, (info) => console.log(`api listening on :${info.port}`));
