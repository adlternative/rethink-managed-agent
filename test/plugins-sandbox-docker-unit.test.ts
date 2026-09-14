import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Record every execFile ("docker inspect/run/rm/pause/...") and every spawn ("docker exec").
const execCalls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
const spawnCalls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
let inspectRunning = "true";

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const execFile = (file: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === "function" ? opts : cb;
    execCalls.push({ args, env: (opts as { env?: NodeJS.ProcessEnv })?.env });
    if (args[0] === "inspect") return done?.(null, { stdout: `${inspectRunning}\n`, stderr: "" });
    if (args[0] === "exec") return done?.(null, { stdout: "", stderr: "" }); // pickShell probe succeeds -> bash
    return done?.(null, { stdout: "", stderr: "" });
  };
  const spawn = (file: string, args: string[], opts: any) => {
    spawnCalls.push({ args, env: opts?.env });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, write: () => {} };
    child.pid = 4242; child.exitCode = null; child.signalCode = null;
    child.kill = () => {};
    queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0, null); child.emit("exit", 0, null); });
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});

let mod: typeof import("../src/sandbox/docker.ts");
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dkr-"));
  process.env.SANDBOX_LOCAL_ROOT = root;
  process.env.SANDBOX_DOCKER_NETWORK = "none";
  delete process.env.SANDBOX_HOST_ROOT;
  process.env.DATABASE_URL = "postgres://unused";
  mod = await import("../src/sandbox/docker.ts");
});
beforeEach(() => { execCalls.length = 0; spawnCalls.length = 0; inspectRunning = "true"; });
const runArgs = () => execCalls.find((c) => c.args[0] === "run")!.args;

describe("openContainer argument construction", () => {
  const p = () => new mod.DockerProvider();
  it("rejects hostile image references", async () => {
    for (const image of ["Evil", "--privileged", "a b"]) {
      await expect(p().openContainer("sbx_1", { workspaceId: "w", workspaceRef: { kind: "empty" }, image } as never)).rejects.toThrow(/invalid image/);
    }
  });
  it("network 'bridge' passes --network bridge; anything else uses SANDBOX_DOCKER_NETWORK", async () => {
    await p().openContainer("sbx_br", { workspaceId: "w", workspaceRef: { kind: "empty" }, network: "bridge" } as never);
    expect(pairAfter(runArgs(), "--network")).toBe("bridge");
    execCalls.length = 0;
    await p().openContainer("sbx_no", { workspaceId: "w", workspaceRef: { kind: "empty" }, network: "none" } as never);
    expect(pairAfter(runArgs(), "--network")).toBe("none");
  });
  // Secrets are per mount: a container shared by several sessions must not carry one session's secrets.
  it("never bakes secrets into the (shareable) container; each exec passes '-e KEY' with the value only in the CLI env", async () => {
    await p().openContainer("sbx_sec", { workspaceId: "w", workspaceRef: { kind: "empty" }, secrets: { API_TOKEN: "shhh" } } as never);
    const run = execCalls.find((c) => c.args[0] === "run")!;
    expect(run.args).not.toContain("API_TOKEN");
    expect(run.env!.API_TOKEN).toBeUndefined();
    expect(run.env!.DATABASE_URL).toBeUndefined();
    await mkdir(path.join(root, "ctrS", "ms"), { recursive: true });
    const sb = (await p().connectMount("ctrS", "ms", "/host/ms", { API_TOKEN: "shhh" }))!;
    spawnCalls.length = 0;
    for await (const _c of sb.exec("echo $API_TOKEN")) { /* drain */ }
    const exec = spawnCalls.find((c) => c.args[0] === "exec")!;
    expect(pairAfter(exec.args, "-e")).toBe("API_TOKEN");
    expect(exec.args.join(" ")).not.toContain("shhh");
    expect(exec.env!.API_TOKEN).toBe("shhh");
    expect(exec.env!.DATABASE_URL).toBeUndefined();
  });
});

describe("toHostPath", () => {
  it("maps under SANDBOX_HOST_ROOT and rejects a dir outside SANDBOX_LOCAL_ROOT", async () => {
    process.env.SANDBOX_HOST_ROOT = "/host/root";
    vi.resetModules();
    const m2 = await import("../src/sandbox/docker.ts");
    expect(m2.toHostPath(path.join(root, "ctr/mount"))).toBe("/host/root/ctr/mount");
    expect(() => m2.toHostPath("/somewhere/else")).toThrow(/outside SANDBOX_LOCAL_ROOT/);
    delete process.env.SANDBOX_HOST_ROOT;
    vi.resetModules();
    mod = await import("../src/sandbox/docker.ts");
  });
});

describe("file I/O path confinement and connectMount", () => {
  async function sandboxFor(id: string) {
    const dir = path.join(root, "ctrX", id);
    await mkdir(dir, { recursive: true });
    const sb = await new mod.DockerProvider().connectMount("ctrX", id, `/host/${id}`);
    return sb!;
  }
  it("readFile / writeFile reject a path that escapes the workdir", async () => {
    const sb = await sandboxFor("m1");
    await expect(sb.readFile("../other-mount/x")).rejects.toThrow(/escapes workdir/);
    await expect(sb.writeFile("../other-mount/x", new Uint8Array())).rejects.toThrow(/escapes workdir/);
  });
  it("connectMount returns null when the host dir is missing or the container is not running", async () => {
    expect(await new mod.DockerProvider().connectMount("ctrX", "ghost", "/host/ghost")).toBeNull();
    inspectRunning = "false";
    expect(await sandboxFor("m2").catch(() => null)).toBeNull();
  });
});

describe("pause / resume", () => {
  it("pause uses 'docker pause'; resume swallows unpause errors", async () => {
    await new mod.DockerProvider().pause("ctrP");
    expect(execCalls.some((c) => c.args[0] === "pause" && c.args[1] === "ctrP")).toBe(true);
    await expect(new mod.DockerProvider().resume("ctrP")).resolves.toBeUndefined();
    expect(execCalls.some((c) => c.args[0] === "unpause")).toBe(true);
  });
});

describe("docker exec env", () => {
  // Regression: makeSandbox exec runs under sandboxEnv(), which drops DOCKER_HOST, so a remote daemon is unreachable.
  it("keeps DOCKER_HOST in the docker exec spawn env when it is set in process.env", async () => {
    process.env.DOCKER_HOST = "unix:///custom/docker.sock";
    try {
      const dir = path.join(root, "ctrE", "me");
      await mkdir(dir, { recursive: true });
      const sb = (await new mod.DockerProvider().connectMount("ctrE", "me", "/host/me"))!;
      spawnCalls.length = 0;
      for await (const _c of sb.exec("echo hi")) { /* drain */ }
      const exec = spawnCalls.find((c) => c.args[0] === "exec");
      expect(exec!.env!.DOCKER_HOST).toBe("unix:///custom/docker.sock");
    } finally { delete process.env.DOCKER_HOST; }
  });
});

function pairAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
