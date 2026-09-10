import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxHandle, SandboxId, SandboxProcess, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import { materialize, captureGit, captureDir } from "./workspace.ts";
import { streamProcess, sandboxEnv, resolveInside, resolveInsideReal, spawnProcess } from "./exec.ts";

const root = () => path.resolve(env.SANDBOX_LOCAL_ROOT);
const dirExists = (p: string) => stat(p).then((st) => st.isDirectory(), () => false);

/**
 * Dev-only provider: commands run on the runner host itself (no isolation). What it does offer:
 * an allow-listed env (runner secrets never reach the model) and workdir-confined file I/O.
 * externalRef = the workdir on this host.
 */
function makeSandbox(id: SandboxId, workdir: string): Sandbox {
  return {
    id,
    provider: "local",
    workdir,
    exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
      return streamProcess("bash", ["-lc", cmd], {
        cwd: opts.cwd ? resolveInside(workdir, workdir, opts.cwd) : workdir,
        env: sandboxEnv(opts.env),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
    },
    async readFile(p) {
      return new Uint8Array(await readFile(await resolveInsideReal(workdir, workdir, p)));
    },
    async writeFile(p, data) {
      const host = await resolveInsideReal(workdir, workdir, p);
      await mkdir(path.dirname(host), { recursive: true });
      await writeFile(host, data);
    },
    async spawn(cmd, opts = {}): Promise<SandboxProcess> {
      return spawnProcess("bash", ["-lc", cmd], { cwd: opts.cwd ? resolveInside(workdir, workdir, opts.cwd) : workdir, env: sandboxEnv(opts.env) });
    },
  };
}

export class LocalProvider implements SandboxProvider {
  name = "local" as const;

  async create(id: SandboxId, req: SandboxRequest): Promise<SandboxHandle> {
    const workdir = await materialize(req.workspaceRef, path.join(root(), id));
    return { sandbox: makeSandbox(id, workdir), externalRef: workdir };
  }

  async connect(id: SandboxId, externalRef: string): Promise<SandboxHandle | null> {
    return (await dirExists(externalRef)) ? { sandbox: makeSandbox(id, externalRef), externalRef } : null;
  }

  async destroy(id: SandboxId, externalRef: string | null): Promise<void> {
    // Only delete provider-managed dirs, never user-supplied `local` workspace paths.
    const dir = externalRef ?? path.join(root(), id);
    if (dir.startsWith(root() + path.sep)) await rm(dir, { recursive: true, force: true });
  }

  async capture(h: SandboxHandle, prev: WorkspaceRef): Promise<WorkspaceRef> {
    if (prev.kind === "git") return captureGit(h.sandbox.workdir, prev);
    if (prev.kind === "local") return prev;
    return captureDir(h.sandbox.workdir, prev, h.sandbox.id);
  }
}
