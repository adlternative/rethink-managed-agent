/**
 * Plugin host: a child process (one per agent) started by the runner with Node's permission model
 * (read-only fs limited to the package dirs, no child processes, no workers). It loads packages,
 * registers their tools/hooks, and serves `tool.execute` / `hook.emit` over stdio. Every capability
 * a plugin uses is a call back to the runner.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lockdown } from "./lockdown.ts";
import type { CommandSpec, HookEvent, HookName, PackageManifest, PluginAPI, PluginContext, PluginFactory, ToolSpec } from "./api.ts";
import { Rpc, type SessionInfo } from "./protocol.ts";
import { piCompatFactory } from "./pi-compat.ts";

// Runner mode: must run before the first plugin import (net/http/etc. unresolvable, fetch gone).
// Sandbox mode (PMA_HOST_LOCKDOWN=0): the sandbox is the boundary; plugins may use fs/net directly.
if (process.env.PMA_HOST_LOCKDOWN !== "0") lockdown();

type Handler = (event: HookEvent, ctx: PluginContext) => unknown;
const tools = new Map<string, { spec: ToolSpec; source: string }>();
const commands = new Map<string, { spec: CommandSpec; source: string }>();
const hooks = new Map<HookName, { handler: Handler; source: string }[]>();
const warnings: string[] = [];

const rpc = new Rpc(
  (line) => process.stdout.write(line),
  async (method, params) => {
    switch (method) {
      case "load": return load((params as { packages: PackageManifest[] }).packages);
      case "tool.execute": {
        const p = params as { session: SessionInfo; name: string; input: unknown };
        const t = tools.get(p.name);
        if (!t) throw new Error(`plugin host: unknown tool ${p.name}`);
        const r = await t.spec.execute(p.input as never, makeContext(p.session, t.source));
        return typeof r === "string" ? { content: [{ type: "text", text: r }] } : r;
      }
      case "command.run": {
        const p = params as { session: SessionInfo; name: string; args: string };
        const c = commands.get(p.name);
        if (!c) throw new Error(`plugin host: unknown command /${p.name}`);
        const r = await c.spec.handler(p.args, makeContext(p.session, c.source));
        return typeof r === "string" ? { reply: r } : (r ?? {});
      }
      case "hook.emit": {
        const p = params as { session: SessionInfo; event: HookEvent };
        let merged: Record<string, unknown> | undefined;
        // Handlers run in registration order; each sees the event as modified by earlier ones
        // (input.text, tool_call.input), so plugins compose like middleware.
        let event: Record<string, unknown> = { ...p.event };
        for (const h of hooks.get(p.event.type) ?? []) {
          const r = (await h.handler(event as unknown as HookEvent, makeContext(p.session, h.source))) as Record<string, unknown> | undefined | void;
          if (!r || typeof r !== "object") continue;
          merged = { ...(merged ?? {}) };
          for (const [k, v] of Object.entries(r)) {
            if (v === undefined) continue;
            // accumulate text-ish fields, otherwise last writer wins
            if ((k === "appendSystemPrompt" || k === "instructions" || k === "reason") && typeof merged[k] === "string" && typeof v === "string") merged[k] = `${merged[k]}\n${v}`;
            else merged[k] = v;
          }
          if (p.event.type === "input" && typeof r.text === "string") event = { ...event, text: r.text };
          if (p.event.type === "tool_call" && r.input !== undefined) event = { ...event, input: r.input };
          // decisions that later handlers cannot undo
          if ((p.event.type === "tool_call" && r.block) || (p.event.type === "input" && r.cancel) || (p.event.type === "before_compact" && r.cancel) || (p.event.type === "turn_end" && r.stop)) break;
        }
        return merged ?? null;
      }
      default: throw new Error(`plugin host: unknown method ${method}`);
    }
  },
);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => rpc.feed(c));
process.stdin.on("end", () => process.exit(0));

function makeContext(session: SessionInfo, plugin = "plugin"): PluginContext {
  const call = <T>(method: string, params: Record<string, unknown>) => rpc.call<T>(method, { session, ...params });
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    workspaceId: session.workspaceId,
    plugin,
    session: {
      note: (text) => call("session.note", { plugin, text }).then(() => undefined),
      send: (text) => call("session.send", { text }).then(() => undefined),
      interrupt: () => call("session.interrupt", {}).then(() => undefined),
    },
    sandbox: {
      exec: (command, opts) => call("sandbox.exec", { command, ...opts }),
      readFile: (p, opts) => call("sandbox.readFile", { path: p, ...opts }),
      writeFile: (p, content, opts) => call("sandbox.writeFile", { path: p, content, ...opts }).then(() => undefined),
      envs: () => call("sandbox.envs", {}),
    },
    store: {
      get: (key, scope = "agent") => call("store.get", { key, scope }) as Promise<never>,
      set: (key, value, scope = "agent") => call("store.set", { key, scope, value }).then(() => undefined),
    },
    model: { complete: (prompt, opts) => call("model.complete", { prompt, ...opts }) },
    agent: { run: (task, opts) => call("agent.run", { task, ...opts }) },
    fetch: (url, init) => call("fetch", { url, ...init }),
    log: (...args) => void call("log", { args }).catch(() => {}),
  };
}

function apiFor(source: string): PluginAPI {
  return {
    registerTool(spec) {
      if (tools.has(spec.name)) warnings.push(`${source}: tool ${spec.name} already registered by ${tools.get(spec.name)!.source}; overriding`);
      tools.set(spec.name, { spec: spec as ToolSpec, source });
    },
    registerCommand(spec) {
      if (!/^[a-z][a-z0-9_-]*$/.test(spec.name)) { warnings.push(`${source}: invalid command name /${spec.name}`); return; }
      if (commands.has(spec.name)) warnings.push(`${source}: command /${spec.name} already registered by ${commands.get(spec.name)!.source}; overriding`);
      commands.set(spec.name, { spec, source });
    },
    on(event, handler) {
      const list = hooks.get(event) ?? [];
      list.push({ handler: handler as Handler, source });
      hooks.set(event, list);
    },
  };
}

async function load(packages: PackageManifest[]) {
  for (const pkg of packages) {
    for (const rel of pkg.plugins) {
      const file = path.resolve(pkg.dir, rel);
      const source = pkg.name ?? `${pkg.source}:${rel}`;
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: PluginFactory };
        if (typeof mod.default !== "function") throw new Error("plugin module must default-export a function (api) => void");
        const api = apiFor(source);
        await (pkg.kind === "pi" ? piCompatFactory(mod.default, api, source, warnings) : mod.default(api));
      } catch (e) {
        warnings.push(`${source}: failed to load: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return {
    tools: [...tools.entries()].map(([name, t]) => ({ name, description: t.spec.description, parameters: t.spec.parameters, source: t.source })),
    commands: [...commands.entries()].map(([name, c]) => ({ name, description: c.spec.description, source: c.source })),
    hooks: [...hooks.keys()],
    warnings: warnings.splice(0),
  };
}
