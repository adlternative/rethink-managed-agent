import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// Integration (real Postgres): run with PMA_IT=1 against the compose stack. Uses its own owner id.
process.env.MESSAGING_BACKEND ??= "memory";

describe.skipIf(!process.env.PMA_IT)("MCP credentials are sealed at rest and never returned by the API", () => {
  const OWNER = `prc_itmcp_${randomBytes(5).toString("hex")}`;
  const TOKEN = "Bearer IT-MCP-SECRET-TOKEN";
  let db: typeof import("../src/infra/db.ts");
  let env: typeof import("../src/shared/env.ts").env;
  let creds: typeof import("../src/infra/mcp-credentials.ts");
  let migrate: typeof import("../src/infra/migrate.ts");
  let app: import("hono").Hono;
  let envId = "";
  const savedKey = { v: "" };
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const mcpTool = { type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://docs.example.com/mcp", authorization: TOKEN, headers: { "x-api-key": "IT-HEADER-SECRET" } } };
  const rowText = async (id: string) => (await db.pool.query(`SELECT agent::text AS a FROM sessions WHERE id=$1`, [id])).rows[0]?.a as string;

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    ({ env } = await import("../src/shared/env.ts"));
    creds = await import("../src/infra/mcp-credentials.ts");
    migrate = await import("../src/infra/migrate.ts");
    savedKey.v = env.PMA_SECRET_KEY;
    if (!env.PMA_SECRET_KEY) env.PMA_SECRET_KEY = "d".repeat(64);
    const { Hono } = await import("hono");
    const { errorResponse } = await import("../src/api/errors.ts");
    const { sessions } = await import("../src/api/routes/sessions.ts");
    const { openaiAgents } = await import("../src/api/routes/compat/openai-agents.ts");
    const { agentsApi } = await import("../src/api/routes/compat/agents-api.ts");
    app = new Hono().onError((e, c) => errorResponse(c, e))
      .use("*", async (c, next) => { c.set("owner" as never, OWNER as never); await next(); })
      .route("/v1/sessions", sessions).route("/openai/v1", openaiAgents).route("/agents-api/v1", agentsApi) as never;
    await db.principals.upsert({ id: OWNER, display_name: "it-mcp" });
    envId = (await db.repos.environments.create({ owner_id: OWNER, name: "it-mcp", provider: "local", image: null, network: "none", plugin_host: "runner", workspace: { kind: "empty" } } as never)).id;
  });

  afterAll(async () => {
    if (!db) return;
    env.PMA_SECRET_KEY = savedKey.v;
    for (const q of [
      `DELETE FROM session_environments WHERE session_id IN (SELECT id FROM sessions WHERE owner_id=$1)`,
      `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE owner_id=$1)`,
      `DELETE FROM sessions WHERE owner_id=$1`, `DELETE FROM workspaces WHERE owner_id=$1`, `DELETE FROM environments WHERE owner_id=$1`,
      `DELETE FROM agents WHERE owner_id=$1`, `DELETE FROM principals WHERE id=$1`,
    ]) await db.pool.query(q, [OWNER]);
    await db.pool.end();
  });

  it("OpenAI-compat create stores the MCP credentials sealed; native GET, list and archive never echo them", async () => {
    const created = await req("POST", "/openai/v1/agents/sessions", { environment: { type: "reference", environment_id: envId }, agent: { model: "qoder/auto", tools: [mcpTool] } });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain("IT-MCP-SECRET-TOKEN");
    const id = JSON.parse(created.text).id as string;

    const stored = await rowText(id);
    expect(stored).not.toContain("IT-MCP-SECRET-TOKEN");
    expect(stored).not.toContain("IT-HEADER-SECRET");
    expect(stored).toContain('"type": "encrypted"');

    for (const r of [await req("GET", `/v1/sessions/${id}`), await req("GET", "/v1/sessions?limit=50"), await req("POST", `/v1/sessions/${id}/archive`, {})]) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("IT-MCP-SECRET-TOKEN");
      expect(r.text).not.toContain("IT-HEADER-SECRET");
      expect(r.text).not.toContain('"ct"'); // no ciphertext either
    }
    const got = JSON.parse((await req("GET", `/v1/sessions/${id}`)).text);
    expect(got.agent.mcp_servers).toEqual([{ label: "docs", url: "https://docs.example.com/mcp", authorization: "[redacted]", headers: { "x-api-key": "[redacted]" } }]);

    // what the runner loads opens back to the real credentials
    const session = await db.repos.sessions.get(id);
    expect(creds.openMcpCredentials(session!.agent.mcp_servers![0]!)).toEqual({ authorization: TOKEN, headers: { "x-api-key": "IT-HEADER-SECRET" } });
  });

  it("the legacy /agents-api/v1 create seals too", async () => {
    const created = await req("POST", "/agents-api/v1/sessions", { environment: { environment_id: envId }, agent: { model: "qoder/auto", tools: [mcpTool] } });
    expect(created.status).toBe(201);
    const stored = await rowText(JSON.parse(created.text).id);
    expect(stored).not.toContain("IT-MCP-SECRET-TOKEN");
    expect(stored).toContain('"type": "encrypted"');
  });

  it("without PMA_SECRET_KEY a credentialed MCP server is refused (400) and nothing is written", async () => {
    const before = (await db.pool.query(`SELECT count(*)::int n FROM sessions WHERE owner_id=$1`, [OWNER])).rows[0].n;
    const key = env.PMA_SECRET_KEY;
    env.PMA_SECRET_KEY = "";
    try {
      const r = await req("POST", "/openai/v1/agents/sessions", { environment: { type: "reference", environment_id: envId }, agent: { model: "qoder/auto", tools: [mcpTool] } });
      expect(r.status).toBe(400);
      expect(r.text).toMatch(/PMA_SECRET_KEY/);
      // a server without credentials is still fine without a key
      const open = await req("POST", "/openai/v1/agents/sessions", { environment: { type: "reference", environment_id: envId }, agent: { model: "qoder/auto", tools: [{ type: "mcp", server_label: "open", transport: { type: "http", server_url: "https://open.example.com/mcp" } }] } });
      expect(open.status).toBe(201);
    } finally { env.PMA_SECRET_KEY = key; }
    expect((await db.pool.query(`SELECT count(*)::int n FROM sessions WHERE owner_id=$1`, [OWNER])).rows[0].n).toBe(before + 1);
  });

  it("a vault credential authenticates a server declared without credentials, and rotation reaches the next run", async () => {
    const url = "https://vaulted.example.com/mcp";
    const vault = await db.vaults.create({ owner_id: OWNER, name: "it-mcp-vault" });
    const cred = await db.vaultCredentials.put(vault.id, { name: "vaulted", value: "IT-VAULT-TOKEN", kind: "static_bearer", mcp_server_url: url });
    expect(cred).toMatchObject({ kind: "static_bearer", mcp_server_url: url });
    expect(JSON.stringify(cred)).not.toContain("IT-VAULT-TOKEN");

    const created = await req("POST", "/openai/v1/agents/sessions", {
      environment: { type: "reference", environment_id: envId },
      agent: { model: "qoder/auto", tools: [{ type: "mcp", server_label: "vaulted", transport: { type: "http", server_url: `HTTPS://Vaulted.example.com:443/mcp/` } }] },
      vault_ids: [vault.id],
    });
    expect(created.status).toBe(201);
    const session = (await db.repos.sessions.get(JSON.parse(created.text).id))!;

    // what the runner does at the start of a run: read the session's MCP credentials, match by URL
    const resolve = async () => creds.resolveMcpCredentials(session.agent.mcp_servers![0]!, await db.mcpVaultCredentials(OWNER, session.vault_ids ?? []));
    expect(await resolve()).toEqual({ authorization: "Bearer IT-VAULT-TOKEN" });

    await db.vaultCredentials.put(vault.id, { name: "vaulted", value: "IT-VAULT-ROTATED", kind: "static_bearer", mcp_server_url: url });
    expect(await resolve()).toEqual({ authorization: "Bearer IT-VAULT-ROTATED" }); // no session change needed

    // env-var credentials stay out of MCP, and MCP credentials stay out of the sandbox env
    await db.vaultCredentials.put(vault.id, { name: "PLAIN_ENV", value: "env-only" });
    expect(await db.vaultSecrets(OWNER, [vault.id])).toEqual({ PLAIN_ENV: "env-only" });
    expect((await db.mcpVaultCredentials(OWNER, [vault.id])).map((r) => r.mcp_server_url)).toEqual([url]);

    // a second credential for the same server in one vault is ambiguous, so the store refuses it
    await expect(db.vaultCredentials.put(vault.id, { name: "duplicate", value: "x", kind: "static_bearer", mcp_server_url: url })).rejects.toThrow();

    await db.pool.query(`DELETE FROM vaults WHERE id=$1`, [vault.id]);
  });

  it("migrate reseals plaintext credentials left by older versions", async () => {
    const [created] = (await db.pool.query(`SELECT id, agent FROM sessions WHERE owner_id=$1 LIMIT 1`, [OWNER])).rows;
    const legacyAgent = { ...created.agent, mcp_servers: [{ label: "legacy", url: "https://legacy.example.com/mcp", authorization: "Bearer LEGACY-PLAINTEXT" }] };
    await db.pool.query(`UPDATE sessions SET agent=$2 WHERE id=$1`, [created.id, JSON.stringify(legacyAgent)]);
    expect(await rowText(created.id)).toContain("LEGACY-PLAINTEXT");

    // scoped to this test's owner: never reseal other sessions in the shared dev database with the test key
    expect(await migrate.sealLegacyMcpCredentials(db.pool, { ownerId: OWNER })).toBe(1);
    const after = await rowText(created.id);
    expect(after).not.toContain("LEGACY-PLAINTEXT");
    const s = await db.repos.sessions.get(created.id);
    expect(creds.openMcpCredentials(s!.agent.mcp_servers![0]!)).toEqual({ authorization: "Bearer LEGACY-PLAINTEXT", headers: undefined });
    expect(await migrate.sealLegacyMcpCredentials(db.pool, { ownerId: OWNER })).toBe(0); // idempotent: nothing left to seal
  });
});
