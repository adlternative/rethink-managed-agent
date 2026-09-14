import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Sandbox as E2bSandbox } from "e2b";
import { env } from "../shared/env.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxHandle, SandboxId, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import { captureDir } from "./workspace.ts";

/**
 * e2b cloud sandboxes. A *container* is one remote e2b sandbox; *mounts* are subdirs
 * (/home/user/mnt/<mountId>), so a parent and its children share one cloud sandbox — its processes,
 * installed packages and network — while working in separate directories. containerRef = e2b id.
 */
const run = promisify(execFile);
const MNT = "/home/user/mnt";
const TEMPLATE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const GIT_ARG_RE = /^[^\s-][^\s]*$/;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const mountWorkdir = (mountId: SandboxId) => `${MNT}/${mountId}`;
/** A unique /tmp path in the (possibly shared) remote sandbox: concurrent mount ops must not share temp files. */
const tmpName = (prefix: string, ext: string) => `/tmp/${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

function insidePath(workdir: string, p: string): string {
  const abs = path.posix.resolve(workdir, p);
  if (abs !== workdir && !abs.startsWith(workdir + "/")) throw new Error(`path escapes workdir: ${p}`);
  return abs;
}
function gitArg(kind: string, v: string): string {
  if (!GIT_ARG_RE.test(v)) throw new Error(`invalid git ${kind}: ${JSON.stringify(v)}`);
  return q(v);
}
function opts() {
  if (!env.E2B_API_KEY) throw new Error("e2b provider: E2B_API_KEY is not set");
  return { apiKey: env.E2B_API_KEY };
}
async function sh(sbx: E2bSandbox, cmd: string, timeoutMs = 600_000): Promise<string> {
  const r = await sbx.commands.run(cmd, { timeoutMs }).catch((e: { exitCode?: number; stderr?: string; stdout?: string; error?: string }) => e);
  if (r.exitCode !== 0) throw new Error(`e2b: command failed (${r.exitCode}): ${cmd}\n${r.stderr || ("error" in r && r.error) || ""}`.trim());
  return r.stdout ?? "";
}

async function materializeRemote(sbx: E2bSandbox, workdir: string, ref: WorkspaceRef): Promise<void> {
  await sh(sbx, `mkdir -p ${q(workdir)}`);
  if (ref.kind === "empty") return;
  if (ref.kind === "local") throw new Error("e2b provider: {kind:'local'} workspaces cannot be used with a cloud sandbox");
  if (ref.kind === "byoc" || ref.kind === "blob") throw new Error(`e2b provider: ${ref.kind} workspaces cannot be materialized here`);
  if (ref.kind === "git") {
    await sh(sbx, `git clone --quiet -- ${gitArg("remote", ref.remote)} ${q(workdir)}`);
    if (ref.base) await sh(sbx, `cd ${q(workdir)} && git checkout --quiet --detach ${gitArg("ref", ref.base)}`);
    if (ref.patch) { const pf = tmpName("pi-ws", "patch"); await sbx.files.write(pf, ref.patch); await sh(sbx, `cd ${q(workdir)} && git apply --whitespace=nowarn ${pf} && rm -f ${pf}`); }
    return;
  }
  // dir
  const tgz = path.join(await mkdtemp(path.join(tmpdir(), "e2b-up-")), "ws.tgz");
  try {
    await run("tar", ["czf", tgz, "-C", ref.path, "."]);
    const remote = tmpName("pi-ws", "tgz");
    await sbx.files.write(remote, new Blob([await readFile(tgz)]));
    await sh(sbx, `tar xzf ${remote} -C ${q(workdir)} && rm -f ${remote}`);
  } finally { await rm(path.dirname(tgz), { recursive: true, force: true }); }
}

/** Vault secrets ride on every command (not the shared sandbox's env), so sessions sharing it never see each other's. */
function makeSandbox(id: SandboxId, sbx: E2bSandbox, workdir: string, secrets: Record<string, string> = {}): Sandbox {
  return {
    id, provider: "e2b", workdir,
    async *exec(cmd: string, o: ExecOptions = {}): AsyncIterable<ExecChunk> {
      const queue: ExecChunk[] = []; let notify: (() => void) | null = null;
      const push = (c: ExecChunk) => { queue.push(c); notify?.(); };
      const handle = await sbx.commands.run(cmd, { background: true, cwd: o.cwd ? path.posix.resolve(workdir, o.cwd) : workdir, envs: { ...secrets, ...o.env }, timeoutMs: o.timeoutMs ?? 0, onStdout: (d) => push({ type: "stdout", data: d }), onStderr: (d) => push({ type: "stderr", data: d }) });
      const kill = () => { void handle.kill(); };
      o.signal?.addEventListener("abort", kill, { once: true });
      void handle.wait().then((r) => push({ type: "exit", code: r.exitCode }), (e: { exitCode?: number }) => push({ type: "exit", code: e.exitCode ?? 1 }));
      try {
        while (true) { if (queue.length === 0) await new Promise<void>((r) => (notify = r)); notify = null; const c = queue.shift()!; yield c; if (c.type === "exit") return; }
      } finally { o.signal?.removeEventListener("abort", kill); if (handle.exitCode === undefined) kill(); }
    },
    async readFile(p) { return sbx.files.read(insidePath(workdir, p), { format: "bytes" }); },
    async writeFile(p, data) { await sbx.files.write(insidePath(workdir, p), new Blob([data])); },
  };
}

/** Live SDK objects for containers this process opened/connected (needed by mount ops + capture). */
const live = new Map<string, E2bSandbox>();
async function sandboxFor(containerRef: string): Promise<E2bSandbox> {
  let sbx = live.get(containerRef);
  if (sbx && (await sbx.isRunning().catch(() => false))) return sbx;
  sbx = await E2bSandbox.connect(containerRef, opts());
  await sbx.setTimeout(env.E2B_SANDBOX_TIMEOUT_MS).catch(() => {});
  live.set(containerRef, sbx);
  return sbx;
}

export class E2bProvider implements SandboxProvider {
  name = "e2b" as const;

  async openContainer(containerId: SandboxId, req: SandboxRequest): Promise<string> {
    const template = req.image || env.E2B_TEMPLATE;
    if (!TEMPLATE_RE.test(template)) throw new Error(`e2b provider: invalid template name ${JSON.stringify(template)}`);
    const sbx = await E2bSandbox.create(template, { ...opts(), timeoutMs: env.E2B_SANDBOX_TIMEOUT_MS, metadata: { "pi.container": containerId } });
    live.set(sbx.sandboxId, sbx);
    return sbx.sandboxId;
  }
  async connectContainer(containerRef: string): Promise<boolean> {
    try { await sandboxFor(containerRef); return true; } catch { return false; }
  }
  async destroyContainer(containerRef: string): Promise<void> { live.delete(containerRef); await E2bSandbox.kill(containerRef, opts()).catch(() => {}); }

  async addMount(containerRef: string, mountId: SandboxId, ref: WorkspaceRef, secrets?: Record<string, string>): Promise<SandboxHandle> {
    const sbx = await sandboxFor(containerRef);
    const workdir = mountWorkdir(mountId);
    await materializeRemote(sbx, workdir, ref);
    return { sandbox: makeSandbox(mountId, sbx, workdir, secrets), containerRef, workdir };
  }
  async connectMount(containerRef: string, mountId: SandboxId, workdir: string, secrets?: Record<string, string>): Promise<Sandbox | null> {
    const sbx = await sandboxFor(containerRef).catch(() => null);
    if (!sbx) return null;
    return makeSandbox(mountId, sbx, workdir, secrets);
  }
  async removeMount(containerRef: string, _mountId: SandboxId, workdir: string): Promise<void> {
    const sbx = await sandboxFor(containerRef).catch(() => null);
    if (sbx) await sh(sbx, `rm -rf ${q(workdir)}`).catch(() => {});
  }
  async captureMount(containerRef: string, _mountId: SandboxId, workdir: string, prev: WorkspaceRef): Promise<WorkspaceRef> {
    if (prev.kind === "local") return prev;
    const sbx = await sandboxFor(containerRef);
    if (prev.kind === "git") {
      const base = (await sh(sbx, `cd ${q(workdir)} && git rev-parse HEAD`)).trim();
      const patch = await sh(sbx, `cd ${q(workdir)} && git add -N --all && git diff HEAD --binary`);
      return patch.trim() ? { kind: "git", remote: prev.remote, base, patch } : { kind: "git", remote: prev.remote, base };
    }
    const tmp = await mkdtemp(path.join(tmpdir(), "e2b-cap-"));
    try {
      const remote = tmpName("pi-cap", "tgz");
      await sh(sbx, `cd ${q(workdir)} && tar czf ${remote} .`);
      const bytes = await sbx.files.read(remote, { format: "bytes" });
      await sh(sbx, `rm -f ${remote}`);
      const tgz = path.join(tmp, "ws.tgz"); const dir = path.join(tmp, "ws");
      await writeFile(tgz, bytes); await mkdir(dir); await run("tar", ["xzf", tgz, "-C", dir]);
      return await captureDir(dir, prev, path.posix.basename(workdir));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  async pause(containerRef: string): Promise<void> { live.delete(containerRef); await E2bSandbox.pause(containerRef, opts()); }
  async resume(_containerRef: string): Promise<void> { /* connect() / sandboxFor() auto-resumes */ }
}
