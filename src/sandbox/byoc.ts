/**
 * BYOC provider: sandboxes live on a worker the user runs (`pma worker`). This side only relays
 * operations over the byoc transport and tracks which worker owns which sandbox.
 */
import { env } from "../shared/env.ts";
import type { ExecChunk, ExecOptions, Sandbox, SandboxHandle, SandboxId, SandboxProvider, SandboxRequest, WorkspaceRef } from "../shared/types.ts";
import { anyWorkerAlive, awaitResult, enqueue, isWorkerAlive, newReqId, workerFor } from "../infra/byoc.ts";

const WORKDIR = "/workspace"; // logical; the worker maps it to its own directory per sandbox

function makeSandbox(id: SandboxId, envId: string): Sandbox {
  const call = async (req: Parameters<typeof enqueue>[1], timeoutMs: number, onChunk?: (s: "stdout" | "stderr", d: string) => void, signal?: AbortSignal) => {
    await enqueue(envId, req);
    const r = await awaitResult(req.req_id, { timeoutMs, onChunk, signal });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  return {
    id,
    provider: "byoc",
    workdir: WORKDIR,
    async *exec(cmd: string, opts: ExecOptions = {}): AsyncIterable<ExecChunk> {
      const queue: ExecChunk[] = [];
      let notify: (() => void) | null = null;
      const push = (c: ExecChunk) => { queue.push(c); notify?.(); };
      const timeoutMs = (opts.timeoutMs ?? env.BASH_TIMEOUT_MS) + 30_000;
      const done = call({ req_id: newReqId(), op: "exec", sandbox_id: id, command: cmd, cwd: opts.cwd, timeout_ms: opts.timeoutMs }, timeoutMs, (stream, data) => push({ type: stream, data }), opts.signal)
        .then((r) => push({ type: "exit", code: (r as { code: number }).code }), (e) => { push({ type: "stderr", data: String(e.message ?? e) }); push({ type: "exit", code: 1 }); });
      for (;;) {
        if (queue.length === 0) await new Promise<void>((r) => (notify = r));
        notify = null;
        const c = queue.shift()!;
        yield c;
        if (c.type === "exit") { await done; return; }
      }
    },
    async readFile(p) {
      const r = (await call({ req_id: newReqId(), op: "read", sandbox_id: id, path: p }, 60_000)) as { content_b64: string };
      return new Uint8Array(Buffer.from(r.content_b64, "base64"));
    },
    async writeFile(p, data) {
      await call({ req_id: newReqId(), op: "write", sandbox_id: id, path: p, content_b64: Buffer.from(data).toString("base64") }, 60_000);
    },
  };
}

export class ByocProvider implements SandboxProvider {
  name = "byoc" as const;

  /**
   * A container is a worker (identified by its environment id). Mounts are the worker's per-sandbox
   * directories, so all mounts of one environment share the worker process. containerRef = envId.
   */
  async openContainer(_containerId: SandboxId, req: SandboxRequest & { environmentId?: string }): Promise<string> {
    const envId = req.environmentId;
    if (!envId) throw new Error("byoc provider: environment id missing");
    if (!(await anyWorkerAlive(envId))) throw new Error(`no BYOC worker is connected for environment ${envId}; start one with: pma worker --env ${envId} --key <worker_key>`);
    return envId;
  }

  async connectContainer(containerRef: string): Promise<boolean> { return anyWorkerAlive(containerRef); }

  async destroyContainer(_containerRef: string): Promise<void> { /* the worker owns its own lifecycle; mounts are removed individually */ }

  async addMount(containerRef: string, mountId: SandboxId, ref: WorkspaceRef): Promise<SandboxHandle> {
    if (ref.kind === "local" || ref.kind === "dir" || ref.kind === "blob") throw new Error(`byoc provider: ${ref.kind} workspaces cannot be shipped to a worker; use git or empty`);
    const reqId = newReqId();
    await enqueue(containerRef, { req_id: reqId, op: "create", sandbox_id: mountId, workspace_ref: ref });
    const r = await awaitResult(reqId, { timeoutMs: 120_000 });
    if (!r.ok) throw new Error(`byoc worker failed to create sandbox: ${r.error}`);
    return { sandbox: makeSandbox(mountId, containerRef), containerRef, workdir: WORKDIR };
  }

  async connectMount(containerRef: string, mountId: SandboxId, _workdir: string): Promise<Sandbox | null> {
    const worker = await workerFor(mountId);
    if (!worker || !(await isWorkerAlive(containerRef, worker))) return null;
    return makeSandbox(mountId, containerRef);
  }

  async removeMount(containerRef: string, mountId: SandboxId, _workdir: string): Promise<void> {
    await enqueue(containerRef, { req_id: newReqId(), op: "destroy", sandbox_id: mountId }).catch(() => {});
  }

  async captureMount(containerRef: string, mountId: SandboxId, _workdir: string, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const reqId = newReqId();
    await enqueue(containerRef, { req_id: reqId, op: "capture", sandbox_id: mountId, prev });
    const r = await awaitResult(reqId, { timeoutMs: 120_000 });
    if (!r.ok) throw new Error(r.error);
    return r.result as WorkspaceRef;
  }
}
