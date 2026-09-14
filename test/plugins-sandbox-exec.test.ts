import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInside, resolveInsideReal, sandboxEnv, streamProcess } from "../src/sandbox/exec.ts";

let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(path.join(tmpdir(), "pma-exec-")); });
afterAll(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); });

describe("resolveInside", () => {
  const W = "/w";
  it("accepts a subpath, an absolute path inside, and a normalized inner path", () => {
    expect(resolveInside("/host", W, "sub")).toBe(path.join("/host", "sub"));
    expect(resolveInside("/host", W, "/w/sub")).toBe(path.join("/host", "sub"));
    expect(resolveInside("/host", W, "a/../b")).toBe(path.join("/host", "b"));
  });
  // Regression: resolveInside checks rel.startsWith("..") so a real filename beginning with ".." is rejected.
  it("accepts a filename that merely starts with '..' but stays inside ('..foo')", () => {
    expect(resolveInside("/host", W, "..foo")).toBe(path.join("/host", "..foo"));
  });
  it("rejects a real escape and an absolute path outside the workdir", () => {
    expect(() => resolveInside("/host", W, "../x")).toThrow(/escapes workdir/);
    expect(() => resolveInside("/host", W, "/etc/passwd")).toThrow(/escapes workdir/);
  });
});

describe("resolveInsideReal", () => {
  it("allows a symlink that points inside the root", async () => {
    const root = await mkdtemp(path.join(tmp, "in-"));
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "link"));
    await writeFile(path.join(root, "real/f.txt"), "x");
    expect(await resolveInsideReal(root, root, "link/f.txt")).toBe(path.join(await realOf(root), "real/f.txt"));
  });
  it("rejects a symlinked ancestor that escapes and a dangling symlink", async () => {
    const root = await mkdtemp(path.join(tmp, "esc-"));
    const outside = await mkdtemp(path.join(tmp, "out-"));
    await writeFile(path.join(outside, "secret"), "s");
    await symlink(outside, path.join(root, "esc"));
    await expect(resolveInsideReal(root, root, "esc/secret")).rejects.toThrow(/symlink/);
    await symlink(path.join(root, "nope"), path.join(root, "dangling"));
    await expect(resolveInsideReal(root, root, "dangling")).rejects.toThrow(/symlink/);
  });
  it("handles a hostRoot that is itself under a symlink (macOS /var -> /private/var)", async () => {
    // tmpdir() on macOS is under /var, a symlink to /private/var; resolveInsideReal realpaths hostRoot.
    const root = await mkdtemp(path.join(tmp, "sym-"));
    await writeFile(path.join(root, "f.txt"), "x");
    const resolved = await resolveInsideReal(root, root, "f.txt");
    expect(resolved).toBe(path.join(await realOf(root), "f.txt"));
    // a genuine escape is still caught even through the symlinked ancestor
    await expect(resolveInsideReal(root, root, "../escape")).rejects.toThrow(/escapes workdir/);
  });
});
async function realOf(p: string) { return (await import("node:fs/promises")).realpath(p); }

describe("sandboxEnv", () => {
  it("drops runner secrets, keeps the allowlist, and applies extra overrides", () => {
    process.env.DATABASE_URL = "postgres://secret";
    process.env.PATH = process.env.PATH || "/usr/bin";
    const e = sandboxEnv({ TOKEN: "t", PATH: "/override" });
    expect(e.DATABASE_URL).toBeUndefined();
    expect(e.TOKEN).toBe("t");
    expect(e.PATH).toBe("/override");
    expect(sandboxEnv().PATH).toBe(process.env.PATH);
  });
});

async function collect(it: AsyncIterable<{ type: string; data?: string; code?: number }>) {
  let out = "", err = "", code = -99;
  for await (const c of it) { if (c.type === "stdout") out += c.data; if (c.type === "stderr") err += c.data; if (c.type === "exit") code = c.code!; }
  return { out, err, code };
}
const psExists = async (pat: string) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("pgrep", ["-f", pat]).catch(() => ({ stdout: "" }));
  return stdout.trim().length > 0;
};

describe("streamProcess", () => {
  it("a timeout kills the whole process group (a backgrounded grandchild is gone)", async () => {
    // a sleep duration no other test uses, so pgrep cannot match another test's process
    const secs = `41.${process.pid % 1000}`;
    const r = await collect(streamProcess("bash", ["-lc", `sleep ${secs} & wait`], { timeoutMs: 200 }));
    expect(r.code).not.toBe(0);
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) { await new Promise((res) => setTimeout(res, 100)); alive = await psExists(`sleep ${secs}`); }
    expect(alive).toBe(false);
  }, 10_000);

  it("a timed-out command never reports success even if the shell outlives its killed job (load race)", async () => {
    // Regression: under load the group kill reached the backgrounded sleep before bash, bash survived,
    // `wait` returned 0 and the timeout was reported as exit 0.
    const runs = await Promise.all(Array.from({ length: 40 }, () => collect(streamProcess("bash", ["-lc", `sleep 42.${process.pid % 1000} & wait`], { timeoutMs: 150 }))));
    expect(runs.map((r) => r.code).filter((c) => c === 0)).toEqual([]);
  }, 20_000);

  it("an abort signal kills the process", async () => {
    const ac = new AbortController();
    const p = collect(streamProcess("bash", ["-lc", "sleep 30"], { signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.code).not.toBe(0);
  }, 10_000);

  it("a missing binary yields stderr plus exit 127", async () => {
    const r = await collect(streamProcess("this-binary-does-not-exist-pma", [], {}));
    expect(r.code).toBe(127);
    expect(r.err).toBeTruthy();
  });

  it("breaking out of the loop early kills the child", async () => {
    let pid = "";
    const marker = `pma-break-${process.pid}-${Date.now()}`;
    const it = streamProcess("bash", ["-lc", `echo go; exec -a ${marker} sleep 30`], {});
    for await (const c of it) { if (c.type === "stdout" && c.data?.includes("go")) break; }
    await new Promise((res) => setTimeout(res, 300));
    expect(await psExists(marker)).toBe(false);
    expect(pid).toBe("");
  }, 10_000);
});
