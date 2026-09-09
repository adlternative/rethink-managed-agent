import { pool, repos } from "../infra/db.ts";
import { appendEvents, listAllEvents } from "../infra/events.ts";
import { migrate } from "../infra/migrate.ts";
import { onInterrupt, popSteer, publish, redis } from "../infra/pubsub.ts";
import { consumeRuns, enqueueRun } from "../infra/queue.ts";
import { claimRun, finishRun, heartbeat, HEARTBEAT_MS } from "../infra/runs.ts";
import { runSession, type RunDeps } from "../harness/run-turn.ts";
import { sandboxManager } from "../sandbox/provider.ts";
import { env } from "../shared/env.ts";
import type { RunJob, SandboxProviderName } from "../shared/types.ts";

const REAP_INTERVAL_MS = 60_000;

await migrate();

/** Everything runSession needs, wired to infra + sandbox. Provider is chosen per session below. */
function makeDeps(provider: SandboxProviderName): RunDeps {
  return {
    sandboxes: sandboxManager.bind(provider),
    // runSession publishes each event itself (so deltas and events interleave in order).
    appendEvents: (id, payloads) => appendEvents(id, payloads, { publish: false }),
    listEvents: (id) => listAllEvents(id),
    publish,
    onInterrupt,
    popSteer,
    getSession: (id) => repos.sessions.get(id),
    getWorkspace: (id) => repos.workspaces.get(id),
    getEnvironment: (id) => repos.environments.get(id),
    updateWorkspaceRef: (id, ref, expected) => repos.workspaces.updateRef(id, ref, expected),
    claimRun,
    finishRun,
  };
}

async function providerFor(sessionId: string): Promise<SandboxProviderName> {
  const session = await repos.sessions.get(sessionId);
  const environment = session ? await repos.environments.get(session.environment_id) : null;
  return environment?.provider ?? env.SANDBOX_DEFAULT_PROVIDER;
}

async function handleJob(job: RunJob): Promise<"done" | "retry"> {
  const started = Date.now();
  console.log(`[runner] run ${job.session_id} (trigger_seq=${job.trigger_seq})`);
  // Heartbeat while running so a re-examined job can tell a live run from a dead runner's.
  const hb = setInterval(() => void heartbeat(job.session_id).catch(() => {}), HEARTBEAT_MS);
  try {
    const outcome = await runSession(job.session_id, makeDeps(await providerFor(job.session_id)));
    if (outcome.status === "busy") {
      console.log(`[runner] ${job.session_id} is running elsewhere; leaving job pending`);
      return "retry";
    }
    if (outcome.unconsumedSeq !== null) {
      console.log(`[runner] ${job.session_id}: user message seq=${outcome.unconsumedSeq} arrived after the last steer pop; enqueueing follow-up`);
      await enqueueRun({ session_id: job.session_id, trigger_seq: outcome.unconsumedSeq });
    }
    return "done";
  } finally {
    clearInterval(hb);
    console.log(`[runner] done ${job.session_id} in ${Date.now() - started}ms`);
  }
}

async function reap(): Promise<void> {
  try {
    for (const [name, ids] of Object.entries(await sandboxManager.reap(env.SANDBOX_IDLE_TTL_MS))) {
      if (ids.length) console.log(`[reaper] ${name}: destroyed ${ids.join(", ")}`);
    }
  } catch (e) {
    console.error("[reaper] failed", e);
  }
}

const stopping = new AbortController();
const reaper = setInterval(() => void reap(), REAP_INTERVAL_MS);

const shutdown = (sig: string) => {
  if (stopping.signal.aborted) return;
  console.log(`[runner] ${sig}: finishing in-flight run, then exiting`);
  clearInterval(reaper);
  stopping.abort();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`[runner] consuming runs (default provider=${env.SANDBOX_DEFAULT_PROVIDER}, idle ttl=${env.SANDBOX_IDLE_TTL_MS}ms)`);
try {
  await consumeRuns(handleJob, { signal: stopping.signal });
} finally {
  clearInterval(reaper);
  await Promise.allSettled([pool.end(), redis.quit()]);
  console.log("[runner] stopped");
}
