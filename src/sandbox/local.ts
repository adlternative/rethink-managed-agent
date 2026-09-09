import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxId, SandboxLease, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import * as store from "./lease-store.ts";
import { materialize, captureGit, captureDir } from "./workspace.ts";
import { streamProcess, sandboxEnv, resolveInside, resolveInsideReal } from "./exec.ts";

const root = () => path.resolve(env.SANDBOX_LOCAL_ROOT);
const dirExists = (p: string) => stat(p).then((st) => st.isDirectory(), () => false);

/**
 * Dev-only provider: commands run on the runner host itself (no isolation). What it does offer:
 * an allow-listed env (runner secrets never reach the model) and workdir-confined file I/O.
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
  };
}

export class LocalProvider implements SandboxProvider {
  name = "local" as const;

  async acquire(req: SandboxRequest): Promise<SandboxLease> {
    let id: SandboxId;
    let workdir: string;
    const reused = req.affinity ? await store.findReadyByAffinity("local", req.affinity) : null;
    if (reused?.external_ref && (await dirExists(reused.external_ref))) {
      id = reused.id;
      workdir = reused.external_ref;
    } else {
      // A ready row whose directory is gone (different runner host, wiped volume) is stale: retire it.
      if (reused) await store.setStatus(reused.id, "destroyed");
      // DESIGN §5: the provider rejects a duplicate affinity rather than letting two runs share a dir.
      if (req.affinity && (await store.findBusyByAffinity("local", req.affinity))) {
        throw new Error(`workspace ${req.affinity} is in use by another running session; retry when it is idle`);
      }
      id = newId("sbx");
      const dir = path.join(root(), id);
      try {
        workdir = await materialize(req.workspaceRef, dir);
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
      await store.insert({ id, provider: "local", status: "busy", workspace_id: req.workspaceId, affinity: req.affinity ?? null, external_ref: workdir });
    }
    const sandbox = makeSandbox(id, workdir);
    return {
      sandbox,
      release: async () => { await store.setStatus(id, "ready"); },
    };
  }

  async capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef> {
    if (prev.kind === "git") return captureGit(sb.workdir, prev);
    if (prev.kind === "local") return prev;
    return captureDir(sb.workdir, prev, sb.id);
  }

  async reap(idleTtlMs: number): Promise<SandboxId[]> {
    const rows = await store.listIdle("local", idleTtlMs);
    const ids: SandboxId[] = [];
    for (const r of rows) {
      // only delete provider-managed dirs, never user-supplied local paths
      if (r.external_ref && r.external_ref.startsWith(root() + path.sep)) await rm(r.external_ref, { recursive: true, force: true });
      await store.setStatus(r.id, "destroyed");
      ids.push(r.id);
    }
    return ids;
  }
}
