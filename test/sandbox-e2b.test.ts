import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRow } from "../src/shared/types.ts";

// ---- in-memory lease store ----
const rows = new Map<string, SandboxRow>();
vi.mock("../src/sandbox/lease-store.ts", () => ({
  insert: async (r: SandboxRow) => { rows.set(r.id, { ...r, last_used_at: new Date().toISOString(), created_at: new Date().toISOString() }); },
  setStatus: async (id: string, status: SandboxRow["status"]) => { rows.get(id)!.status = status; },
  setExternalRef: async (id: string, ref: string) => { rows.get(id)!.external_ref = ref; },
  touch: async () => {},
  findReadyByAffinity: async (_p: string, affinity: string) => {
    const r = [...rows.values()].find((r) => r.affinity === affinity && r.status === "ready");
    if (r) r.status = "busy";
    return r ?? null;
  },
  findBusyByAffinity: async (_p: string, affinity: string) => [...rows.values()].find((r) => r.affinity === affinity && r.status === "busy") ?? null,
  listIdle: async () => [...rows.values()].filter((r) => r.status === "ready"),
}));

// ---- fake e2b SDK: a tiny in-memory "remote" filesystem + shell that records commands ----
type Fake = { id: string; running: boolean; files: Map<string, Uint8Array>; cmds: string[]; killed: string[] };
const fakes = new Map<string, Fake>();
const killedIds: string[] = [];
class FakeSandbox {
  constructor(public fake: Fake) {}
  get sandboxId() { return this.fake.id; }
  static async create(template: string, o: { apiKey: string; metadata?: Record<string, string> }) {
    if (!o.apiKey) throw new Error("no key");
    const f: Fake = { id: `e2b_${template}_${fakes.size + 1}`, running: true, files: new Map(), cmds: [], killed: [] };
    fakes.set(f.id, f);
    return new FakeSandbox(f);
  }
  static async connect(id: string) {
    const f = fakes.get(id);
    if (!f) throw new Error("not found");
    return new FakeSandbox(f);
  }
  static async kill(id: string) { killedIds.push(id); const f = fakes.get(id); if (f) f.running = false; return true; }
  async isRunning() { return this.fake.running; }
  async setTimeout() {}
  async kill() { this.fake.running = false; return true; }
  files = {
    read: async (p: string, o?: { format?: string }) => {
      const d = this.fake.files.get(p);
      if (!d) throw new Error(`ENOENT ${p}`);
      return o?.format === "bytes" ? d : new TextDecoder().decode(d);
    },
    write: async (p: string, data: string | Blob) => {
      this.fake.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer()));
    },
  };
  commands = {
    run: async (cmd: string, o: { background?: boolean; onStdout?: (s: string) => void; onStderr?: (s: string) => void; cwd?: string; envs?: Record<string, string> }) => {
      this.fake.cmds.push(cmd);
      // minimal shell: echo, exit N, env lookup, tar round trip for capture
      let stdout = "", exitCode = 0;
      if (cmd.startsWith("echo ")) stdout = cmd.slice(5).replace(/^\$(\w+)$/, (_, k) => o.envs?.[k] ?? "") + "\n";
      else if (cmd.startsWith("exit ")) exitCode = Number(cmd.slice(5));
      else if (cmd.includes("git rev-parse HEAD")) stdout = "deadbeef\n";
      else if (cmd.includes("git diff HEAD --binary")) stdout = "diff --git a/x b/x\n";
      else if (cmd.includes("tar czf /tmp/pi-capture.tgz")) {
        // produce a real tgz of {hello.txt: "hi"} so the provider's local extraction works
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const dir = await mkdtemp(path.join(tmpdir(), "fake-"));
        await writeFile(path.join(dir, "hello.txt"), "hi");
        await promisify(execFile)("tar", ["czf", path.join(dir, "c.tgz"), "-C", dir, "hello.txt"]);
        this.fake.files.set("/tmp/pi-capture.tgz", new Uint8Array(await readFile(path.join(dir, "c.tgz"))));
      }
      if (o.background) {
        const handle = {
          exitCode: undefined as number | undefined,
          wait: async () => { o.onStdout?.(stdout); handle.exitCode = exitCode; if (exitCode) throw Object.assign(new Error("exit"), { exitCode }); return { exitCode, stdout, stderr: "" }; },
          kill: async () => { this.fake.killed.push(cmd); return true; },
        };
        return handle;
      }
      if (exitCode) throw Object.assign(new Error("exit"), { exitCode, stdout, stderr: "boom" });
      return { exitCode, stdout, stderr: "" };
    },
  };
}
vi.mock("e2b", () => ({ Sandbox: FakeSandbox }));

let E2bProvider: typeof import("../src/sandbox/e2b.ts").E2bProvider;
beforeAll(async () => {
  process.env.E2B_API_KEY = "test-key";
  process.env.WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "ws-"));
  process.env.DATABASE_URL = "postgres://unused";
  ({ E2bProvider } = await import("../src/sandbox/e2b.ts"));
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = "", code = -1;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "exit") code = c.code!; }
  return { out, code };
}

describe("E2bProvider", () => {
  it("creates a remote sandbox, materializes an empty workspace, execs, reads/writes, captures and reaps", async () => {
    const p = new E2bProvider();
    const lease = await p.acquire({ workspaceId: "ws_1", workspaceRef: { kind: "empty" }, affinity: "ws_1" });
    const sb = lease.sandbox;
    expect(sb.provider).toBe("e2b");
    const fake = [...fakes.values()][0];
    expect(fake.cmds[0]).toContain("mkdir -p '/home/user/workspace'");

    expect(await collect(sb.exec("echo hi"))).toEqual({ out: "hi\n", code: 0 });
    expect((await collect(sb.exec("exit 3"))).code).toBe(3);
    expect((await collect(sb.exec("echo $FOO", { env: { FOO: "bar" } }))).out).toBe("bar\n");

    await sb.writeFile("a/b.txt", new TextEncoder().encode("x"));
    expect(new TextDecoder().decode(await sb.readFile("a/b.txt"))).toBe("x");
    expect(fake.files.has("/home/user/workspace/a/b.txt")).toBe(true);
    await expect(sb.readFile("../../etc/passwd")).rejects.toThrow(/escapes/);

    const ref = await p.capture(sb, { kind: "empty" });
    expect(ref.kind).toBe("dir");
    expect(await readFile(path.join((ref as { path: string }).path, "hello.txt"), "utf8")).toBe("hi");

    await lease.release();
    expect(rows.get(sb.id)!.status).toBe("ready");
    expect(rows.get(sb.id)!.external_ref).toBe(fake.id);

    // affinity reuse reconnects to the same remote sandbox
    const lease2 = await p.acquire({ workspaceId: "ws_1", workspaceRef: ref, affinity: "ws_1" });
    expect(lease2.sandbox.id).toBe(sb.id);
    expect(fakes.size).toBe(1);
    await lease2.release();

    // reap kills remotely and retires the row
    expect(await p.reap(0)).toEqual([sb.id]);
    expect(killedIds).toEqual([fake.id]);
    expect(rows.get(sb.id)!.status).toBe("destroyed");
  });

  it("materializes git refs with quoted args and captures a patch", async () => {
    const p = new E2bProvider();
    const lease = await p.acquire({ workspaceId: "ws_2", workspaceRef: { kind: "git", remote: "https://x/y.git", base: "abc", patch: "P" }, affinity: "ws_2" });
    const fake = fakes.get(rows.get(lease.sandbox.id)!.external_ref!)!;
    expect(fake.cmds.some((c) => c.includes("git clone --quiet -- 'https://x/y.git'"))).toBe(true);
    expect(fake.cmds.some((c) => c.includes("git checkout --quiet --detach 'abc'"))).toBe(true);
    expect(fake.cmds.some((c) => c.includes("git apply"))).toBe(true);
    const ref = await p.capture(lease.sandbox, { kind: "git", remote: "https://x/y.git", base: "old" });
    expect(ref).toEqual({ kind: "git", remote: "https://x/y.git", base: "deadbeef", patch: "diff --git a/x b/x\n" });
    await lease.release();
  });

  it("rejects hostile git args, local workspaces and bad templates", async () => {
    const p = new E2bProvider();
    await expect(p.acquire({ workspaceId: "w", workspaceRef: { kind: "git", remote: "--upload-pack=evil", base: "x" } })).rejects.toThrow(/invalid git remote/);
    await expect(p.acquire({ workspaceId: "w", workspaceRef: { kind: "local", path: "/" } })).rejects.toThrow(/cloud sandbox/);
    await expect(p.acquire({ workspaceId: "w", workspaceRef: { kind: "empty" }, image: "-bad" })).rejects.toThrow(/invalid template/);
  });
});
