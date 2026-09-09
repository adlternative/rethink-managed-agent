import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

const rows = new Map<string, SandboxRow>();
vi.mock("../src/sandbox/lease-store.ts", () => ({
  insert: async (r: SandboxRow) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() }); },
  setStatus: async (id: string, status: SandboxRow["status"]) => { rows.get(id)!.status = status; },
  touch: async () => {},
  findReadyByAffinity: async (_p: string, affinity: string) => {
    const r = [...rows.values()].find((r) => r.affinity === affinity && r.status === "ready");
    if (r) r.status = "busy";
    return r ?? null;
  },
  listIdle: async () => [...rows.values()].filter((r) => r.status === "ready"),
}));

let root: string;
let LocalProvider: typeof import("../src/sandbox/local.ts").LocalProvider;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sbx-"));
  process.env.SANDBOX_LOCAL_ROOT = root;
  ({ LocalProvider } = await import("../src/sandbox/local.ts"));
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = "", code = -1;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "exit") code = c.code!; }
  return { out, code };
}

describe("LocalProvider", () => {
  it("acquire/exec/write/read/capture/release/reap", async () => {
    const p = new LocalProvider();
    const lease = await p.acquire({ workspaceId: "ws_1", workspaceRef: { kind: "empty" }, affinity: "a" });
    const sb = lease.sandbox;
    expect(sb.workdir).toBe(path.join(root, sb.id));

    await sb.writeFile("hello.txt", new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(await sb.readFile("hello.txt"))).toBe("hi");
    await expect(sb.readFile("../escape")).rejects.toThrow(/escapes/);

    const r = await collect(sb.exec("cat hello.txt && echo $FOO", { env: { FOO: "bar" } }));
    expect(r.out).toBe("hibar\n");
    expect(r.code).toBe(0);

    const t = await collect(sb.exec("sleep 5", { timeoutMs: 100 }));
    expect(t.code).not.toBe(0);

    expect(await p.capture(sb, { kind: "empty" })).toEqual({ kind: "dir", path: sb.workdir });

    await lease.release();
    expect(rows.get(sb.id)!.status).toBe("ready");

    const again = await p.acquire({ workspaceId: "ws_1", workspaceRef: { kind: "empty" }, affinity: "a" });
    expect(again.sandbox.id).toBe(sb.id);
    await again.release();

    expect(await p.reap(0)).toEqual([sb.id]);
    expect(rows.get(sb.id)!.status).toBe("destroyed");
    await expect(stat(sb.workdir)).rejects.toThrow();
  });
});
