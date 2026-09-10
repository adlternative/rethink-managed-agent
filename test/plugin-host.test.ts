import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { PluginHost, type Capabilities } from "../src/plugins/client.ts";
import { loadContent, type PackageManifest } from "../src/plugins/installer.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = (dir: string, extra: Partial<PackageManifest> = {}): PackageManifest => ({ dir, source: dir, kind: "pma", plugins: ["index.ts"], skills: [], prompts: [], ...extra });
const session = { sessionId: "sess_t", agentId: "agent_t", workspaceId: "ws_t" };

let host: PluginHost;
const store = new Map<string, unknown>();
const calls: string[] = [];
const caps: Capabilities = {
  sandboxExec: async (command) => { calls.push(`exec:${command}`); return { stdout: `ran ${command}`, stderr: "", code: 0 }; },
  sandboxRead: async (p) => `content of ${p}`,
  sandboxWrite: async (p) => { calls.push(`write:${p}`); },
  storeGet: async (key, scope) => store.get(`${scope}:${key}`) ?? null,
  storeSet: async (key, scope, value) => { store.set(`${scope}:${key}`, value); },
  modelComplete: async (prompt) => `completed: ${prompt}`,
  agentRun: async (task) => `sub-agent report for: ${task}`,
  fetch: async (url) => ({ status: 200, headers: {}, body: `<html><body><h1>Hello ${url}</h1><script>x()</script></body></html>` }),
  log: (args) => calls.push(`log:${args.join(" ")}`),
};

beforeAll(async () => {
  host = await PluginHost.start(
    [
      pkg(path.join(ROOT, "plugins/goal")),
      pkg(path.join(ROOT, "plugins/fork")),
      pkg(path.join(ROOT, "plugins/safety-net")),
      pkg(path.join(ROOT, "plugins/web-fetch"), { skills: ["skills"] }),
      pkg(path.join(ROOT, "test/fixtures/pi-ext-demo"), { kind: "pi" }),
    ],
    { agentId: "agent_t", repoRoot: ROOT },
  );
  host.attach(session, caps);
}, 30_000);
afterAll(() => host?.stop());

describe("plugin host", () => {
  it("loads pma and pi packages and reports tools/hooks", () => {
    expect(host.tools.map((t) => t.name).sort()).toEqual(["demo_secret", "fork", "goal_progress", "set_goal", "web_fetch"]);
    expect([...host.hooks].sort()).toEqual(["context", "tool_call"]);
    expect(host.warnings).toEqual([]);
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
