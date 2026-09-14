import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listArtifacts, readArtifact, deleteArtifact } from "../src/infra/artifacts.ts";

let root = "", outside = "";
beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "infra-art-"));
  root = path.join(base, "ws"); outside = path.join(base, "host");
  await mkdir(path.join(root, "pkg", "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.env"), "HOST_SECRET=1");
  await writeFile(path.join(root, "pkg", "index.js"), "x");
  await writeFile(path.join(root, "pkg", "node_modules", "dep", "a.js"), "y");
  await writeFile(path.join(root, ".pi-workspace.patch"), "patch");
  await symlink(path.join(outside, "secret.env"), path.join(root, "leak"));
  await symlink(outside, path.join(root, "hostdir"));
});
const ref = () => ({ kind: "dir" as const, path: root });

describe("artifact reader edge paths", () => {
  it("skips nested node_modules, the workspace patch, and symlinks when listing", async () => {
    expect((await listArtifacts(ref())).map((e) => e.path)).toEqual(["pkg/index.js"]);
  });

  it("a deep, wide tree (more entries than the concurrent-fs bound) is listed completely and in path order", async () => {
    const wide = await mkdtemp(path.join(os.tmpdir(), "infra-art-wide-"));
    const expected: string[] = [];
    for (let d = 0; d < 12; d++) {
      const dir = path.join(wide, `d${d}`, "nested", "deeper");
      await mkdir(dir, { recursive: true });
      await mkdir(path.join(wide, `d${d}`, ".git"), { recursive: true });
      await writeFile(path.join(wide, `d${d}`, ".git", "HEAD"), "ref");
      for (let f = 0; f < 15; f++) {
        await writeFile(path.join(wide, `d${d}`, `f${f}.txt`), "a"); expected.push(`d${d}/f${f}.txt`);
        await writeFile(path.join(dir, `g${f}.txt`), "b"); expected.push(`d${d}/nested/deeper/g${f}.txt`);
      }
    }
    expected.sort((a, b) => a.localeCompare(b));
    const listed = await listArtifacts({ kind: "dir", path: wide });
    expect(listed.map((e) => e.path)).toEqual(expected);
  });

  it("local refs are host trees too", async () => {
    expect((await listArtifacts({ kind: "local", path: root } as never)).map((e) => e.path)).toEqual(["pkg/index.js"]);
  });

  it("absolute paths outside the root are refused", async () => {
    await expect(readArtifact(ref(), "/etc/passwd")).rejects.toThrow(/escapes/);
    await expect(deleteArtifact(ref(), "../host/secret.env")).rejects.toThrow(/escapes/);
  });

  it("a directory is not an artifact; a missing file reads null and deletes false", async () => {
    expect(await readArtifact(ref(), "sub")).toBeNull();
    expect(await readArtifact(ref(), "")).toBeNull();
    expect(await readArtifact(ref(), "nope.txt")).toBeNull();
    expect(await deleteArtifact(ref(), "nope.txt")).toBe(false);
    expect(await deleteArtifact(ref(), "sub")).toBe(false);
  });

  it("an undefined ref yields [] / null / false", async () => {
    expect(await listArtifacts(undefined)).toEqual([]);
    expect(await readArtifact(undefined, "a")).toBeNull();
    expect(await deleteArtifact(undefined, "a")).toBe(false);
  });

  it("a listing entry reports size and mtime seconds", async () => {
    const [e] = await listArtifacts(ref());
    expect(e!.size).toBe(1);
    expect(Number.isInteger(e!.mtimeSec)).toBe(true);
  });

  // Regression: confinement is lexical; stat/readFile follow symlinks, so a symlink the agent creates in its
  // workspace discloses host files.
  it("reading a symlink to a host file does not return the host file's bytes", async () => {
    const r = await readArtifact(ref(), "leak").catch(() => null);
    expect(r).toBeNull();
  });

  it("reading through a symlinked directory does not escape the workspace", async () => {
    const r = await readArtifact(ref(), "hostdir/secret.env").catch(() => null);
    expect(r).toBeNull();
  });
});
