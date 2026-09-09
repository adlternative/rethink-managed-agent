import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRef, WorkspaceSpec } from "../shared/types.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });

/**
 * Puts workspace content into `targetHostDir` and returns the directory the sandbox should use
 * as its workdir (equals targetHostDir except for `local`, which is used in place).
 */
export async function materialize(ws: WorkspaceSpec | WorkspaceRef, targetHostDir: string): Promise<string> {
  if (ws.kind === "local") return path.resolve(ws.path);
  await mkdir(targetHostDir, { recursive: true });
  if (ws.kind === "empty") return targetHostDir;
  if (ws.kind === "dir") {
    if (path.resolve(ws.path) !== path.resolve(targetHostDir)) await run("cp", ["-R", `${ws.path}/.`, targetHostDir]);
    return targetHostDir;
  }
  // git spec or ref
  await git(targetHostDir, "clone", "--quiet", ws.remote, ".");
  const base = "base" in ws ? ws.base : ws.ref;
  if (base) await git(targetHostDir, "checkout", "--quiet", base);
  if ("patch" in ws && ws.patch) {
    const patchFile = path.join(targetHostDir, ".pi-workspace.patch");
    await writeFile(patchFile, ws.patch);
    try {
      await git(targetHostDir, "apply", "--whitespace=nowarn", patchFile);
    } finally {
      await rm(patchFile, { force: true });
    }
  }
  return targetHostDir;
}

/** Captures HEAD + working-tree diff (untracked files included) as a git WorkspaceRef. */
export async function captureGit(dir: string, prev: Extract<WorkspaceRef, { kind: "git" }>): Promise<WorkspaceRef> {
  const { stdout: head } = await git(dir, "rev-parse", "HEAD");
  await git(dir, "add", "-N", "--all");
  const { stdout: patch } = await git(dir, "diff", "HEAD", "--binary");
  const ref: WorkspaceRef = { kind: "git", remote: prev.remote, base: head.trim() };
  if (patch.trim()) ref.patch = patch;
  return ref;
}
