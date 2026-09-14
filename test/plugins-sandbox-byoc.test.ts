import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// A controllable fake of the byoc transport. Each op enqueued gets a scripted result / chunk stream.
type Result = { ok: true; result?: unknown } | { ok: false; error: string };
const enqueued: any[] = [];
let anyAlive = true;
let workerAliveFlag = true;
let workerForVal: string | null = "worker-1";
const results = new Map<string, Result>();
const chunks = new Map<string, { stream: "stdout" | "stderr"; data: string }[]>();

vi.mock("../src/infra/byoc.ts", () => ({
  WORKER_TTL_S: 60,
  newReqId: () => `req_${enqueued.length + 1}`,
  enqueue: async (_env: string, req: any) => { enqueued.push(req); if (req.op === "destroy" && (req as any)._throw) throw new Error("enqueue boom"); },
  awaitResult: async (reqId: string, opts: { onChunk?: (s: "stdout" | "stderr", d: string) => void }) => {
    for (const c of chunks.get(reqId) ?? []) opts.onChunk?.(c.stream, c.data);
    const r = results.get(reqId) ?? { ok: true, result: {} };
    return r as any;
  },
  anyWorkerAlive: async () => anyAlive,
  isWorkerAlive: async () => workerAliveFlag,
  workerFor: async () => workerForVal,
}));

let mod: typeof import("../src/sandbox/byoc.ts");
beforeAll(async () => { process.env.DATABASE_URL = "postgres://unused"; mod = await import("../src/sandbox/byoc.ts"); });
beforeEach(() => { enqueued.length = 0; anyAlive = true; workerAliveFlag = true; workerForVal = "worker-1"; results.clear(); chunks.clear(); });
const p = () => new mod.ByocProvider();
const req = (o: Record<string, unknown> = {}) => ({ workspaceId: "w", workspaceRef: { kind: "empty" as const }, ...o });

describe("ByocProvider.openContainer", () => {
  it("throws when no environmentId is given", async () => {
    await expect(p().openContainer("sbx_1", req() as never)).rejects.toThrow(/environment id missing/);
  });
  it("throws with the 'pma worker' hint when no worker is alive", async () => {
    anyAlive = false;
    await expect(p().openContainer("sbx_1", req({ environmentId: "env_x" }) as never)).rejects.toThrow(/pma worker --env env_x/);
  });
  it("returns the environment id as the container ref when a worker is alive", async () => {
    expect(await p().openContainer("sbx_1", req({ environmentId: "env_x" }) as never)).toBe("env_x");
  });
});

describe("ByocProvider.addMount", () => {
  it("rejects local, dir and blob refs", async () => {
    for (const ref of [{ kind: "local", path: "/" }, { kind: "dir", path: "/" }, { kind: "blob", key: "k", bytes: 1 }] as const) {
      await expect(p().addMount("env_x", "sbx_m", ref as never)).rejects.toThrow(/cannot be shipped to a worker/);
    }
  });
  it("enqueues a create and returns a sandbox on success", async () => {
    results.set("req_1", { ok: true });
    const h = await p().addMount("env_x", "sbx_m", { kind: "git", remote: "r", base: "b" });
    expect(enqueued[0]).toMatchObject({ op: "create", sandbox_id: "sbx_m" });
    expect(h.containerRef).toBe("env_x");
    expect(h.sandbox.provider).toBe("byoc");
  });
  it("propagates a worker create failure", async () => {
    results.set("req_1", { ok: false, error: "no disk" });
    await expect(p().addMount("env_x", "sbx_m", { kind: "empty" })).rejects.toThrow(/failed to create sandbox: no disk/);
  });
});

describe("ByocProvider.exec streaming", () => {
  async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
    const stdout: string[] = [], stderr: string[] = []; let code = -1;
    for await (const c of it) { if (c.type === "stdout") stdout.push(c.data!); if (c.type === "stderr") stderr.push(c.data!); if (c.type === "exit") code = c.code!; }
    return { stdout, stderr, code };
  }
  async function newSandbox() {
    results.set("req_1", { ok: true }); // the create
    return (await p().addMount("env_x", "sbx_m", { kind: "empty" })).sandbox;
  }
  it("streams stdout/stderr chunks then the exit code", async () => {
    const sb = await newSandbox();
    chunks.set("req_2", [{ stream: "stdout", data: "hello " }, { stream: "stderr", data: "warn" }, { stream: "stdout", data: "world" }]);
    results.set("req_2", { ok: true, result: { code: 0 } });
    const r = await collect(sb.exec("echo hi"));
    expect(r.stdout.join("")).toBe("hello world");
    expect(r.stderr.join("")).toBe("warn");
    expect(r.code).toBe(0);
  });
  it("an awaitResult rejection yields stderr plus exit 1", async () => {
    const sb = await newSandbox();
    results.set("req_2", { ok: false, error: "worker died" });
    const r = await collect(sb.exec("boom"));
    expect(r.stderr.join("")).toContain("worker died");
    expect(r.code).toBe(1);
  });
});

describe("ByocProvider.connectMount", () => {
  it("returns null when workerFor is null or the worker is dead", async () => {
    workerForVal = null;
    expect(await p().connectMount("env_x", "sbx_m", "/workspace")).toBeNull();
    workerForVal = "worker-1"; workerAliveFlag = false;
    expect(await p().connectMount("env_x", "sbx_m", "/workspace")).toBeNull();
  });
  it("returns a sandbox when the worker is alive", async () => {
    expect(await p().connectMount("env_x", "sbx_m", "/workspace")).not.toBeNull();
  });
});

describe("ByocProvider.removeMount / captureMount", () => {
  it("removeMount swallows enqueue errors", async () => {
    await expect(p().removeMount("env_x", "sbx_m", "/workspace")).resolves.toBeUndefined();
    expect(enqueued[0]).toMatchObject({ op: "destroy", sandbox_id: "sbx_m" });
  });
  it("captureMount propagates r.error", async () => {
    results.set("req_1", { ok: false, error: "capture failed" });
    await expect(p().captureMount("env_x", "sbx_m", "/workspace", { kind: "git", remote: "r", base: "b" })).rejects.toThrow("capture failed");
  });
  it("captureMount returns the worker's ref on success", async () => {
    results.set("req_1", { ok: true, result: { kind: "git", remote: "r", base: "new" } });
    expect(await p().captureMount("env_x", "sbx_m", "/workspace", { kind: "git", remote: "r", base: "b" })).toEqual({ kind: "git", remote: "r", base: "new" });
  });
});
