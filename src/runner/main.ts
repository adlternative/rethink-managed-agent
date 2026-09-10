import { pluginStore, pool, repos } from "../infra/db.ts";
import { appendEvents, listAllEvents } from "../infra/events.ts";
import { migrate } from "../infra/migrate.ts";
import { onInterrupt, popSteer, publish, redis } from "../infra/pubsub.ts";
import { consumeRuns, enqueueRun } from "../infra/queue.ts";
import { claimRun, finishRun, heartbeat, HEARTBEAT_MS } from "../infra/runs.ts";
import { runSession, type AgentPlugins, type RunDeps } from "../harness/run-turn.ts";
import { createModelRegistry } from "../harness/models.ts";
import { PluginHost } from "../plugins/client.ts";
import { buildHostBundle } from "../plugins/bundle.ts";
import { ensurePackages, loadContent } from "../plugins/installer.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxManager } from "../sandbox/provider.ts";
import { env } from "../shared/env.ts";
import type { RunJob, SandboxProviderName } from "../shared/types.ts";

const REAP_INTERVAL_MS = 60_000;

await migrate();

/** Everything runSession needs, wired to infra + sandbox. Provider is chosen per session below. */
const models = createModelRegistry();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * One plugin host per (agent id, package list); hosts are long-lived and serve every session of
 * that agent. Agents without packages get no host at all.
 */
const pluginCache = new Map<string, Promise<AgentPlugins>>();
function pluginsFor(agent: Parameters<RunDeps["pluginsFor"]>[0]): Promise<AgentPlugins> {
  const packages = agent.packages ?? [];
  if (packages.length === 0) return Promise.resolve({ manifests: [], skills: [], prompts: [], runnerHost: () => Promise.reject(new Error("no packages")), bundle: () => Promise.reject(new Error("no packages")) });
  const key = `${agent.id}:${JSON.stringify(packages)}`;
  let p = pluginCache.get(key);
  if (!p) {
    p = (async () => {
      const manifests = await ensurePackages(agent.id, packages);
      const content = await loadContent(manifests);
      let runner: Promise<PluginHost> | null = null;
      return {
        manifests,
        ...content,
        runnerHost: () => (runner ??= PluginHost.start(manifests, { agentId: agent.id, repoRoot: REPO_ROOT, extraReadDirs: [env.PI_AGENT_ROOT] }).then((host) => {
          for (const w of host.warnings) console.warn(`[plugins] ${agent.id}: ${w}`);
          console.log(`[plugins] ${agent.id} (runner host): tools=${host.tools.map((t) => t.name).join(",") || "-"} hooks=${[...host.hooks].join(",") || "-"} skills=${content.skills.map((s) => s.name).join(",") || "-"}`);
          return host;
        })),
        bundle: () => buildHostBundle(manifests, REPO_ROOT),
      };
    })();
    pluginCache.set(key, p);
    p.catch(() => pluginCache.delete(key));
  }
  return p;
}

function makeDeps(provider: SandboxProviderName): RunDeps {
  return {
    models,
    pluginsFor,
    pluginStore,
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
