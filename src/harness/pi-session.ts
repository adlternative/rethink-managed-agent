/**
 * Hosts pi's own harness (`@earendil-works/pi-coding-agent` AgentSession) headlessly inside the
 * runner, so pi packages — extensions (hooks + registered tools), skills and prompt templates —
 * work unchanged. Route A from the design discussion: extensions run in the runner process;
 * only the built-in file/shell tools are ours and go through the sandbox lease.
 *
 * What an extension sees: `hasUI === false`, `mode === "rpc"`, `cwd` = the workspace dir when
 * the provider keeps one on this host (local/docker bind mount), else a scratch dir (e2b).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createReadTool,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { env } from "../shared/env.ts";
import type { ModelRef, SessionResource } from "../shared/types.ts";

const QODER_MODEL_IDS = ["auto", "ultimate", "performance", "efficient", "lite", "cmodel", "kmodel", "gmodel", "qmodel"];

export interface PiSessionOptions {
  agent: SessionResource["agent"];
  /** Directory extensions see as `cwd`. */
  cwd: string;
  /** History to seed (everything except the prompt that triggers this run). */
  history: AgentMessage[];
  /** Sandbox-backed tools (bash/read/write/edit) — replace pi's cwd-bound builtins. */
  tools: AgentTool[];
  systemPrompt: string;
}

/** pi's per-agent home: settings.json (packages), installed packages, auth. Never the user's ~/.pi. */
export function agentDirFor(agentId: string): string {
  return path.resolve(env.PI_AGENT_ROOT, agentId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

/** Install the agent's packages into its agentDir (idempotent: skipped when the source list is unchanged). */
export async function ensurePackages(agentId: string, packages: string[], cwd: string): Promise<string> {
  const agentDir = agentDirFor(agentId);
  await mkdir(agentDir, { recursive: true });
  const marker = path.join(agentDir, ".packages.installed");
  const want = createHash("sha256").update(JSON.stringify(packages)).digest("hex");
  const have = await readFile(marker, "utf8").catch(() => "");
  if (have === want) return agentDir;
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setPackages([]);
  const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  for (const source of packages) {
    console.log(`[pi] installing package ${source} for ${agentId}`);
    await pm.installAndPersist(source);
  }
  await writeFile(marker, want);
  return agentDir;
}

const runtimes = new Map<string, Promise<ModelRuntime>>();

/** pi ModelRuntime with the qoder proxy registered (and anthropic via env), cached per agentDir. */
function modelRuntimeFor(agentDir: string): Promise<ModelRuntime> {
  let p = runtimes.get(agentDir);
  if (!p) {
    p = (async () => {
      const rt = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null });
      rt.registerProvider("qoder", {
        name: "Qoder",
        baseUrl: env.QODER_BASE_URL,
        apiKey: env.QODER_API_KEY,
        api: "openai-completions",
        models: QODER_MODEL_IDS.map((id) => ({
          id,
          name: `qoder/${id}`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: id === "ultimate" || id === "cmodel" ? 1_000_000 : 200_000,
          maxTokens: 32_000,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        })),
      });
      return rt;
    })();
    runtimes.set(agentDir, p);
  }
  return p;
}

export function resolvePiModel(rt: ModelRuntime, ref: ModelRef): Model<any> {
  const m = rt.getModel(ref.provider, ref.id);
  if (!m) throw new Error(`Unknown model ${ref.provider}/${ref.id}`);
  return m;
}

/** Our pi-agent-core AgentTool -> pi-coding-agent ToolDefinition (same execute, no renderers). */
function toToolDefinition(t: AgentTool): ToolDefinition {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    executionMode: t.executionMode,
    execute: (id, params, signal, onUpdate) => t.execute(id, params, signal, onUpdate),
  };
}

/**
 * pi skills and prompt templates are "progressive disclosure": the system prompt lists them and
 * tells the model to `read` their files, which live on the *runner* (agentDir), not in the sandbox.
 * So `read` gets a read-only overlay: absolute paths inside agentDir are served from the runner
 * with pi's own read tool; everything else goes to the sandbox as before.
 */
async function withRunnerReadOverlay(def: ToolDefinition, dirs: string[]): Promise<ToolDefinition> {
  const roots = await Promise.all([...new Set(dirs)].map((d) => realpath(d).catch(() => path.resolve(d))));
  const readers = new Map(roots.map((r) => [r, createReadTool(r)] as const));
  return {
    ...def,
    description: `${def.description} Skill and prompt-template files listed in the system prompt are readable by the exact absolute path shown there.`,
    async execute(id, params, signal, onUpdate, ctx) {
      const p = (params as { path?: string }).path;
      if (typeof p === "string" && path.isAbsolute(p)) {
        const real = await realpath(p).catch(() => path.resolve(p));
        const root = roots.find((r) => real === r || real.startsWith(r + path.sep));
        if (root) return readers.get(root)!.execute(id, params as never, signal, onUpdate as never);
      }
      return def.execute(id, params, signal, onUpdate, ctx);
    },
  };
}

export interface PiSessionHandle {
  session: AgentSession;
  agentDir: string;
  /** Names of tools contributed by extensions (for logging / events). */
  extensionTools: string[];
  dispose(): void;
}

export async function createPiSession(opts: PiSessionOptions): Promise<PiSessionHandle> {
  const agentDir = await ensurePackages(opts.agent.id, opts.agent.packages ?? [], opts.cwd);
  const settingsManager = SettingsManager.create(opts.cwd, agentDir);
  const modelRuntime = await modelRuntimeFor(agentDir);
  const model = resolvePiModel(modelRuntime, opts.agent.model);

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    settingsManager,
    systemPrompt: opts.systemPrompt,
    noThemes: true,
    // AGENTS.md / CLAUDE.md in the workspace are still picked up (they live in cwd for local/docker).
  });
  await resourceLoader.reload();
  const extensionTools = resourceLoader
    .getExtensions()
    .extensions.flatMap((e) => [...e.tools.keys()]);
  // Runner-side files the model is told to read: skills / prompt templates, wherever pi resolved them.
  const readableDirs = [
    agentDir,
    ...resourceLoader.getSkills().skills.map((sk) => path.dirname(sk.filePath)),
    ...resourceLoader.getPrompts().prompts.map((pt) => path.dirname(pt.filePath)),
  ];

  const sessionManager = SessionManager.inMemory(opts.cwd);
  for (const m of opts.history) sessionManager.appendMessage(m as never);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    noTools: "builtin", // pi's cwd-bound read/bash/edit/write are replaced by our sandbox tools
    customTools: await Promise.all(opts.tools.map(toToolDefinition).map((d) => (d.name === "read" ? withRunnerReadOverlay(d, readableDirs) : d))),
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  // With noTools nothing is active by default; enable ours plus everything extensions registered.
  session.setActiveToolsByName([...opts.tools.map((t) => t.name), ...extensionTools]);
  return { session, agentDir, extensionTools, dispose: () => session.dispose() };
}
