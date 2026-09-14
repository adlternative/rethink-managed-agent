import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";

// Hermetic: capture what migrate() sends to Postgres.
const queries: string[] = [];
const clientQueries: string[] = [];
vi.mock("pg", () => {
  class Pool {
    query = async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; };
    connect = async () => ({ query: async (sql: string) => { clientQueries.push(sql); return { rows: [], rowCount: 0 }; }, release() {} });
    end = async () => {};
  }
  return { default: { Pool }, Pool };
});

const { migrate } = await import("../src/infra/migrate.ts");
const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");

describe("migrate", () => {
  it("applies sql/schema.sql verbatim", async () => {
    await migrate();
    expect([...queries, ...clientQueries].some((q) => q === schema)).toBe(true);
  });

  it("schema DDL is idempotent (IF NOT EXISTS on every CREATE TABLE / INDEX, ADD COLUMN)", () => {
    for (const m of schema.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)(\S+)/g)) throw new Error(`non-idempotent CREATE ${m[1]} ${m[2]}`);
    for (const m of schema.matchAll(/ADD COLUMN\s+(?!IF NOT EXISTS)(\S+)/g)) throw new Error(`non-idempotent ADD COLUMN ${m[1]}`);
  });

  // Regression: api and runner both migrate at boot; concurrent CREATE ... IF NOT EXISTS is not race-safe in
  // Postgres, so the schema should be applied under an advisory lock.
  it("serializes concurrent migrations with an advisory lock", async () => {
    queries.length = 0; clientQueries.length = 0;
    await migrate();
    expect([...queries, ...clientQueries].some((q) => /pg_advisory(_xact)?_lock/.test(q))).toBe(true);
  });
});
