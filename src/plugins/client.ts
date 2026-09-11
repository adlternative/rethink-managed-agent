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
import type { Sandbox, SandboxProcess } from "../shared/types.ts";
import { SANDBOX_HOST_DIR, type HostBundle } from "./bundle.ts";
import { Rpc, type RunnerMethods, type SessionInfo } from "./protocol.ts";

export interface Capabilities {
  sandboxExec(command: string, opts: { cwd?: string; timeoutMs?: number; env?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
  sandboxRead(p: string, env?: string): Promise<string>;
  sandboxWrite(p: string, content: string, env?: string): Promise<void>;
  sandboxEnvs(): string[];
  storeGet(key: string, scope: "agent" | "workspace" | "principal"): Promise<unknown>;
  storeSet(key: string, scope: "agent" | "workspace" | "principal", value: unknown): Promise<void>;
  modelComplete(prompt: string, opts: { system?: string; maxTokens?: number }): Promise<string>;
  agentRun(task: string, opts: { system?: string; maxTurns?: number; tools?: string[]; isolated?: boolean; env?: string }): Promise<string | { report: string; patch?: string; sessionId: string }>;
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  log(args: unknown[]): void;
  agentsSpawn(task: string, opts: Record<string, unknown>): Promise<{ sessionId: string; name?: string; role?: string }>;
  agentsWait(child: string, opts: { timeoutMs?: number; untilQuestion?: boolean }): Promise<unknown>;
  agentsStatus(child: string): Promise<unknown>;
  agentsSteer(child: string, text: string): Promise<void>;
  agentsReply(child: string, questionId: string, text: string): Promise<void>;
  agentsStop(child: string): Promise<void>;
  agentsList(): Promise<unknown>;
  agentsPatch(child: string): Promise<string | null>;
  sessionNote(plugin: string, text: string): Promise<void>;
  sessionSend(text: string): Promise<void>;
  sessionInterrupt(): Promise<void>;
}
export interface LoadedCommand { name: string; description: string; source: string }

export interface LoadedTools { name: string; description: string; parameters: unknown; source: string }

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "host.ts");

function localTransport(child: ChildProcess): SandboxProcess {
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  return {
    write: (d) => { child.stdin!.write(d); },
    end: () => { child.stdin!.end(); },
    onStdout: (cb) => { child.stdout!.on("data", cb); },
    onStderr: (cb) => { child.stderr!.on("data", cb); },
    onExit: (cb) => { child.on("exit", (code, sig) => cb(code ?? (sig ? 137 : null))); },
    kill: () => { child.stdin?.end(); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); },
  };
}

export class PluginHost {
  private proc: SandboxProcess;
  private rpc: Rpc;
  private sessions = new Map<string, Capabilities>();
  private exited: Promise<string>;
  public tools: LoadedTools[] = [];
  public commands: LoadedCommand[] = [];
  public hooks = new Set<string>();
  public warnings: string[] = [];
  /** "runner" (permission-restricted local process) or "sandbox" (inside the leased sandbox). */
  public mode: "runner" | "sandbox";

  private constructor(proc: SandboxProcess, mode: "runner" | "sandbox") {
    this.proc = proc;
    this.mode = mode;
    this.rpc = new Rpc(
      (line) => proc.write(line),
      (method, params) => this.serve(method as keyof RunnerMethods, params as never),
    );
    proc.onStdout((c) => this.rpc.feed(c));
    proc.onStderr((c) => process.stderr.write(`[plugin-host:${mode}] ${c}`));
    this.exited = new Promise((resolve) => proc.onExit((code) => { const why = `plugin host exited (${code})`; this.rpc.abortAll(why); resolve(why); }));
  }

  private static async load(host: PluginHost, packages: PackageManifest[], agentId: string): Promise<PluginHost> {
    const loaded = await Promise.race([
      host.rpc.call<{ tools: LoadedTools[]; commands?: LoadedCommand[]; hooks: string[]; warnings: string[] }>("load", { packages }),
      host.exited.then((why) => { throw new Error(`${why} while loading packages for ${agentId}`); }),
    ]);
    host.tools = loaded.tools;
    host.commands = loaded.commands ?? [];
    host.hooks = new Set(loaded.hooks);
    host.warnings = loaded.warnings;
    return host;
  }

  /**
   * Start a host inside a sandbox: upload the bundle (host sources + typebox + packages), unpack it
   * under /tmp (outside the workspace, so captures never include it), and run it with the sandbox's
   * own node. No permission model / lockdown: the sandbox is the boundary, and plugins may use fs
   * and the network directly (subject to the environment's `network`).
   */
  static async startInSandbox(sandbox: Sandbox, bundle: HostBundle, opts: { agentId: string }): Promise<PluginHost> {
    if (!sandbox.spawn) throw new Error(`sandbox provider ${sandbox.provider} cannot host plugins (no spawn support)`);
    const tgz = `${SANDBOX_HOST_DIR}.tgz`;
    // The bundle lives outside the workspace, where writeFile (workspace-confined by design) cannot
    // reach: stream it through a process's stdin instead.
    await new Promise<void>((resolve, reject) => {
      sandbox.spawn!(`base64 -d > ${tgz}`).then((up) => {
        let err = "";
        up.onStderr((c) => { err += c; });
        up.onExit((code) => (code === 0 ? resolve() : reject(new Error(`bundle upload failed (${code}): ${err.trim()}`))));
        const b64 = Buffer.from(bundle.tgz).toString("base64");
        for (let i = 0; i < b64.length; i += 65536) up.write(b64.slice(i, i + 65536) + "\n");
        up.end();
      }, reject);
    });
    let out = "";
    for await (const c of sandbox.exec(`command -v node >/dev/null || { echo "node is not installed in the sandbox image" >&2; exit 127; }; rm -rf ${SANDBOX_HOST_DIR} && mkdir -p ${SANDBOX_HOST_DIR} && tar xzf ${tgz} -C ${SANDBOX_HOST_DIR} && rm -f ${tgz} && node --version`, { timeoutMs: 60_000 })) {
      if (c.type === "exit" && c.code !== 0) throw new Error(`plugin host bundle setup failed in sandbox: ${out.trim()}`);
      if (c.data) out += c.data;
    }
    const proc = await sandbox.spawn(`exec node ${SANDBOX_HOST_DIR}/src/plugins/host.ts`, { env: { PMA_HOST_LOCKDOWN: "0", PMA_PLUGIN_HOST: "1" } });
    return PluginHost.load(new PluginHost(proc, "sandbox"), bundle.manifests, opts.agentId);
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
    return PluginHost.load(new PluginHost(localTransport(child), "runner"), packages, opts.agentId);
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
      case "sandbox.exec": { const p = params as RunnerMethods["sandbox.exec"]["params"]; return caps.sandboxExec(p.command, { cwd: p.cwd, timeoutMs: p.timeoutMs, env: p.env }); }
      case "sandbox.readFile": { const p = params as RunnerMethods["sandbox.readFile"]["params"]; return caps.sandboxRead(p.path, p.env); }
      case "sandbox.writeFile": { const p = params as RunnerMethods["sandbox.writeFile"]["params"]; await caps.sandboxWrite(p.path, p.content, p.env); return null; }
      case "sandbox.envs": return caps.sandboxEnvs();
      case "store.get": { const p = params as RunnerMethods["store.get"]["params"]; return caps.storeGet(p.key, p.scope); }
      case "store.set": { const p = params as RunnerMethods["store.set"]["params"]; await caps.storeSet(p.key, p.scope, p.value); return null; }
      case "model.complete": { const p = params as RunnerMethods["model.complete"]["params"]; return caps.modelComplete(p.prompt, { system: p.system, maxTokens: p.maxTokens }); }
      case "agent.run": { const p = params as RunnerMethods["agent.run"]["params"]; return caps.agentRun(p.task, { system: p.system, maxTurns: p.maxTurns, tools: p.tools, isolated: p.isolated, env: p.env }); }
      case "fetch": { const p = params as RunnerMethods["fetch"]["params"]; return caps.fetch(p.url, { method: p.method, headers: p.headers, body: p.body }); }
      case "log": caps.log((params as RunnerMethods["log"]["params"]).args); return null;
      case "agents.spawn": { const p = params as RunnerMethods["agents.spawn"]["params"]; return caps.agentsSpawn(p.task, p.opts ?? {}); }
      case "agents.wait": { const p = params as RunnerMethods["agents.wait"]["params"]; return caps.agentsWait(p.child, { timeoutMs: p.timeoutMs, untilQuestion: p.untilQuestion }); }
      case "agents.status": return caps.agentsStatus((params as RunnerMethods["agents.status"]["params"]).child);
      case "agents.steer": { const p = params as RunnerMethods["agents.steer"]["params"]; await caps.agentsSteer(p.child, p.text); return null; }
      case "agents.reply": { const p = params as RunnerMethods["agents.reply"]["params"]; await caps.agentsReply(p.child, p.questionId, p.text); return null; }
      case "agents.stop": await caps.agentsStop((params as RunnerMethods["agents.stop"]["params"]).child); return null;
      case "agents.list": return caps.agentsList();
      case "agents.patch": return caps.agentsPatch((params as RunnerMethods["agents.patch"]["params"]).child);
      case "session.note": { const p = params as RunnerMethods["session.note"]["params"]; await caps.sessionNote(p.plugin, p.text); return null; }
      case "session.send": await caps.sessionSend((params as RunnerMethods["session.send"]["params"]).text); return null;
      case "session.interrupt": await caps.sessionInterrupt(); return null;
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

  /** Run a registered slash command; returns its reply and/or a prompt to send to the model. */
  runCommand(session: SessionInfo, name: string, args: string): Promise<{ reply?: string; send?: string }> {
    return this.rpc.call("command.run", { session, name, args });
  }

  async emit<E extends HookEvent>(session: SessionInfo, event: E): Promise<HookResultFor<E> | null> {
    if (!this.hooks.has(event.type)) return null;
    return this.rpc.call<HookResultFor<E> | null>("hook.emit", { session, event });
  }

  stop(): void {
    this.proc.kill();
  }
}
