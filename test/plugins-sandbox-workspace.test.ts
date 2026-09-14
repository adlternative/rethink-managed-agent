import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
let tmp: string;
let wsRoot: string;
let mod: typeof import("../src/sandbox/workspace.ts");

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "pma-ws-"));
  wsRoot = await mkdtemp(path.join(tmpdir(), "pma-wsroot-"));
  process.env.WORKSPACE_ROOT = wsRoot;
  process.env.SANDBOX_LOCAL_ROOT = tmp;
  mod = await import("../src/sandbox/workspace.ts");
});
afterAll(async () => { for (const d of [tmp, wsRoot]) if (d) await rm(d, { recursive: true, force: true }); });

async function gitRepo(name: string, files: Record<string, string> = { "a.txt": "one\n" }): Promise<string> {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  for (const [f, c] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, f)), { recursive: true }); await writeFile(path.join(dir, f), c); }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("captureGit", () => {
  // Regression: captureGit runs git in a sandbox-writable repo without disabling config-driven hooks
  // (core.fsmonitor / diff.external), so sandboxed code gets arbitrary execution on the runner host.
  it("does not execute a command injected via .git/config core.fsmonitor / diff.external", async () => {
    const dir = await gitRepo("pwn");
    const marker = path.join(tmp, "PWNED");
    await run("git", ["config", "core.fsmonitor", `touch ${marker}; false #`], { cwd: dir });
    await run("git", ["config", "diff.external", `touch ${marker}`], { cwd: dir });
    await writeFile(path.join(dir, "a.txt"), "changed\n");
    const ref = await mod.captureGit(dir, { kind: "git", remote: "r", base: "x" });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
    expect(ref.kind).toBe("git");
    expect((ref as { patch?: string }).patch).toMatch(/changed/);
  });

  it("includes an untracked new file in the patch (add -N)", async () => {
    const dir = await gitRepo("untracked");
    await writeFile(path.join(dir, "new.txt"), "brand new\n");
    const ref = await mod.captureGit(dir, { kind: "git", remote: "r", base: "x" });
    expect((ref as { patch?: string }).patch).toMatch(/new\.txt/);
    expect((ref as { patch?: string }).patch).toMatch(/brand new/);
  });

  it("gives no patch key on a clean tree", async () => {
    const dir = await gitRepo("clean");
    const ref = await mod.captureGit(dir, { kind: "git", remote: "r", base: "x" });
    expect("patch" in ref).toBe(false);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: dir });
    expect((ref as { base: string }).base).toBe(stdout.trim());
  });

  it("round-trips a binary change through materialize(ref)", async () => {
    const dir = await gitRepo("binary", { "keep.txt": "x\n" });
    const bin = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10]);
    await writeFile(path.join(dir, "data.bin"), bin);
    const remote = await bareRemote(dir);
    const ref = await mod.captureGit(dir, { kind: "git", remote, base: "x" });
    const target = path.join(tmp, "materialized");
    await mod.materialize(ref, target);
    expect(Buffer.from(await readFile(path.join(target, "data.bin")))).toEqual(bin);
    expect(await stat(path.join(target, ".pi-workspace.patch")).then(() => true, () => false)).toBe(false);
  });
});
async function bareRemote(dir: string): Promise<string> {
  const bare = path.join(tmp, `${path.basename(dir)}.git`);
  await run("git", ["clone", "-q", "--bare", dir, bare]);
  return bare;
}

describe("materialize", () => {
  it("rejects a hostile git remote before it reaches argv", async () => {
    await expect(mod.materialize({ kind: "git", remote: "-uhack", base: "x" } as never, path.join(tmp, "m1"))).rejects.toThrow(/invalid git remote/);
  });
  it("rejects a ref with whitespace and a ref starting with '-' (after a real clone)", async () => {
    const remote = await bareRemote(await gitRepo("ref-check"));
    await expect(mod.materialize({ kind: "git", remote, base: "a b" } as never, path.join(tmp, "m2"))).rejects.toThrow(/invalid git ref/);
    await expect(mod.materialize({ kind: "git", remote, base: "-rf" } as never, path.join(tmp, "m3"))).rejects.toThrow(/invalid git ref/);
  }, 15_000);

  it("throws for byoc and blob refs", async () => {
    await expect(mod.materialize({ kind: "byoc", worker: "w", path: "/x" } as never, path.join(tmp, "b1"))).rejects.toThrow(/BYOC/);
    await expect(mod.materialize({ kind: "blob", key: "k", bytes: 1 } as never, path.join(tmp, "b2"))).rejects.toThrow(/blob/);
  });

  it("does not copy a dir ref onto itself when path === target", async () => {
    const src = path.join(tmp, "self");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "f.txt"), "keep");
    const out = await mod.materialize({ kind: "dir", path: src }, src);
    expect(out).toBe(src);
    expect(await readFile(path.join(src, "f.txt"), "utf8")).toBe("keep");
  });

  it("applies a git patch and removes the .pi-workspace.patch file", async () => {
    const dir = await gitRepo("patched", { "f.txt": "orig\n" });
    const remote = await bareRemote(dir);
    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd: dir });
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-orig\n+patched\n";
    const target = path.join(tmp, "patch-target");
    await mod.materialize({ kind: "git", remote, base: head.trim(), patch }, target);
    expect(await readFile(path.join(target, "f.txt"), "utf8")).toBe("patched\n");
    expect(await stat(path.join(target, ".pi-workspace.patch")).then(() => true, () => false)).toBe(false);
  });
});

describe("captureDir", () => {
  it("succeeds despite leftover <dest>.old-<pid> and <dest>.tmp-<pid> dirs", async () => {
    const sandboxDir = path.join(tmp, "cap-src");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(path.join(sandboxDir, "f.txt"), "v1");
    const dest = path.join(wsRoot, "cap-dest");
    await mkdir(`${dest}.old-${process.pid}`, { recursive: true });
    await mkdir(`${dest}.tmp-${process.pid}`, { recursive: true });
    await writeFile(path.join(`${dest}.tmp-${process.pid}`, "junk"), "junk");
    const ref = await mod.captureDir(sandboxDir, { kind: "dir", path: dest }, "cap-dest");
    expect(ref).toEqual({ kind: "dir", path: dest });
    expect(await readFile(path.join(dest, "f.txt"), "utf8")).toBe("v1");
    expect(await stat(`${dest}.old-${process.pid}`).then(() => true, () => false)).toBe(false);
  });

  it("leaves the previous dest intact when the copy fails", async () => {
    const sandboxDir = path.join(tmp, "cap-fail-src");
    await mkdir(sandboxDir, { recursive: true });
    // an unreadable file makes `cp -R` fail
    const bad = path.join(sandboxDir, "secret");
    await writeFile(bad, "x");
    await run("chmod", ["000", bad]);
    const dest = path.join(wsRoot, "cap-fail-dest");
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "prev.txt"), "previous");
    let threw = false;
    try { await mod.captureDir(sandboxDir, { kind: "dir", path: dest }, "cap-fail-dest"); } catch { threw = true; }
    // whether cp errors depends on privileges; if it did throw, the old dest must survive
    if (threw) expect(await readFile(path.join(dest, "prev.txt"), "utf8")).toBe("previous");
    await run("chmod", ["644", bad]).catch(() => {});
  });
});
