import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxId, SandboxLease, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import * as store from "./lease-store.ts";
import { materialize, captureGit, captureDir } from "./workspace.ts";
import { streamProcess, sandboxEnv } from "./exec.ts";

const docker = promisify(execFile);
const WORKDIR = "/workspace";
const DEFAULT_IMAGE = "node:22-alpine";
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:-]*(@sha256:[a-f0-9]{64})?$/;
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

/** `docker exec` with stdin, collecting stdout; used for file I/O so paths resolve *inside* the container. */
function execIn(container: string, argv: string[], stdin?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", "-w", WORKDIR, container, ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `docker exec exited ${code}`))));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Absolute in-container path under /workspace; lexical only — symlinks are resolved by the container's own kernel view. */
function insidePath(p: string): string {
  const abs = path.posix.resolve(WORKDIR, p);
  if (abs !== WORKDIR && !abs.startsWith(WORKDIR + "/")) throw new Error(`path escapes workdir: ${p}`);
  return abs;
}

function makeSandbox(id: SandboxId, container: string, shell: "bash" | "sh"): Sandbox {
  return {
    id,
    provider: "docker",
    workdir: WORKDIR,
    exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
      const args = ["exec", "-i", "-w", opts.cwd ? path.posix.resolve(WORKDIR, opts.cwd) : WORKDIR];
      // `-e K` (no value) copies K from the docker CLI's env: values never appear in argv / `ps`.
      for (const k of Object.keys(opts.env ?? {})) args.push("-e", k);
      args.push(container, shell, "-lc", cmd);
      return streamProcess("docker", args, { env: sandboxEnv(opts.env), timeoutMs: opts.timeoutMs, signal: opts.signal });
    },
    // File I/O goes through the container so a symlink planted by the model resolves in the
    // container's filesystem, never on the runner host side of the bind mount.
    async readFile(p) {
      return new Uint8Array(await execIn(container, ["cat", "--", insidePath(p)]));
    },
    async writeFile(p, data) {
      const abs = insidePath(p);
      await execIn(container, ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", abs], data);
    },
  };
}

export class DockerProvider implements SandboxProvider {
  name = "docker" as const;

  async acquire(req: SandboxRequest): Promise<SandboxLease> {
    let id: SandboxId;
    const reused = req.affinity ? await store.findReadyByAffinity("docker", req.affinity) : null;
    if (reused?.external_ref && (await isAlive(reused.id, reused.external_ref))) {
      id = reused.id;
    } else {
      // Stale row (container gone / dir gone, e.g. docker restart or another runner host): retire it.
      if (reused) {
        await docker("docker", ["rm", "-f", reused.id]).catch(() => {});
        await store.setStatus(reused.id, "destroyed");
      }
      if (req.affinity && (await store.findBusyByAffinity("docker", req.affinity))) {
        throw new Error(`workspace ${req.affinity} is in use by another running session; retry when it is idle`);
      }
      const image = req.image || DEFAULT_IMAGE;
      if (!IMAGE_RE.test(image)) throw new Error(`docker provider: invalid image reference ${JSON.stringify(image)}`);
      id = newId("sbx");
      const hostDir = path.join(root(), id);
      // Row first (status busy) so a crash between here and `docker run` leaves a record the reaper can retire.
      await store.insert({ id, provider: "docker", status: "busy", workspace_id: req.workspaceId, affinity: req.affinity ?? null, external_ref: hostDir });
      try {
        await materialize(req.workspaceRef, hostDir);
        const args = [
          "run", "-d", "--name", id, "-w", WORKDIR, "-v", `${toHostPath(hostDir)}:${WORKDIR}`,
          "--network", env.SANDBOX_DOCKER_NETWORK, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--pids-limit", env.SANDBOX_DOCKER_PIDS, "--memory", env.SANDBOX_DOCKER_MEMORY, "--cpus", env.SANDBOX_DOCKER_CPUS,
          "--label", "pi.sandbox=1", "--label", `pi.workspace=${req.workspaceId}`,
        ];
        // Secrets travel through the CLI's environment (`-e K`), never as `-e K=V` in argv.
        for (const k of Object.keys(req.secrets ?? {})) args.push("-e", k);
        args.push("--", image, "sleep", "infinity");
        await docker("docker", args, { env: sandboxEnv(req.secrets) });
      } catch (e) {
        await docker("docker", ["rm", "-f", id]).catch(() => {});
        await rm(hostDir, { recursive: true, force: true });
        await store.setStatus(id, "destroyed");
        throw e;
      }
    }
    const sandbox = makeSandbox(id, id, await pickShell(id));
    return { sandbox, release: async () => { await store.setStatus(id, "ready"); } };
  }

  async capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const hostDir = path.join(root(), sb.id);
    if (prev.kind === "git") return captureGit(hostDir, prev);
    if (prev.kind === "local") return prev;
    return captureDir(hostDir, prev, sb.id);
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
