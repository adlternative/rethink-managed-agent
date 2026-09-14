import { Redis } from "ioredis";
import { EventEmitter } from "node:events";
import { env } from "../shared/env.ts";
import type { RunJob } from "../shared/types.ts";
import { redis } from "./pubsub.ts";
import { pool } from "./db.ts";

/**
 * The run queue behind a pluggable backend (MESSAGING_BACKEND):
 *   - "redis":  a Redis Streams consumer group — at-least-once, XAUTOCLAIM reclaims a dead runner's
 *               in-flight work. The only backend that works across the split api/runner processes.
 *   - "memory": an in-process queue for single-process dev/test (no Redis, no cross-process reclaim).
 * Callers use enqueueRun / consumeRuns / queueDepth and never see the backend.
 */
interface RunQueue {
  enqueue(job: RunJob): Promise<void>;
  depth(): Promise<number>;
  consume(handler: (job: RunJob) => Promise<"done" | "retry">, opts: { consumer?: string; signal?: AbortSignal; concurrency?: number }): Promise<void>;
}

const STREAM = "runs";
const GROUP = "runners";
/** Pending entries idle longer than this are re-examined by any runner (a live run keeps its heartbeat fresh). */
const STALE_MS = 120_000;
type Entry = [id: string, fields: string[]];
/** Backoff before a "retry" job becomes claimable again (a busy session must not be hot-spun or block newer jobs). */
const retryDelay = (attempt: number, baseMs: number, capMs: number) => Math.min(capMs, baseMs * 2 ** Math.min(attempt, 16));
const parseJob = (fields: string[]): RunJob | null => { const i = fields.indexOf("job"); return i >= 0 && fields[i + 1] ? (JSON.parse(fields[i + 1]!) as RunJob) : null; };

function redisQueue(): RunQueue {
  async function ensureGroup(r: Redis): Promise<void> {
    try { await r.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM"); } catch (e) { if (!String(e).includes("BUSYGROUP")) throw e; }
  }
  return {
    async enqueue(job) { await redis.xadd(STREAM, "*", "job", JSON.stringify(job)); },
    // The undelivered backlog: the group's lag (entries not yet read by any runner), like the other backends'
    // pending count. XPENDING would count in-flight work instead. Before the group exists, the stream length.
    async depth() {
      try {
        const groups = (await redis.xinfo("GROUPS", STREAM)) as unknown[][];
        const g = groups.find((f) => f[f.indexOf("name") + 1] === GROUP);
        const lag = g ? g[g.indexOf("lag") + 1] : undefined;
        if (typeof lag === "number" || (typeof lag === "string" && lag !== "")) return Number(lag);
        return g ? 0 : Number(await redis.xlen(STREAM));
      } catch { try { return Number(await redis.xlen(STREAM)); } catch { return 0; } }
    },
    async consume(handler, opts) {
      const consumer = opts.consumer ?? `runner-${process.pid}`;
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const inflight = new Set<Promise<void>>();
      const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }); // dedicated: XREADGROUP BLOCK would stall the shared one
      await ensureGroup(r);
      const handle = (entries: Entry[]) => {
        for (const [id, fields] of entries) {
          const p = (async () => {
            let outcome: "done" | "retry" = "done";
            try { const job = parseJob(fields); if (job) outcome = await handler(job); } catch (e) { console.error("[queue] handler failed", id, e); }
            // XACK alone keeps the entry in the stream forever; a finished job is deleted too (only ever acked,
            // already-delivered entries, so the group's lag and XAUTOCLAIM of in-flight work are unaffected).
            if (outcome === "done") { await r.xack(STREAM, GROUP, id).catch(() => {}); await r.xdel(STREAM, id).catch(() => {}); }
          })();
          inflight.add(p); void p.finally(() => inflight.delete(p));
        }
      };
      try {
        while (!opts.signal?.aborted) {
          const free = concurrency - inflight.size;
          if (free <= 0) { await Promise.race(inflight); continue; }
          const claimed = (await r.xautoclaim(STREAM, GROUP, consumer, STALE_MS, "0-0", "COUNT", free)) as [string, Entry[]];
          if (claimed[1]?.length) handle(claimed[1]);
          if (concurrency - inflight.size <= 0) continue; // reclaimed work filled every slot
          const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", concurrency - inflight.size, "BLOCK", 5000, "STREAMS", STREAM, ">")) as [string, Entry[]][] | null;
          if (res) for (const [, entries] of res) handle(entries);
        }
        await Promise.allSettled(inflight);
      } finally { r.disconnect(); }
    },
  };
}

function memoryQueue(): RunQueue {
  const pending: RunJob[] = [];
  const signal = new EventEmitter(); signal.setMaxListeners(0);
  return {
    async enqueue(job) { pending.push(job); signal.emit("job"); },
    async depth() { return pending.length; },
    async consume(handler, opts) {
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const inflight = new Set<Promise<void>>();
      const attempts = new WeakMap<RunJob, number>();
      const delayed = new Map<ReturnType<typeof setTimeout>, RunJob>();
      const requeue = (job: RunJob) => { pending.push(job); signal.emit("job"); }; // wake a consumer parked on the signal
      const start = (job: RunJob) => {
        const p = (async () => {
          try {
            if ((await handler(job)) !== "retry") return;
            const n = attempts.get(job) ?? 0; attempts.set(job, n + 1);
            const t = setTimeout(() => { delayed.delete(t); requeue(job); }, retryDelay(n, 10, 2000));
            delayed.set(t, job);
          } catch (e) { console.error("[queue] handler failed", e); }
        })();
        inflight.add(p); void p.finally(() => inflight.delete(p));
      };
      while (!opts.signal?.aborted) {
        while (pending.length && inflight.size < concurrency) start(pending.shift()!);
        if (inflight.size >= concurrency) { await Promise.race(inflight); continue; }
        if (opts.signal?.aborted) break; // aborted by a handler that just ran: no "abort" event is coming any more
        await new Promise<void>((res) => { const done = () => { signal.off("job", done); opts.signal?.removeEventListener("abort", done); res(); }; signal.once("job", done); opts.signal?.addEventListener("abort", done, { once: true }); });
      }
      await Promise.allSettled(inflight);
      for (const [t, job] of delayed) { clearTimeout(t); pending.push(job); } // hand retries back for the next consumer
    },
  };
}

/** Postgres run queue: FOR UPDATE SKIP LOCKED claiming + LISTEN/NOTIFY wakeups + a stale-reclaim sweep. No Redis. */
function pgQueue(): RunQueue {
  const STALE_MS = 120_000;
  const owners = env.RUNNER_OWNERS; // empty = handle any owner (shared operator brain)
  return {
    async enqueue(job) { await pool.query("INSERT INTO run_jobs (session_id, trigger_seq, owner_id) VALUES ($1,$2,$3)", [job.session_id, job.trigger_seq, job.owner_id ?? null]); await pool.query("SELECT pg_notify('pma_jobs','1')").catch(() => {}); },
    async depth() { const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM run_jobs WHERE status='pending'${owners.length ? " AND owner_id = ANY($1::text[])" : ""}`, owners.length ? [owners] : []); return r.rows[0]?.n ?? 0; },
    async consume(handler, opts) {
      const consumer = opts.consumer ?? `runner-${process.pid}`;
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const inflight = new Set<Promise<void>>();
      let wake: (() => void) | null = null;
      const lc = await pool.connect(); // dedicated LISTEN connection
      lc.on("notification", () => wake?.());
      lc.on("error", (e) => console.error("[pg-queue] listener error", e));
      await lc.query("LISTEN pma_jobs");
      // A tenant-scoped runner (RUNNER_OWNERS) claims only its owners' jobs; the shared runner claims any.
      type Row = { id: string; session_id: string; trigger_seq: string; owner_id: string | null };
      const claim = async () => (await pool.query<Row>(
        `UPDATE run_jobs SET status='running', claimed_by=$1, claimed_at=now()
         WHERE id = (SELECT id FROM run_jobs WHERE status='pending'${owners.length ? " AND owner_id = ANY($2::text[])" : ""} ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, session_id, trigger_seq, owner_id`, owners.length ? [consumer, owners] : [consumer])).rows[0];
      const release = (id: string) => pool.query("UPDATE run_jobs SET status='pending', claimed_by=null, claimed_at=null WHERE id=$1", [id]).catch(() => {});
      // A retried row stays claimed (so no consumer re-claims it) while it backs off, outside the inflight
      // slots (so newer jobs are not head-of-line blocked); shutdown hands it back immediately.
      const attempts = new Map<string, number>();
      const backingOff = new Map<string, ReturnType<typeof setTimeout>>();
      const runOne = (row: Row) => {
        const p = (async () => {
          let outcome: "done" | "retry" = "done";
          try { outcome = await handler({ session_id: row.session_id, trigger_seq: Number(row.trigger_seq), ...(row.owner_id ? { owner_id: row.owner_id } : {}) }); } catch (e) { console.error("[queue] handler failed", row.id, e); }
          if (outcome === "done") { attempts.delete(row.id); await pool.query("DELETE FROM run_jobs WHERE id=$1", [row.id]).catch(() => {}); return; }
          const n = attempts.get(row.id) ?? 0; attempts.set(row.id, n + 1);
          backingOff.set(row.id, setTimeout(() => { backingOff.delete(row.id); void release(row.id).then(() => wake?.()); }, retryDelay(n, 500, 30_000)));
        })();
        inflight.add(p); void p.finally(() => inflight.delete(p));
      };
      // Reset abandoned claims (a dead runner's), but never one whose session is still heartbeating: a long run
      // keeps its job claimed, and re-delivering it would only spin a second runner on "busy".
      const sweep = setInterval(() => {
        void pool.query(`UPDATE run_jobs SET status='pending', claimed_by=null, claimed_at=null WHERE status='running' AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = run_jobs.session_id AND s.status = 'running' AND s.updated_at > now() - ($1::bigint * interval '1 millisecond'))`, [STALE_MS]).catch(() => {});
      }, 30_000);
      try {
        while (!opts.signal?.aborted) {
          let claimed = false;
          while (inflight.size < concurrency) { const row = await claim(); if (!row) break; runOne(row); claimed = true; }
          if (inflight.size >= concurrency) { await Promise.race(inflight); continue; }
          if (claimed) continue; // just claimed some; loop to claim more before sleeping
          await new Promise<void>((res) => { // sleep until a NOTIFY or a 2s poll or abort
            let done = false; const finish = () => { if (done) return; done = true; wake = null; clearTimeout(t); opts.signal?.removeEventListener("abort", finish); res(); };
            wake = finish; const t = setTimeout(finish, 2000); opts.signal?.addEventListener("abort", finish, { once: true });
          });
        }
        await Promise.allSettled(inflight);
      } finally {
        clearInterval(sweep);
        await Promise.all([...backingOff].map(([id, t]) => { clearTimeout(t); return release(id); }));
        lc.release();
      }
    },
  };
}

const queue: RunQueue = env.MESSAGING_BACKEND === "memory" ? memoryQueue() : env.MESSAGING_BACKEND === "postgres" ? pgQueue() : redisQueue();

export const enqueueRun = (job: RunJob) => queue.enqueue(job);
export const queueDepth = () => queue.depth();
export const consumeRuns = (handler: (job: RunJob) => Promise<"done" | "retry">, opts: { consumer?: string; signal?: AbortSignal; concurrency?: number } = {}) => queue.consume(handler, opts);
