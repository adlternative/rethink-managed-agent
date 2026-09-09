import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./db.ts";

/** Applies sql/schema.sql (all statements are IF NOT EXISTS, so re-running is safe). */
export async function migrate(): Promise<void> {
  const sql = await readFile(new URL("../../sql/schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
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
