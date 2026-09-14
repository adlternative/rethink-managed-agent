import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginHost, type Capabilities } from "../src/plugins/client.ts";
import type { PackageManifest } from "../src/plugins/api.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = (n: string) => path.join(ROOT, "test/fixtures", n);
const pkg = (dir: string): PackageManifest => ({ dir, source: dir, name: path.basename(dir), kind: "pma", plugins: ["index.ts"], skills: [], prompts: [] });
const sessA = { sessionId: "sess_a", agentId: "agent_m", workspaceId: "ws_a" };
const sessB = { sessionId: "sess_b", agentId: "agent_m", workspaceId: "ws_b" };

/** Capabilities backed by one map; every call not needed here resolves to null. */
function fakeCaps(label: string) {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const caps = new Proxy({} as Capabilities, {
    get: (_t, k) => {
      if (k === "storeGet") return async (key: string) => { calls.push(`get:${key}`); return store.has(key) ? store.get(key) : `${label}:${key}`; };
      if (k === "storeSet") return async (key: string, _scope: string, v: unknown) => { calls.push(`set:${key}`); store.set(key, v); };
      if (k === "log" || k === "sandboxEnvs") return () => [];
      return async () => null;
    },
  });
  return { caps, store, calls };
}

let host: PluginHost;
const main = fakeCaps("A");
beforeAll(async () => {
  host = await PluginHost.start([pkg(FIX("plugins-sandbox-merge-a")), pkg(FIX("plugins-sandbox-merge-b")), pkg(FIX("plugins-sandbox-merge-c"))], { agentId: "agent_m", repoRoot: ROOT });
  host.attach(sessA, main.caps);
}, 30_000);
afterAll(() => host?.stop());
const tool = (name: string, s = sessA) => host.agentTools(s).find((t) => t.name === name)!;

describe("hook.emit merge semantics", () => {
  it("joins appendSystemPrompt / instructions / reason with newlines in registration order", async () => {
    expect((await host.emit(sessA, { type: "context", systemPrompt: "s", messageCount: 1, contextTokens: 1, contextWindow: 10 }))?.appendSystemPrompt).toBe("A-append\nB-append");
    expect((await host.emit(sessA, { type: "before_agent_start", systemPrompt: "s", messageCount: 1, trigger: "t" }))?.appendSystemPrompt).toBe("A-bas\nB-bas");
    expect((await host.emit(sessA, { type: "before_compact", contextTokens: 1, contextWindow: 2, messageCount: 1 }))?.instructions).toBe("A-ins\nB-ins");
    expect((await host.emit(sessA, { type: "tool_call", toolName: "x", toolCallId: "1", input: {} }))?.reason).toBe("A-reason\nB-reason");
  });

  it("a non-accumulating field is last-writer-wins", async () => {
    const r = (await host.emit(sessA, { type: "context", systemPrompt: "s", messageCount: 1, contextTokens: 1, contextWindow: 10 })) as Record<string, unknown>;
    expect(r.foo).toBe("B-foo");
  });

  it("before_compact summary/keepRecentTokens are first-writer-wins; {summary: undefined} does not claim; the loser is warned on stderr", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { writes.push(String(c)); return true; });
    try {
      const r = await host.emit(sessA, { type: "before_compact", contextTokens: 1, contextWindow: 2, messageCount: 1 });
      // A returned summary: undefined, so B (the first real writer) wins over C
      expect(r?.summary).toBe("B-summary");
      expect(r?.keepRecentTokens).toBe(100);
      await vi.waitFor(() => {
        const all = writes.join("");
        expect(all).toMatch(/before_compact\.summary already provided/);
        expect(all).toMatch(/before_compact\.keepRecentTokens already provided/);
      }, { timeout: 3000 });
    } finally { spy.mockRestore(); }
  });

  it("tool_call {block:true} stops later handlers", async () => {
    main.calls.length = 0;
    const r = await host.emit(sessA, { type: "tool_call", toolName: "bash", toolCallId: "1", input: { block: true } });
    expect(r).toEqual({ block: true, reason: "A-block" });
    expect(main.calls.filter((c) => c === "set:tc-seen")).toEqual([]);
  });

  it("input {cancel:true} and turn_end {stop:true} short-circuit", async () => {
    main.calls.length = 0;
    expect(await host.emit(sessA, { type: "input", text: "please cancel", source: "user" })).toEqual({ cancel: true });
    expect(await host.emit(sessA, { type: "turn_end", turn: 99 })).toEqual({ stop: true, reason: "A-stop" });
    expect(main.calls).toEqual([]);
    // without the short-circuit, the second handler does run
    expect(await host.emit(sessA, { type: "turn_end", turn: 1 })).toEqual({ reason: "B-turn" });
    expect(main.store.get("turn-seen")).toBe(1);
  });

  it("later handlers see input text and tool_call input as rewritten by earlier ones", async () => {
    expect(await host.emit(sessA, { type: "input", text: "hello", source: "user" })).toEqual({ text: "HELLO!" });
    expect(main.store.get("input-seen")).toBe("HELLO");
    const r = await host.emit(sessA, { type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "ls" } });
    expect(r?.input).toEqual({ command: "ls", a: 1 });
    expect(main.store.get("tc-seen")).toEqual({ command: "ls", a: 1 });
  });

  it("a throwing handler makes emit reject with its message", async () => {
    await expect(host.emit(sessA, { type: "error", errorType: "x", message: "m1" })).rejects.toThrow("hook exploded: m1");
  });

  it("emit for an event with no handlers resolves null without a round trip", async () => {
    expect(await host.emit(sessA, { type: "session_start", sessionId: "s" })).toBeNull();
  });
});

describe("tool and command results", () => {
  it("an isError result throws with the joined text", async () => {
    await expect(tool("t_iserror").execute("1", {})).rejects.toThrow("bad thing");
  });

  // Regression: host.ts passes an undefined tool result through as null; client.ts then reads r.isError on null.
  it("a tool returning undefined yields empty content or a clear (non-TypeError) error", async () => {
    const r = await tool("t_undefined").execute("1", {}).then((ok) => ({ ok }), (err) => ({ err }));
    if ("err" in r) {
      expect(r.err).not.toBeInstanceOf(TypeError);
      expect(String((r.err as Error).message)).not.toMatch(/Cannot read properties/);
    } else expect(r.ok.content).toEqual([]);
  });

  it("a command returning undefined resolves to {}", async () => {
    expect(await host.runCommand(sessA, "c_undef", "")).toEqual({});
  });

  it("unknown tools and commands reject", async () => {
    const rpc = (host as unknown as { rpc: { call(m: string, p: unknown): Promise<unknown> } }).rpc;
    await expect(rpc.call("tool.execute", { session: sessA, name: "nope", input: {} })).rejects.toThrow(/unknown tool nope/);
    await expect(host.runCommand(sessA, "nope", "")).rejects.toThrow(/unknown command \/nope/);
  });

  it("an invalid command name is a warning and not registered; a duplicate tool warns and the later one wins", async () => {
    expect(host.commands.map((c) => c.name)).toEqual(["c_undef"]);
    expect(host.warnings.some((w) => w.includes("invalid command name /Bad Name"))).toBe(true);
    expect(host.warnings.some((w) => /tool t_dup already registered by plugins-sandbox-merge-a; overriding/.test(w))).toBe(true);
    expect(host.tools.filter((t) => t.name === "t_dup")).toHaveLength(1);
    expect((await tool("t_dup").execute("1", {})).content[0]).toMatchObject({ text: "from B" });
  });
});

describe("serve() session scoping", () => {
  it("rejects capability calls from a session that is not attached, and after unregister", async () => {
    await expect(tool("t_store", sessB).execute("1", {})).rejects.toThrow(/no active session sess_b/);
    const sessC = { sessionId: "sess_c", agentId: "agent_m", workspaceId: "ws_c" };
    const c = fakeCaps("C");
    const off = host.attach(sessC, c.caps);
    expect((await tool("t_store", sessC).execute("1", {})).content[0]).toMatchObject({ text: JSON.stringify("C:k") });
    off();
    await expect(tool("t_store", sessC).execute("2", {})).rejects.toThrow(/no active session sess_c/);
  });

  it("routes each session's calls to its own capabilities", async () => {
    const b = fakeCaps("B");
    const off = host.attach(sessB, b.caps);
    main.calls.length = 0;
    const [ra, rb] = await Promise.all([tool("t_store", sessA).execute("1", {}), tool("t_store", sessB).execute("2", {})]);
    expect(ra.content[0]).toMatchObject({ text: JSON.stringify("A:k") });
    expect(rb.content[0]).toMatchObject({ text: JSON.stringify("B:k") });
    expect(main.calls).toEqual(["get:k"]);
    expect(b.calls).toEqual(["get:k"]);
    off();
  });
});

// Scenarios that crash or wedge the runner side run in a separate node process (see the driver).
const run = promisify(execFile);
async function drive(scenario: string) {
  const { stdout } = await run(process.execPath, ["--no-warnings", FIX("plugins-sandbox-driver/drive.ts"), scenario], { cwd: ROOT, timeout: 30_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error(`driver produced no result: ${stdout}`);
  return JSON.parse(line.slice(7));
}

describe("runner resilience (out of process)", () => {
  // Regression: a plugin's console.log reaches Rpc.feed as a non-JSON line and throws in the stdout listener.
  it("a tool that console.logs still returns 'ok' without an uncaughtException in the runner", async () => {
    const r = await drive("console");
    expect(r.first.ok.content[0].text).toBe("ok");
    expect(r.after.ok).toBeDefined();
    expect(r.uncaught).toEqual([]);
  }, 40_000);

  it("an in-flight call rejects with 'plugin host exited' when the host process exits", async () => {
    const r = await drive("exit");
    expect(r.inflight.err).toMatch(/plugin host exited \(1\)/);
  }, 40_000);

  // Regression: after the host exits, later rpc.call()s write to a dead stdin and never settle.
  it("calls after the host exited reject quickly instead of hanging, with no unhandled errors", async () => {
    const r = await drive("exit");
    expect(r.emit.timeout).toBeUndefined();
    expect(r.emit.err).toMatch(/exited/);
    expect(r.tool.timeout).toBeUndefined();
    expect(r.tool.err).toMatch(/exited/);
    expect(r.uncaught).toEqual([]);
  }, 40_000);

  // Regression: host.ts has no uncaughtException handler, so an async throw kills the host and later calls hang.
  it("an uncaught async throw inside a plugin does not leave later emits hanging", async () => {
    const r = await drive("crash-async");
    expect(r.first.ok.content[0].text).toBe("scheduled");
    expect(r.emit.timeout).toBeUndefined();
  }, 40_000);
});
