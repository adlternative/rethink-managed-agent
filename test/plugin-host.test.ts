import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { PluginHost, type Capabilities } from "../src/plugins/client.ts";
import { loadContent, type PackageManifest } from "../src/plugins/installer.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = (dir: string, extra: Partial<PackageManifest> = {}): PackageManifest => ({ dir, source: dir, name: path.basename(dir), kind: "pma", plugins: ["index.ts"], skills: [], prompts: [], ...extra });
const session = { sessionId: "sess_t", agentId: "agent_t", workspaceId: "ws_t" };

let host: PluginHost;
const store = new Map<string, unknown>();
const calls: string[] = [];
const caps: Capabilities = {
  sandboxExec: async (command) => { calls.push(`exec:${command}`); return { stdout: `ran ${command}`, stderr: "", code: 0 }; },
  sandboxRead: async (p) => `content of ${p}`,
  sandboxWrite: async (p) => { calls.push(`write:${p}`); },
  sandboxEnvs: () => ["main"],
  storeGet: async (key, scope) => store.get(`${scope}:${key}`) ?? null,
  storeSet: async (key, scope, value) => { store.set(`${scope}:${key}`, value); },
  modelComplete: async (prompt) => `completed: ${prompt}`,
  agentRun: async (task) => `sub-agent report for: ${task}`,
  fetch: async (url) => ({ status: 200, headers: {}, body: `<html><body><h1>Hello ${url}</h1><script>x()</script></body></html>` }),
  log: (args) => calls.push(`log:${args.join(" ")}`),
  sessionNote: async (plugin, text) => { calls.push(`note:${plugin}:${text}`); },
  agentsSpawn: async (task, o) => { calls.push(`spawn:${o.role ?? "-"}:${task.slice(0, 20)}`); return { sessionId: `sess_c${calls.length}`, role: o.role as string | undefined }; },
  agentsWait: async (child) => ({ sessionId: child, status: "idle", finished: true, stopReason: "end_turn", lastReport: `report from ${child}`, updates: [] }),
  agentsStatus: async (child) => ({ sessionId: child, status: "idle", finished: true, updates: [] }),
  agentsSteer: async (child, text) => { calls.push(`steer:${child}:${text}`); },
  agentsReply: async () => {},
  agentsStop: async () => {},
  agentsList: async () => [],
  agentsPatch: async () => null,
  sessionSend: async (text) => { calls.push(`send:${text}`); },
  sessionInterrupt: async () => { calls.push("interrupt"); },
  sessionSetModel: async (model) => { calls.push(`setModel:${model}`); return { model }; },
  sessionSetActiveTools: async (names) => { calls.push(`setTools:${names.join(",")}`); return { active: names }; },
};

beforeAll(async () => {
  host = await PluginHost.start(
    [
      pkg(path.join(ROOT, "plugins/goal")),
      pkg(path.join(ROOT, "plugins/fork")),
      pkg(path.join(ROOT, "plugins/safety-net")),
      pkg(path.join(ROOT, "plugins/web-fetch"), { skills: ["skills"] }),
      pkg(path.join(ROOT, "plugins/team")),
      pkg(path.join(ROOT, "plugins/workflow")),
      pkg(path.join(ROOT, "test/fixtures/pi-ext-demo"), { kind: "pi" }),
    ],
    { agentId: "agent_t", repoRoot: ROOT },
  );
  host.attach(session, caps);
}, 30_000);
afterAll(() => host?.stop());

describe("plugin host", () => {
  it("loads pma and pi packages and reports tools/commands/hooks", () => {
    expect(host.tools.map((t) => t.name).sort()).toEqual(["agent_patch", "demo_secret", "fork", "goal_progress", "list_agents", "message_agent", "run_workflow", "set_goal", "spawn_agent", "wait_agents", "web_fetch"]);
    expect(host.commands.map((c) => c.name).sort()).toEqual(["goal", "team"]);
    expect([...host.hooks].sort()).toEqual(["before_agent_start", "context", "session_end", "tool_call"]);
    expect(host.warnings).toEqual([]);
  });

  it("dispatches slash commands and lets hooks talk to the session", async () => {
    expect(await host.runCommand(session, "goal", "")).toMatchObject({ reply: expect.stringContaining("No goal set") });
    const r = await host.runCommand(session, "goal", "ship v1");
    expect(r.reply).toContain("Goal noted");
    expect(r.send).toContain("set_goal");
    // hooks can post notes through ctx.session
    await host.emit(session, { type: "before_agent_start", systemPrompt: "s", messageCount: 1, trigger: "x" });
    expect(calls.some((c) => c.startsWith("note:") && c.includes("working toward"))).toBe(false); // no goal in store yet
    const tools = Object.fromEntries(host.agentTools(session).map((t) => [t.name, t]));
    await tools.set_goal!.execute("g", { goal: "ship v1", steps: ["a"] });
    await host.emit(session, { type: "before_agent_start", systemPrompt: "s", messageCount: 1, trigger: "x" });
    expect(calls.some((c) => c.includes("note:") && c.includes("working toward: ship v1"))).toBe(true);
  });

  it("runs tools through capabilities (store, agent, fetch)", async () => {
    const tools = Object.fromEntries(host.agentTools(session).map((t) => [t.name, t]));
    expect((await tools.set_goal!.execute("1", { goal: "ship", steps: ["a", "b"] })).content[0]).toMatchObject({ text: "goal set with 2 steps" });
    expect((await tools.goal_progress!.execute("2", { done_steps: [0] })).content[0]).toMatchObject({ text: "remaining: b" });
    expect((await tools.fork!.execute("3", { task: "look around" })).content[0]).toMatchObject({ text: "sub-agent report for: look around" });
    expect((await tools.web_fetch!.execute("4", { url: "https://example.com" })).content[0]!.text).toBe("HTTP 200\nHello https://example.com");
    expect((await tools.demo_secret!.execute("5", { name: "adl" })).content[0]).toMatchObject({ text: "secret-code-for-adl: PI-EXT-OK" });
  });

  it("context hook injects the goal; tool_call hooks block (pma safety-net and pi compat)", async () => {
    const c = await host.emit(session, { type: "context", systemPrompt: "base", messageCount: 1 });
    expect(c?.appendSystemPrompt).toContain("## Current goal");
    expect(c?.appendSystemPrompt).toContain("[x] 0. a");
    expect(await host.emit(session, { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command: "rm -rf / --no-preserve-root" } })).toMatchObject({ block: true });
    expect(await host.emit(session, { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command: "echo BLOCKME" } })).toMatchObject({ block: true });
    expect(await host.emit(session, { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command: "ls" } })).toBeNull();
  });

  it("team + workflow plugins orchestrate children through ctx.agents", async () => {
    const tools = Object.fromEntries(host.agentTools(session).map((t) => [t.name, t]));
    expect((await tools.spawn_agent!.execute("1", { role: "explorer", task: "look around" })).content[0]!.text).toMatch(/spawned explorer sess_c/);
    expect(calls.some((c) => c.startsWith("spawn:explorer:"))).toBe(true);
    const wf = await tools.run_workflow!.execute("2", { script: `export const meta = { name: "t" }
      phase("Review")
      const r = await parallel([() => agent("a", { role: "reviewer" }), () => agent("b", { role: "reviewer" })])
      log("two done")
      return r.map((x) => String(x).slice(0, 11))` });
    expect(wf.content[0]!.text).toContain("report from");
    expect(wf.content[0]!.text).toContain("── Review ──");
    expect(wf.content[0]!.text).toContain("two done");
    await expect(tools.run_workflow!.execute("3", { script: `return Date.now()` })).rejects.toThrow(/Date.now\(\) is not allowed/);
    // pipeline(): each item flows through both stages; the mock returns "report from <child>"
    const pl = await tools.run_workflow!.execute("4", { script: `export const meta = { name: "p" }
      const out = await pipeline([1, 2], (n) => agent("draft " + n), (rep, n) => agent("verify " + n + ": " + rep))
      return out.map((x) => String(x).slice(0, 11))`, args: undefined, max_agents: 10 });
    expect(pl.content[0]!.text).toContain("report from");
  });

  it("host cannot touch the filesystem, spawn processes, or reach the network", async () => {
    // a throwaway plugin that tries to escape; loaded into a second host
    const escape = await PluginHost.start([pkg(path.join(ROOT, "test/fixtures/pma-escape"))], { agentId: "agent_e", repoRoot: ROOT });
    escape.attach(session, caps);
    const t = Object.fromEntries(escape.agentTools(session).map((x) => [x.name, x]));
    const r = await t.escape!.execute("1", {});
    expect(r.content[0]!.text).toMatch(/write:ERR_ACCESS_DENIED/);
    expect(r.content[0]!.text).toMatch(/spawn:blocked/); // child_process cannot even be resolved
    expect(r.content[0]!.text).toMatch(/fetch:blocked/);
    expect(r.content[0]!.text).toMatch(/http:blocked/);
    expect(r.content[0]!.text).toMatch(/net:blocked/);
    expect(r.content[0]!.text).toMatch(/readrepo:ERR_ACCESS_DENIED/); // repo root is not readable, only src/plugins + typebox + package dirs
    escape.stop();
  }, 30_000);

  it("loads skills from packages", async () => {
    const { skills } = await loadContent([pkg(path.join(ROOT, "plugins/web-fetch"), { skills: ["skills"] })]);
    expect(skills.map((s) => s.name)).toEqual(["web-research"]);
    expect(skills[0]!.body).toContain("primary sources");
  });
});

describe("runtime switches (setModel / setActiveTools)", () => {
  it("routes ctx.session.setModel / setActiveTools through capabilities", async () => {
    const h = await PluginHost.start([pkg(path.join(ROOT, "test/fixtures/pma-runtime"))], { agentId: "agent_rt", repoRoot: ROOT });
    h.attach(session, caps);
    const t = Object.fromEntries(h.agentTools(session).map((x) => [x.name, x]));
    const r = await t.escalate!.execute("1", { model: "qoder/ultimate", tools: ["bash", "read"] });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ model: "qoder/ultimate", active: ["bash", "read"] });
    expect(calls).toContain("setModel:qoder/ultimate");
    expect(calls).toContain("setTools:bash,read");
    h.stop();
  }, 30_000);
});

describe("tool_result structured content", () => {
  it("passes blocks through, preserves images, and composes as middleware", async () => {
    const h = await PluginHost.start([pkg(path.join(ROOT, "test/fixtures/pma-toolresult"))], { agentId: "agent_tr", repoRoot: ROOT });
    h.attach(session, caps);
    const r = await h.emit(session, {
      type: "tool_result", toolName: "bash", toolCallId: "t1", input: {},
      content: [{ type: "text", text: "the SECRET is 42" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false,
    }) as { content: any[] };
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text);
    expect(text[0]).toBe("the [redacted] is 42");            // handler A rewrote the text block
    expect(r.content.some((b) => b.type === "image" && b.data === "AAAA")).toBe(true); // image survived untouched
    expect(text).toContain("seen:the [redacted] is 42");     // handler B saw A's edit (chaining)
    h.stop();
  }, 30_000);
});

describe("starter template", () => {
  it("loads and registers a tool, a command, and hooks", async () => {
    const h = await PluginHost.start([pkg(path.join(ROOT, "plugins/_template"))], { agentId: "agent_tpl", repoRoot: ROOT });
    h.attach(session, caps);
    expect(h.warnings).toEqual([]);
    expect(h.tools.map((t) => t.name)).toContain("template_echo");
    expect(h.commands.map((c) => c.name)).toContain("template");
    expect([...h.hooks].sort()).toEqual(["before_compact", "tool_call"]);
    const t = Object.fromEntries(h.agentTools(session).map((x) => [x.name, x]));
    expect((await t.template_echo!.execute("1", { message: "hi" })).content[0]).toMatchObject({ text: "echo: hi" });
    h.stop();
  }, 30_000);
});

describe("before_compact override hook (custom compaction)", () => {
  it("lets a plugin supply the summary, and enforces single-owner (first plugin wins)", async () => {
    const events = [
      { seq: 1, type: "user.message", payload: { content: [{ type: "text", text: "build the thing" }] } },
      { seq: 2, type: "agent.message", payload: { content: [{ type: "text", text: "done, edited app.ts" }] } },
    ];
    // the plugin only accepts a reply shaped like a briefing (see fix-compactor-plugin), so the fake
    // summarizer answers with one
    const capsC: Capabilities = { ...caps, eventsGet: async () => events, modelComplete: async (prompt) => `## Decisions\n— STRUCTURED[${prompt.length}]` };
    // compactor is registered before pma-compact-two, so its summary must win.
    const h = await PluginHost.start(
      [pkg(path.join(ROOT, "plugins/compactor")), pkg(path.join(ROOT, "test/fixtures/pma-compact-two"))],
      { agentId: "agent_c", repoRoot: ROOT },
    );
    h.attach(session, capsC);
    expect([...h.hooks]).toContain("before_compact");
    const r = await h.emit(session, { type: "before_compact", contextTokens: 9000, contextWindow: 10000, messageCount: 2 });
    expect(r?.summary).toMatch(/STRUCTURED\[/); // compactor's own model summary, not "SECOND-PLUGIN-SUMMARY"
    expect(r?.summary).not.toBe("SECOND-PLUGIN-SUMMARY");
    h.stop();
  }, 30_000);

  it("falls back to the built-in summarizer when the plugin cannot summarize", async () => {
    const capsC: Capabilities = { ...caps, eventsGet: async () => [], modelComplete: async () => "" };
    const h = await PluginHost.start([pkg(path.join(ROOT, "plugins/compactor"))], { agentId: "agent_c2", repoRoot: ROOT });
    h.attach(session, capsC);
    const r = await h.emit(session, { type: "before_compact", contextTokens: 9000, contextWindow: 10000, messageCount: 0 });
    expect(r?.summary).toBeUndefined(); // no events -> undefined -> harness runs its own summarizer
    h.stop();
  }, 30_000);
});

describe("plugin host inside a sandbox", () => {
  it("runs the bundle with the sandbox's node; plugins may use fs/net directly there", async () => {
    const { buildHostBundle } = await import("../src/plugins/bundle.ts");
    const { spawnProcess } = await import("../src/sandbox/exec.ts");
    const { mkdtemp, readFile: rf, writeFile: wf, mkdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    // a stand-in Sandbox backed by a temp dir on this machine (what LocalProvider does, minus the DB)
    const workdir = await mkdtemp(path.join(os.tmpdir(), "sbx-host-"));
    const sandbox = {
      id: "sbx_test", provider: "local" as const, workdir,
      async *exec(cmd: string) { try { const { stdout } = await run("bash", ["-lc", cmd], { cwd: workdir }); yield { type: "stdout" as const, data: stdout }; yield { type: "exit" as const, code: 0 }; } catch (e: any) { yield { type: "stderr" as const, data: String(e.stderr ?? e.message) }; yield { type: "exit" as const, code: e.code ?? 1 }; } },
      async readFile(p: string) { return new Uint8Array(await rf(path.resolve(workdir, p))); },
      async writeFile(p: string, data: Uint8Array) { const abs = path.resolve(workdir, p); await mkdir(path.dirname(abs), { recursive: true }); await wf(abs, data); },
      async spawn(cmd: string, opts: { env?: Record<string, string> } = {}) { return spawnProcess("bash", ["-lc", cmd], { cwd: workdir, env: { ...process.env, ...opts.env } }); },
      // note: writeFile above is workspace-confined like the real providers, so the bundle must go via spawn
    };
    const bundle = await buildHostBundle([pkg(path.join(ROOT, "test/fixtures/pma-escape"))], ROOT);
    expect(bundle.manifests[0]!.dir).toMatch(/^\/tmp\/pma-host\/[^/]+\/packages\//); // one dir per bundle
    const host = await PluginHost.startInSandbox(sandbox, bundle, { agentId: "agent_s" });
    host.attach(session, caps);
    const t = Object.fromEntries(host.agentTools(session).map((x) => [x.name, x]));
    const text = (await t.escape!.execute("1", {})).content[0]!.text;
    // inside the sandbox there is no permission model / lockdown: the sandbox is the boundary
    expect(text).toMatch(/write:OK/);
    expect(text).toMatch(/http:OK/);
    expect(text).toMatch(/net:OK/);
    host.stop();
  }, 60_000);
});
