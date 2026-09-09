import { pool, repos } from "../infra/db.ts";
import { appendEvents, listEvents } from "../infra/events.ts";
import { migrate } from "../infra/migrate.ts";
import { onInterrupt, popSteer, publish, redis } from "../infra/pubsub.ts";
import { consumeRuns } from "../infra/queue.ts";
import { createModelRegistry } from "../harness/models.ts";
import { runSession, type RunDeps } from "../harness/run-turn.ts";
import { allProviders, getProvider } from "../sandbox/provider.ts";
import { env } from "../shared/env.ts";
import type { RunJob, SandboxProvider } from "../shared/types.ts";

const REAP_INTERVAL_MS = 60_000;

await migrate();
const models = createModelRegistry();

/** Everything runSession needs, wired to infra + sandbox. Provider is chosen per session below. */
function makeDeps(provider: SandboxProvider): RunDeps {
  return {
    models,
    provider,
    // runSession publishes each event itself (so deltas and events interleave in order).
    appendEvents: (id, payloads) => appendEvents(id, payloads, { publish: false }),
    listEvents: (id) => listEvents(id),
    publish,
    onInterrupt,
    // Steer entries are persisted user events; only their content is fed into the live loop.
    popSteer: async (id) => (await popSteer(id)).flatMap((s) => (s.type === "user.message" ? [s.content] : [])),
    getSession: (id) => repos.sessions.get(id),
    getWorkspace: (id) => repos.workspaces.get(id),
    getEnvironment: (id) => repos.environments.get(id),
    updateWorkspaceRef: (id, ref) => repos.workspaces.updateRef(id, ref),
    setSessionStatus: (id, status) => repos.sessions.setStatus(id, status),
  };
}

async function providerFor(sessionId: string): Promise<SandboxProvider> {
  const session = await repos.sessions.get(sessionId);
  const environment = session ? await repos.environments.get(session.environment_id) : null;
  return getProvider(environment?.provider ?? env.SANDBOX_DEFAULT_PROVIDER);
}

async function handleJob(job: RunJob): Promise<void> {
  const started = Date.now();
  console.log(`[runner] run ${job.session_id} (trigger_seq=${job.trigger_seq})`);
  try {
    await runSession(job.session_id, makeDeps(await providerFor(job.session_id)));
  } finally {
    console.log(`[runner] done ${job.session_id} in ${Date.now() - started}ms`);
  }
}

async function reap(): Promise<void> {
  for (const p of allProviders()) {
    try {
      const ids = await p.reap(env.SANDBOX_IDLE_TTL_MS);
      if (ids.length) console.log(`[reaper] ${p.name}: destroyed ${ids.join(", ")}`);
    } catch (e) {
      console.error(`[reaper] ${p.name} failed`, e);
    }
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
