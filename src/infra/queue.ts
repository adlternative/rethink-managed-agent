import { Redis } from "ioredis";
import { env } from "../shared/env.ts";
import type { RunJob } from "../shared/types.ts";
import { redis } from "./pubsub.ts";

const STREAM = "runs";
const GROUP = "runners";
const STALE_MS = 60_000;

export async function enqueueRun(job: RunJob): Promise<void> {
  await redis.xadd(STREAM, "*", "job", JSON.stringify(job));
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

export async function consumeRuns(
  handler: (job: RunJob) => Promise<void>,
  opts: { consumer?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const consumer = opts.consumer ?? `runner-${process.pid}`;
  // Dedicated connection: XREADGROUP BLOCK would stall the shared one.
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await ensureGroup(r);

  const handle = async (entries: Entry[]) => {
    for (const [id, fields] of entries) {
      try {
        const job = parseJob(fields);
        if (job) await handler(job);
      } catch (e) {
        console.error("[queue] handler failed", id, e);
      }
      await r.xack(STREAM, GROUP, id);
    }
  };

  try {
    while (!opts.signal?.aborted) {
      // Reclaim messages left pending by dead consumers.
      const claimed = (await r.xautoclaim(STREAM, GROUP, consumer, STALE_MS, "0-0", "COUNT", 10)) as [string, Entry[]];
      if (claimed[1]?.length) await handle(claimed[1]);

      const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", 1, "BLOCK", 5000, "STREAMS", STREAM, ">")) as
        | [string, Entry[]][]
        | null;
      if (res) for (const [, entries] of res) await handle(entries);
    }
  } finally {
    r.disconnect();
  }
}
