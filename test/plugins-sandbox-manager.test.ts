import { describe, it, expect, beforeEach } from "vitest";
import { SandboxManager, type LeaseStore } from "../src/sandbox/manager.ts";
import type { Sandbox, SandboxHandle, SandboxProvider, SandboxRow, WorkspaceRef } from "../src/shared/types.ts";

// ---- an in-memory LeaseStore injected via the manager constructor (no vi.mock, no Postgres) ----
function memStore() {
  const rows = new Map<string, SandboxRow>();
  const now = () => new Date().toISOString();
  const store = {
    _rows: rows,
    async insert(r: Omit<SandboxRow, "last_used_at" | "created_at">) { rows.set(r.id, { ...r, last_used_at: now(), created_at: now() } as SandboxRow); },
    async setMount(id: string, cref: string, wd: string) { const r = rows.get(id)!; r.container_ref = cref; r.workdir = wd; r.last_used_at = now(); },
    async setStatus(id: string, status: SandboxRow["status"]) { const r = rows.get(id); if (r) { r.status = status; r.last_used_at = now(); } },
    async setExternalRef() {},
    async touch(id: string) { const r = rows.get(id); if (r) r.last_used_at = now(); },
    async get(id: string) { return rows.get(id) ?? null; },
    async list() { return [...rows.values()].filter((r) => r.status !== "destroyed"); },
    async mountsOf(cref: string) { return [...rows.values()].filter((r) => r.container_ref === cref && r.status !== "destroyed"); },
    async findContainer(p: string, key: string) { return [...rows.values()].find((r) => r.provider === p && r.container_key === key && r.container_ref && ["ready", "busy", "paused"].includes(r.status)) ?? null; },
    async findReadyByAffinity(p: string, affinity: string) {
      const r = [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && (r.status === "ready" || r.status === "paused"));
      if (!r) return null; const prev = r.status; r.status = "busy"; r.last_used_at = now(); return { ...r, status: prev };
    },
    async findBusyByAffinity(p: string, affinity: string) { return [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && r.status === "busy") ?? null; },
    async listIdle(p: string) { return [...rows.values()].filter((r) => r.provider === p && r.status === "ready"); },
    async listToDestroy(p: string) { return [...rows.values()].filter((r) => r.provider === p && (r.status === "destroying" || r.status === "paused")); },
    async markForDestroy() { return true; },
    async markForPause() { return true; },
    async getScoped() { return null; },
  };
  return store as unknown as LeaseStore & { _rows: Map<string, SandboxRow> };
}

// ---- a fake provider whose behavior each test tunes ----
function fakeProvider(over: Partial<SandboxProvider> & { hasPause?: boolean } = {}) {
  const calls: string[] = [];
  const mkSandbox = (id: string, workdir: string): Sandbox => ({ id, provider: "local", workdir, async *exec() { yield { type: "exit", code: 0 }; }, async readFile() { return new Uint8Array(); }, async writeFile() {} });
  const base: SandboxProvider & { hasPause?: boolean; calls: string[] } = {
    name: "local", calls,
    async openContainer(id) { calls.push(`open:${id}`); return `ctr_${id}`; },
    async connectContainer(ref) { calls.push(`connect:${ref}`); return true; },
    async destroyContainer(ref) { calls.push(`destroyC:${ref}`); },
    async addMount(ref, id, _r, _s) { calls.push(`add:${ref}:${id}`); return { sandbox: mkSandbox(id, `/w/${id}`), containerRef: ref, workdir: `/w/${id}` }; },
    async connectMount(ref, id, wd) { calls.push(`connectM:${ref}:${id}`); return mkSandbox(id, wd); },
    async removeMount(ref, id) { calls.push(`remove:${ref}:${id}`); },
    async captureMount(_ref, _id, _wd, prev) { return prev; },
    ...over,
  };
  if (over.hasPause) { base.pause = over.pause ?? (async (ref) => { calls.push(`pause:${ref}`); }); base.resume = over.resume ?? (async (ref) => { calls.push(`resume:${ref}`); }); }
  return base;
}
const mgr = (p: ReturnType<typeof fakeProvider>, store: LeaseStore) => new SandboxManager({ local: p } as never, store);
const req = (o: Partial<import("../src/shared/types.ts").SandboxRequest> = {}) => ({ workspaceId: "ws", workspaceRef: { kind: "empty" as const }, ...o });

describe("acquire edge cases", () => {
  // Regression: findReadyByAffinity claims a container_ref-null row busy, then findBusyByAffinity re-finds it and throws.
  it("a ready mine with a null container_ref is not treated as an in-use conflict", async () => {
    const store = memStore();
    await store.insert({ id: "sbx_legacy", owner_id: null, provider: "local", status: "ready", workspace_id: "ws", affinity: "aff", external_ref: null, container_key: "k", container_ref: null, workdir: null });
    const p = fakeProvider();
    const lease = await mgr(p, store).acquire("local", req({ affinity: "aff", containerKey: "k" }));
    expect(lease.origin).toBe("created");
    // Regression guard: the stuck legacy row must not be left busy
    expect(store._rows.get("sbx_legacy")!.status).toBe("destroyed");
  });

  // Regression: a stale mount is marked destroyed without removeMount/destroyContainer, leaking the dir/container.
  it("a stale mount (connectMount null) removes the mount and destroys its now-empty container", async () => {
    const store = memStore();
    await store.insert({ id: "sbx_stale", owner_id: null, provider: "local", status: "ready", workspace_id: "ws", affinity: "aff", external_ref: null, container_key: "k", container_ref: "ctr_old", workdir: "/w/sbx_stale" });
    const p = fakeProvider({ connectContainer: async () => true, connectMount: async () => null });
    await mgr(p, store).acquire("local", req({ affinity: "aff", containerKey: "k2" }));
    // Regression guard: removeMount + destroyContainer for the container the stale mount left behind
    expect(p.calls).toContain("remove:ctr_old:sbx_stale");
    expect(p.calls).toContain("destroyC:ctr_old");
  });

  it("addMount throwing on a freshly opened container tears the container down", async () => {
    const store = memStore();
    const p = fakeProvider({ addMount: async () => { throw new Error("mount boom"); } });
    await expect(mgr(p, store).acquire("local", req({ containerKey: "solo" }))).rejects.toThrow("mount boom");
    expect(p.calls.some((c) => c.startsWith("destroyC:"))).toBe(true);
    expect([...store._rows.values()].every((r) => r.status === "destroyed")).toBe(true);
  });

  it("addMount throwing on a shared container leaves the container running", async () => {
    const store = memStore();
    await store.insert({ id: "sbx_sib", owner_id: null, provider: "local", status: "ready", workspace_id: "wsA", affinity: "affA", external_ref: null, container_key: "shared", container_ref: "ctr_shared", workdir: "/w/a" });
    const p = fakeProvider({ addMount: async () => { throw new Error("mount boom"); } });
    await expect(mgr(p, store).acquire("local", req({ workspaceId: "wsB", affinity: "affB", containerKey: "shared" }))).rejects.toThrow("mount boom");
    expect(p.calls.filter((c) => c.startsWith("destroyC:"))).toEqual([]);
  });

  it("a paused mine is resumed with origin 'resumed'; a ready mine is 'reused'", async () => {
    for (const [status, origin] of [["paused", "resumed"], ["ready", "reused"]] as const) {
      const store = memStore();
      await store.insert({ id: `sbx_${status}`, owner_id: null, provider: "local", status, workspace_id: "ws", affinity: "aff", external_ref: null, container_key: "k", container_ref: "ctr", workdir: "/w/x" });
      const p = fakeProvider({ hasPause: true });
      const lease = await mgr(p, store).acquire("local", req({ affinity: "aff", containerKey: "k" }));
      expect(lease.origin).toBe(origin);
      if (status === "paused") expect(p.calls).toContain("resume:ctr");
    }
  });

  it("a paused sibling container is resumed and yields origin 'shared'", async () => {
    const store = memStore();
    await store.insert({ id: "sbx_sib", owner_id: null, provider: "local", status: "paused", workspace_id: "wsA", affinity: "affA", external_ref: null, container_key: "shared", container_ref: "ctr_shared", workdir: "/w/a" });
    const p = fakeProvider({ hasPause: true });
    const lease = await mgr(p, store).acquire("local", req({ workspaceId: "wsB", affinity: "affB", containerKey: "shared" }));
    expect(lease.origin).toBe("shared");
    expect(p.calls).toContain("resume:ctr_shared");
    expect(p.calls).toContain("add:ctr_shared:" + lease.sandbox.id);
  });

  // Regression: release() unconditionally sets status 'ready', resurrecting a row destroy() already retired.
  it("release after destroy(id) does not resurrect the row to 'ready'", async () => {
    const store = memStore();
    const p = fakeProvider();
    const m = mgr(p, store);
    const lease = await m.acquire("local", req({ affinity: "aff", containerKey: "k" }));
    await m.destroy(lease.sandbox.id);
    expect(store._rows.get(lease.sandbox.id)!.status).toBe("destroyed");
    await lease.release();
    // Regression guard: release() must not set a destroyed row back to 'ready'
    expect(store._rows.get(lease.sandbox.id)!.status).toBe("destroyed");
  });

  it("capture() on a sandbox this process does not hold throws", async () => {
    const store = memStore();
    const m = mgr(fakeProvider(), store);
    const phantom: Sandbox = { id: "sbx_phantom", provider: "local", workdir: "/w", async *exec() {}, async readFile() { return new Uint8Array(); }, async writeFile() {} };
    await expect(m.capture(phantom, { kind: "empty" })).rejects.toThrow(/not held by this process/);
  });
});

describe("reap tiers with shared containers", () => {
  const insertRow = (store: ReturnType<typeof memStore>, id: string, status: SandboxRow["status"], cref: string, over: Partial<SandboxRow> = {}) =>
    store.insert({ id, owner_id: null, provider: "local", status, workspace_id: id, affinity: id, external_ref: null, container_key: cref, container_ref: cref, workdir: `/w/${id}`, ...over });

  // Regression: reap acts only at whole-container granularity; a 'destroying' mount beside a live one is never removed.
  it("removes a 'destroying' mount while its container keeps the live sibling", async () => {
    const store = memStore();
    await insertRow(store, "A", "destroying", "ctr1");
    await insertRow(store, "B", "ready", "ctr1"); // ready, not idle (listIdle returns [] below)
    const p = fakeProvider({ hasPause: true });
    (store as unknown as { listIdle(): Promise<SandboxRow[]> }).listIdle = async () => [];
    await mgr(p, store).reap(0, 3_600_000);
    expect(store._rows.get("A")!.status).toBe("destroyed");
    expect(p.calls).toContain("remove:ctr1:A");
    expect(store._rows.get("B")!.status).toBe("ready");
    expect(p.calls).not.toContain("destroyC:ctr1");
  });

  // Regression: a paused-past-ttl sibling next to a ready idle mount leaves the container running forever.
  it("eventually pauses or destroys a container with one paused-expired and one ready-idle mount", async () => {
    const store = memStore();
    await insertRow(store, "A", "paused", "ctr2");
    await insertRow(store, "B", "ready", "ctr2");
    const p = fakeProvider({ hasPause: true });
    const out = await mgr(p, store).reap(0, 0); // idleTtl 0 (B is idle) and pausedTtl 0 (A expired)
    const done = [...store._rows.values()].every((r) => r.status === "paused" || r.status === "destroyed");
    expect(done).toBe(true);
    expect(out.local.paused.length + out.local.destroyed.length).toBeGreaterThan(0);
  });

  it("falls back to destroy when pause throws", async () => {
    const store = memStore();
    await insertRow(store, "A", "ready", "ctr3");
    await insertRow(store, "B", "ready", "ctr3");
    const p = fakeProvider({ hasPause: true, pause: async () => { throw new Error("pause failed"); } });
    const out = await mgr(p, store).reap(0, 3_600_000);
    expect(new Set(out.local.destroyed)).toEqual(new Set(["A", "B"]));
    expect(p.calls).toContain("destroyC:ctr3");
  });

  it("a busy mount abandoned past ABANDONED_MS alone in its container is destroyed", async () => {
    const store = memStore();
    await insertRow(store, "A", "busy", "ctr4");
    (store as unknown as { listToDestroy(): Promise<SandboxRow[]> }).listToDestroy = async () => [store._rows.get("A")!];
    const p = fakeProvider({ hasPause: true });
    const out = await mgr(p, store).reap(0, 0);
    expect(out.local.destroyed).toEqual(["A"]);
    expect(store._rows.get("A")!.status).toBe("destroyed");
  });

  it("a provider without pause destroys idle containers instead of pausing", async () => {
    const store = memStore();
    await insertRow(store, "A", "ready", "ctr5");
    const p = fakeProvider(); // no pause
    const out = await mgr(p, store).reap(0, 3_600_000);
    expect(out.local.destroyed).toEqual(["A"]);
    expect(out.local.paused).toEqual([]);
    expect(p.calls).toContain("destroyC:ctr5");
  });
});
