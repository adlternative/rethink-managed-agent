import { files, memoryStores, pluginStore, pool, repos, sessionConfig, skills, toolOutputs } from "../infra/db.ts";
import { appendEvents, listAllEvents } from "../infra/events.ts";
import { migrate } from "../infra/migrate.ts";
import { onInterrupt, onProvidersChanged, popSteer, publish, pushSteer, redis } from "../infra/pubsub.ts";
import { consumeRuns, enqueueRun } from "../infra/queue.ts";
import { claimRun, findStrandedSessions, finishRun, heartbeat, HEARTBEAT_MS, recordUsage } from "../infra/runs.ts";
import { runSession, type AgentPlugins, type ChildSpawn, type RunDeps } from "../harness/run-turn.ts";
import { workspaceRoot } from "../sandbox/workspace.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { buildModelRegistry, createModelRegistry } from "../harness/models.ts";
import { PluginHost } from "../plugins/client.ts";
import { buildHostBundle } from "../plugins/bundle.ts";
import { ensurePackages, loadContent } from "../plugins/installer.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxManager } from "../sandbox/provider.ts";
import { env } from "../shared/env.ts";
import type { RunJob, SandboxProviderName, SessionResource, WorkspaceRef } from "../shared/types.ts";

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

const run = promisify(execFile);

/** Fork a workspace for a child session: metadata refs are copied; `dir` refs are copied on disk (runner owns that volume). */
async function forkWorkspace(parentWorkspaceId: string) {
  const parent = await repos.workspaces.get(parentWorkspaceId);
  if (!parent) throw new Error(`workspace ${parentWorkspaceId} not found`);
  if (parent.ref.kind === "local") throw new Error("local workspaces cannot be forked");
  const child = await repos.workspaces.create(parent.spec, parent.ref);
  if (parent.ref.kind === "dir") {
    const dest = path.join(workspaceRoot(), child.id);
    await mkdir(dest, { recursive: true });
    await run("cp", ["-R", `${parent.ref.path}/.`, dest]);
    const ref: WorkspaceRef = { kind: "dir", path: dest };
    await repos.workspaces.updateRef(child.id, ref, parent.ref);
  }
  return child;
}

const children: ChildSpawn = {
  async spawn(parent, envRow, task, system) {
    const ws = await forkWorkspace(envRow.workspace_id);
    const child = await repos.sessions.create({
      agent_id: parent.agent_id,
      environment_id: envRow.environment_id,
      workspace_id: ws.id,
      agent: system ? { ...parent.agent, system } : parent.agent,
      environments: [{ key: "main", environment_id: envRow.environment_id, workspace_id: ws.id }],
      parent_id: parent.id,
      memory_stores: parent.memory_stores ?? [],
    });
    const [ev] = await appendEvents(child.id, [{ type: "user.message", content: [{ type: "text", text: task }] }]);
    await enqueueRun({ session_id: child.id, trigger_seq: ev!.seq });
    return child;
  },
  async wait(childId, signal) {
    for (;;) {
      if (signal.aborted) throw new Error("parent run aborted while waiting for child session");
      const s = await repos.sessions.get(childId);
      if (!s) throw new Error(`child session ${childId} disappeared`);
      // idle *after* having run: the child starts idle before its job is claimed, so wait for status_running first
      if (s.status === "terminated") return s;
      if (s.status === "idle") {
        const evs = await listAllEvents(childId);
        if (evs.some((e) => e.type === "session.status_idle")) return s;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
};

function makeDeps(_provider: SandboxProviderName): RunDeps {
  return {
    get models() { return models; },
    pluginsFor,
    pluginStore,
    sandboxFor: (name) => sandboxManager.bind(name),
    children,
    // runSession publishes each event itself (so deltas and events interleave in order).
    appendEvents: (id, payloads) => appendEvents(id, payloads, { publish: false }),
    listEvents: (id) => listAllEvents(id),
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
    getSkills: async (refs) => (await skills.getMany(refs.map((r) => r.skill_id))).map((s) => ({ name: s.name, description: s.description, body: s.body, source: `skill:${s.id}` })),
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

console.log(`[runner] consuming runs (concurrency=${env.RUNNER_CONCURRENCY}, default provider=${env.SANDBOX_DEFAULT_PROVIDER}, idle ttl=${env.SANDBOX_IDLE_TTL_MS}ms)`);
try {
  await consumeRuns(handleJob, { signal: stopping.signal, concurrency: env.RUNNER_CONCURRENCY });
} finally {
  clearInterval(reaper);
  await stopProvidersWatch();
  await Promise.allSettled([pool.end(), redis.quit()]);
  console.log("[runner] stopped");
}
