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
 * e2b cloud sandboxes (https://e2b.dev). Unlike local/docker there is no host directory: the
 * workspace is materialized *inside* the remote sandbox and captured back over the SDK.
 * externalRef = the e2b sandbox id.
 */
const run = promisify(execFile);
const WORKDIR = "/home/user/workspace";
const TEMPLATE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const GIT_ARG_RE = /^[^\s-][^\s]*$/;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function insidePath(p: string): string {
  const abs = path.posix.resolve(WORKDIR, p);
  if (abs !== WORKDIR && !abs.startsWith(WORKDIR + "/")) throw new Error(`path escapes workdir: ${p}`);
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

/** Runs `cmd` to completion inside the sandbox; throws with stderr on non-zero exit. */
async function sh(sbx: E2bSandbox, cmd: string, timeoutMs = 600_000): Promise<string> {
  const r = await sbx.commands.run(cmd, { timeoutMs }).catch((e: { exitCode?: number; stderr?: string; stdout?: string; error?: string }) => e);
  if (r.exitCode !== 0) throw new Error(`e2b: command failed (${r.exitCode}): ${cmd}\n${r.stderr || ("error" in r && r.error) || ""}`.trim());
  return r.stdout ?? "";
}

async function materializeRemote(sbx: E2bSandbox, ref: WorkspaceRef): Promise<void> {
  await sh(sbx, `mkdir -p ${q(WORKDIR)}`);
  switch (ref.kind) {
    case "empty":
      return;
    case "local":
      throw new Error("e2b provider: {kind:'local'} workspaces are host paths and cannot be used with a cloud sandbox");
    case "git": {
      await sh(sbx, `git clone --quiet -- ${gitArg("remote", ref.remote)} ${q(WORKDIR)}`);
      if (ref.base) await sh(sbx, `cd ${q(WORKDIR)} && git checkout --quiet --detach ${gitArg("ref", ref.base)}`);
      if (ref.patch) {
        await sbx.files.write("/tmp/pi-workspace.patch", ref.patch);
        await sh(sbx, `cd ${q(WORKDIR)} && git apply --whitespace=nowarn /tmp/pi-workspace.patch && rm -f /tmp/pi-workspace.patch`);
      }
      return;
    }
    case "dir": {
      const tgz = path.join(await mkdtemp(path.join(tmpdir(), "e2b-up-")), "ws.tgz");
      try {
        await run("tar", ["czf", tgz, "-C", ref.path, "."]);
        await sbx.files.write("/tmp/pi-workspace.tgz", new Blob([await readFile(tgz)]));
        await sh(sbx, `tar xzf /tmp/pi-workspace.tgz -C ${q(WORKDIR)} && rm -f /tmp/pi-workspace.tgz`);
      } finally {
        await rm(path.dirname(tgz), { recursive: true, force: true });
      }
      return;
    }
  }
}

function makeSandbox(id: SandboxId, sbx: E2bSandbox): Sandbox {
  return {
    id,
    provider: "e2b",
    workdir: WORKDIR,
    async *exec(cmd: string, o: ExecOptions = {}): AsyncIterable<ExecChunk> {
      const queue: ExecChunk[] = [];
      let notify: (() => void) | null = null;
      const push = (c: ExecChunk) => { queue.push(c); notify?.(); };
      const handle = await sbx.commands.run(cmd, {
        background: true,
        cwd: o.cwd ? path.posix.resolve(WORKDIR, o.cwd) : WORKDIR,
        envs: o.env,
        timeoutMs: o.timeoutMs ?? 0,
        onStdout: (d) => push({ type: "stdout", data: d }),
        onStderr: (d) => push({ type: "stderr", data: d }),
      });
      const kill = () => { void handle.kill(); };
      o.signal?.addEventListener("abort", kill, { once: true });
      // wait() rejects with CommandExitError on non-zero exit; both paths carry the exit code.
      void handle.wait().then(
        (r) => push({ type: "exit", code: r.exitCode }),
        (e: { exitCode?: number; message?: string }) => push({ type: "exit", code: e.exitCode ?? 1 }),
      );
      try {
        while (true) {
          if (queue.length === 0) await new Promise<void>((r) => (notify = r));
          notify = null;
          const c = queue.shift()!;
          yield c;
          if (c.type === "exit") return;
        }
      } finally {
        o.signal?.removeEventListener("abort", kill);
        if (handle.exitCode === undefined) kill();
      }
    },
    async readFile(p) {
      return sbx.files.read(insidePath(p), { format: "bytes" });
    },
    async writeFile(p, data) {
      await sbx.files.write(insidePath(p), new Blob([data]));
    },
  };
}

/** A handle that also carries the live SDK object (needed by capture). */
interface E2bHandle extends SandboxHandle { sbx: E2bSandbox }

export class E2bProvider implements SandboxProvider {
  name = "e2b" as const;

  async create(id: SandboxId, req: SandboxRequest): Promise<E2bHandle> {
    const template = req.image || env.E2B_TEMPLATE;
    if (!TEMPLATE_RE.test(template)) throw new Error(`e2b provider: invalid template name ${JSON.stringify(template)}`);
    const sbx = await E2bSandbox.create(template, {
      ...opts(),
      timeoutMs: env.E2B_SANDBOX_TIMEOUT_MS,
      metadata: { "pi.sandbox": id, "pi.workspace": req.workspaceId },
      envs: req.secrets,
    });
    try {
      await materializeRemote(sbx, req.workspaceRef);
    } catch (e) {
      await sbx.kill().catch(() => {});
      throw e;
    }
    return { sandbox: makeSandbox(id, sbx), externalRef: sbx.sandboxId, sbx };
  }

  async connect(id: SandboxId, externalRef: string): Promise<E2bHandle | null> {
    const sbx = await E2bSandbox.connect(externalRef, opts()).catch(() => null);
    if (!sbx || !(await sbx.isRunning().catch(() => false))) return null;
    await sbx.setTimeout(env.E2B_SANDBOX_TIMEOUT_MS).catch(() => {});
    return { sandbox: makeSandbox(id, sbx), externalRef, sbx };
  }

  /** e2b keeps a snapshot (memory + fs); Sandbox.connect() resumes it transparently. */
  async pause(_id: SandboxId, externalRef: string): Promise<void> {
    await E2bSandbox.pause(externalRef, opts());
  }
  async resume(): Promise<void> {
    /* connect() auto-resumes a paused e2b sandbox */
  }

  async destroy(_id: SandboxId, externalRef: string | null): Promise<void> {
    if (externalRef) await E2bSandbox.kill(externalRef, opts()).catch(() => {});
  }

  async capture(h: SandboxHandle, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const sbx = (h as E2bHandle).sbx;
    if (prev.kind === "local") return prev;
    if (prev.kind === "git") {
      const base = (await sh(sbx, `cd ${q(WORKDIR)} && git rev-parse HEAD`)).trim();
      const patch = await sh(sbx, `cd ${q(WORKDIR)} && git add -N --all && git diff HEAD --binary`);
      return patch.trim() ? { kind: "git", remote: prev.remote, base, patch } : { kind: "git", remote: prev.remote, base };
    }
    // dir / empty: tar the remote workdir, download it, and hand the extracted copy to captureDir.
    const tmp = await mkdtemp(path.join(tmpdir(), "e2b-cap-"));
    try {
      await sh(sbx, `cd ${q(WORKDIR)} && tar czf /tmp/pi-capture.tgz .`);
      const bytes = await sbx.files.read("/tmp/pi-capture.tgz", { format: "bytes" });
      await sh(sbx, "rm -f /tmp/pi-capture.tgz");
      const tgz = path.join(tmp, "ws.tgz");
      const dir = path.join(tmp, "ws");
      await writeFile(tgz, bytes);
      await mkdir(dir);
      await run("tar", ["xzf", tgz, "-C", dir]);
      return await captureDir(dir, prev, h.sandbox.id);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
