import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

const rows = new Map<string, SandboxRow>();
vi.mock("../src/sandbox/lease-store.ts", () => ({
  insert: async (r: SandboxRow) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() }); },
  setStatus: async (id: string, status: SandboxRow["status"]) => { rows.get(id)!.status = status; },
  setExternalRef: async (id: string, ref: string) => { rows.get(id)!.external_ref = ref; },
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

let root: string;
let wsRoot: string;
let manager: import("../src/sandbox/manager.ts").SandboxManager;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sbx-"));
  wsRoot = await mkdtemp(path.join(tmpdir(), "ws-"));
  process.env.SANDBOX_LOCAL_ROOT = root;
  process.env.WORKSPACE_ROOT = wsRoot;
  process.env.DATABASE_URL = "postgres://unused";
  const { LocalProvider } = await import("../src/sandbox/local.ts");
  const { SandboxManager } = await import("../src/sandbox/manager.ts");
  manager = new SandboxManager({ local: new LocalProvider() } as never);
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = "", code = -1;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "exit") code = c.code!; }
  return { out, code };
}

describe("LocalProvider", () => {
  it("acquire/exec/write/read/capture/release/reap", async () => {
    const lease = await manager.acquire("local", { workspaceId: "ws_1", workspaceRef: { kind: "empty" }, affinity: "a" });
    const sb = lease.sandbox;
    expect(sb.workdir).toBe(path.join(root, sb.id));

    await sb.writeFile("hello.txt", new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(await sb.readFile("hello.txt"))).toBe("hi");
    await expect(sb.readFile("../escape")).rejects.toThrow(/escapes/);

    const r = await collect(sb.exec("cat hello.txt && echo $FOO", { env: { FOO: "bar" } }));
    expect(r.out).toBe("hibar\n");
    expect(r.code).toBe(0);

    // runner secrets never reach the sandbox env
    process.env.PI_TEST_SECRET = "s3cret";
    expect((await collect(sb.exec("echo \"[$PI_TEST_SECRET]\""))).out).toBe("[]\n");

    // symlink escapes are rejected on the host side of file I/O
    await collect(sb.exec("ln -s / esc && ln -s /nonexistent-target dangling"));
    await expect(sb.readFile("esc/etc/hosts")).rejects.toThrow(/symlink/);
    await expect(sb.writeFile("esc/tmp/pwned", new Uint8Array())).rejects.toThrow(/symlink/);
    await expect(sb.writeFile("dangling", new Uint8Array())).rejects.toThrow(/symlink/);
    await sb.writeFile("sub/new.txt", new TextEncoder().encode("ok")); // new file under a new dir is fine

    const t = await collect(sb.exec("sleep 5", { timeoutMs: 100 }));
    expect(t.code).not.toBe(0);

    // a second session on the same workspace while this one holds the lease is rejected
    await expect(manager.acquire("local", { workspaceId: "ws_1", workspaceRef: { kind: "empty" }, affinity: "a" })).rejects.toThrow(/in use/);

    // capture copies into the persistent workspace root, outside the reapable sandbox dir
    const ref = await manager.capture(sb, { kind: "empty" });
    expect(ref).toEqual({ kind: "dir", path: path.join(wsRoot, sb.id) });
    const wsDir = (ref as { path: string }).path;
    expect(await readFile(path.join(wsDir, "hello.txt"), "utf8")).toBe("hi");
    // recapturing into an existing dir ref replaces it (deletions propagate)
    await sb.writeFile("hello.txt", new TextEncoder().encode("hi2"));
    await collect(sb.exec("rm sub/new.txt"));
    expect(await manager.capture(sb, ref)).toEqual(ref);
    expect(await readFile(path.join(wsDir, "hello.txt"), "utf8")).toBe("hi2");
    await expect(stat(path.join(wsDir, "sub/new.txt"))).rejects.toThrow();

    await lease.release();
    expect(rows.get(sb.id)!.status).toBe("ready");

    const again = await manager.acquire("local", { workspaceId: "ws_1", workspaceRef: ref, affinity: "a" });
    expect(again.sandbox.id).toBe(sb.id);
    await again.release();

    expect((await manager.reap(0, 0)).local.destroyed).toEqual([sb.id]); // local has no pause(): idle -> destroyed
    expect(rows.get(sb.id)!.status).toBe("destroyed");
    await expect(stat(sb.workdir)).rejects.toThrow();
    // the workspace survives the reaper and rebuilds a fresh sandbox
    const rebuilt = await manager.acquire("local", { workspaceId: "ws_1", workspaceRef: ref, affinity: "a" });
    expect(rebuilt.sandbox.id).not.toBe(sb.id);
    expect(new TextDecoder().decode(await rebuilt.sandbox.readFile("hello.txt"))).toBe("hi2");
    await rebuilt.release();
  });
});
