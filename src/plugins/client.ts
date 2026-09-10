/**
 * Runner side of the plugin host: spawns the sandboxed host process for an agent, exposes its tools
 * as pi-agent-core AgentTools, dispatches hooks, and serves capability calls with the session's
 * sandbox / store / model / sub-agent — the only authority plugins ever get.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { HookEvent, HookResultFor, PackageManifest } from "./api.ts";
import { Rpc, type RunnerMethods, type SessionInfo } from "./protocol.ts";

export interface Capabilities {
  sandboxExec(command: string, opts: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
  sandboxRead(p: string): Promise<string>;
  sandboxWrite(p: string, content: string): Promise<void>;
  storeGet(key: string, scope: "agent" | "workspace"): Promise<unknown>;
  storeSet(key: string, scope: "agent" | "workspace", value: unknown): Promise<void>;
  modelComplete(prompt: string, opts: { system?: string; maxTokens?: number }): Promise<string>;
  agentRun(task: string, opts: { system?: string; maxTurns?: number; tools?: string[] }): Promise<string>;
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  log(args: unknown[]): void;
}

export interface LoadedTools { name: string; description: string; parameters: unknown; source: string }

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "host.ts");

export class PluginHost {
  private child: ChildProcess;
  private rpc: Rpc;
  private sessions = new Map<string, Capabilities>();
  private exited: Promise<string>;
  public tools: LoadedTools[] = [];
  public hooks = new Set<string>();
  public warnings: string[] = [];

  private constructor(child: ChildProcess) {
    this.child = child;
    this.rpc = new Rpc(
      (line) => { child.stdin!.write(line); },
      (method, params) => this.serve(method as keyof RunnerMethods, params as never),
    );
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => this.rpc.feed(c));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => process.stderr.write(`[plugin-host] ${c}`));
    this.exited = new Promise((resolve) => child.on("exit", (code, sig) => { const why = `plugin host exited (${code ?? sig})`; this.rpc.abortAll(why); resolve(why); }));
  }

  /**
   * Start a host with Node's permission model: read-only access to the package dirs and to this
   * repo (so `tsx` and typebox resolve), no fs write, no child processes, no workers.
   */
  static async start(packages: PackageManifest[], opts: { agentId: string; repoRoot: string; extraReadDirs?: string[] }): Promise<PluginHost> {
    // Read access is the minimum: the host's own sources, typebox (plugins import it for schemas),
    // the package dirs, and any extra roots the runner names. Never the repo root: .env, the rest of
    // src/ and node_modules stay invisible to plugins.
    const readDirs = [...new Set([
      path.join(opts.repoRoot, "src", "plugins"),
      path.join(opts.repoRoot, "node_modules", "typebox"),
      ...packages.map((p) => p.dir),
      ...(opts.extraReadDirs ?? []),
    ])];
    // Node's native type stripping (22.18+) runs host.ts and plugin .ts files without tsx, which
    // would need a cache dir and a loader worker the permission model forbids.
    const args = ["--permission", "--no-warnings", ...readDirs.map((d) => `--allow-fs-read=${d}`), HOST_ENTRY];
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "", PMA_PLUGIN_HOST: "1" } });
    const host = new PluginHost(child);
    const loaded = await Promise.race([
      host.rpc.call<{ tools: LoadedTools[]; hooks: string[]; warnings: string[] }>("load", { packages }),
      host.exited.then((why) => { throw new Error(`${why} while loading packages for ${opts.agentId}`); }),
    ]);
    host.tools = loaded.tools;
    host.hooks = new Set(loaded.hooks);
    host.warnings = loaded.warnings;
    return host;
  }

  /** Register the capabilities backing one session's calls; returns an unregister. */
  attach(session: SessionInfo, caps: Capabilities): () => void {
    this.sessions.set(session.sessionId, caps);
    return () => { this.sessions.delete(session.sessionId); };
  }

  private async serve<M extends keyof RunnerMethods>(method: M, params: RunnerMethods[M]["params"]): Promise<unknown> {
    const caps = this.sessions.get(params.session.sessionId);
    if (!caps) throw new Error(`no active session ${params.session.sessionId} for capability ${method}`);
    switch (method) {
      case "sandbox.exec": { const p = params as RunnerMethods["sandbox.exec"]["params"]; return caps.sandboxExec(p.command, { cwd: p.cwd, timeoutMs: p.timeoutMs }); }
      case "sandbox.readFile": return caps.sandboxRead((params as RunnerMethods["sandbox.readFile"]["params"]).path);
      case "sandbox.writeFile": { const p = params as RunnerMethods["sandbox.writeFile"]["params"]; await caps.sandboxWrite(p.path, p.content); return null; }
      case "store.get": { const p = params as RunnerMethods["store.get"]["params"]; return caps.storeGet(p.key, p.scope); }
      case "store.set": { const p = params as RunnerMethods["store.set"]["params"]; await caps.storeSet(p.key, p.scope, p.value); return null; }
      case "model.complete": { const p = params as RunnerMethods["model.complete"]["params"]; return caps.modelComplete(p.prompt, { system: p.system, maxTokens: p.maxTokens }); }
      case "agent.run": { const p = params as RunnerMethods["agent.run"]["params"]; return caps.agentRun(p.task, { system: p.system, maxTurns: p.maxTurns, tools: p.tools }); }
      case "fetch": { const p = params as RunnerMethods["fetch"]["params"]; return caps.fetch(p.url, { method: p.method, headers: p.headers, body: p.body }); }
      case "log": caps.log((params as RunnerMethods["log"]["params"]).args); return null;
      default: throw new Error(`unknown capability ${String(method)}`);
    }
  }

  /** pi-agent-core tools that execute inside the host. */
  agentTools(session: SessionInfo): AgentTool[] {
    return this.tools.map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters as TSchema,
      executionMode: "sequential",
      execute: async (_id, params) => {
        const r = await this.rpc.call<{ content: { type: "text"; text: string }[]; isError?: boolean }>("tool.execute", { session, name: t.name, input: params });
        if (r.isError) throw new Error(r.content.map((c) => c.text).join("") || "plugin tool failed");
        return { content: r.content, details: {} };
      },
    }));
  }

  async emit<E extends HookEvent>(session: SessionInfo, event: E): Promise<HookResultFor<E> | null> {
    if (!this.hooks.has(event.type)) return null;
    return this.rpc.call<HookResultFor<E> | null>("hook.emit", { session, event });
  }

  stop(): void {
    this.child.stdin?.end();
    setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
  }
}
