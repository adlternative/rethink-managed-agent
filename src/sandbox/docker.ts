import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxHandle, SandboxId, SandboxProcess, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import { materialize, captureGit, captureDir } from "./workspace.ts";
import { streamProcess, sandboxEnv, spawnProcess } from "./exec.ts";

const docker = promisify(execFile);
const CONTAINER_ROOT = "/host"; // the container's host-dir bind mount; mounts live at /host/<mountId>
const DEFAULT_IMAGE = "node:22-alpine";
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:-]*(@sha256:[a-f0-9]{64})?$/;
const root = () => path.resolve(env.SANDBOX_LOCAL_ROOT);
/** Host dir tree bind-mounted into a container (one per container, shared by all its mounts). */
const containerHostDir = (containerRef: string) => path.join(root(), containerRef);
/** Host dir for one mount (materialize/capture operate here; it appears at /host/<mountId> in the container). */
const mountHostDir = (containerRef: string, mountId: SandboxId) => path.join(containerHostDir(containerRef), mountId);
const mountWorkdir = (mountId: SandboxId) => path.posix.join(CONTAINER_ROOT, mountId);

/** Translate a runner-local dir into the path the docker daemon should bind-mount (SANDBOX_HOST_ROOT inside a container). */
export function toHostPath(dir: string): string {
  if (!env.SANDBOX_HOST_ROOT) return dir;
  const rel = path.relative(root(), dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`docker provider: ${dir} is outside SANDBOX_LOCAL_ROOT (${root()})`);
  return path.posix.join(env.SANDBOX_HOST_ROOT, rel.split(path.sep).join("/"));
}

async function isRunning(container: string): Promise<boolean> {
  try { return (await docker("docker", ["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() === "true"; } catch { return false; }
}
async function pickShell(container: string): Promise<"bash" | "sh"> {
  try { await docker("docker", ["exec", container, "bash", "-c", "true"]); return "bash"; } catch { return "sh"; }
}

/** `docker exec -w <workdir>` with stdin, collecting stdout; file I/O resolves inside the container. */
function execIn(container: string, workdir: string, argv: string[], stdin?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", "-w", workdir, container, ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `docker exec exited ${code}`))));
    child.stdin.end(stdin ?? undefined);
  });
}

function insidePath(workdir: string, p: string): string {
  const abs = path.posix.resolve(workdir, p);
  if (abs !== workdir && !abs.startsWith(workdir + "/")) throw new Error(`path escapes workdir: ${p}`);
  return abs;
}

/** Env for the docker CLI itself: the sandbox allowlist plus how to reach the daemon (never forwarded into the container). */
const DOCKER_CLI_VARS = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_CONFIG"];
function dockerCliEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out = sandboxEnv(extra);
  for (const k of DOCKER_CLI_VARS) if (process.env[k] !== undefined && out[k] === undefined) out[k] = process.env[k];
  return out;
}

/**
 * Vault secrets are per mount, passed on every exec (`-e NAME`, value from the CLI env): a container
 * shared by several sessions must not hand one session's secrets to another, and a reused mount gets
 * the current run's secrets.
 */
function makeSandbox(mountId: SandboxId, container: string, shell: "bash" | "sh", workdir: string, secrets: Record<string, string> = {}): Sandbox {
  const envOf = (opts: ExecOptions) => ({ ...secrets, ...opts.env });
  const execArgs = (cmd: string, opts: ExecOptions) => {
    const args = ["exec", "-i", "-w", opts.cwd ? path.posix.resolve(workdir, opts.cwd) : workdir];
    for (const k of Object.keys(envOf(opts))) args.push("-e", k);
    args.push(container, shell, "-lc", cmd);
    return args;
  };
  return {
    id: mountId,
    provider: "docker",
    workdir,
    exec: (cmd, opts = {}) => streamProcess("docker", execArgs(cmd, opts), { env: dockerCliEnv(envOf(opts)), timeoutMs: opts.timeoutMs, signal: opts.signal }),
    async readFile(p) { return new Uint8Array(await execIn(container, workdir, ["cat", "--", insidePath(workdir, p)])); },
    async writeFile(p, data) { await execIn(container, workdir, ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", insidePath(workdir, p)], data); },
    async spawn(cmd, opts = {}): Promise<SandboxProcess> { return spawnProcess("docker", execArgs(cmd, opts), { env: dockerCliEnv(envOf(opts)) }); },
  };
}

/** A container is one docker container with `<root>/<containerId>` bind-mounted at /host; mounts are subdirs. */
export class DockerProvider implements SandboxProvider {
  name = "docker" as const;

  async openContainer(containerId: SandboxId, req: SandboxRequest): Promise<string> {
    const image = req.image || DEFAULT_IMAGE;
    if (!IMAGE_RE.test(image)) throw new Error(`docker provider: invalid image reference ${JSON.stringify(image)}`);
    const hostRoot = containerHostDir(containerId);
    await mkdir(hostRoot, { recursive: true });
    const args = [
      "run", "-d", "--name", containerId, "-w", CONTAINER_ROOT, "-v", `${toHostPath(hostRoot)}:${CONTAINER_ROOT}`,
      "--network", req.network === "bridge" ? "bridge" : env.SANDBOX_DOCKER_NETWORK, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", env.SANDBOX_DOCKER_PIDS, "--memory", env.SANDBOX_DOCKER_MEMORY, "--cpus", env.SANDBOX_DOCKER_CPUS,
      "--label", "pi.sandbox=1", "--label", `pi.container=${containerId}`,
    ];
    args.push("--", image, "sleep", "infinity");
    await docker("docker", args, { env: dockerCliEnv() });
    return containerId;
  }

  connectContainer(containerRef: string): Promise<boolean> { return isRunning(containerRef); }

  async destroyContainer(containerRef: string): Promise<void> {
    await docker("docker", ["rm", "-f", containerRef]).catch(() => {});
    const dir = containerHostDir(containerRef);
    if (dir.startsWith(root() + path.sep)) await rm(dir, { recursive: true, force: true });
  }

  async addMount(containerRef: string, mountId: SandboxId, ref: WorkspaceRef, secrets?: Record<string, string>): Promise<SandboxHandle> {
    await materialize(ref, mountHostDir(containerRef, mountId)); // host-side; appears at /host/<mountId> via the bind mount
    return { sandbox: makeSandbox(mountId, containerRef, await pickShell(containerRef), mountWorkdir(mountId), secrets), containerRef, workdir: mountWorkdir(mountId) };
  }

  async connectMount(containerRef: string, mountId: SandboxId, workdir: string, secrets?: Record<string, string>): Promise<Sandbox | null> {
    const dirOk = await stat(mountHostDir(containerRef, mountId)).then((st) => st.isDirectory(), () => false);
    if (!dirOk || !(await isRunning(containerRef))) return null;
    return makeSandbox(mountId, containerRef, await pickShell(containerRef), workdir, secrets);
  }

  async removeMount(containerRef: string, _mountId: SandboxId, workdir: string): Promise<void> {
    const hostDir = path.join(containerHostDir(containerRef), path.posix.basename(workdir));
    if (hostDir.startsWith(root() + path.sep)) await rm(hostDir, { recursive: true, force: true });
  }

  async captureMount(containerRef: string, _mountId: SandboxId, workdir: string, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const hostDir = path.join(containerHostDir(containerRef), path.posix.basename(workdir));
    if (prev.kind === "git") return captureGit(hostDir, prev);
    if (prev.kind === "local") return prev;
    return captureDir(hostDir, prev, path.posix.basename(workdir));
  }

  // `docker pause` freezes the container's processes (freezer cgroup) and keeps them in memory, so a
  // resume restores the exact running state — matching e2b's snapshot pause. `stop` would free RAM
  // but kill every process; that is the destroy tier's job.
  async pause(containerRef: string): Promise<void> { await docker("docker", ["pause", containerRef]); }
  async resume(containerRef: string): Promise<void> { await docker("docker", ["unpause", containerRef]).catch(() => {}); }
}
