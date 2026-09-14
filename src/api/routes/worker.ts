import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { pool, repos } from "../../infra/db.ts";
import { pollForWorker, pushResult, isWorkerAlive, markWorkerAlive, type WorkerResult } from "../../infra/byoc.ts";
import { enqueueRun } from "../../infra/queue.ts";
import { ApiError, invalid, notFound, readJson } from "../errors.ts";

/**
 * On a worker (re)connect, re-enqueue idle sessions of this environment that are paused awaiting one:
 * those whose newest environment signal is a disconnect (environmentActions over the log, evaluated in
 * one query from the newest disconnected/status_running event per session instead of reading each log).
 */
export async function resumeEnvironment(envId: string): Promise<number> {
  const { rows } = await pool.query<{ id: string; owner_id: string; last_seq: string | number }>(
    `SELECT s.id, s.owner_id, (SELECT MAX(seq) FROM events WHERE session_id = s.id) AS last_seq
     FROM sessions s
     WHERE s.environment_id=$1 AND s.status='idle'
       AND (SELECT MAX(seq) FROM events WHERE session_id = s.id AND type = 'session.environment_disconnected')
         > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = s.id AND type = 'session.status_running'), 0)`,
    [envId],
  );
  for (const s of rows) await enqueueRun({ session_id: s.id, trigger_seq: Number(s.last_seq ?? 0), owner_id: s.owner_id });
  return rows.length;
}

const hash = (s: string) => createHash("sha256").update(s).digest();
function checkKey(given: string | undefined, expected: string | null | undefined): void {
  if (!expected) throw new ApiError(403, "no_worker_key", "this environment is not a byoc environment");
  if (!given || !timingSafeEqual(hash(given), hash(expected))) throw new ApiError(401, "bad_worker_key", "invalid worker key");
}

/**
 * Self-hosted worker API (outbound-only from the worker's side):
 *   POST /v1/environments/:id/worker/poll   { worker_id, sandbox_ids[] }   -> next request or null (long-poll, <=25s)
 *   POST /v1/environments/:id/worker/result { req_id, type, ... }
 * Authenticated with the environment's worker key (x-worker-key header).
 */
export const worker = new Hono()
  .post("/poll", async (c) => {
    const envId = c.req.param("id")!;
    const e = await repos.environments.get(envId);
    if (!e) throw notFound("environment", envId);
    checkKey(c.req.header("x-worker-key"), e.worker_key);
    const body = await readJson<{ worker_id?: string; sandbox_ids?: string[] }>(c);
    if (!body.worker_id || !/^[A-Za-z0-9_.:-]{1,64}$/.test(body.worker_id)) throw invalid("worker_id is required");
    const ids = Array.isArray(body.sandbox_ids) ? body.sandbox_ids.filter((s) => typeof s === "string").slice(0, 64) : [];
    // On a fresh (re)connect, mark alive first (so the runner's re-check wins) then resume paused runs.
    if (!(await isWorkerAlive(envId, body.worker_id))) { await markWorkerAlive(envId, body.worker_id); void resumeEnvironment(envId).catch(() => {}); }
    const req = await pollForWorker(envId, body.worker_id, ids, 20);
    return c.json({ request: req });
  })
  .post("/result", async (c) => {
    const envId = c.req.param("id")!;
    const e = await repos.environments.get(envId);
    if (!e) throw notFound("environment", envId);
    checkKey(c.req.header("x-worker-key"), e.worker_key);
    const body = await readJson<WorkerResult>(c);
    if (!body.req_id || (body.type !== "chunk" && body.type !== "done")) throw invalid("result must have req_id and type chunk|done");
    await pushResult(body);
    return c.json({ ok: true });
  });
