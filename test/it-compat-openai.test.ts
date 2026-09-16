import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import OpenAI from "openai7";

/**
 * Integration tests for /openai/v1 against a live Postgres (PMA_IT=1). Two unique owners per run
 * (a stub owner header instead of api keys), sessions created without input so no runner or queue
 * is involved. Everything created under those owners is removed afterwards.
 */

const IT = !!process.env.PMA_IT;
if (IT && !process.env.PMA_SECRET_KEY) process.env.PMA_SECRET_KEY = randomBytes(32).toString("base64");

describe.skipIf(!IT)("it: /openai/v1 against Postgres", () => {
  const tag = randomBytes(4).toString("hex");
  const A = `prc_itca_${tag}`;
  const B = `prc_itcb_${tag}`;
  let db: typeof import("../src/infra/db.ts");
  let app: Hono;
  let envA: string;
  let envB: string;

  const call = (owner: string, method: string, p: string, body?: unknown) =>
    app.request(`/openai/v1${p}`, { method, headers: { "content-type": "application/json", "x-owner": owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sdk = (owner: string) => new OpenAI({ apiKey: "x", baseURL: "http://local/openai/v1", fetch: (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url.toString());
    return app.request(`${u.pathname}${u.search}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-owner": owner } });
  }) as never, maxRetries: 0 });
  const createSession = async (owner: string, env: string) => {
    const res = await call(owner, "POST", "/agents/sessions", { agent: { model: "qoder/ultimate" }, environment: { environment_id: env } });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  };

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    const { openaiAgents } = await import("../src/api/routes/compat/openai-agents.ts");
    const { errorResponse } = await import("../src/api/errors.ts");
    app = new Hono()
      .onError((err, c) => errorResponse(c, err))
      .use("*", async (c, next) => { c.set("owner" as never, c.req.header("x-owner") as never); await next(); })
      .route("/openai/v1", openaiAgents) as unknown as Hono;
    for (const id of [A, B]) await db.principals.upsert({ id, handle: `it-compat-${id}`, display_name: "it compat" });
    const mkEnv = async (owner: string) => (await db.repos.environments.create({ owner_id: owner, name: `it-compat-${tag}`, provider: "local", image: "none", workspace: { kind: "empty" } } as never)).id;
    envA = await mkEnv(A);
    envB = await mkEnv(B);
  });

  afterAll(async () => {
    if (!db) return;
    const owners = [A, B];
    await db.pool.query(`DELETE FROM sessions WHERE owner_id = ANY($1::text[])`, [owners]);
    await db.pool.query(`DELETE FROM workspaces WHERE owner_id = ANY($1::text[])`, [owners]);
    await db.pool.query(`DELETE FROM agents WHERE owner_id = ANY($1::text[])`, [owners]);
    await db.pool.query(`DELETE FROM environments WHERE owner_id = ANY($1::text[])`, [owners]);
    await db.pool.query(`DELETE FROM vault_credentials WHERE vault_id IN (SELECT id FROM vaults WHERE owner_id = ANY($1::text[]))`, [owners]);
    await db.pool.query(`DELETE FROM vaults WHERE owner_id = ANY($1::text[])`, [owners]);
    await db.pool.query(`DELETE FROM principals WHERE id = ANY($1::text[])`, [owners]);
    await db.pool.end();
  });

  it("the first page of sessions.list only returns the caller's sessions", async () => {
    const ids = [await createSession(A, envA), await createSession(A, envA), await createSession(A, envA)];
    await createSession(B, envB);
    const res = await call(A, "GET", "/agents/sessions?limit=50");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((s: any) => s.id).sort()).toEqual([...ids].sort());
  });

  // Regression: the SDK's second page sends after=<session id>, which listPage casts to timestamptz -> 500.
  it("SDK auto-pagination with limit 2 returns all 3 sessions without a 500", async () => {
    const owner = `prc_itcp_${tag}`;
    await db.principals.upsert({ id: owner, handle: `it-compat-${owner}`, display_name: "it compat" });
    const env = (await db.repos.environments.create({ owner_id: owner, name: `it-compat-${tag}`, provider: "local", image: "none", workspace: { kind: "empty" } } as never)).id;
    try {
      const ids = [await createSession(owner, env), await createSession(owner, env), await createSession(owner, env)];
      const seen: string[] = [];
      for await (const s of sdk(owner).beta.agents.sessions.list({ limit: 2 } as never)) seen.push(s.id);
      expect(seen.sort()).toEqual([...ids].sort());
    } finally {
      for (const t of ["sessions", "workspaces", "agents", "environments"]) await db.pool.query(`DELETE FROM ${t} WHERE owner_id=$1`, [owner]);
      await db.pool.query(`DELETE FROM principals WHERE id=$1`, [owner]);
    }
  });

  it("B gets 404 on every route of A's session and cannot use A's environment", async () => {
    const sid = await createSession(A, envA);
    const child = await db.repos.sessions.create({ owner_id: A, agent_id: (await db.repos.sessions.get(sid))!.agent_id, environment_id: envA, workspace_id: (await db.repos.sessions.get(sid))!.workspace_id, agent: (await db.repos.sessions.get(sid))!.agent, parent_id: sid });
    const routes: [string, string, unknown?][] = [
      ["GET", `/agents/sessions/${sid}`], ["POST", `/agents/sessions/${sid}`, {}], ["POST", `/agents/sessions/${sid}/events`, { events: [{ type: "agent.session.input.cancel" }] }],
      ["GET", `/agents/sessions/${sid}/events`], ["GET", `/agents/sessions/${sid}/items`], ["GET", `/agents/sessions/${sid}/turns`],
      ["GET", `/agents/sessions/${sid}/artifacts`], ["GET", `/agents/sessions/${sid}/subagents`], ["GET", `/agents/sessions/${sid}/subagents/${child.id}`],
      ["DELETE", `/agents/sessions/${sid}`],
    ];
    for (const [m, p, b] of routes) expect([m, p, (await call(B, m, p, b)).status]).toEqual([m, p, 404]);
    expect(await db.repos.sessions.get(sid)).not.toBeNull();
    const res = await call(B, "POST", "/agents/sessions", { agent: { model: "m" }, environment: { environment_id: envA } });
    expect(res.status).toBe(404);
    // B's own session cannot reach A's child as a subagent
    const sidB = await createSession(B, envB);
    expect((await call(B, "GET", `/agents/sessions/${sidB}/subagents/${child.id}`)).status).toBe(404);
    expect((await (await call(A, "GET", `/agents/sessions/${sid}/subagents/${child.id}`)).json()).id).toBe(child.id);
  });

  it("B cannot see or modify A's vault and credentials; secrets are never returned", async () => {
    const v = await (await call(A, "POST", "/vaults", { name: "a" })).json();
    const cred = await call(A, "POST", `/vaults/${v.id}/credentials`, { name: "TOKEN", auth: { type: "static_bearer", mcp_server_url: "https://tenant-a.example.com/mcp", token: "super-secret-value" } });
    expect(cred.status).toBe(201);
    expect(await cred.text()).not.toContain("super-secret-value");
    expect((await call(B, "GET", `/vaults/${v.id}`)).status).toBe(404);
    expect((await call(B, "GET", `/vaults/${v.id}/credentials`)).status).toBe(404);
    expect((await call(B, "POST", `/vaults/${v.id}/credentials`, { name: "X", value: "y" })).status).toBe(404);
    expect((await call(B, "DELETE", `/vaults/${v.id}/credentials/TOKEN`)).status).toBe(404);
    expect((await call(B, "DELETE", `/vaults/${v.id}`)).status).toBe(404);
    expect((await (await call(B, "GET", "/vaults")).json()).data.map((x: any) => x.id)).not.toContain(v.id);
    const list = await (await call(A, "GET", `/vaults/${v.id}/credentials`)).text();
    expect(JSON.parse(list).data.map((c: any) => c.name)).toEqual(["TOKEN"]);
    expect(list).not.toContain("super-secret-value");
  });
});
