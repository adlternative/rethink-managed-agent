import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import type { WorkspaceRef, WorkspaceSpec } from "../shared/types.ts";

const run = promisify(execFile);
// Runs as the runner (not sandboxed): it needs the runner's git/ssh config to reach private remotes.
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });

/** Persistent home of `dir` workspaces: provider-independent and never touched by the reaper. */
export const workspaceRoot = () => path.resolve(env.WORKSPACE_ROOT);

/** Defense in depth behind the API's validation: nothing git could read as an option reaches argv. */
function assertGitArg(kind: string, v: string): string {
  if (!v || v.startsWith("-") || /\s/.test(v)) throw new Error(`invalid git ${kind}: ${JSON.stringify(v)}`);
  return v;
}

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
  if (ws.kind === "byoc") throw new Error(`workspace lives on BYOC worker ${ws.worker}; only a byoc environment can materialize it`);
  if (ws.kind === "blob") throw new Error("blob refs are memory-store snapshots; workspaces do not use them");
  // git spec or ref
  await git(targetHostDir, "clone", "--quiet", "--", assertGitArg("remote", ws.remote), ".");
  const base = "base" in ws ? ws.base : ws.ref;
  // `--detach` so `base` is always parsed as a commit-ish, never as a pathspec.
  if (base) await git(targetHostDir, "checkout", "--quiet", "--detach", assertGitArg("ref", base));
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

/**
 * git on a repo the sandbox could write: its .git/config and .gitattributes are attacker-controlled,
 * so every config knob that makes git run a command is neutralized (fsmonitor, hooks, external diff,
 * textconv, and each clean/smudge/process filter the config defines).
 */
async function untrustedGit(cwd: string, ...args: string[]) {
  const { stdout: filters } = await git(cwd, "config", "--includes", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$").catch(() => ({ stdout: "" }));
  const off = filters.split("\n").map((l) => l.split(" ")[0]!).filter(Boolean).flatMap((k) => ["-c", `${k}=`]);
  return run("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...off, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

/** Captures HEAD + working-tree diff (untracked files included) as a git WorkspaceRef. */
export async function captureGit(dir: string, prev: Extract<WorkspaceRef, { kind: "git" }>): Promise<WorkspaceRef> {
  const { stdout: head } = await untrustedGit(dir, "rev-parse", "HEAD");
  await untrustedGit(dir, "add", "-N", "--all");
  const { stdout: patch } = await untrustedGit(dir, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--binary");
  const ref: WorkspaceRef = { kind: "git", remote: prev.remote, base: head.trim() };
  if (patch.trim()) ref.patch = patch;
  return ref;
}

/**
 * Captures a non-git sandbox dir by copying it into the persistent workspace root (a fresh copy is
 * built beside the old one and swapped in, so a crash mid-copy never leaves a half-written ref).
 * The sandbox dir itself stays ephemeral: the reaper may delete it any time after release.
 */
export async function captureDir(sandboxDir: string, prev: WorkspaceRef, name: string): Promise<WorkspaceRef> {
  const dest = prev.kind === "dir" ? path.resolve(prev.path) : path.join(workspaceRoot(), name);
  const tmp = `${dest}.tmp-${process.pid}`;
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await run("cp", ["-R", `${sandboxDir}/.`, tmp]);
  const old = `${dest}.old-${process.pid}`;
  await rm(old, { recursive: true, force: true });
  await rename(dest, old).catch((e) => { if (e.code !== "ENOENT") throw e; });
  await rename(tmp, dest);
  await rm(old, { recursive: true, force: true });
  return { kind: "dir", path: dest };
}
