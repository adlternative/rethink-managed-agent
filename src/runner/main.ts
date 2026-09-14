import { files, memoryStores, pluginStore, pool, principals, repos, sessionConfig, skills, toolOutputs, vaultSecrets } from "../infra/db.ts";
import { appendEvents, foldSince, listEventsWindow } from "../infra/events.ts";
import { migrate } from "../infra/migrate.ts";
import { closeBus, onInterrupt, onProvidersChanged, popSteer, publish, pushSteer, takeToolResult } from "../infra/pubsub.ts";
import { anyWorkerAlive } from "../infra/byoc.ts";
import { openMcpCredentials } from "../infra/mcp-credentials.ts";
import { consumeRuns, enqueueRun, queueDepth } from "../infra/queue.ts";
import { disallowedFor } from "../plugins/allow.ts";
import { createServer } from "node:http";
import { counter, gauge, histogram, onScrape, render as renderMetrics } from "../infra/metrics.ts";
import { log } from "../infra/log.ts";
import { claimRun, findStrandedSessions, finishRun, heartbeat, HEARTBEAT_MS, recordUsage } from "../infra/runs.ts";
import { runSession, type AgentPlugins, type RunDeps } from "../harness/run-turn.ts";
import { children } from "./children.ts";
import { buildModelRegistry, createModelRegistry } from "../harness/models.ts";
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
/** Model registry from the providers table; rebuilt when the API publishes providers:changed. */
let models = createModelRegistry();
async function reloadModels(): Promise<void> {
  const rows = await repos.providers.list();
  if (rows.length === 0) return; // not seeded yet: keep the built-in defaults
  models = buildModelRegistry(rows);
  console.log(`[models] ${rows.filter((r) => r.enabled).map((r) => `${r.id}(${r.models.length})`).join(", ")}`);
}
await reloadModels();
const stopProvidersWatch = await onProvidersChanged(() => void reloadModels().catch((e) => console.error("[models] reload failed", e)));
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
      let started: PluginHost | null = null;
      return {
        manifests,
        ...content,
        // a host whose process died is replaced on the next session instead of failing it forever
        runnerHost: () => { if (started?.exitReason) { console.warn(`[plugins] ${agent.id}: ${started.exitReason}; restarting the runner host`); runner = null; started = null; } return (runner ??= (async () => {
          const blocked = disallowedFor(packages, "runner");
          if (blocked.length) throw new Error(`packages ${blocked.join(", ")} are not allowed on the shared runner (PLUGIN_ALLOW); attach an environment with plugin_host=sandbox to run them isolated in the user's own sandbox`);
          return PluginHost.start(manifests, { agentId: agent.id, repoRoot: REPO_ROOT, extraReadDirs: [env.PI_AGENT_ROOT] });
        })().then((host) => {
          started = host;
          for (const w of host.warnings) console.warn(`[plugins] ${agent.id}: ${w}`);
          console.log(`[plugins] ${agent.id} (runner host): tools=${host.tools.map((t) => t.name).join(",") || "-"} hooks=${[...host.hooks].join(",") || "-"} skills=${content.skills.map((s) => s.name).join(",") || "-"}`);
          return host;
        }, (e) => { runner = null; throw e; })); },
        bundle: () => { const blocked = disallowedFor(packages, "sandbox"); if (blocked.length) throw new Error(`packages ${blocked.join(", ")} are not allowed even in an isolated sandbox host (PLUGIN_ALLOW_SANDBOX)`); return buildHostBundle(manifests, REPO_ROOT); },
      };
    })();
    pluginCache.set(key, p);
    p.catch(() => pluginCache.delete(key));
  }
  return p;
}

function makeDeps(_provider: SandboxProviderName): RunDeps {
  return {
    get models() { return models; },
    pluginsFor,
    pluginStore,
    principalFetchAllow: async (ownerId) => (await principals.get(ownerId))?.fetch_allow ?? null,
    vaultSecrets: (session) => vaultSecrets(session.owner_id, session.vault_ids ?? []),
    mcpCredentials: (server) => openMcpCredentials(server),
    awaitToolResult: async (sessionId, callId, signal, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return null;
        const r = await takeToolResult(sessionId, callId);
        if (r) return r;
        await new Promise((res) => setTimeout(res, 200));
      }
      return null;
    },
    sandboxFor: (name) => sandboxManager.bind(name),
    children,
    // runSession publishes each event itself (so deltas and events interleave in order).
    appendEvents: (id, payloads) => appendEvents(id, payloads, { publish: false }),
    listEvents: (id, opts) => listEventsWindow(id, opts),
    foldSince,
    publish,
    onInterrupt,
    popSteer,
    // A plugin "send": persist as a normal user.message, then queue it like the API does for running sessions.
    pushSteer: async (id, text) => {
      const [ev] = await appendEvents(id, [{ type: "user.message", content: [{ type: "text", text }] }]);
      await pushSteer(id, { seq: ev!.seq, content: ev!.payload.type === "user.message" ? ev!.payload.content : [] });
    },
    getSession: (id) => repos.sessions.get(id),
    getWorkspace: (id) => repos.workspaces.get(id),
    getEnvironment: (id) => repos.environments.get(id),
    updateWorkspaceRef: (id, ref, expected) => repos.workspaces.updateRef(id, ref, expected),
    claimRun,
    finishRun,
    recordUsage,
    toolOutputs,
    recordSystemPrompt: (id, prompt) => sessionConfig.recordSystemPrompt(id, prompt),
    files: { get: async (id) => { const f = await files.content(id); return f ? { name: f.meta.filename, mime: f.meta.mime_type, data: new Uint8Array(f.data) } : null; } },
    getSkills: async (refs, ownerId) => (await skills.getMany(refs.map((r) => r.skill_id), { owner: ownerId })).map((s) => ({ name: s.name, description: s.description, body: s.body, source: `skill:${s.id}` })),
    getMemoryStores: async (mounts) => {
      const stores = await memoryStores.getMany(mounts.map((m) => m.memory_store_id));
      return mounts.flatMap((m) => { const st = stores.find((x) => x.id === m.memory_store_id); return st ? [{ store: st, mount_path: m.mount_path }] : []; });
    },
    updateMemoryRef: (id, ref) => memoryStores.updateRef(id, ref),
  };
}

async function providerFor(sessionId: string): Promise<SandboxProviderName> {
  const session = await repos.sessions.get(sessionId);
  const environment = session ? await repos.environments.get(session.environment_id) : null;
  return environment?.provider ?? env.SANDBOX_DEFAULT_PROVIDER;
}

const runsTotal = counter("runner_runs_total", "Runs handled, by outcome");
const runDuration = histogram("runner_run_duration_seconds", "Run wall-clock duration");
const activeRuns = gauge("runner_active_runs", "Runs currently executing on this runner");
let active = 0;

/**
 * BYOC pause: a byoc environment with no live worker cannot run. Instead of failing (or hanging on
 * acquire), append a session.environment_disconnected event — the session then reads as
 * requires_action(environment_connection) — and skip the run. A worker (re)connect re-enqueues it
 * (see resumeEnvironment on the worker poll). Returns true if the run was paused.
 */
async function pauseIfDisconnected(job: RunJob): Promise<boolean> {
  const session = await repos.sessions.get(job.session_id);
  if (!session) return false;
  const environment = await repos.environments.get(session.environment_id);
  if (environment?.provider !== "byoc" || (await anyWorkerAlive(environment.id))) return false;
  const [ev] = await appendEvents(session.id, [{ type: "session.environment_disconnected", environment_id: environment.id }]);
  if (ev) await publish({ type: "event", event: ev });
  return true;
}

async function handleJob(job: RunJob): Promise<"done" | "retry"> {
  const started = Date.now();
  const jlog = log.child({ session: job.session_id, trigger_seq: job.trigger_seq });
  jlog.info("run.start");
  if (await pauseIfDisconnected(job)) { jlog.info("run.paused_env_disconnected"); return "done"; }
  activeRuns.set(++active);
  // Heartbeat while running so a re-examined job can tell a live run from a dead runner's.
  const hb = setInterval(() => void heartbeat(job.session_id).catch(() => {}), HEARTBEAT_MS);
  let outcomeLabel = "done";
  try {
    const outcome = await runSession(job.session_id, makeDeps(await providerFor(job.session_id)));
    if (outcome.status === "terminated") {
      jlog.info("run.session_terminated"); // never runs again: drop the job instead of retrying it forever
      outcomeLabel = "terminated";
      return "done";
    }
    if (outcome.status === "busy") {
      jlog.info("run.busy_elsewhere");
      outcomeLabel = "busy";
      return "retry";
    }
    if (outcome.unconsumedSeq !== null) {
      jlog.info("run.followup", { unconsumed_seq: outcome.unconsumedSeq });
      await enqueueRun({ session_id: job.session_id, trigger_seq: outcome.unconsumedSeq, owner_id: job.owner_id });
    }
    outcomeLabel = outcome.status === "done" ? outcome.stopReason : "done";
    return "done";
  } catch (e) {
    outcomeLabel = "error";
    jlog.error("run.error", { error: (e as Error)?.message ?? String(e) });
    throw e;
  } finally {
    clearInterval(hb);
    activeRuns.set(--active);
    const seconds = (Date.now() - started) / 1000;
    runsTotal.inc({ outcome: outcomeLabel });
    runDuration.observe(seconds);
    jlog.info("run.done", { outcome: outcomeLabel, ms: Date.now() - started });
  }
}

async function reap(): Promise<void> {
  try {
    for (const [name, r] of Object.entries(await sandboxManager.reap(env.SANDBOX_IDLE_TTL_MS, env.SANDBOX_PAUSED_TTL_MS))) {
      if (r.paused.length) console.log(`[reaper] ${name}: paused ${r.paused.join(", ")}`);
      if (r.destroyed.length) console.log(`[reaper] ${name}: destroyed ${r.destroyed.join(", ")}`);
    }
  } catch (e) {
    console.error("[reaper] failed", e);
  }
}

/** Reconcile the enqueue-after-commit gap: re-enqueue idle sessions whose newest user.message never got a run. */
async function reconcile(): Promise<void> {
  try {
    for (const job of await findStrandedSessions(30_000)) {
      console.warn(`[reconcile] ${job.session_id}: user.message seq=${job.trigger_seq} has no run; enqueueing`);
      await enqueueRun(job);
    }
  } catch (e) {
    console.error("[reconcile] failed", e);
  }
}

const stopping = new AbortController();
const reaper = setInterval(() => { void reap(); void reconcile(); }, REAP_INTERVAL_MS);
void reconcile();

const shutdown = (sig: string) => {
  if (stopping.signal.aborted) return;
  console.log(`[runner] ${sig}: finishing in-flight run, then exiting`);
  clearInterval(reaper);
  stopping.abort();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Prometheus metrics endpoint (per-process; the runner has no HTTP API otherwise).
const queueGauge = gauge("runner_queue_depth", "Pending entries in the run stream");
onScrape(async () => queueGauge.set(await queueDepth()));
let metricsServer: ReturnType<typeof createServer> | null = null;
if (env.RUNNER_METRICS_PORT > 0) {
  metricsServer = createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
    if (req.url === "/metrics") { void renderMetrics().then((t) => res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(t)); return; }
    res.writeHead(404).end();
  }).listen(env.RUNNER_METRICS_PORT, () => log.info("runner.metrics_listening", { port: env.RUNNER_METRICS_PORT }));
}

if (env.RUNNER_OWNERS.length && env.MESSAGING_BACKEND !== "postgres") log.warn("runner.owners_ignored", { note: "RUNNER_OWNERS routing needs MESSAGING_BACKEND=postgres; this runner will handle ALL owners", owners: env.RUNNER_OWNERS });
log.info("runner.consuming", { concurrency: env.RUNNER_CONCURRENCY, default_provider: env.SANDBOX_DEFAULT_PROVIDER, idle_ttl_ms: env.SANDBOX_IDLE_TTL_MS });
try {
  await consumeRuns(handleJob, { signal: stopping.signal, concurrency: env.RUNNER_CONCURRENCY });
} finally {
  clearInterval(reaper);
  metricsServer?.close();
  await stopProvidersWatch();
  await Promise.allSettled([pool.end(), closeBus()]);
  log.info("runner.stopped");
}
