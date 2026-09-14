import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool, tx } from "./db.ts";
import { sealMcpServers } from "./mcp-credentials.ts";
import { secretsConfigured } from "./secrets.ts";

/**
 * Applies sql/schema.sql (all statements are IF NOT EXISTS, so re-running is safe). The api and the
 * runner both migrate at boot, and concurrent CREATE ... IF NOT EXISTS is not race-safe in Postgres,
 * so the schema is applied under a transaction-scoped advisory lock.
 */
export async function migrate(): Promise<void> {
  const sql = await readFile(new URL("../../sql/schema.sql", import.meta.url), "utf8");
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7355608)");
    await c.query(sql);
    await sealLegacyMcpCredentials(c);
  });
}

/**
 * Seal MCP server credentials stored in plaintext by sessions created before they were sealed at creation.
 * Needs PMA_SECRET_KEY; without it those rows stay as they are (API output is redacted either way).
 */
export async function sealLegacyMcpCredentials(c: Pick<typeof pool, "query"> = pool, opts: { ownerId?: string } = {}): Promise<number> {
  if (!secretsConfigured()) return 0;
  const { rows } = await c.query<{ id: string; agent: { mcp_servers?: Parameters<typeof sealMcpServers>[0] } }>(
    `SELECT id, agent FROM sessions WHERE jsonb_path_exists(agent, '$.mcp_servers[*] ? (exists(@.authorization) || exists(@.headers.keyvalue()))')${opts.ownerId ? " AND owner_id = $1" : ""}`,
    opts.ownerId ? [opts.ownerId] : [],
  );
  for (const r of rows) await c.query(`UPDATE sessions SET agent = $2 WHERE id = $1`, [r.id, JSON.stringify({ ...r.agent, mcp_servers: sealMcpServers(r.agent.mcp_servers) })]);
  return rows.length;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => {
      console.log("migrated");
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
