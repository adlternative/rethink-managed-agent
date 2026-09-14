import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../src/shared/ids.ts";
import type { SandboxRow } from "../src/shared/types.ts";

// Guarded integration test: needs the running Postgres. Enable with PMA_IT=1.
// Unique owner/affinity prefixes per run so parallel runs never collide.
const IT = !!process.env.PMA_IT;
const RUN = `it_${newId("ls").slice(4)}`;
const aff = (n: string) => `${RUN}_${n}`;
const owner = `${RUN}_owner`;

let store: typeof import("../src/sandbox/lease-store.ts");
let pool: import("pg").Pool;
const created: string[] = [];

async function seed(over: Partial<SandboxRow> = {}): Promise<string> {
  const id = newId("sbx");
  created.push(id);
  await store.insert({
    id, owner_id: over.owner_id ?? owner, provider: "local", status: over.status ?? "ready",
    workspace_id: over.workspace_id ?? "ws", affinity: over.affinity ?? aff("a"),
    external_ref: over.external_ref ?? null, container_key: over.container_key ?? "k",
    container_ref: over.container_ref ?? "ctr", workdir: over.workdir ?? "/w",
  });
  if (over.last_used_at) await pool.query(`UPDATE sandboxes SET last_used_at=$2 WHERE id=$1`, [id, over.last_used_at]);
  return id;
}

describe.skipIf(!IT)("lease-store against Postgres", () => {
  beforeAll(async () => {
    store = await import("../src/sandbox/lease-store.ts");
    ({ pool } = await import("../src/infra/db.ts"));
  });
  afterAll(async () => { if (created.length) await pool.query(`DELETE FROM sandboxes WHERE id = ANY($1)`, [created]); });

  it("findReadyByAffinity: exactly one of ten concurrent callers claims the row, and gets its pre-claim status", async () => {
    const a = aff("claim");
    await seed({ affinity: a, status: "ready" });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.findReadyByAffinity("local", a)));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("ready"); // pre-claim status
    expect((await store.get(winners[0]!.id))!.status).toBe("busy");
  });

  it("prefers ready over paused, and the newest last_used_at", async () => {
    const a = aff("prefer");
    const old = new Date(Date.now() - 60_000).toISOString();
    await seed({ affinity: a, status: "paused", last_used_at: new Date().toISOString() });
    const oldReady = await seed({ affinity: a, status: "ready", last_used_at: old });
    const newReady = await seed({ affinity: a, status: "ready", last_used_at: new Date().toISOString() });
    const claimed = await store.findReadyByAffinity("local", a);
    expect(claimed!.id).toBe(newReady);
    expect(claimed!.id).not.toBe(oldReady);
    expect(claimed!.status).toBe("ready");
  });

  it("findBusyByAffinity ignores busy rows older than ABANDONED_MS", async () => {
    const a = aff("busy");
    await seed({ affinity: a, status: "busy", last_used_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    expect(await store.findBusyByAffinity("local", a)).toBeNull();
    const fresh = await seed({ affinity: a, status: "busy", last_used_at: new Date().toISOString() });
    expect((await store.findBusyByAffinity("local", a))!.id).toBe(fresh);
  });

  it("markForDestroy returns false for busy and true for ready/paused", async () => {
    const busy = await seed({ affinity: aff("md1"), status: "busy" });
    const ready = await seed({ affinity: aff("md2"), status: "ready" });
    const paused = await seed({ affinity: aff("md3"), status: "paused" });
    expect(await store.markForDestroy(busy)).toBe(false);
    expect(await store.markForDestroy(ready)).toBe(true);
    expect(await store.markForDestroy(paused)).toBe(true);
    expect((await store.get(ready))!.status).toBe("destroying");
  });

  it("markForPause returns true only for ready and makes listIdle include the row", async () => {
    const ready = await seed({ affinity: aff("mp1"), status: "ready" });
    const paused = await seed({ affinity: aff("mp2"), status: "paused" });
    expect(await store.markForPause(paused)).toBe(false);
    expect(await store.markForPause(ready)).toBe(true);
    const idle = await store.listIdle("local", 1);
    expect(idle.map((r) => r.id)).toContain(ready);
  });

  it("getScoped returns null for the wrong owner", async () => {
    const id = await seed({ affinity: aff("scope") });
    expect(await store.getScoped(id, owner)).not.toBeNull();
    expect(await store.getScoped(id, "someone-else")).toBeNull();
  });
});

describe.skipIf(!IT)("SandboxManager.acquire exclusivity against Postgres", () => {
  let manager: import("../src/sandbox/manager.ts").SandboxManager;
  const localRoot = `/tmp/pma-it-${RUN}`;
  beforeAll(async () => {
    process.env.SANDBOX_LOCAL_ROOT = localRoot;
    process.env.WORKSPACE_ROOT = `/tmp/pma-it-ws-${RUN}`;
    const { LocalProvider } = await import("../src/sandbox/local.ts");
    const { SandboxManager } = await import("../src/sandbox/manager.ts");
    store = await import("../src/sandbox/lease-store.ts");
    ({ pool } = await import("../src/infra/db.ts"));
    manager = new SandboxManager({ local: new LocalProvider() } as never);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM sandboxes WHERE affinity LIKE $1`, [`${RUN}_%`]);
    const { rm } = await import("node:fs/promises");
    await rm(localRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Regression: acquire is check-then-insert with no unique constraint, so two concurrent acquires both win.
  it("two concurrent acquires on the same fresh affinity: at most one succeeds", async () => {
    const a = aff("excl");
    const rq = { workspaceId: a, workspaceRef: { kind: "empty" as const }, affinity: a, owner_id: owner };
    const settled = await Promise.allSettled([manager.acquire("local", rq), manager.acquire("local", rq)]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    for (const s of ok) await (s as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
    expect(ok.length).toBeLessThanOrEqual(1);
  });
});
