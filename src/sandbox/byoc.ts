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
  /** environment id per sandbox (needed to route requests); populated on create/connect */
  private envOf = new Map<SandboxId, string>();

  async create(id: SandboxId, req: SandboxRequest & { environmentId?: string }): Promise<SandboxHandle> {
    const envId = req.environmentId;
    if (!envId) throw new Error("byoc provider: environment id missing");
    if (req.workspaceRef.kind === "local" || req.workspaceRef.kind === "dir") throw new Error(`byoc provider: ${req.workspaceRef.kind} workspaces cannot be shipped to a worker; use git or empty`);
    // Fail fast instead of queueing into the void: a worker must be polling this environment.
    if (!(await anyWorkerAlive(envId))) throw new Error(`no BYOC worker is connected for environment ${envId}; start one with: pma worker --env ${envId} --key <worker_key>`);
    const reqId = newReqId();
    await enqueue(envId, { req_id: reqId, op: "create", sandbox_id: id, workspace_ref: req.workspaceRef });
    const r = await awaitResult(reqId, { timeoutMs: 120_000 });
    if (!r.ok) throw new Error(`byoc worker failed to create sandbox: ${r.error}`);
    const worker = (await workerFor(id)) ?? "unknown";
    this.envOf.set(id, envId);
    return { sandbox: makeSandbox(id, envId), externalRef: `${envId}/${worker}` };
  }

  async connect(id: SandboxId, externalRef: string): Promise<SandboxHandle | null> {
    const [envId, worker] = externalRef.split("/");
    if (!envId || !worker || !(await isWorkerAlive(envId, worker)) || (await workerFor(id)) !== worker) return null;
    this.envOf.set(id, envId);
    return { sandbox: makeSandbox(id, envId), externalRef };
  }

  async destroy(id: SandboxId, externalRef: string | null): Promise<void> {
    const envId = externalRef?.split("/")[0] ?? this.envOf.get(id);
    if (!envId) return;
    await enqueue(envId, { req_id: newReqId(), op: "destroy", sandbox_id: id }).catch(() => {});
    this.envOf.delete(id);
  }

  async capture(h: SandboxHandle, prev: WorkspaceRef): Promise<WorkspaceRef> {
    const envId = h.externalRef.split("/")[0]!;
    const reqId = newReqId();
    await enqueue(envId, { req_id: reqId, op: "capture", sandbox_id: h.sandbox.id, prev });
    const r = await awaitResult(reqId, { timeoutMs: 120_000 });
    if (!r.ok) throw new Error(r.error);
    return r.result as WorkspaceRef;
  }
}
