import { Redis } from "ioredis";
import { EventEmitter } from "node:events";
import { env } from "../shared/env.ts";
import type { RunJob } from "../shared/types.ts";
import { redis } from "./pubsub.ts";

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

const queue: RunQueue = env.MESSAGING_BACKEND === "memory" ? memoryQueue() : redisQueue();

export const enqueueRun = (job: RunJob) => queue.enqueue(job);
export const queueDepth = () => queue.depth();
export const consumeRuns = (handler: (job: RunJob) => Promise<"done" | "retry">, opts: { consumer?: string; signal?: AbortSignal; concurrency?: number } = {}) => queue.consume(handler, opts);
