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
const parseJob = (fields: string[]): RunJob | null => { const i = fields.indexOf("job"); return i >= 0 && fields[i + 1] ? (JSON.parse(fields[i + 1]!) as RunJob) : null; };

function redisQueue(): RunQueue {
  async function ensureGroup(r: Redis): Promise<void> {
    try { await r.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM"); } catch (e) { if (!String(e).includes("BUSYGROUP")) throw e; }
  }
  return {
    async enqueue(job) { await redis.xadd(STREAM, "*", "job", JSON.stringify(job)); },
    async depth() { try { const r = (await redis.xpending(STREAM, GROUP)) as [number, ...unknown[]] | null; return Array.isArray(r) ? Number(r[0] ?? 0) : 0; } catch { return 0; } },
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
            if (outcome === "done") await r.xack(STREAM, GROUP, id).catch(() => {});
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
          const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", Math.max(1, concurrency - inflight.size), "BLOCK", 5000, "STREAMS", STREAM, ">")) as [string, Entry[]][] | null;
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
      const start = (job: RunJob) => {
        const p = (async () => { try { const r = await handler(job); if (r === "retry") pending.push(job); } catch (e) { console.error("[queue] handler failed", e); } })();
        inflight.add(p); void p.finally(() => inflight.delete(p));
      };
      while (!opts.signal?.aborted) {
        while (pending.length && inflight.size < concurrency) start(pending.shift()!);
        if (inflight.size >= concurrency) { await Promise.race(inflight); continue; }
        await new Promise<void>((res) => { const done = () => { signal.off("job", done); opts.signal?.removeEventListener("abort", done); res(); }; signal.once("job", done); opts.signal?.addEventListener("abort", done, { once: true }); });
      }
      await Promise.allSettled(inflight);
    },
  };
}

/** Postgres run queue: FOR UPDATE SKIP LOCKED claiming + LISTEN/NOTIFY wakeups + a stale-reclaim sweep. No Redis. */
function pgQueue(): RunQueue {
  const STALE_MS = 120_000;
  return {
    async enqueue(job) { await pool.query("INSERT INTO run_jobs (session_id, trigger_seq) VALUES ($1,$2)", [job.session_id, job.trigger_seq]); await pool.query("SELECT pg_notify('pma_jobs','1')").catch(() => {}); },
    async depth() { const r = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM run_jobs WHERE status='pending'"); return r.rows[0]?.n ?? 0; },
    async consume(handler, opts) {
      const consumer = opts.consumer ?? `runner-${process.pid}`;
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const inflight = new Set<Promise<void>>();
      let wake: (() => void) | null = null;
      const lc = await pool.connect(); // dedicated LISTEN connection
      lc.on("notification", () => wake?.());
      lc.on("error", (e) => console.error("[pg-queue] listener error", e));
      await lc.query("LISTEN pma_jobs");
      const claim = async () => (await pool.query<{ id: string; session_id: string; trigger_seq: string }>(
        `UPDATE run_jobs SET status='running', claimed_by=$1, claimed_at=now()
         WHERE id = (SELECT id FROM run_jobs WHERE status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, session_id, trigger_seq`, [consumer])).rows[0];
      const runOne = (row: { id: string; session_id: string; trigger_seq: string }) => {
        const p = (async () => {
          let outcome: "done" | "retry" = "done";
          try { outcome = await handler({ session_id: row.session_id, trigger_seq: Number(row.trigger_seq) }); } catch (e) { console.error("[queue] handler failed", row.id, e); }
          if (outcome === "done") await pool.query("DELETE FROM run_jobs WHERE id=$1", [row.id]).catch(() => {});
          else await pool.query("UPDATE run_jobs SET status='pending', claimed_by=null, claimed_at=null WHERE id=$1", [row.id]).catch(() => {});
        })();
        inflight.add(p); void p.finally(() => inflight.delete(p));
      };
      const sweep = setInterval(() => { void pool.query(`UPDATE run_jobs SET status='pending', claimed_by=null WHERE status='running' AND claimed_at < now() - ($1::bigint * interval '1 millisecond')`, [STALE_MS]).catch(() => {}); }, 30_000);
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
      } finally { clearInterval(sweep); lc.release(); }
    },
  };
}

const queue: RunQueue = env.MESSAGING_BACKEND === "memory" ? memoryQueue() : env.MESSAGING_BACKEND === "postgres" ? pgQueue() : redisQueue();

export const enqueueRun = (job: RunJob) => queue.enqueue(job);
export const queueDepth = () => queue.depth();
export const consumeRuns = (handler: (job: RunJob) => Promise<"done" | "retry">, opts: { consumer?: string; signal?: AbortSignal; concurrency?: number } = {}) => queue.consume(handler, opts);
