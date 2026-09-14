import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxHandle, SandboxId, SandboxProcess, SandboxProvider, WorkspaceRef } from "../shared/types.ts";
import { materialize, captureGit, captureDir } from "./workspace.ts";
import { streamProcess, sandboxEnv, resolveInside, resolveInsideReal, spawnProcess } from "./exec.ts";

/**
 * Dev-only provider: commands run on the runner host itself (no isolation). A "container" is a root
 * directory; each mount is a subdirectory under it, so a parent and its children share the root
 * while working in separate dirs. What it offers: an allow-listed env and workdir-confined I/O.
 */
const root = () => path.resolve(env.SANDBOX_LOCAL_ROOT);
const dirExists = (p: string) => stat(p).then((st) => st.isDirectory(), () => false);
const containerDir = (containerRef: string) => path.join(root(), containerRef);

function makeSandbox(id: SandboxId, workdir: string, secrets: Record<string, string> = {}): Sandbox {
  // Vault secrets are baked into every command's env (per-call env still wins on a name clash).
  const withSecrets = (e?: Record<string, string>) => sandboxEnv({ ...secrets, ...e });
  return {
    id,
    provider: "local",
    workdir,
    exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
      return streamProcess("bash", ["-lc", cmd], { cwd: opts.cwd ? resolveInside(workdir, workdir, opts.cwd) : workdir, env: withSecrets(opts.env), timeoutMs: opts.timeoutMs, signal: opts.signal });
    },
    async readFile(p) { return new Uint8Array(await readFile(await resolveInsideReal(workdir, workdir, p))); },
    async writeFile(p, data) { const host = await resolveInsideReal(workdir, workdir, p); await mkdir(path.dirname(host), { recursive: true }); await writeFile(host, data); },
    async spawn(cmd, opts = {}): Promise<SandboxProcess> {
      return spawnProcess("bash", ["-lc", cmd], { cwd: opts.cwd ? resolveInside(workdir, workdir, opts.cwd) : workdir, env: withSecrets(opts.env) });
    },
  };
}

export class LocalProvider implements SandboxProvider {
  name = "local" as const;

  async openContainer(containerId: SandboxId): Promise<string> {
    await mkdir(containerDir(containerId), { recursive: true });
    return containerId;
  }
  async connectContainer(containerRef: string): Promise<boolean> { return dirExists(containerDir(containerRef)); }
  async destroyContainer(containerRef: string): Promise<void> { await rm(containerDir(containerRef), { recursive: true, force: true }); }

  async addMount(containerRef: string, mountId: SandboxId, ref: WorkspaceRef, secrets?: Record<string, string>): Promise<SandboxHandle> {
    const workdir = await materialize(ref, path.join(containerDir(containerRef), mountId));
    return { sandbox: makeSandbox(mountId, workdir, secrets), containerRef, workdir };
  }
  async connectMount(_containerRef: string, mountId: SandboxId, workdir: string, secrets?: Record<string, string>): Promise<Sandbox | null> {
    return (await dirExists(workdir)) ? makeSandbox(mountId, workdir, secrets) : null;
  }
  async removeMount(_containerRef: string, _mountId: SandboxId, workdir: string): Promise<void> {
    if (workdir.startsWith(root() + path.sep)) await rm(workdir, { recursive: true, force: true });
  }
  async captureMount(_containerRef: string, _mountId: SandboxId, workdir: string, prev: WorkspaceRef): Promise<WorkspaceRef> {
    if (prev.kind === "git") return captureGit(workdir, prev);
    if (prev.kind === "local") return prev;
    return captureDir(workdir, prev, path.basename(workdir));
  }
}
