/**
 * Hermetic fakes for runSession: an in-memory event log, a scripted model, an in-memory sandbox
 * and a duck-typed plugin host. No DB, Redis, docker or network.
 */
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunDeps, SteerMessage } from "../../../src/harness/run-turn.ts";
import type { Capabilities } from "../../../src/plugins/client.ts";
import type {
  EnvironmentResource, ExecChunk, ExecOptions, Sandbox, SandboxLease, SandboxRequest, SessionEvent, SessionEventPayload, SessionResource, StopReason, StreamDelta, WorkspaceRef, WorkspaceResource,
} from "../../../src/shared/types.ts";

export const T0 = "2026-01-01T00:00:00.000Z";
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function model(contextWindow = 200_000, id = "m", provider = "fake"): Model<any> {
  return { id, name: id, api: "openai-completions", provider, baseUrl: "http://fake", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000 } as Model<any>;
}

export function assistantMsg(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  const hasTool = content.some((c) => c.type === "toolCall");
  return { role: "assistant", content, api: "openai-completions", provider: "fake", model: "m", usage: zeroUsage(), stopReason: hasTool ? "toolUse" : "stop", timestamp: Date.now(), ...extra };
}
export const text = (t: string, extra: Partial<AssistantMessage> = {}) => assistantMsg([{ type: "text", text: t }], extra);
export const call = (id: string, name: string, args: Record<string, unknown>, extra: Partial<AssistantMessage> = {}) => assistantMsg([{ type: "toolCall", id, name, arguments: args }], extra);

/** One model request: what it saw, plus a reply (message, or a function of the signal). */
export interface ModelRequest { model: Model<any>; context: Context; signal?: AbortSignal }
export type Reply = AssistantMessage | ((req: ModelRequest) => AssistantMessage | Promise<AssistantMessage>);

export function fakeModels(replies: Reply[], opts: { models?: Model<any>[] } = {}) {
  const known = opts.models ?? [model()];
  const requests: ModelRequest[] = [];
  const models = {
    getModel: (provider: string, id: string) => known.find((m) => m.provider === provider && m.id === id),
    getModels: () => known,
    complete: async () => text("completion"),
    streamSimple(m: Model<any>, context: Context, options?: { signal?: AbortSignal }) {
      const req = { model: m, context: { ...context, tools: context.tools ? [...context.tools] : undefined, messages: [...context.messages] }, signal: options?.signal };
      requests.push(req);
      // pi-ai reports "error" (not "aborted") when the signal was already aborted before the request started
      const r = options?.signal?.aborted ? assistantMsg([], { stopReason: "error", errorMessage: "Request was aborted" }) : replies.shift() ?? text("(script exhausted)");
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const msg = typeof r === "function" ? await r(req) : r;
        stream.push({ type: "start", partial: { ...msg, content: [] } });
        if (msg.stopReason === "aborted" || msg.stopReason === "error") stream.push({ type: "error", reason: msg.stopReason, error: msg });
        else stream.push({ type: "done", reason: msg.stopReason as "stop", message: msg });
        stream.end();
      })();
      return stream;
    },
  };
  return { models, requests };
}

/** Resolves to an aborted assistant message once the request's signal fires. */
export const waitForAbort: Reply = (req) => new Promise((resolve) => {
  const done = () => resolve(assistantMsg([], { stopReason: "aborted", errorMessage: "aborted" }));
  if (req.signal?.aborted) return done();
  req.signal?.addEventListener("abort", done, { once: true });
});

export type ExecHandler = (cmd: string, opts?: ExecOptions) => AsyncIterable<ExecChunk> | ExecChunk[] | Promise<ExecChunk[]>;

export function memSandbox(id = "sbx_1", exec?: ExecHandler): Sandbox & { files: Map<string, Uint8Array>; execs: { cmd: string; opts?: ExecOptions }[] } {
  const files = new Map<string, Uint8Array>();
  const execs: { cmd: string; opts?: ExecOptions }[] = [];
  return {
    id, provider: "local", workdir: "/work", files, execs,
    async *exec(cmd, opts) {
      execs.push({ cmd, opts });
      const r = exec ? await exec(cmd, opts) : [{ type: "stdout", data: `ran ${cmd}` }, { type: "exit", code: 0 }] as ExecChunk[];
      for await (const c of r as AsyncIterable<ExecChunk>) yield c;
    },
    async readFile(p) { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f; },
    async writeFile(p, d) { files.set(p, d); },
  };
}

export function sessionFixture(over: Partial<SessionResource> = {}, agent: Partial<SessionResource["agent"]> = {}): SessionResource {
  return {
    id: "sess_1", owner_id: "prc_a", agent_id: "agent_1", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, requests: 0 }, context: null,
    environment_id: "env_main", workspace_id: "ws_main", environments: [], parent_id: null, container_group: "sess_1", memory_stores: [], vault_ids: [], status: "idle",
    agent: { id: "agent_1", owner_id: "prc_a", name: "a", model: { provider: "fake", id: "m" }, system: null, tools: ["bash", "read", "write", "edit"], packages: [], skills: [], ...agent },
    created_at: T0, updated_at: T0, ...over,
  };
}

/** Duck-typed PluginHost: hooks are plain functions receiving the session capabilities. */
export interface FakeHostSpec {
  hooks?: Record<string, (ev: any, caps: Capabilities) => unknown>;
  commands?: Record<string, (args: string, caps: Capabilities) => { reply?: string; send?: string } | Promise<{ reply?: string; send?: string }>>;
  tools?: AgentTool[];
}
export function fakeHost(spec: FakeHostSpec) {
  const state: { caps: Capabilities | null; emitted: any[] } = { caps: null, emitted: [] };
  const host = {
    hooks: new Set(Object.keys(spec.hooks ?? {})),
    commands: Object.keys(spec.commands ?? {}).map((name) => ({ name, description: name, source: "fake" })),
    warnings: [] as string[],
    tools: [],
    attach(_info: unknown, caps: Capabilities) { state.caps = caps; return () => { state.caps = null; }; },
    agentTools: () => spec.tools ?? [],
    async emit(_info: unknown, ev: any) { state.emitted.push(ev); const h = spec.hooks?.[ev.type]; return h ? ((await h(ev, state.caps!)) ?? null) : null; },
    async runCommand(_info: unknown, name: string, args: string) { return spec.commands![name]!(args, state.caps!); },
    stop() {},
  };
  return { host, state };
}

export interface FakeOpts {
  session?: SessionResource;
  events?: SessionEventPayload[];
  replies?: Reply[];
  models?: Model<any>[];
  exec?: ExecHandler;
  host?: ReturnType<typeof fakeHost>["host"];
  environments?: Record<string, EnvironmentResource>;
  workspaces?: Record<string, WorkspaceResource>;
}

export function envFixture(id = "env_main", over: Partial<EnvironmentResource> = {}): EnvironmentResource {
  return { id, owner_id: "prc_a", name: id, provider: "local", image: null, network: "none", plugin_host: "runner", workspace: { kind: "empty" }, created_at: T0, ...over };
}
export function wsFixture(id = "ws_main", ref: WorkspaceRef = { kind: "empty" }): WorkspaceResource {
  return { id, owner_id: "prc_a", spec: { kind: "empty" }, ref, created_at: T0, updated_at: T0 };
}

/** A complete fake RunDeps; every field can be overridden after construction. */
export function fakeDeps(o: FakeOpts = {}) {
  const session = o.session ?? sessionFixture();
  const log: SessionEvent[] = [];
  const logs = new Map<string, SessionEvent[]>([[session.id, log]]);
  const logOf = (sid: string) => { let l = logs.get(sid); if (!l) { l = []; logs.set(sid, l); } return l; };
  let nextSeq = 1;
  const appendTo = (sid: string, payloads: SessionEventPayload[]) => payloads.map((payload) => {
    const e: SessionEvent = { id: `evt_${nextSeq}`, session_id: sid, seq: nextSeq++, type: payload.type, payload, created_at: T0 };
    logOf(sid).push(e);
    return e;
  });
  for (const p of o.events ?? []) appendTo(session.id, [p]);
  const { models, requests } = fakeModels(o.replies ?? [], { models: o.models });
  const sandboxes: ReturnType<typeof memSandbox>[] = [];
  const acquires: SandboxRequest[] = [];
  const released: string[] = [];
  const published: StreamDelta[] = [];
  const steer: SteerMessage[] = [];
  const interruptHandlers: (() => void)[] = [];
  let unsubscribed = 0;
  const finishCalls: { stopReason: StopReason; consumedSeq: number }[] = [];
  const usage: unknown[] = [];
  const prompts: string[] = [];
  const sessions = new Map<string, SessionResource>([[session.id, session]]);
  const environments: Record<string, EnvironmentResource> = { env_main: envFixture(), ...o.environments };
  const workspaces: Record<string, WorkspaceResource> = { ws_main: wsFixture(), ...o.workspaces };
  const sandboxService = {
    acquire: async (req: SandboxRequest): Promise<SandboxLease> => {
      acquires.push(req);
      const sb = memSandbox(`sbx_${req.environmentId}`, o.exec);
      sandboxes.push(sb);
      return { sandbox: sb, origin: "created", release: async () => { released.push(sb.id); } };
    },
    capture: async (_sb: Sandbox, _prev: WorkspaceRef): Promise<WorkspaceRef> => ({ kind: "dir", path: "/captured" }),
  };
  const deps: RunDeps = {
    models: models as unknown as RunDeps["models"],
    sandboxFor: () => sandboxService,
    children: {
      spawn: async () => { throw new Error("no children"); },
      wait: async (id) => sessions.get(id)!,
      list: async (parentId) => [...sessions.values()].filter((s) => s.parent_id === parentId),
      message: async () => {},
      stop: async () => {},
    },
    pluginsFor: async () => ({ manifests: o.host ? [{ name: "fake" } as never] : [], skills: [], prompts: [], runnerHost: async () => o.host as never, bundle: async () => { throw new Error("no bundle"); } }),
    pluginStore: { get: async () => null, set: async () => {} },
    principalFetchAllow: async () => "*",
    vaultSecrets: async () => ({}),
    awaitToolResult: async () => null,
    appendEvents: async (sid, payloads) => appendTo(sid, payloads),
    listEvents: async (sid) => [...logOf(sid)],
    publish: (d) => { published.push(d); },
    onInterrupt: (_sid, h) => { interruptHandlers.push(h); return () => { unsubscribed++; }; },
    popSteer: async () => steer.splice(0),
    pushSteer: async (sid, t) => { const [e] = appendTo(sid, [{ type: "user.message", content: [{ type: "text", text: t }] }]); steer.push({ seq: e!.seq, content: [{ type: "text", text: t }] }); },
    getSession: async (id) => sessions.get(id) ?? null,
    getWorkspace: async (id) => workspaces[id] ?? null,
    getEnvironment: async (id) => environments[id] ?? null,
    updateWorkspaceRef: async () => true,
    claimRun: async (sid) => appendTo(sid, [{ type: "session.status_running" }]),
    finishRun: async (sid, stopReason, consumedSeq) => {
      finishCalls.push({ stopReason, consumedSeq });
      return { events: appendTo(sid, [{ type: "session.status_idle", stop_reason: stopReason }]), unconsumedSeq: null };
    },
    recordUsage: async (_sid, u, c) => { usage.push({ usage: u, context: c }); return { ...u, requests: 1 } as never; },
    recordSystemPrompt: async (_sid, p) => { prompts.push(p); },
    files: { get: async () => null },
    getSkills: async () => [],
    getMemoryStores: async () => [],
    updateMemoryRef: async () => {},
    toolOutputs: { put: async () => {}, get: async () => null },
  };
  const types = () => log.map((e) => e.type);
  const payloads = <K extends SessionEventPayload["type"]>(type: K) => log.filter((e) => e.type === type).map((e) => e.payload as Extract<SessionEventPayload, { type: K }>);
  return {
    deps, session, sessions, log, logOf, appendTo, requests, sandboxes, acquires, released, published, steer, interruptHandlers, finishCalls, usage, prompts, types, payloads,
    environments, workspaces, sandboxService,
    get unsubscribed() { return unsubscribed; },
    interrupt: () => interruptHandlers.forEach((h) => h()),
  };
}

export const userMsg = (t: string): SessionEventPayload => ({ type: "user.message", content: [{ type: "text", text: t }] });
export const toolNames = (req: ModelRequest) => (req.context.tools ?? []).map((t) => t.name);
