import { spawn } from "node:child_process";
import path from "node:path";
import type { ExecChunk, ExecOptions } from "../shared/types.ts";

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
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };

  child.stdout.on("data", (d: Buffer) => push({ type: "stdout", data: d.toString() }));
  child.stderr.on("data", (d: Buffer) => push({ type: "stderr", data: d.toString() }));
  child.on("error", (e) => { push({ type: "stderr", data: String(e) }); push({ type: "exit", code: 127 }); });
  child.on("close", (code, sig) => push({ type: "exit", code: code ?? (sig ? 137 : 1) }));

  const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;
  opts.signal?.addEventListener("abort", kill, { once: true });
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
    opts.signal?.removeEventListener("abort", kill);
    if (child.exitCode === null && child.signalCode === null) kill();
  }
}

/** Builds `ExecOptions.env` string map merged over process env. */
export function mergeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return extra ? { ...process.env, ...extra } : process.env;
}

/** Resolves `p` (relative to `workdir`, or absolute inside `workdir`) to a host path under `hostRoot`; rejects escapes. */
export function resolveInside(hostRoot: string, workdir: string, p: string): string {
  const inSandbox = path.posix.resolve(workdir, p);
  const rel = path.posix.relative(workdir, inSandbox);
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) throw new Error(`path escapes workdir: ${p}`);
  return path.join(hostRoot, rel);
}

export type { ExecOptions };
