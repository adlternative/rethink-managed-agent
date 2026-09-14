import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool, tx } from "./db.ts";

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
  });
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
