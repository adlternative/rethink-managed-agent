import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hermetic: the real app from src/api/main.ts, with Postgres/Redis/blob/server modules replaced by in-memory fakes.
vi.hoisted(() => { process.env.MESSAGING_BACKEND = "memory"; process.env.LOG_LEVEL = "error"; });
vi.mock("@hono/node-server", () => ({ serve: () => {} }));
vi.mock("../src/infra/migrate.ts", () => ({ migrate: async () => {} }));
vi.mock("../src/infra/db.ts", () => import("./fixtures/api-harness/fake-db.ts"));
vi.mock("../src/infra/events.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).events);
vi.mock("../src/infra/queue.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).queue);
vi.mock("../src/infra/byoc.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).byoc);
vi.mock("../src/infra/blobs.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).blobs);
vi.mock("../src/sandbox/lease-store.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).leaseStore);

const { app } = await import("../src/api/main.ts");
const { env } = await import("../src/shared/env.ts");
const { store, reset, seed, apiKeys } = await import("./fixtures/api-harness/fake-db.ts");
const { headerResolver } = await import("./fixtures/api-harness/fakes.ts");
const { setResolver, loadResolver, bearerApiKeyResolver } = await import("../src/api/principal-resolver.ts");
const { errorResponse, ApiError } = await import("../src/api/errors.ts");

const saved = { ...env };
beforeEach(() => { reset(); setResolver(undefined); });
afterEach(() => { Object.assign(env, saved); setResolver(undefined); vi.restoreAllMocks(); });

const json = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("auth() middleware", () => {
  it("AUTH_REQUIRED=true without credentials -> 401 authentication_error envelope", async () => {
    env.AUTH_REQUIRED = true;
    const r = await app.request("/v1/agents");
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("AUTH_REQUIRED=true guards the compat prefixes too", async () => {
    env.AUTH_REQUIRED = true;
    expect((await app.request("/openai/v1/agents")).status).toBe(401);
    expect((await app.request("/agents-api/v1/agents")).status).toBe(401);
  });

  it("AUTH_REQUIRED=false provisions PMA_DEFAULT_PRINCIPAL on a miss and scopes to it", async () => {
    env.AUTH_REQUIRED = false;
    env.PMA_DEFAULT_PRINCIPAL = "prc_devdefault";
    seed.agent("prc_devdefault", { name: "mine" });
    seed.agent("prc_other", { name: "theirs" });
    const r = await app.request("/v1/agents");
    expect(r.status).toBe(200);
    const body = await r.json() as { data: { name: string }[] };
    expect(body.data.map((a) => a.name)).toEqual(["mine"]);
    expect(store.ops).toContain("principals.upsert:prc_devdefault");
    const me = await (await app.request("/v1/me")).json() as { id: string };
    expect(me.id).toBe("prc_devdefault");
  });

  it("AUTH_REQUIRED=false reuses an existing default principal (no upsert)", async () => {
    env.PMA_DEFAULT_PRINCIPAL = "prc_seeded";
    seed.principal("prc_seeded");
    await app.request("/v1/agents");
    expect(store.ops.filter((o) => o.startsWith("principals.upsert"))).toEqual([]);
  });

  it("a resolver-supplied owner (org) is the scope for reads and the owner stamped on writes, not actor.id", async () => {
    setResolver(headerResolver);
    seed.agent("org_x", { name: "org-agent" });
    seed.agent("prc_a", { name: "personal" });
    const list = await (await app.request("/v1/agents", { headers: { "x-as": "prc_a", "x-org": "org_x" } })).json() as { data: { name: string }[] };
    expect(list.data.map((a) => a.name)).toEqual(["org-agent"]);
    const created = await json("POST", "/v1/agents", { name: "n", model: { provider: "qoder", id: "auto" } }, { "x-as": "prc_a", "x-org": "org_x" });
    expect(created.status).toBe(201);
    expect((await created.json() as { owner_id: string }).owner_id).toBe("org_x");
    const me = await (await app.request("/v1/me", { headers: { "x-as": "prc_a", "x-org": "org_x" } })).json() as { id: string };
    expect(me.id).toBe("prc_a"); // actor is still the caller
  });

  it("a bearer token from the built-in resolver authenticates when AUTH_REQUIRED=true", async () => {
    env.AUTH_REQUIRED = true;
    seed.principal("prc_bearer");
    seed.agent("prc_bearer", { name: "b" });
    const { token } = await apiKeys.create("prc_bearer");
    const r = await app.request("/v1/agents", { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect((await r.json() as { data: unknown[] }).data).toHaveLength(1);
    const bad = await app.request("/v1/agents", { headers: { authorization: "Bearer pma_wrong" } });
    expect(bad.status).toBe(401);
  });

  it("the BYOC worker endpoints skip principal auth (they use x-worker-key)", async () => {
    env.AUTH_REQUIRED = true;
    const e = seed.environment("prc_a", { provider: "byoc", worker_key: "wk_secret" });
    const r = await json("POST", `/v1/environments/${e.id}/worker/result`, { req_id: "req_1", type: "done" }, { "x-worker-key": "wk_secret" });
    expect(r.status).toBe(200);
  });

  // Regression: the bypass regex /\/worker(\/|$)/ matches any path with a "worker" segment, so these run unauthenticated.
  for (const [method, path] of [["GET", "/v1/sessions/worker"], ["GET", "/v1/principals/worker"], ["DELETE", "/v1/vaults/v1/credentials/worker"], ["GET", "/openai/v1/agents/sessions/worker"]] as const) {
    it(`only /v1/environments/:id/worker/* skips auth: ${method} ${path} -> 401`, async () => {
      env.AUTH_REQUIRED = true;
      const r = await app.request(path, { method });
      expect(r.status).toBe(401);
    });
  }
});

describe("principal resolver", () => {
  const req = (h: Record<string, string>) => ({ header: (n: string) => h[n.toLowerCase()], method: "GET", path: "/v1/x" });

  it("bearer parsing: scheme is case-insensitive, token trimmed; empty token or other schemes -> null", async () => {
    seed.principal("prc_p");
    const { token } = await apiKeys.create("prc_p");
    expect((await bearerApiKeyResolver.resolve(req({ authorization: `bearer ${token}` })))?.actor.id).toBe("prc_p");
    expect((await bearerApiKeyResolver.resolve(req({ authorization: `Bearer    ${token}   ` })))?.actor.id).toBe("prc_p");
    expect(await bearerApiKeyResolver.resolve(req({ authorization: "Bearer " }))).toBeNull();
    expect(await bearerApiKeyResolver.resolve(req({ authorization: "Bearer" }))).toBeNull();
    expect(await bearerApiKeyResolver.resolve(req({ authorization: `Basic ${token}` }))).toBeNull();
  });

  it("PRINCIPAL_RESOLVER module without a default/named resolver rejects with a descriptive error", async () => {
    env.PRINCIPAL_RESOLVER = new URL("./fixtures/api-resolvers/no-resolver.ts", import.meta.url).pathname;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(loadResolver()).rejects.toThrow(/must default-export a \{ resolve \} PrincipalResolver/);
  });

  it("PRINCIPAL_RESOLVER module exporting a named `resolver` is accepted, and setResolver(undefined) resets the cache", async () => {
    env.PRINCIPAL_RESOLVER = new URL("./fixtures/api-resolvers/named-resolver.ts", import.meta.url).pathname;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await loadResolver();
    expect((await r.resolve(req({})))?.actor.id).toBe("prc_named");
    expect(await loadResolver()).toBe(r); // cached
    env.PRINCIPAL_RESOLVER = "";
    expect(await loadResolver()).toBe(r); // still cached until reset
    setResolver(undefined);
    expect(await loadResolver()).toBe(bearerApiKeyResolver);
  });

  it("a resolver that throws ApiError(401) yields a 401 envelope even with AUTH_REQUIRED=false", async () => {
    setResolver({ resolve: async () => { throw new ApiError(401, "authentication_error", "bad jwt"); } });
    const r = await app.request("/v1/agents");
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { type: "authentication_error", message: "bad jwt" } });
  });
});

describe("principals routes", () => {
  it("POST /v1/api_keys for self returns a token once", async () => {
    setResolver(headerResolver);
    seed.principal("prc_a");
    const r = await json("POST", "/v1/api_keys", {}, { "x-as": "prc_a" });
    expect(r.status).toBe(201);
    const body = await r.json() as { principal_id: string; token: string };
    expect(body.principal_id).toBe("prc_a");
    expect(body.token).toMatch(/^pma_/);
  });

  it("POST /v1/api_keys for an unknown principal -> 404", async () => {
    setResolver(headerResolver);
    expect((await json("POST", "/v1/api_keys", { principal_id: "prc_ghost" }, { "x-as": "prc_a" })).status).toBe(404);
  });

  it("POST /v1/principals rejects an unknown kind", async () => {
    expect((await json("POST", "/v1/principals", { kind: "admin" })).status).toBe(400);
  });

  // Regression (account takeover): any authenticated caller can mint a token for any principal_id.
  it("POST /v1/api_keys for another principal is forbidden (403)", async () => {
    env.AUTH_REQUIRED = true;
    seed.principal("prc_a"); seed.principal("prc_b");
    const { token } = await apiKeys.create("prc_a");
    const r = await json("POST", "/v1/api_keys", { principal_id: "prc_b" }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(403);
  });

  // Regression: GET /v1/principals lists every tenant.
  it("GET /v1/principals does not list other tenants when AUTH_REQUIRED=true", async () => {
    env.AUTH_REQUIRED = true;
    seed.principal("prc_a"); seed.principal("prc_b");
    const { token } = await apiKeys.create("prc_a");
    const r = await app.request("/v1/principals", { headers: { authorization: `Bearer ${token}` } });
    const ids = r.status === 200 ? (await r.json() as { data: { id: string }[] }).data.map((p) => p.id) : [];
    expect(r.status === 403 || (r.status === 200 && !ids.includes("prc_b"))).toBe(true);
  });
});

describe("app-level middleware and error shapes", () => {
  it("echoes an incoming x-request-id and generates req_* otherwise", async () => {
    const r1 = await app.request("/healthz", { headers: { "x-request-id": "abc-123" } });
    expect(r1.headers.get("x-request-id")).toBe("abc-123");
    const r2 = await app.request("/healthz");
    expect(r2.headers.get("x-request-id")).toMatch(/^req_/);
    const r3 = await app.request("/nope"); // also on error responses
    expect(r3.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("unknown route -> 404 not_found_error envelope", async () => {
    const r = await app.request("/v1/definitely-not-a-route/x/y");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
  });

  it("a thrown non-ApiError -> 500 api_error envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.hooks.listThrow = "boom";
    const r = await app.request("/v1/agents");
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
  });

  it("errorResponse maps ApiError status/type and non-errors to 500", async () => {
    const { Hono } = await import("hono");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = new Hono().get("/a", (c) => errorResponse(c, new ApiError(409, "conflict", "x"))).get("/b", (c) => errorResponse(c, "str"));
    const a = await h.request("/a");
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({ type: "error", error: { type: "conflict", message: "x" } });
    const b = await h.request("/b");
    expect(b.status).toBe(500);
    expect(await b.json()).toEqual({ type: "error", error: { type: "api_error", message: "str" } });
  });

  it("malformed JSON -> 400 'body must be valid JSON'", async () => {
    const r = await json("POST", "/v1/agents", "{not json");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { type: "invalid_request_error", message: "body must be valid JSON" } });
  });

  // Regression: `null` parses as JSON, then `body.name` throws a TypeError -> 500 leaking the internal message.
  it("JSON body `null` on POST /v1/agents -> 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await json("POST", "/v1/agents", "null");
    expect(r.status).toBe(400);
  });

  // Regression: Hono's formData() TypeError on a bad multipart body is not an ApiError -> 500.
  it("malformed multipart on POST /v1/files -> 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await app.request("/v1/files", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zz" }, body: "garbage" });
    expect(r.status).toBe(400);
  });
});

describe("body size limit", () => {
  const agentBody = (pad: number) => JSON.stringify({ name: "big", model: { provider: "qoder", id: "auto" }, system: "x".repeat(pad) });

  it("content-length above API_MAX_BODY_BYTES -> 413 payload_too_large (POST and PATCH)", async () => {
    env.API_MAX_BODY_BYTES = 100;
    const body = agentBody(500);
    const r = await app.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "payload_too_large" } });
    const p = await app.request("/v1/agents/agent_x", { method: "PATCH", headers: { "content-type": "application/json", "content-length": String(body.length) }, body });
    expect(p.status).toBe(413);
    expect(store.ops.filter((o) => o.startsWith("agents.create"))).toEqual([]);
  });

  it("a body under the limit passes through", async () => {
    env.API_MAX_BODY_BYTES = 10_000;
    const body = agentBody(10);
    const r = await app.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body });
    expect(r.status).toBe(201);
  });

  // Regression: only the content-length header is checked; a chunked body of any size is read and parsed.
  it("a chunked (no content-length) body above the limit is rejected", async () => {
    env.API_MAX_BODY_BYTES = 100;
    const bytes = new TextEncoder().encode(agentBody(5000));
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 256) c.enqueue(bytes.slice(i, i + 256)); c.close(); } });
    const r = await app.request(new Request("http://localhost/v1/agents", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    expect(r.status).toBe(413);
    expect(store.ops.filter((o) => o.startsWith("agents.create"))).toEqual([]);
  });

  // Regression: /v1/files is exempt from the limit and files.ts buffers the whole body before its 32MB check.
  it("POST /v1/files over 32MB is rejected without reading the whole body", async () => {
    const CHUNK = 1024 * 1024; const TOTAL = 48; let pulled = 0; let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= TOTAL) { c.close(); return; } sent++; pulled += CHUNK; c.enqueue(new Uint8Array(CHUNK)); } });
    const r = await app.request(new Request("http://localhost/v1/files", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: stream, duplex: "half" } as RequestInit));
    expect(r.status === 400 || r.status === 413).toBe(true);
    expect(pulled).toBeLessThan(40 * CHUNK);
  });
});
