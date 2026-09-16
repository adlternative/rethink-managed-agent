import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Hermetic repo tests: pg is a scripted fake (queries recorded, rows served by SQL fragment); the blob
// store is the fs backend over a temp dir; the secret key is a random 32-byte key.
const blobDir = await mkdtemp(path.join(tmpdir(), "infra-db-blobs-"));
process.env.BLOB_BACKEND = "fs";
process.env.BLOB_DIR = blobDir;
process.env.PMA_SECRET_KEY = randomBytes(32).toString("hex");

type Call = { sql: string; params: unknown[]; via: "pool" | "client" };
const calls: Call[] = [];
let connects = 0;
let script: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined;
const run = (via: Call["via"]) => async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params, via });
  const rows = script(sql, params) ?? [];
  return { rows, rowCount: rows.length };
};
vi.mock("pg", () => {
  class Pool {
    query = run("pool");
    connect = async () => { connects++; return { query: run("client"), release() {} }; };
  }
  return { default: { Pool }, Pool };
});

const db = await import("../src/infra/db.ts");
const { seal } = await import("../src/infra/secrets.ts");
const { repos, vaultSecrets, vaultCredentials, files } = db;

beforeEach(() => { calls.length = 0; connects = 0; script = () => undefined; });
const find = (frag: string) => calls.find((c) => c.sql.includes(frag));

describe("vaultSecrets / vaultCredentials", () => {
  it("no vault ids -> {} without a query", async () => {
    expect(await vaultSecrets("prc_a", [])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("joins vaults for owner scoping; a later vault wins; unreadable secrets are skipped", async () => {
    script = () => [
      { name: "K", vault_id: "v1", secret: seal("from-v1") },
      { name: "K", vault_id: "v2", secret: seal("from-v2") },
      { name: "BROKEN", vault_id: "v2", secret: { ...seal("x"), tag: Buffer.alloc(16).toString("base64") } },
      { name: "OTHER", vault_id: "v1", secret: seal("ok") },
    ];
    expect(await vaultSecrets("prc_a", ["v1", "v2"])).toEqual({ K: "from-v2", OTHER: "ok" });
    expect(calls[0]!.sql).toMatch(/JOIN vaults v ON v.id = c.vault_id/);
    expect(calls[0]!.sql).toContain("v.owner_id = $2");
    expect(calls[0]!.params).toEqual([["v1", "v2"], "prc_a"]);
  });

  it("put seals the value (no plaintext in params) and RETURNING excludes the secret column", async () => {
    script = () => [{ id: "cred_1", vault_id: "v1", name: "API_KEY", metadata: {}, created_at: new Date(0) }];
    const r = await vaultCredentials.put("v1", { name: "API_KEY", value: "super-secret-plaintext" });
    const c = calls[0]!;
    const sealed = JSON.parse(c.params[3] as string);
    expect(sealed).toMatchObject({ type: "encrypted", v: 1 });
    expect(JSON.stringify(c.params)).not.toContain("super-secret-plaintext");
    expect(c.sql.slice(c.sql.indexOf("RETURNING"))).not.toMatch(/\bsecret\b/);
    expect(r).not.toHaveProperty("secret");
    expect(r.created_at).toBe(new Date(0).toISOString());
  });

  it("list/get never select the secret column", async () => {
    await vaultCredentials.list("v1");
    await vaultCredentials.get("v1", "K");
    for (const c of calls) expect(c.sql.split("FROM")[0]).not.toContain("secret");
  });
});

describe("sessions.listPage", () => {
  const row = (id: string, ms: number) => ({ id, created_at: new Date(ms) });

  it("clamps the limit to [1, 200] (LIMIT lim+1)", async () => {
    await repos.sessions.listPage({ owner: "prc_a" }, { limit: 0 });
    expect(calls[0]!.sql).toMatch(/LIMIT 2$/);
    calls.length = 0;
    await repos.sessions.listPage({ owner: "prc_a" }, { limit: 500 });
    expect(calls[0]!.sql).toMatch(/LIMIT 201$/);
  });

  it("lim+1 rows -> has_more and next_cursor is the last kept row; cursor follows the owner param", async () => {
    script = (sql) => (sql.startsWith("SELECT *, to_char") ? [row("s3", 3000), row("s2", 2000), row("s1", 1000)] : sql.includes("session_environments") ? [{ session_id: "s2", key: "main", environment_id: "e", workspace_id: "w" }] : undefined);
    const p = await repos.sessions.listPage({ owner: "prc_a" }, { limit: 2, cursor: "2030-01-01T00:00:00.000Z" });
    expect(p.data.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(p.has_more).toBe(true);
    expect(p.next_cursor).toBe(`${new Date(2000).toISOString()}|s2`); // (created_at, id) keyset cursor
    expect(calls[0]!.sql).toContain("WHERE owner_id=$1 AND created_at < $2::timestamptz");
    expect(calls[0]!.params).toEqual(["prc_a", "2030-01-01T00:00:00.000Z"]);
    const envq = find("session_environments")!;
    expect(envq.sql).toContain("ANY($1::text[])");
    expect(envq.params).toEqual([["s3", "s2"]]);
    expect(p.data[1]!.environments).toEqual([{ key: "main", environment_id: "e", workspace_id: "w" }]);
    expect(p.data[0]!.environments).toEqual([]);
  });

  it("an empty page skips the environments query", async () => {
    script = () => [];
    const p = await repos.sessions.listPage(undefined, {});
    expect(p).toEqual({ data: [], has_more: false, next_cursor: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toContain("WHERE");
  });
  // The millisecond-cursor skip is covered against real timestamptz in test/it-infra-sessions-page.test.ts.
});

describe("sessions.list / apiKeys.resolve", () => {
  it("a scoped list reads only its own sessions' environment rows and groups them per session in query order", async () => {
    script = (sql) => (sql.startsWith("SELECT * FROM sessions") ? [{ id: "s1", created_at: new Date(0) }, { id: "s2", created_at: new Date(1) }]
      : sql.includes("session_environments") ? [{ session_id: "s2", key: "main", environment_id: "e2", workspace_id: "w2" }, { session_id: "s1", key: "main", environment_id: "e1", workspace_id: "w1" }, { session_id: "s2", key: "aux", environment_id: "e3", workspace_id: "w3" }] : undefined);
    const list = await repos.sessions.list({ owner: "prc_a" });
    const envq = find("session_environments")!;
    expect(envq.sql).toContain("WHERE session_id = ANY($1::text[])");
    expect(envq.params).toEqual([["s1", "s2"]]);
    expect(list.map((s) => [s.id, s.environments.map((e) => e.key)])).toEqual([["s1", ["main"]], ["s2", ["main", "aux"]]]);
  });

  it("apiKeys.resolve is one statement that returns the principal and throttles the last_used_at touch", async () => {
    script = (sql) => (sql.includes("FROM api_keys") ? [{ id: "prc_a", kind: "user", handle: null, display_name: "A", created_at: new Date(0) }] : undefined);
    const p = await db.apiKeys.resolve("pma_token");
    expect(p).toEqual({ id: "prc_a", kind: "user", handle: null, display_name: "A", created_at: new Date(0).toISOString() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/last_used_at IS NULL OR k\.last_used_at < now\(\) - interval '60 seconds'/);
    expect(calls[0]!.params[0]).toMatch(/^[0-9a-f]{64}$/); // only the hash is sent
    script = () => [];
    expect(await db.apiKeys.resolve("pma_unknown")).toBeNull();
  });
});

describe("sessions.create / childrenOf / agents.update / providers.upsert", () => {
  const agent = {} as never;

  it("environments without 'main' throw before connecting", async () => {
    await expect(repos.sessions.create({ owner_id: "prc_a", agent_id: "a", environment_id: "e", workspace_id: "w", agent, environments: [{ key: "side", environment_id: "e2", workspace_id: "w2" }] })).rejects.toThrow(/must include key 'main'/);
    expect(connects).toBe(0);
  });

  it("two environments -> two session_environments rows on the tx client; main's ids go into sessions", async () => {
    script = (sql, p) => (sql.includes("INSERT INTO sessions") ? [{ id: p[0], created_at: new Date(0) }] : undefined);
    const s = await repos.sessions.create({ owner_id: "prc_a", agent_id: "a", environment_id: "ignored", workspace_id: "ignored", agent, environments: [{ key: "side", environment_id: "e2", workspace_id: "w2" }, { key: "main", environment_id: "e1", workspace_id: "w1" }] });
    const ins = find("INSERT INTO sessions")!;
    expect(ins.via).toBe("client");
    expect(ins.params.slice(1, 5)).toEqual(["prc_a", "a", "e1", "w1"]);
    expect(ins.params[8]).toBeNull(); // container_group null -> COALESCE($9, $1)
    expect(ins.sql).toContain("COALESCE($9, $1)");
    const envRows = calls.filter((c) => c.sql.includes("INSERT INTO session_environments"));
    expect(envRows.map((c) => [c.via, ...c.params.slice(1)])).toEqual([["client", "side", "e2", "w2"], ["client", "main", "e1", "w1"]]);
    expect(envRows.every((c) => c.params[0] === s.id)).toBe(true);
    expect(calls.at(-1)!.sql).toBe("COMMIT");
  });

  it("agents.update distinguishes system: null from an absent system", async () => {
    await repos.agents.update("agent_1", { system: null });
    expect(calls[0]!.params[7]).toBe(true);
    expect(calls[0]!.params[3]).toBeNull();
    await repos.agents.update("agent_1", {});
    expect(calls[1]!.params[7]).toBe(false);
    expect(calls[1]!.params).toHaveLength(13); // one param slot per updatable column, scoped or not
    await repos.agents.update("agent_1", { name: "n" }, { owner: "prc_a" });
    expect(calls[2]!.sql).toContain("AND owner_id=$9");
    expect(calls[2]!.params[8]).toBe("prc_a");
  });

  // Regression: childrenOf returns SessionResource rows without `environments`, unlike get/list/listPage.
  it("childrenOf attaches environments like the other session reads", async () => {
    script = (sql) => (sql.includes("parent_id=$1") ? [{ id: "child", created_at: new Date(0) }] : sql.includes("session_environments") ? [{ session_id: "child", key: "main", environment_id: "e", workspace_id: "w" }] : undefined);
    const [c] = await repos.sessions.childrenOf("parent");
    expect(Array.isArray(c!.environments)).toBe(true);
  });

  // Regression: ON CONFLICT (id) DO UPDATE has no owner guard, so another tenant can overwrite a provider row
  // that stays owned by its original owner.
  it("providers.upsert's conflict update is guarded by owner", async () => {
    await repos.providers.upsert({ id: "openai", owner_id: "prc_b", name: "n", api: "openai-completions", base_url: "http://evil", headers: {}, auth: { type: "none" }, models: [], enabled: true } as never);
    const up = calls[0]!.sql;
    expect(up.slice(up.indexOf("DO UPDATE"))).toMatch(/WHERE\s+providers\.owner_id\s*=\s*EXCLUDED\.owner_id/);
  });
});

describe("files with the fs blob store", () => {
  let fileRow: Record<string, unknown> | null = null;
  beforeAll(() => { fileRow = null; });

  it("create stores bytes in the blob store (files/<id>) and null inline data", async () => {
    script = (sql, p) => (sql.includes("INSERT INTO files") ? [(fileRow = { id: p[0], owner_id: p[1], filename: p[2], mime_type: p[3], size_bytes: p[4], sha256: p[5], blob_key: p[6], data: p[7], created_at: new Date(0) })] : undefined);
    const f = await files.create({ owner_id: "prc_a", filename: "a.txt", mime_type: "text/plain", data: Buffer.from("hello blob") });
    const ins = find("INSERT INTO files")!;
    expect(ins.params[6]).toBe(`files/${f.id}`);
    expect(ins.params[7]).toBeNull();
    expect(ins.sql.slice(ins.sql.indexOf("RETURNING"))).not.toMatch(/\bdata\b|blob_key/);
    expect((await readFile(path.join(blobDir, "files", f.id))).toString()).toBe("hello blob");
    expect(f).toMatchObject({ type: "file", downloadable: true, filename: "a.txt" });
  });

  it("content reads from the blob; a missing blob yields null", async () => {
    script = (sql) => (sql.startsWith("SELECT * FROM files") ? [{ ...fileRow! }] : undefined);
    const c = await files.content(fileRow!.id as string, { owner: "prc_a" });
    expect(c?.data.toString()).toBe("hello blob");
    expect(c?.meta).not.toHaveProperty("data");
    expect(c?.meta).not.toHaveProperty("blob_key");
    script = (sql) => (sql.startsWith("SELECT * FROM files") ? [{ ...fileRow!, blob_key: "files/missing" }] : undefined);
    expect(await files.content("x")).toBeNull();
  });

  it("scoped delete by a non-owner returns false and keeps the blob; the owner's delete removes it", async () => {
    const id = fileRow!.id as string;
    script = (_sql, p) => (p[1] === "prc_b" ? [] : [{ blob_key: `files/${id}` }]);
    expect(await files.delete(id, { owner: "prc_b" })).toBe(false);
    expect(find("DELETE FROM files")!.sql).toContain("AND owner_id=$2");
    expect((await stat(path.join(blobDir, "files", id))).isFile()).toBe(true);
    expect(await files.delete(id, { owner: "prc_a" })).toBe(true);
    await expect(stat(path.join(blobDir, "files", id))).rejects.toThrow(/ENOENT/);
  });
});
