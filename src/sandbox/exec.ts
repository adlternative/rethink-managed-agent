import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecChunk, ExecOptions, SandboxProcess } from "../shared/types.ts";

/** Spawns `file args` (process-group leader) and streams stdout/stderr; timeout/abort kills the whole group. */
export async function* streamProcess(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
): AsyncIterable<ExecChunk> {
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const queue: ExecChunk[] = [];
  let notify: (() => void) | null = null;
  const push = (c: ExecChunk) => { queue.push(c); notify?.(); };
  // Kill the whole group AND the leader: under load the group signal can reach the children before the
  // leader (bash) joined, which then survives, sees its job die and exits 0.
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group gone or not formed */ } try { child.kill("SIGKILL"); } catch { /* already exited */ } };
  let killed = false; // a timeout/abort kill: the command did not complete, so it never reports success
  const killFor = () => { killed = true; kill(); };

  child.stdout.on("data", (d: Buffer) => push({ type: "stdout", data: d.toString() }));
  child.stderr.on("data", (d: Buffer) => push({ type: "stderr", data: d.toString() }));
  child.on("error", (e) => { push({ type: "stderr", data: String(e) }); push({ type: "exit", code: 127 }); });
  child.on("close", (code, sig) => push({ type: "exit", code: killed && !code ? 137 : code ?? (sig ? 137 : 1) }));

  const timer = opts.timeoutMs ? setTimeout(killFor, opts.timeoutMs) : null;
  opts.signal?.addEventListener("abort", killFor, { once: true });
  try {
    while (true) {
      if (queue.length === 0) await new Promise<void>((r) => (notify = r));
      notify = null;
      const c = queue.shift()!;
      yield c;
      if (c.type === "exit") return;
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", killFor);
    if (child.exitCode === null && child.signalCode === null) kill();
  }
}

/** Runner env vars a sandboxed process may see. Everything else (DB/Redis URLs, API keys) stays out. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR"];

/** Builds a minimal, allow-listed env for sandboxed processes (never the runner's full process.env). */
export function sandboxEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) out[k] = process.env[k];
  return { ...out, ...extra };
}

/** Resolves `p` (relative to `workdir`, or absolute inside `workdir`) to a host path under `hostRoot`; rejects lexical escapes. */
export function resolveInside(hostRoot: string, workdir: string, p: string): string {
  const inSandbox = path.posix.resolve(workdir, p);
  const rel = path.posix.relative(workdir, inSandbox);
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) throw new Error(`path escapes workdir: ${p}`);
  return path.join(hostRoot, rel);
}

/**
 * `resolveInside` plus a symlink check: the real path of the deepest existing ancestor must still
 * be under the real `hostRoot`, so `ln -s / esc; read esc/etc/passwd` cannot leave the workspace.
 */
export async function resolveInsideReal(hostRoot: string, workdir: string, p: string): Promise<string> {
  const target = resolveInside(hostRoot, workdir, p);
  const root = await realpath(hostRoot);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      const rest = path.relative(probe, target);
      const realTarget = rest ? path.join(real, rest) : real;
      if (realTarget !== root && !realTarget.startsWith(root + path.sep)) throw new Error(`path escapes workdir via symlink: ${p}`);
      return realTarget;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // ENOENT from realpath: either nothing is there, or a dangling symlink — which a later
      // mkdir/write would follow — so reject the latter.
      if ((await lstat(probe).catch(() => null))?.isSymbolicLink()) throw new Error(`path escapes workdir via symlink: ${p}`);
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent; // component does not exist yet (write to a new file): check its nearest ancestor
    }
  }
}

export type { ExecOptions };

/** Long-lived child with stdin, for hosting a plugin host process inside a sandbox. */
export function spawnProcess(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): SandboxProcess {
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // EPIPE once the process is gone: its exit is reported through onExit
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return {
    write: (d) => { if (!child.stdin.writable) throw new Error("process stdin is closed"); child.stdin.write(d); },
    end: () => { child.stdin.end(); },
    onStdout: (cb) => { child.stdout.on("data", cb); },
    onStderr: (cb) => { child.stderr.on("data", cb); },
    onExit: (cb) => { child.on("exit", (code) => cb(code)); },
    kill: () => { child.stdin.end(); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); },
  };
}
