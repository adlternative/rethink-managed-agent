import { Redis } from "ioredis";
import { env } from "../shared/env.ts";
import type { RunJob } from "../shared/types.ts";
import { redis } from "./pubsub.ts";

const STREAM = "runs";
const GROUP = "runners";
/**
 * Pending entries idle longer than this are re-examined by any runner. A live run keeps the
 * session `running` with a fresh heartbeat, so a re-examined job of a healthy run is simply
 * left pending ("retry") until its owner acks it; only a dead runner's job is actually taken over.
 */
const STALE_MS = 120_000;

export async function enqueueRun(job: RunJob): Promise<void> {
  await redis.xadd(STREAM, "*", "job", JSON.stringify(job));
}

/** Backlog for the queue-depth metric: entries delivered to the group but not yet acked (real pending work). */
export async function queueDepth(): Promise<number> {
  try {
    const r = (await redis.xpending(STREAM, GROUP)) as [number, ...unknown[]] | null;
    return Array.isArray(r) ? Number(r[0] ?? 0) : 0;
  } catch { return 0; } // group not created yet
}

async function ensureGroup(r: Redis): Promise<void> {
  try {
    await r.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
  } catch (e) {
    if (!String(e).includes("BUSYGROUP")) throw e;
  }
}

type Entry = [id: string, fields: string[]];

function parseJob(fields: string[]): RunJob | null {
  const i = fields.indexOf("job");
  return i >= 0 ? (JSON.parse(fields[i + 1]) as RunJob) : null;
}

/** Handler returns "done" to ack the entry, or "retry" to leave it pending for a later re-examination. */
export async function consumeRuns(
  handler: (job: RunJob) => Promise<"done" | "retry">,
  opts: { consumer?: string; signal?: AbortSignal; concurrency?: number } = {},
): Promise<void> {
  const consumer = opts.consumer ?? `runner-${process.pid}`;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const inflight = new Set<Promise<void>>();
  // Dedicated connection: XREADGROUP BLOCK would stall the shared one.
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await ensureGroup(r);

  // Entries run concurrently up to `concurrency`; each is ACKed when its handler settles.
  const handle = (entries: Entry[]) => {
    for (const [id, fields] of entries) {
      const p = (async () => {
        let outcome: "done" | "retry" = "done";
        try {
          const job = parseJob(fields);
          if (job) outcome = await handler(job);
        } catch (e) {
          console.error("[queue] handler failed", id, e);
        }
        if (outcome === "done") await r.xack(STREAM, GROUP, id).catch(() => {});
      })();
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  };

  try {
    while (!opts.signal?.aborted) {
      const free = concurrency - inflight.size;
      if (free <= 0) { await Promise.race(inflight); continue; }
      // Reclaim messages left pending by dead consumers.
      const claimed = (await r.xautoclaim(STREAM, GROUP, consumer, STALE_MS, "0-0", "COUNT", free)) as [string, Entry[]];
      if (claimed[1]?.length) handle(claimed[1]);
      const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", Math.max(1, concurrency - inflight.size), "BLOCK", 5000, "STREAMS", STREAM, ">")) as
        | [string, Entry[]][]
        | null;
      if (res) for (const [, entries] of res) handle(entries);
    }
    await Promise.allSettled(inflight);
  } finally {
    r.disconnect();
  }
}
