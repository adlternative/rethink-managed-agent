/**
 * BYOC transport: the runner talks to a self-hosted worker through Redis lists relayed by the API.
 *   runner  --LPUSH byoc:env:<env>:create / byoc:sbx:<sbx>:req-->  API long-poll  -->  worker (outbound only)
 *   worker  --POST result-->  API  --LPUSH byoc:res:<reqId>-->  runner (BRPOP)
 * Workers heartbeat on every poll; a sandbox whose worker went quiet is treated as gone.
 */
import { Redis } from "ioredis";
import { newId } from "../shared/ids.ts";
import { env } from "../shared/env.ts";
import { redis } from "./pubsub.ts";

export const WORKER_TTL_S = 60;
export type WorkerRequest =
  | { req_id: string; op: "create"; sandbox_id: string; workspace_ref: unknown }
  | { req_id: string; op: "exec"; sandbox_id: string; command: string; cwd?: string; timeout_ms?: number }
  | { req_id: string; op: "read"; sandbox_id: string; path: string }
  | { req_id: string; op: "write"; sandbox_id: string; path: string; content_b64: string }
  | { req_id: string; op: "capture"; sandbox_id: string; prev: unknown }
  | { req_id: string; op: "destroy"; sandbox_id: string };
export type WorkerResult =
  | { req_id: string; type: "chunk"; stream: "stdout" | "stderr"; data: string }
  | { req_id: string; type: "done"; ok: true; result?: unknown }
  | { req_id: string; type: "done"; ok: false; error: string };

const envQueue = (envId: string) => `byoc:env:${envId}:create`;
const sbxQueue = (sbxId: string) => `byoc:sbx:${sbxId}:req`;
const resQueue = (reqId: string) => `byoc:res:${reqId}`;
const sbxWorker = (sbxId: string) => `byoc:sbx:${sbxId}:worker`;
const workerAlive = (envId: string, workerId: string) => `byoc:env:${envId}:worker:${workerId}`;
/** Per-env sorted set of live worker ids scored by heartbeat expiry (ms), so liveness is one ZCOUNT instead of a keyspace walk. */
const envWorkers = (envId: string) => `byoc:env:${envId}:workers`;

// ---- runner side ----
export async function enqueue(envId: string, req: WorkerRequest): Promise<void> {
  const key = req.op === "create" ? envQueue(envId) : sbxQueue(req.sandbox_id);
  await redis.lpush(key, JSON.stringify(req));
  await redis.expire(key, 3600);
}

/** Await results for a request; `onChunk` receives streamed output. Resolves with the final `done`. */
export async function awaitResult(reqId: string, opts: { timeoutMs: number; signal?: AbortSignal; onChunk?: (stream: "stdout" | "stderr", data: string) => void }): Promise<Extract<WorkerResult, { type: "done" }>> {
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const deadline = Date.now() + opts.timeoutMs;
  // An abort interrupts the blocking BRPOP (disconnecting ends it) instead of waiting out its slice.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("aborted")); opts.signal?.addEventListener("abort", onAbort, { once: true }); });
  aborted.catch(() => {});
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      if (deadline <= Date.now()) throw new Error(`byoc: worker did not answer within ${opts.timeoutMs}ms`);
      const pop = r.brpop(resQueue(reqId), Math.min(left, 5));
      pop.catch(() => {}); // a disconnect after abort rejects it; nothing is waiting any more
      const hit = await Promise.race([pop, aborted]);
      if (!hit) continue;
      const msg = JSON.parse(hit[1]) as WorkerResult;
      if (msg.type === "chunk") { opts.onChunk?.(msg.stream, msg.data); continue; }
      await redis.del(resQueue(reqId)).catch(() => {});
      return msg;
    }
  } finally {
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    r.disconnect();
  }
}

export const newReqId = () => newId("req");
export async function workerFor(sbxId: string): Promise<string | null> { return redis.get(sbxWorker(sbxId)); }
export async function isWorkerAlive(envId: string, workerId: string): Promise<boolean> { return (await redis.exists(workerAlive(envId, workerId))) === 1; }
export async function anyWorkerAlive(envId: string): Promise<boolean> {
  if ((await redis.zcount(envWorkers(envId), Date.now(), "+inf")) > 0) return true;
  // Not in the set: fall back to the per-worker keys (a worker last marked by a build without the set, during a
  // rolling deploy). SCAN is incremental and never blocks Redis the way KEYS does; it only runs on the rare "no worker" path.
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `byoc:env:${envId}:worker:*`, "COUNT", 5000);
    if (keys.length > 0) return true;
    cursor = next;
  } while (cursor !== "0");
  return false;
}

// ---- API side (worker long-poll) ----
/** Mark a worker live (heartbeat). Called at the top of every poll; also used to win the reconnect race before resuming paused sessions. */
export async function markWorkerAlive(envId: string, workerId: string): Promise<void> {
  const expiresAt = Date.now() + WORKER_TTL_S * 1000;
  await redis.multi()
    .set(workerAlive(envId, workerId), "1", "EX", WORKER_TTL_S)
    .zadd(envWorkers(envId), expiresAt, workerId)
    .zremrangebyscore(envWorkers(envId), "-inf", `(${Date.now()}`) // drop workers whose heartbeat lapsed
    .expire(envWorkers(envId), WORKER_TTL_S)
    .exec();
}
export async function pollForWorker(envId: string, workerId: string, sandboxIds: string[], waitS: number): Promise<WorkerRequest | null> {
  await markWorkerAlive(envId, workerId);
  for (const s of sandboxIds) await redis.expire(sbxWorker(s), WORKER_TTL_S * 2);
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  try {
    const keys = [envQueue(envId), ...sandboxIds.map(sbxQueue)];
    const hit = await r.brpop(...keys, waitS);
    if (!hit) return null;
    const req = JSON.parse(hit[1]) as WorkerRequest;
    if (req.op === "create") await redis.set(sbxWorker(req.sandbox_id), workerId, "EX", WORKER_TTL_S * 2);
    return req;
  } finally {
    r.disconnect();
  }
}
export async function pushResult(res: WorkerResult): Promise<void> {
  await redis.lpush(resQueue(res.req_id), JSON.stringify(res));
  await redis.expire(resQueue(res.req_id), 600);
}
