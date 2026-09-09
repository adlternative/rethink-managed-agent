import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxId, SandboxLease, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import * as store from "./lease-store.ts";
import { materialize, captureGit } from "./workspace.ts";
import { streamProcess, resolveInside } from "./exec.ts";

const docker = promisify(execFile);
const WORKDIR = "/workspace";
const DEFAULT_IMAGE = "node:22-alpine";
const root = () => path.resolve(env.SANDBOX_LOCAL_ROOT);

/**
 * Translate a runner-local sandbox dir into the path the docker daemon should bind-mount.
 * When the runner runs on the host they are the same; inside a container SANDBOX_HOST_ROOT
 * says where the sandboxes volume/bind lives on the host.
 */
export function toHostPath(dir: string): string {
  if (!env.SANDBOX_HOST_ROOT) return dir;
  const rel = path.relative(root(), dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`docker provider: ${dir} is outside SANDBOX_LOCAL_ROOT (${root()}); cannot map to SANDBOX_HOST_ROOT`);
  return path.posix.join(env.SANDBOX_HOST_ROOT, rel.split(path.sep).join("/"));
}

/** True when the sandbox container is still running and its workspace dir is still here. */
async function isAlive(container: string, hostDir: string): Promise<boolean> {
  const dirOk = await stat(hostDir).then((st) => st.isDirectory(), () => false);
  if (!dirOk) return false;
  try {
    const { stdout } = await docker("docker", ["inspect", "-f", "{{.State.Running}}", container]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function pickShell(container: string): Promise<"bash" | "sh"> {
  try {
    await docker("docker", ["exec", container, "bash", "-c", "true"]);
    return "bash";
  } catch {
    return "sh";
  }
}

function makeSandbox(id: SandboxId, container: string, hostDir: string, shell: "bash" | "sh"): Sandbox {
  return {
    id,
    provider: "docker",
    workdir: WORKDIR,
    exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
      const args = ["exec", "-i", "-w", opts.cwd ? path.posix.resolve(WORKDIR, opts.cwd) : WORKDIR];
      for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
      args.push(container, shell, "-lc", cmd);
      return streamProcess("docker", args, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    },
    async readFile(p) {
      return new Uint8Array(await readFile(resolveInside(hostDir, WORKDIR, p)));
    },
    async writeFile(p, data) {
      const host = resolveInside(hostDir, WORKDIR, p);
      await mkdir(path.dirname(host), { recursive: true });
      await writeFile(host, data);
    },
  };
}

export class DockerProvider implements SandboxProvider {
  name = "docker" as const;

  async acquire(req: SandboxRequest): Promise<SandboxLease> {
    let id: SandboxId;
    let hostDir: string;
    const reused = req.affinity ? await store.findReadyByAffinity("docker", req.affinity) : null;
    if (reused?.external_ref && (await isAlive(reused.id, reused.external_ref))) {
      id = reused.id;
      hostDir = reused.external_ref;
    } else {
      // Stale row (container gone / dir gone, e.g. docker restart or another runner host): retire it.
      if (reused) {
        await docker("docker", ["rm", "-f", reused.id]).catch(() => {});
        await store.setStatus(reused.id, "destroyed");
      }
      id = newId("sbx");
      hostDir = await materialize(req.workspaceRef, path.join(root(), id));
      const args = ["run", "-d", "--name", id, "-w", WORKDIR, "-v", `${toHostPath(hostDir)}:${WORKDIR}`];
      for (const [k, v] of Object.entries(req.secrets ?? {})) args.push("-e", `${k}=${v}`);
      args.push(req.image || DEFAULT_IMAGE, "sleep", "infinity");
      await docker("docker", args);
      await store.insert({ id, provider: "docker", status: "busy", workspace_id: req.workspaceId, affinity: req.affinity ?? null, external_ref: hostDir });
    }
    const sandbox = makeSandbox(id, id, hostDir, await pickShell(id));
    return { sandbox, release: async () => { await store.setStatus(id, "ready"); } };
  }

  async capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const hostDir = path.join(root(), sb.id);
    if (prev.kind === "git") return captureGit(hostDir, prev);
    if (prev.kind === "local") return prev;
    return { kind: "dir", path: hostDir };
  }

  async reap(idleTtlMs: number): Promise<SandboxId[]> {
    const rows = await store.listIdle("docker", idleTtlMs);
    const ids: SandboxId[] = [];
    for (const r of rows) {
      await docker("docker", ["rm", "-f", r.id]).catch(() => {});
      if (r.external_ref && r.external_ref.startsWith(root() + path.sep)) await rm(r.external_ref, { recursive: true, force: true });
      await store.setStatus(r.id, "destroyed");
      ids.push(r.id);
    }
    return ids;
  }
}
