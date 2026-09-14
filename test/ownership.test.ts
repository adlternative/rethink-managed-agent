import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture every SQL query the repos issue, and feed back canned rows, so we can assert the
// ownership threading (owner_id columns on writes, "AND owner_id=$n" filters on scoped reads)
// without a live Postgres.
const calls: { sql: string; params: unknown[] }[] = [];
let nextRows: unknown[][] = [];
function respond(): { rows: unknown[]; rowCount: number } {
  const rows = nextRows.shift() ?? [{ id: "row_1", owner_id: "prc_x" }];
  return { rows, rowCount: rows.length };
}
const fakeClient = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return respond(); } };
vi.mock("pg", () => {
  class Pool {
    query = async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return respond(); };
    connect = async () => ({ ...fakeClient, release() {} });
  }
  return { default: { Pool }, Pool };
});

const db = await import("../src/infra/db.ts");
const { repos, skills, principals, apiKeys } = db;
const leaseStore = await import("../src/sandbox/lease-store.ts");

beforeEach(() => { calls.length = 0; nextRows = []; });
const last = () => calls[calls.length - 1]!;
const find = (frag: string) => calls.find((c) => c.sql.includes(frag))!;

describe("ownership threading", () => {
  it("stamps owner_id on writes", async () => {
    await repos.agents.create({ owner_id: "prc_a", name: "x", model: { provider: "p", id: "m" }, system: null, tools: [], packages: [], skills: [] } as never);
    const c = last();
    expect(c.sql).toMatch(/INSERT INTO agents \(id, owner_id,/);
    expect(c.params[1]).toBe("prc_a");
  });

  it("scoped get adds an owner filter and param; unscoped does not", async () => {
    await repos.agents.get("agent_1", { owner: "prc_a" });
    expect(last().sql).toContain("WHERE id=$1 AND owner_id=$2");
    expect(last().params).toEqual(["agent_1", "prc_a"]);

    await repos.agents.get("agent_1");
    expect(last().sql).toContain("WHERE id=$1");
    expect(last().sql).not.toContain("owner_id");
    expect(last().params).toEqual(["agent_1"]);
  });

  it("scoped list filters by owner; unscoped lists all", async () => {
    await repos.agents.list({ owner: "prc_a" });
    expect(last().sql).toContain("WHERE owner_id=$1");
    expect(last().params).toEqual(["prc_a"]);

    await repos.agents.list();
    expect(last().sql).not.toContain("owner_id");
    expect(last().params).toEqual([]);
  });

  it("scoped delete only removes within the owner", async () => {
    await repos.providers.delete("qoder", { owner: "prc_a" });
    expect(last().sql).toContain("DELETE FROM providers WHERE id=$1 AND owner_id=$2");
    expect(last().params).toEqual(["qoder", "prc_a"]);
  });

  it("session create includes owner_id and threads it into the row", async () => {
    await repos.sessions.create({ owner_id: "prc_a", agent_id: "agent_1", environment_id: "env_1", workspace_id: "ws_1", agent: {} as never });
    const ins = find("INSERT INTO sessions");
    expect(ins.sql).toMatch(/INSERT INTO sessions \(id, owner_id,/);
    expect(ins.params[1]).toBe("prc_a");
  });

  it("skills upsert carries owner_id; scoped reads filter", async () => {
    await skills.upsert({ owner_id: "prc_a", name: "s", description: "d", body: "b" });
    expect(find("INSERT INTO skills").sql).toMatch(/INSERT INTO skills \(id, owner_id,/);
    await skills.getMany(["skill_1", "skill_2"], { owner: "prc_a" });
    expect(last().sql).toContain("AND owner_id=$2");
    expect(last().params).toEqual([["skill_1", "skill_2"], "prc_a"]);
  });

  it("sandbox rows carry owner_id and the ops view filters by owner (phase 2)", async () => {
    nextRows = [[], [], [], [], []]; // BEGIN, advisory lock, no other busy lease on the affinity, INSERT, COMMIT
    await leaseStore.insert({ id: "sbx_1", owner_id: "prc_a", provider: "local", status: "busy", workspace_id: "ws_1", affinity: "ws_1", external_ref: null, container_key: "prc_a/g/env", container_ref: "c1", workdir: "/w" } as never);
    const ins = find("INSERT INTO sandboxes");
    expect(ins.sql).toMatch(/INSERT INTO sandboxes \(id, owner_id,/);
    expect(ins.params[1]).toBe("prc_a");

    await leaseStore.list({ owner: "prc_a" });
    expect(last().sql).toContain("owner_id=$1");
    expect(last().params).toEqual(["prc_a"]);

    await leaseStore.getScoped("sbx_1", "prc_a");
    expect(last().sql).toContain("WHERE id=$1 AND owner_id=$2");
    expect(last().params).toEqual(["sbx_1", "prc_a"]);
  });

  it("principals + api key: token is hashed, never stored in plaintext", async () => {
    nextRows = [[{ id: "prc_a", kind: "user", handle: "a", display_name: "A" }]];
    await principals.upsert({ id: "prc_a", display_name: "A" });
    expect(find("INSERT INTO principals").params[0]).toBe("prc_a");

    const { token } = await apiKeys.create("prc_a", "cli");
    expect(token).toMatch(/^pma_/);
    const insert = find("INSERT INTO api_keys");
    const stored = insert.params[2] as string;
    expect(stored).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    expect(stored).not.toContain(token); // plaintext never persisted
  });
});
