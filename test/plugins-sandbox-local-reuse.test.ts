import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

// Same in-memory lease store shape the other sandbox-local tests use.
const rows = new Map<string, SandboxRow>();
vi.mock("../src/sandbox/lease-store.ts", () => ({
  insert: async (r: SandboxRow) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() }); },
  setStatus: async (id: string, status: SandboxRow["status"]) => { rows.get(id)!.status = status; },
  setExternalRef: async () => {},
  setMount: async (id: string, cref: string, wd: string) => { const r = rows.get(id)!; r.container_ref = cref; r.workdir = wd; },
  findContainer: async (p: string, key: string) => [...rows.values()].find((r) => r.provider === p && r.container_key === key && r.container_ref && ["ready", "busy", "paused"].includes(r.status)) ?? null,
  mountsOf: async (cref: string) => [...rows.values()].filter((r) => r.container_ref === cref && r.status !== "destroyed"),
  touch: async () => {},
  get: async (id: string) => rows.get(id) ?? null,
  list: async () => [...rows.values()].filter((r) => r.status !== "destroyed"),
  findReadyByAffinity: async (p: string, affinity: string) => {
    const r = [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && (r.status === "ready" || r.status === "paused"));
    if (!r) return null;
    const prev = r.status; r.status = "busy";
    return { ...r, status: prev };
  },
  findBusyByAffinity: async (p: string, affinity: string) => [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && r.status === "busy") ?? null,
  listIdle: async (p: string) => [...rows.values()].filter((r) => r.provider === p && r.status === "ready"),
  listToDestroy: async (p: string, ttl: number) => [...rows.values()].filter((r) => r.provider === p && ((r.status === "paused" && ttl === 0) || r.status === "destroying")),
}));

let manager: import("../src/sandbox/manager.ts").SandboxManager;
beforeAll(async () => {
  process.env.SANDBOX_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), "sbx-"));
  process.env.WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "ws-"));
  process.env.DATABASE_URL = "postgres://unused";
  const { LocalProvider } = await import("../src/sandbox/local.ts");
  const { SandboxManager } = await import("../src/sandbox/manager.ts");
  manager = new SandboxManager({ local: new LocalProvider() } as never);
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = ""; for await (const c of it) if (c.type === "stdout") out += c.data; return out;
}

describe("LocalProvider secret persistence across reuse", () => {
  // Regression: connectMount rebuilds the sandbox without secrets, so a reused lease loses vault secrets.
  it("a reused local lease still sees the secrets baked in at acquire", async () => {
    const req = { workspaceId: "ws_sec", workspaceRef: { kind: "empty" as const }, affinity: "aff_sec", secrets: { TOKEN: "t" } };
    const first = await manager.acquire("local", req);
    expect(await collect(first.sandbox.exec("echo $TOKEN"))).toBe("t\n");
    await first.release();
    const reused = await manager.acquire("local", req);
    expect(reused.origin).toBe("reused");
    expect(await collect(reused.sandbox.exec("echo $TOKEN"))).toBe("t\n");
    await reused.release();
  });
});
