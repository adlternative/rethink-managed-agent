import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// Integration (real Postgres): run with PMA_IT=1 against the compose stack. Each run uses its own owner ids.
process.env.MESSAGING_BACKEND ??= "memory";

describe.skipIf(!process.env.PMA_IT)("agent/environment delete (remove vs archive) and session vault_ids", () => {
  const A = `prc_itdel_a_${randomBytes(5).toString("hex")}`;
  const B = `prc_itdel_b_${randomBytes(5).toString("hex")}`;
  let db: typeof import("../src/infra/db.ts");
  let appFor: (owner: string) => import("hono").Hono;
  const req = async (owner: string, method: string, path: string, body?: unknown) => {
    const res = await appFor(owner).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const agentBody = { name: "it-del", model: { provider: "qoder", id: "auto" } };
  const envBody = { name: "it-del", provider: "local", workspace: { kind: "empty" } };

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    const { Hono } = await import("hono");
    const { errorResponse } = await import("../src/api/errors.ts");
    const { agents } = await import("../src/api/routes/agents.ts");
    const { environments } = await import("../src/api/routes/environments.ts");
    const { sessions } = await import("../src/api/routes/sessions.ts");
    const { vaultsRoute } = await import("../src/api/routes/vaults.ts");
    const { openaiAgents } = await import("../src/api/routes/compat/openai-agents.ts");
    appFor = (owner) => new Hono().onError((e, c) => errorResponse(c, e))
      .use("*", async (c, next) => { c.set("owner" as never, owner as never); await next(); })
      .route("/v1/agents", agents).route("/v1/environments", environments).route("/v1/sessions", sessions)
      .route("/v1/vaults", vaultsRoute).route("/openai/v1", openaiAgents) as never;
    for (const id of [A, B]) await db.principals.upsert({ id, display_name: "it-del" });
    // the seeded qoder provider is operator-shared; make sure agents validate against it
  });

  afterAll(async () => {
    if (!db) return;
    for (const o of [A, B]) {
      await db.pool.query(`DELETE FROM session_environments WHERE session_id IN (SELECT id FROM sessions WHERE owner_id=$1)`, [o]);
      await db.pool.query(`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE owner_id=$1)`, [o]);
      await db.pool.query(`DELETE FROM sessions WHERE owner_id=$1`, [o]);
      await db.pool.query(`DELETE FROM workspaces WHERE owner_id=$1`, [o]);
      await db.pool.query(`DELETE FROM environments WHERE owner_id=$1`, [o]);
      await db.pool.query(`DELETE FROM agents WHERE owner_id=$1`, [o]);
      await db.pool.query(`DELETE FROM vaults WHERE owner_id=$1`, [o]);
      await db.pool.query(`DELETE FROM principals WHERE id=$1`, [o]);
    }
    await db.pool.end();
  });

  it("an unused agent and environment are removed outright", async () => {
    const ag = await req(A, "POST", "/v1/agents", agentBody);
    const en = await req(A, "POST", "/v1/environments", envBody);
    expect(ag.status).toBe(201); expect(en.status).toBe(201);
    expect(await req(A, "DELETE", `/v1/agents/${ag.json.id}`)).toEqual({ status: 200, json: { id: ag.json.id, object: "agent.deleted", deleted: true, archived: false } });
    expect(await req(A, "DELETE", `/v1/environments/${en.json.id}`)).toEqual({ status: 200, json: { id: en.json.id, object: "environment.deleted", deleted: true, archived: false } });
    expect((await db.pool.query(`SELECT 1 FROM agents WHERE id=$1 UNION ALL SELECT 1 FROM environments WHERE id=$2`, [ag.json.id, en.json.id])).rowCount).toBe(0);
  });

  it("an agent/environment referenced by a session is archived: hidden, unusable for new sessions, still readable by the runner", async () => {
    const ag = (await req(A, "POST", "/v1/agents", agentBody)).json;
    const en = (await req(A, "POST", "/v1/environments", envBody)).json;
    const s = await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id });
    expect(s.status).toBe(201);

    expect((await req(A, "DELETE", `/v1/agents/${ag.id}`)).json).toMatchObject({ deleted: true, archived: true });
    expect((await req(A, "DELETE", `/v1/environments/${en.id}`)).json).toMatchObject({ deleted: true, archived: true });

    // hidden from the owner
    expect((await req(A, "GET", `/v1/agents/${ag.id}`)).status).toBe(404);
    expect((await req(A, "GET", `/v1/environments/${en.id}`)).status).toBe(404);
    expect((await req(A, "GET", "/v1/agents")).json.data.map((x: any) => x.id)).not.toContain(ag.id);
    expect((await req(A, "GET", "/v1/environments")).json.data.map((x: any) => x.id)).not.toContain(en.id);
    expect((await req(A, "PATCH", `/v1/agents/${ag.id}`, { name: "x" })).status).toBe(404);
    // a second delete is a 404, not a hard delete of a referenced row
    expect((await req(A, "DELETE", `/v1/agents/${ag.id}`)).status).toBe(404);
    // unusable for new sessions
    expect((await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id })).status).toBe(404);
    // the existing session still reads fine and the runner (unscoped) still sees both rows
    expect((await req(A, "GET", `/v1/sessions/${s.json.id}`)).status).toBe(200);
    expect(await db.repos.agents.get(ag.id)).not.toBeNull();
    expect(await db.repos.environments.get(en.id)).not.toBeNull();
  });

  it("another tenant can neither see nor delete an agent/environment (404)", async () => {
    const ag = (await req(A, "POST", "/v1/agents", agentBody)).json;
    const en = (await req(A, "POST", "/v1/environments", envBody)).json;
    expect((await req(B, "DELETE", `/v1/agents/${ag.id}`)).status).toBe(404);
    expect((await req(B, "DELETE", `/v1/environments/${en.id}`)).status).toBe(404);
    expect(await db.repos.agents.get(ag.id, { owner: A })).not.toBeNull();
  });

  it("an environment attached only as a secondary environment is archived, not removed", async () => {
    const ag = (await req(A, "POST", "/v1/agents", agentBody)).json;
    const main = (await req(A, "POST", "/v1/environments", envBody)).json;
    const side = (await req(A, "POST", "/v1/environments", { ...envBody, name: "side" })).json;
    const s = await req(A, "POST", "/v1/sessions", { agent: ag.id, environments: [{ environment_id: main.id }, { key: "side", environment_id: side.id }] });
    expect(s.status).toBe(201);
    expect((await req(A, "DELETE", `/v1/environments/${side.id}`)).json).toMatchObject({ archived: true });
  });

  it("native POST /v1/sessions accepts the caller's vault_ids, dedupes them, and 404s on a foreign or unknown vault without writing rows", async () => {
    const ag = (await req(A, "POST", "/v1/agents", agentBody)).json;
    const en = (await req(A, "POST", "/v1/environments", envBody)).json;
    const va = (await req(A, "POST", "/v1/vaults", { name: "a" })).json;
    const vb = (await req(B, "POST", "/v1/vaults", { name: "b" })).json;

    const ok = await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id, vault_ids: [va.id, va.id] });
    expect(ok.status).toBe(201);
    expect(ok.json.vault_ids).toEqual([va.id]);

    const before = (await db.pool.query(`SELECT count(*)::int n FROM workspaces WHERE owner_id=$1`, [A])).rows[0].n;
    expect((await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id, vault_ids: [vb.id] })).status).toBe(404);
    expect((await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id, vault_ids: ["vault_nope"] })).status).toBe(404);
    expect((await req(A, "POST", "/v1/sessions", { agent: ag.id, environment_id: en.id, vault_ids: "vault_x" })).status).toBe(400);
    expect((await db.pool.query(`SELECT count(*)::int n FROM workspaces WHERE owner_id=$1`, [A])).rows[0].n).toBe(before);
  });

  it("OpenAI-compat session create also rejects a foreign vault", async () => {
    const en = (await req(A, "POST", "/v1/environments", envBody)).json;
    const vb = (await req(B, "POST", "/v1/vaults", { name: "b2" })).json;
    const r = await req(A, "POST", "/openai/v1/agents/sessions", { environment: { type: "reference", environment_id: en.id }, agent: { model: "qoder/auto" }, vault_ids: [vb.id] });
    expect(r.status).toBe(404);
  });
});
