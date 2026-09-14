import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { migrate } from "../infra/migrate.ts";
import { env } from "../shared/env.ts";
import { ApiError, errorResponse, limitBody } from "./errors.ts";
import { agents } from "./routes/agents.ts";
import { environments } from "./routes/environments.ts";
import { sessions } from "./routes/sessions.ts";
import { sandboxes } from "./routes/sandboxes.ts";
import { models } from "./routes/models.ts";
import { providers, seedProviders } from "./routes/providers.ts";
import { filesRoute, MAX_FILE_BYTES } from "./routes/files.ts";
import { skillsRoute } from "./routes/skills.ts";
import { memoryStoresRoute } from "./routes/memories.ts";
import { principalsRoute } from "./routes/principals.ts";
import { agentsApi } from "./routes/compat/agents-api.ts";
import { openaiAgents } from "./routes/compat/openai-agents.ts";
import { vaultsRoute } from "./routes/vaults.ts";
import { ui } from "./routes/ui.ts";
import { auth } from "./auth.ts";
import { ensureBucket } from "../infra/blobs.ts";
import { counter, histogram, render as renderMetrics } from "../infra/metrics.ts";
import { log } from "../infra/log.ts";
import { newId } from "../shared/ids.ts";

const httpReqs = counter("http_requests_total", "HTTP requests by method, route and status");
const httpDur = histogram("http_request_duration_seconds", "HTTP request duration");

export const app = new Hono<{ Variables: { requestId: string } }>()
  .onError((err, c) => errorResponse(c, err))
  .notFound((c) => errorResponse(c, new ApiError(404, "not_found_error", `no route ${c.req.method} ${c.req.path}`)))
  // request-id + structured access log + request metrics
  .use("*", async (c, next) => {
    const rid = c.req.header("x-request-id") || newId("req");
    c.set("requestId", rid);
    c.header("x-request-id", rid);
    const started = performance.now();
    await next();
    const seconds = (performance.now() - started) / 1000;
    const route = c.req.routePath || c.req.path;
    const labels = { method: c.req.method, route, status: String(c.res.status) };
    httpReqs.inc(labels);
    httpDur.observe(seconds, { route });
    if (c.req.path !== "/healthz" && c.req.path !== "/metrics") log.info("http", { rid, ...labels, ms: Math.round(seconds * 1000) });
  })
  // reject oversized bodies: early on content-length, and while streaming (chunked bodies have no header).
  // /v1/files gets its own larger cap (file size + multipart envelope slack).
  .use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "PUT") {
      const max = c.req.path.startsWith("/v1/files") ? MAX_FILE_BYTES + 64 * 1024 : env.API_MAX_BODY_BYTES;
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > max) return errorResponse(c, new ApiError(413, "payload_too_large", `request body exceeds ${max} bytes`));
      c.req.raw = limitBody(c.req.raw, max);
    }
    await next();
  })
  .get("/healthz", (c) => c.json({ ok: true }))
  .get("/metrics", async (c) => c.text(await renderMetrics(), 200, { "content-type": "text/plain; version=0.0.4" }))
  .route("/", ui)
  .use("/v1/*", auth())
  .use("/agents-api/v1/*", auth())
  .use("/openai/v1/*", auth())
  .route("/agents-api/v1", agentsApi)
  .route("/openai/v1", openaiAgents)
  .route("/v1", principalsRoute)
  .route("/v1/agents", agents)
  .route("/v1/environments", environments)
  .route("/v1/sessions", sessions)
  .route("/v1/sandboxes", sandboxes)
  .route("/v1/models", models)
  .route("/v1/providers", providers)
  .route("/v1/files", filesRoute)
  .route("/v1/skills", skillsRoute)
  .route("/v1/memory_stores", memoryStoresRoute)
  .route("/v1/vaults", vaultsRoute);

await migrate();
await ensureBucket();
await seedProviders();
serve({ fetch: app.fetch, port: env.API_PORT }, (info) => console.log(`api listening on :${info.port}`));
