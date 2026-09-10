import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

const sh = promisify(execFile);
const rows = new Map<string, SandboxRow>();
vi.mock("../src/sandbox/lease-store.ts", () => ({
  insert: async (r: SandboxRow) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() }); },
  setStatus: async (id: string, status: SandboxRow["status"]) => { rows.get(id)!.status = status; },
  setExternalRef: async (id: string, ref: string) => { rows.get(id)!.external_ref = ref; },
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
let hasDocker = false;

beforeAll(async () => {
  try { await sh("docker", ["version", "--format", "{{.Server.Version}}"]); hasDocker = true; } catch { hasDocker = false; }
  process.env.SANDBOX_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), "sbx-"));
  process.env.WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "ws-"));
  process.env.DATABASE_URL = "postgres://unused";
  const { DockerProvider } = await import("../src/sandbox/docker.ts");
  const { SandboxManager } = await import("../src/sandbox/manager.ts");
  manager = new SandboxManager({ docker: new DockerProvider() } as never);
});

afterAll(async () => {
  await sh("docker", ["ps", "-aq", "--filter", "label=pi.sandbox=1"]).then(async ({ stdout }) => {
    const ids = stdout.trim().split("\n").filter(Boolean);
    if (ids.length) await sh("docker", ["rm", "-f", ...ids]).catch(() => {});
  }).catch(() => {});
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = "", code = -1;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "exit") code = c.code!; }
  return { out: out.trim(), code };
}

describe("DockerProvider shared container", () => {
  it("a parent and child share one container with separate workdirs and a shared runtime", async () => {
    if (!hasDocker) { console.warn("docker not available; skipping"); return; }

    // parent: container_group G, env E -> containerKey G/E
    const key = "grp_demo/env_main";
    const parent = await manager.acquire("docker", { workspaceId: "ws_parent", containerKey: key, workspaceRef: { kind: "empty" }, affinity: "ws_parent" });
    // child: same container_group + env (shared containerKey), different workspace
    const child = await manager.acquire("docker", { workspaceId: "ws_child", containerKey: key, workspaceRef: { kind: "empty" }, affinity: "ws_child" });

    const pRow = rows.get(parent.sandbox.id)!;
    const cRow = rows.get(child.sandbox.id)!;

    // same container, distinct mount ids and distinct workdirs
    expect(cRow.container_ref).toBe(pRow.container_ref);
    expect(child.origin).toBe("shared");
    expect(parent.sandbox.workdir).not.toBe(child.sandbox.workdir);
    expect(parent.sandbox.workdir).toBe(`/host/${parent.sandbox.id}`);
    expect(child.sandbox.workdir).toBe(`/host/${child.sandbox.id}`);

    // separate directories: a file in the parent's workdir is NOT in the child's workdir
    await parent.sandbox.writeFile("only-parent.txt", new TextEncoder().encode("p"));
    expect((await collect(child.sandbox.exec("ls only-parent.txt 2>/dev/null; true"))).out).toBe("");

    // shared runtime: same kernel/hostname, and a file written to the shared /host by one mount
    // is visible to the other (proving one container, one filesystem)
    const ph = (await collect(parent.sandbox.exec("hostname"))).out;
    const chn = (await collect(child.sandbox.exec("hostname"))).out;
    expect(chn).toBe(ph); // one container => one hostname
    await collect(parent.sandbox.exec("echo shared > /host/shared.txt"));
    expect((await collect(child.sandbox.exec("cat /host/shared.txt"))).out).toBe("shared");

    // shared process namespace: a background process started via the parent mount is visible from the child mount
    await collect(parent.sandbox.exec("sleep 300 & echo started"));
    expect((await collect(child.sandbox.exec("pgrep -f 'sleep 300' | head -1 | grep -q . && echo yes || echo no"))).out).toBe("yes");

    await parent.release();
    await child.release();

    // reap at container granularity: both mounts idle -> the ONE container pauses, both mounts paused
    const r1 = await manager.reap(0, 3_600_000);
    expect(new Set(r1.docker.paused)).toEqual(new Set([parent.sandbox.id, child.sandbox.id]));
    expect(rows.get(parent.sandbox.id)!.status).toBe("paused");
    expect(rows.get(child.sandbox.id)!.status).toBe("paused");

    // paused past ttl -> the container is destroyed once, retiring both mounts
    const r2 = await manager.reap(0, 0);
    expect(new Set(r2.docker.destroyed)).toEqual(new Set([parent.sandbox.id, child.sandbox.id]));
    expect(rows.get(parent.sandbox.id)!.status).toBe("destroyed");
    expect(rows.get(child.sandbox.id)!.status).toBe("destroyed");
  }, 120_000);
});
