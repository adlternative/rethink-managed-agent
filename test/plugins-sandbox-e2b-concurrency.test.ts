import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

const run = promisify(execFile);
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
  findReadyByAffinity: async (p: string, affinity: string) => { const r = [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && (r.status === "ready" || r.status === "paused")); if (!r) return null; const prev = r.status; r.status = "busy"; return { ...r, status: prev }; },
  findBusyByAffinity: async (p: string, affinity: string) => [...rows.values()].find((r) => r.provider === p && r.affinity === affinity && r.status === "busy") ?? null,
  listIdle: async () => [],
  listToDestroy: async () => [],
}));

// A fake e2b whose per-container filesystem is keyed by path, so a shared temp path collides across mounts.
type Fake = { id: string; running: boolean; files: Map<string, Uint8Array> };
const fakes = new Map<string, Fake>();
const delay = () => new Promise((r) => setTimeout(r, 40));
class FakeSandbox {
  constructor(public fake: Fake) {}
  get sandboxId() { return this.fake.id; }
  static async create(_t: string, o: { apiKey: string }) { if (!o.apiKey) throw new Error("no key"); const f: Fake = { id: `e2b_${fakes.size + 1}`, running: true, files: new Map() }; fakes.set(f.id, f); return new FakeSandbox(f); }
  static async connect(id: string) { const f = fakes.get(id)!; f.running = true; return new FakeSandbox(f); }
  static async pause(id: string) { const f = fakes.get(id); if (f) f.running = false; }
  static async kill() {}
  async isRunning() { return this.fake.running; }
  async setTimeout() {}
  async kill() {}
  files = {
    read: async (p: string, o?: { format?: string }) => { await delay(); const d = this.fake.files.get(p); if (!d) throw new Error(`ENOENT ${p}`); return o?.format === "bytes" ? d : new TextDecoder().decode(d); },
    write: async (p: string, data: string | Blob) => { this.fake.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer())); },
  };
  commands = {
    run: async (cmd: string) => {
      await delay();
      if (cmd.includes("git rev-parse HEAD")) return { exitCode: 0, stdout: `head-${cmd.match(/mnt\/(sbx_[^\s'`]+)/)?.[1]}\n`, stderr: "" };
      if (cmd.includes("git diff HEAD --binary")) { const id = cmd.match(/mnt\/(sbx_[^\s'`]+)/)?.[1]; return { exitCode: 0, stdout: `diff-for-${id}\n`, stderr: "" }; }
      if (/tar czf \/tmp\/pi-cap\S*\.tgz/.test(cmd)) {
        // capture: build a tgz whose single file names the mount id, written to the temp path named in the command
        const target = /tar czf (\/tmp\/pi-cap\S*\.tgz)/.exec(cmd)![1]!;
        const id = cmd.match(/mnt\/(sbx_[^\s'`]+)/)?.[1]!;
        const dir = await mkdtemp(path.join(tmpdir(), "e2bc-"));
        await writeFile(path.join(dir, "who.txt"), id);
        await run("tar", ["czf", path.join(dir, "c.tgz"), "-C", dir, "who.txt"]);
        this.fake.files.set(target, new Uint8Array(await readFile(path.join(dir, "c.tgz"))));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}
vi.mock("e2b", () => ({ Sandbox: FakeSandbox }));

let manager: import("../src/sandbox/manager.ts").SandboxManager;
beforeAll(async () => {
  process.env.E2B_API_KEY = "k";
  process.env.WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "ws-"));
  process.env.DATABASE_URL = "postgres://unused";
  const { E2bProvider } = await import("../src/sandbox/e2b.ts");
  const { SandboxManager } = await import("../src/sandbox/manager.ts");
  manager = new SandboxManager({ e2b: new E2bProvider() } as never);
});

describe("e2b shared-container concurrency", () => {
  // Regression: captureMount uses the fixed /tmp/pi-cap.tgz, so concurrent dir captures clobber each other.
  it("two concurrent dir captures on different mounts in one container each return their own contents", async () => {
    const key = "grp/env";
    const a = await manager.acquire("e2b", { workspaceId: "wsA", containerKey: key, workspaceRef: { kind: "empty" }, affinity: "wsA" });
    const b = await manager.acquire("e2b", { workspaceId: "wsB", containerKey: key, workspaceRef: { kind: "empty" }, affinity: "wsB" });
    expect(rows.get(b.sandbox.id)!.container_ref).toBe(rows.get(a.sandbox.id)!.container_ref);
    const [ra, rb] = await Promise.all([manager.capture(a.sandbox, { kind: "empty" }), manager.capture(b.sandbox, { kind: "empty" })]);
    const who = async (r: import("../src/shared/types.ts").WorkspaceRef) => readFile(path.join((r as { path: string }).path, "who.txt"), "utf8");
    expect(await who(ra)).toBe(a.sandbox.id);
    expect(await who(rb)).toBe(b.sandbox.id);
    await a.release(); await b.release();
  });

  it("concurrent git captures on different mounts return each mount's own patch", async () => {
    const key = "grp2/env";
    const a = await manager.acquire("e2b", { workspaceId: "wsC", containerKey: key, workspaceRef: { kind: "git", remote: "r", base: "x" }, affinity: "wsC" });
    const b = await manager.acquire("e2b", { workspaceId: "wsD", containerKey: key, workspaceRef: { kind: "git", remote: "r", base: "x" }, affinity: "wsD" });
    const [ra, rb] = await Promise.all([
      manager.capture(a.sandbox, { kind: "git", remote: "r", base: "x" }),
      manager.capture(b.sandbox, { kind: "git", remote: "r", base: "x" }),
    ]);
    expect((ra as { patch?: string }).patch).toBe(`diff-for-${a.sandbox.id}\n`);
    expect((rb as { patch?: string }).patch).toBe(`diff-for-${b.sandbox.id}\n`);
    await a.release(); await b.release();
  });
});
