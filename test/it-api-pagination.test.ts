import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";

// Integration (real Postgres): run with PMA_IT=1 against the compose stack. Each run uses its own owner id.
process.env.MESSAGING_BACKEND ??= "memory";

describe.skipIf(!process.env.PMA_IT)("api pagination and query params against Postgres", () => {
  const OWNER = `prc_itapi_${randomBytes(6).toString("hex")}`;
  let db: typeof import("../src/infra/db.ts");
  let app: import("hono").Hono;
  let listEvents: typeof import("../src/infra/events.ts").listEvents;
  const ids: string[] = [];

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    ({ listEvents } = await import("../src/infra/events.ts"));
    const { Hono } = await import("hono");
    const { errorResponse } = await import("../src/api/errors.ts");
    const { sessions } = await import("../src/api/routes/sessions.ts");
    app = new Hono().onError((e, c) => errorResponse(c, e)).use("*", async (c, next) => { c.set("owner" as never, OWNER as never); await next(); }).route("/v1/sessions", sessions) as never;

    await db.principals.upsert({ id: OWNER, display_name: "it-api" });
    const agent = await db.repos.agents.create({ owner_id: OWNER, name: "it", model: { provider: "qoder", id: "auto" }, system: null, tools: [], packages: [], skills: [] });
    const env = await db.repos.environments.create({ owner_id: OWNER, name: "it", provider: "local", image: null, network: "none", plugin_host: "runner", workspace: { kind: "empty" } });
    const ws = await db.repos.workspaces.create({ kind: "empty" }, { kind: "empty" }, OWNER);
    // Three sessions inside the same millisecond, distinct microseconds (as concurrent child spawns produce).
    for (const us of ["100", "400", "900"]) {
      const s = await db.repos.sessions.create({ owner_id: OWNER, agent_id: agent.id, environment_id: env.id, workspace_id: ws.id, agent: { ...agent } as never });
      await db.pool.query(`UPDATE sessions SET created_at = $2::timestamptz WHERE id=$1`, [s.id, `2026-01-01T12:00:00.123${us}Z`]);
      ids.push(s.id);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool.query(`DELETE FROM sessions WHERE owner_id=$1`, [OWNER]);
    await db.pool.query(`DELETE FROM workspaces WHERE owner_id=$1`, [OWNER]);
    await db.pool.query(`DELETE FROM environments WHERE owner_id=$1`, [OWNER]);
    await db.pool.query(`DELETE FROM agents WHERE owner_id=$1`, [OWNER]);
    await db.pool.query(`DELETE FROM principals WHERE id=$1`, [OWNER]);
    await db.pool.end();
  });

  it("limit=200 returns all three sessions newest first", async () => {
    const page = await db.repos.sessions.listPage({ owner: OWNER }, { limit: 200 });
    expect(page.data.map((s) => s.id)).toEqual([...ids].reverse());
  });

  // Regression: next_cursor is the millisecond ISO string and the predicate is `created_at < cursor` with no id tiebreaker.
  it("paging with limit=1 via next_cursor returns every session exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await db.repos.sessions.listPage({ owner: OWNER }, { limit: 1, cursor });
      seen.push(...page.data.map((s) => s.id));
      if (!page.has_more) break;
      cursor = page.next_cursor!;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });

  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  // Regression: `LIMIT NaN` / a non-timestamp cursor reach Postgres and surface as 500.
  it("GET /v1/sessions?limit=abc -> 400", async () => {
    quiet();
    expect((await app.request("/v1/sessions?limit=abc")).status).toBe(400);
  });
  it("GET /v1/sessions?cursor=not-a-date -> 400", async () => {
    quiet();
    expect((await app.request("/v1/sessions?cursor=not-a-date")).status).toBe(400);
  });
  it("GET /v1/sessions/:id/events?since=abc -> 400", async () => {
    quiet();
    expect((await app.request(`/v1/sessions/${ids[0]}/events?since=abc`)).status).toBe(400);
  });

  it("Postgres itself rejects the NaN/negative inputs the routes forward (confirms the hermetic fake)", async () => {
    await expect(listEvents(ids[0]!, { since: NaN })).rejects.toThrow(/NaN/);
    await expect(listEvents(ids[0]!, { limit: -1 })).rejects.toThrow(/negative/);
    await expect(db.repos.sessions.listPage({ owner: OWNER }, { limit: NaN })).rejects.toThrow();
  });
});
