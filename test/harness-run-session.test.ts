import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runSession } from "../src/harness/run-turn.ts";
import { foldEvents as foldAny, type Folded } from "../src/harness/fold.ts";
import { findCut } from "../src/harness/compaction.ts";
import { env } from "../src/shared/env.ts";
import type { Capabilities } from "../src/plugins/client.ts";
import type { ExecChunk, SessionEvent, SessionEventPayload } from "../src/shared/types.ts";
import {
  assistantMsg, call, envFixture, fakeDeps, fakeHost, model, sessionFixture, text, toolNames, userMsg, waitForAbort, wsFixture, type FakeHostSpec, type Reply,
} from "./fixtures/harness-fakes/deps.ts";

const foldEvents = foldAny as unknown as (events: SessionEvent[]) => Folded;
const saved = { ...env };
afterEach(() => { Object.assign(env, saved); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lastUserText = (req: { context: { messages: any[] } }) => {
  const u = [...req.context.messages].reverse().find((m) => m.role === "user");
  return u ? (typeof u.content === "string" ? u.content : u.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")) : undefined;
};
const eventText = (p: { content: { type: string; text?: string }[] }) => p.content.map((c) => c.text ?? "").join("");

/** A session whose plugin runs `probe(caps)` in session_start; results/errors are collected. */
function probing(probe: (caps: Capabilities) => Promise<unknown>, spec: FakeHostSpec = {}) {
  const results: { ok?: unknown; err?: string }[] = [];
  const h = fakeHost({ ...spec, hooks: { ...spec.hooks, session_start: async (_e, caps) => { try { results.push({ ok: await probe(caps) }); } catch (e) { results.push({ err: (e as Error).message }); } } } });
  return { ...h, results };
}

describe("runSession baseline", () => {
  it("runs user -> bash tool call -> tool result -> final text with the full event lifecycle", async () => {
    const f = fakeDeps({ events: [userMsg("list files")], replies: [call("c1", "bash", { command: "ls" }), text("done")] });
    const out = await runSession("sess_1", f.deps);
    expect(out).toEqual({ status: "done", stopReason: "end_turn", unconsumedSeq: null });
    // the sandbox is leased lazily, when bash first needs it (after agent.tool_use)
    expect(f.types()).toEqual([
      "user.message", "session.status_running", "agent.message", "agent.tool_use", "sandbox.acquired", "agent.tool_result", "agent.message",
      "workspace.captured", "sandbox.released", "session.status_idle",
    ]);
    const [tr] = f.payloads("agent.tool_result");
    expect(tr!.tool_use_id).toBe("c1");
    expect(tr!.is_error).toBe(false);
    expect(tr!.content[0]).toMatchObject({ text: "ran ls" });
    expect(f.finishCalls).toEqual([{ stopReason: "end_turn", consumedSeq: 2 }]);
    expect(f.released).toEqual(["sbx_env_main"]);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.context.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(f.prompts).toHaveLength(1);
    expect(f.unsubscribed).toBe(1);
    // every event appended by the run is published exactly once
    const pubSeqs = f.published.flatMap((d) => (d.type === "event" ? [d.event.seq] : []));
    expect(pubSeqs.sort((a, b) => a - b)).toEqual(f.log.filter((e) => e.seq > 1).map((e) => e.seq));
  });

  it("returns busy without running when another run owns the session", async () => {
    const f = fakeDeps({ events: [userMsg("hi")] });
    f.deps.claimRun = async () => null;
    expect(await runSession("sess_1", f.deps)).toEqual({ status: "busy" });
    expect(f.unsubscribed).toBe(1);
    expect(f.requests).toHaveLength(0);
    expect(f.finishCalls).toHaveLength(0);
  });

  it("a pure chat run never acquires a sandbox", async () => {
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("hello")] });
    await runSession("sess_1", f.deps);
    expect(f.acquires).toHaveLength(0);
    expect(f.types()).not.toContain("sandbox.acquired");
    expect(f.types()).not.toContain("workspace.captured");
  });

  it("a log ending in an assistant message ends quietly without a model call", async () => {
    const f = fakeDeps({ events: [userMsg("hi"), { type: "agent.message", content: [{ type: "text", text: "hello" }], pi: text("hello") }] });
    expect(await runSession("sess_1", f.deps)).toMatchObject({ stopReason: "end_turn" });
    expect(f.requests).toHaveLength(0);
    expect(f.finishCalls).toHaveLength(1);
  });
});

describe("runSession setModel / setActiveTools", () => {
  it("setActiveTools in session_start narrows the FIRST model request (regression: initial context uses `tools`)", async () => {
    const h = fakeHost({ hooks: { session_start: async (_e, caps) => { await caps.sessionSetActiveTools(["read"]); } } });
    const f = fakeDeps({ events: [userMsg("delete build/")], replies: [text("ok")], host: h.host });
    await runSession("sess_1", f.deps);
    expect(toolNames(f.requests[0]!)).toEqual(["read"]);
  });

  it("setActiveTools mid-run narrows from the next request and ignores unknown names", async () => {
    let result: unknown;
    const h = fakeHost({ hooks: { turn_end: async (_e, caps) => { result ??= await caps.sessionSetActiveTools(["read", "does_not_exist"]); } } });
    const f = fakeDeps({ events: [userMsg("go")], replies: [call("c1", "bash", { command: "ls" }), text("ok")], host: h.host });
    await runSession("sess_1", f.deps);
    expect(toolNames(f.requests[0]!)).toContain("bash");
    expect(toolNames(f.requests[1]!)).toEqual(["read"]);
    expect(result).toEqual({ active: ["read"] });
    expect(f.payloads("plugin.message").some((p) => p.plugin === "runtime" && eventText(p) === "active tools: read")).toBe(true);
  });

  it("setModel rejects malformed and unknown refs; a slash in the id is kept and applies on the next turn", async () => {
    const errors: string[] = [];
    let switched: unknown;
    const h = fakeHost({
      hooks: {
        session_start: async (_e, caps) => {
          for (const ref of ["bad", "fake/unknown"]) await caps.sessionSetModel(ref).catch((e) => errors.push((e as Error).message));
        },
        turn_end: async (_e, caps) => { switched ??= await caps.sessionSetModel("fake/id/with/slash"); },
      },
    });
    const f = fakeDeps({ events: [userMsg("go")], replies: [call("c1", "bash", { command: "ls" }), text("ok")], host: h.host, models: [model(), model(100_000, "id/with/slash")] });
    await runSession("sess_1", f.deps);
    expect(errors[0]).toMatch(/provider\/id/);
    expect(errors[1]).toMatch(/Unknown model fake\/unknown/);
    expect(switched).toEqual({ model: "fake/id/with/slash" });
    expect(f.requests[0]!.model.id).toBe("m");
    expect(f.requests[1]!.model.id).toBe("id/with/slash");
  });
});

describe("runSession steering", () => {
  const steerOnce = (f: ReturnType<typeof fakeDeps>, items: { seq: number; content: any[] }[]) => {
    let first = true;
    f.deps.popSteer = async () => { if (!first) return []; first = false; return items; };
  };

  it("drops stale steers (seq <= lastSeq), injects fresh ones and reports the max consumed seq", async () => {
    const f = fakeDeps({ events: [userMsg("start")], replies: [text("ok")] });
    steerOnce(f, [{ seq: 1, content: [{ type: "text", text: "stale" }] }, { seq: 50, content: [{ type: "text", text: "fresh" }] }]);
    await runSession("sess_1", f.deps);
    const texts = f.requests[0]!.context.messages.filter((m) => m.role === "user").map((m: any) => m.content[0].text);
    expect(texts).toEqual(["start", "fresh"]);
    expect(f.finishCalls[0]!.consumedSeq).toBe(50);
  });

  it("an input hook can cancel (still consumed) or rewrite a steer", async () => {
    const h = fakeHost({ hooks: { input: (e) => (e.source !== "steer" ? undefined : e.text === "drop me" ? { cancel: true } : { text: e.text.toUpperCase() }) } });
    const f = fakeDeps({ events: [userMsg("start")], replies: [text("ok")], host: h.host });
    steerOnce(f, [{ seq: 40, content: [{ type: "text", text: "drop me" }] }, { seq: 41, content: [{ type: "text", text: "shout" }] }]);
    await runSession("sess_1", f.deps);
    const texts = f.requests[0]!.context.messages.filter((m) => m.role === "user").map((m: any) => m.content[0].text);
    expect(texts).toEqual(["start", "SHOUT"]);
    expect(f.finishCalls[0]!.consumedSeq).toBe(41);
  });

  it("keeps image blocks of a steered message (regression: textBlocks drops them)", async () => {
    const f = fakeDeps({ events: [userMsg("start")], replies: [text("ok")] });
    f.deps.files = { get: async () => ({ name: "a.png", mime: "image/png", data: new Uint8Array([1, 2, 3]) }) };
    steerOnce(f, [{ seq: 60, content: [{ type: "text", text: "look" }, { type: "image", source: { type: "file", file_id: "file_img" } }] }]);
    await runSession("sess_1", f.deps);
    const steered = f.requests[0]!.context.messages.at(-1) as any;
    expect(steered.content.map((c: any) => c.type)).toContain("image");
  });
});

describe("runSession failures before the loop", () => {
  it("vaultSecrets rejecting after claimRun still finishes the run with an error and unsubscribes (regression: outside try/finally)", async () => {
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.vaultSecrets = async () => { throw new Error("decrypt failed"); };
    await runSession("sess_1", f.deps).catch(() => {});
    expect(f.finishCalls.map((c) => c.stopReason)).toEqual(["error"]);
    expect(f.payloads("session.error").some((p) => p.error.message.includes("decrypt failed"))).toBe(true);
    expect(f.unsubscribed).toBe(1);
  });

  it("publish throwing on the claimed events still finishes the run (regression: outside try/finally)", async () => {
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")] });
    const orig = f.deps.publish;
    f.deps.publish = (d) => { if (d.type === "event" && d.event.type === "session.status_running") throw new Error("bus down"); return orig(d); };
    await runSession("sess_1", f.deps).catch(() => {});
    expect(f.finishCalls).toHaveLength(1);
    expect(f.unsubscribed).toBe(1);
  });

  it("an exception inside the loop becomes session.error + stopReason error and the run is finished", async () => {
    const f = fakeDeps({ events: [userMsg("hi")] });
    f.deps.pluginsFor = async () => { throw new Error("plugin install failed"); };
    const out = await runSession("sess_1", f.deps);
    expect(out).toMatchObject({ stopReason: "error" });
    expect(f.payloads("session.error")).toEqual([{ type: "session.error", error: { type: "Error", message: "plugin install failed" } }]);
    expect(f.unsubscribed).toBe(1);
  });
});

describe("runSession interrupt and timeout", () => {
  it("an interrupt during a bash exec stops with 'interrupted' and still captures + releases", async () => {
    const f = fakeDeps({
      events: [userMsg("build")],
      replies: [call("c1", "bash", { command: "make" }), text("never")],
      exec: (_cmd, opts) => (async function* (): AsyncGenerator<ExecChunk> {
        f.interrupt();
        if (!opts?.signal?.aborted) await new Promise((r) => opts?.signal?.addEventListener("abort", r, { once: true }));
        yield { type: "exit", code: 137 };
      })(),
    });
    const out = await runSession("sess_1", f.deps);
    expect(out).toMatchObject({ stopReason: "interrupted" });
    expect(f.types()).toContain("workspace.captured");
    expect(f.released).toEqual(["sbx_env_main"]);
    expect(f.payloads("session.error")).toEqual([]);
  });

  it("RUN_TIMEOUT_MS during a streaming response stops with 'error' and exactly one run_timeout error", async () => {
    env.RUN_TIMEOUT_MS = 30;
    const f = fakeDeps({ events: [userMsg("think hard")], replies: [waitForAbort] });
    const out = await runSession("sess_1", f.deps);
    expect(out).toMatchObject({ stopReason: "error" });
    expect(f.payloads("session.error").map((p) => p.error.type)).toEqual(["run_timeout"]);
  });

  it("report_to_parent kind=question ends the child's turn as end_turn (regression: aborted next request turns it into 'interrupted')", async () => {
    const f = fakeDeps({ session: sessionFixture({ parent_id: "sess_parent" }), events: [userMsg("task")], replies: [call("q1", "report_to_parent", { kind: "question", text: "which db?" }), waitForAbort] });
    const out = await runSession("sess_1", f.deps);
    expect(f.payloads("agent.thread_message_sent")[0]).toMatchObject({ kind: "question", to_session_id: "sess_parent" });
    expect(out).toMatchObject({ stopReason: "end_turn" });
  });

  it("an interrupt arriving after the loop finished is ignored", async () => {
    const f = fakeDeps({ events: [userMsg("go")], replies: [call("c1", "bash", { command: "ls" }), text("done")] });
    const cap = f.sandboxService.capture;
    f.sandboxService.capture = async (sb, prev) => { f.interrupt(); return cap(sb, prev); };
    const out = await runSession("sess_1", f.deps);
    expect(out).toMatchObject({ stopReason: "end_turn" });
    expect(f.finishCalls[0]!.stopReason).toBe("end_turn");
  });
});

describe("runSession sandbox leases", () => {
  const twoEnvSession = () => sessionFixture({
    environments: [{ key: "main", environment_id: "env_main", workspace_id: "ws_main" }, { key: "db", environment_id: "env_db", workspace_id: "ws_db" }],
  });
  const twoEnvDeps = (replies: Reply[]) => fakeDeps({
    session: twoEnvSession(), events: [userMsg("go")], replies,
    environments: { env_db: envFixture("env_db") }, workspaces: { ws_db: wsFixture("ws_db") },
  });
  const bothEnvs = () => [call("c1", "bash", { command: "ls" }), call("c2", "bash", { command: "psql", env: "db" }), text("done")];

  it("the bash tool offers `env` with several environments and leases one sandbox per env", async () => {
    const f = twoEnvDeps(bothEnvs());
    await runSession("sess_1", f.deps);
    const bash = f.requests[0]!.context.tools!.find((t) => t.name === "bash")!;
    expect(Object.keys((bash.parameters as any).properties)).toContain("env");
    expect((bash.parameters as any).required).toEqual(["command"]);
    expect(f.acquires.map((a) => a.environmentId)).toEqual(["env_main", "env_db"]);
    expect(f.payloads("workspace.captured").map((p) => p.env)).toEqual(["main", "db"]);
    expect(f.released).toEqual(["sbx_env_main", "sbx_env_db"]);
  });

  it("a capture failure on main is reported and its lease still released; a lost CAS is a capture_conflict", async () => {
    const f = twoEnvDeps(bothEnvs());
    const cap = f.sandboxService.capture;
    f.sandboxService.capture = async (sb, prev) => { if (sb.id === "sbx_env_main") throw new Error("git broke"); return cap(sb, prev); };
    f.deps.updateWorkspaceRef = async (id) => id !== "ws_db";
    await runSession("sess_1", f.deps);
    const errs = f.payloads("session.error").map((p) => p.error);
    expect(errs[0]).toEqual({ type: "capture_failed", message: "main: git broke" });
    expect(errs[1]!.type).toBe("capture_conflict");
    expect(f.released).toEqual(["sbx_env_main", "sbx_env_db"]);
    expect(f.finishCalls).toHaveLength(1);
  });

  it("lease.release() throwing on main still captures/releases db and finishes the run (regression: throw escapes the loop)", async () => {
    const f = twoEnvDeps(bothEnvs());
    const acq = f.sandboxService.acquire;
    f.sandboxService.acquire = async (req) => {
      const l = await acq(req);
      return req.environmentId === "env_main" ? { ...l, release: async () => { throw new Error("release failed"); } } : l;
    };
    await runSession("sess_1", f.deps).catch(() => {});
    expect(f.released).toContain("sbx_env_db");
    expect(f.finishCalls).toHaveLength(1);
  });

  it("an acquire still in flight when the loop ends is awaited and released", async () => {
    const h = fakeHost({ hooks: { session_start: (_e, caps) => { void caps.sandboxWrite("x.txt", "x").catch(() => {}); } } });
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("hello")], host: h.host });
    const acq = f.sandboxService.acquire;
    f.sandboxService.acquire = async (req) => { await new Promise((r) => setTimeout(r, 30)); return acq(req); };
    await runSession("sess_1", f.deps);
    expect(f.released).toEqual(["sbx_env_main"]);
  });

  it("concurrent sandbox requests share one acquire; the request carries secrets and the container key", async () => {
    const p = probing(async (caps) => Promise.all([caps.sandboxWrite("a", "1"), caps.sandboxWrite("b", "2")]));
    const f = fakeDeps({ session: sessionFixture({ container_group: "grp_1" }), events: [userMsg("hi")], replies: [text("ok")], host: p.host });
    f.deps.vaultSecrets = async () => ({ API_TOKEN: "s3cret" });
    await runSession("sess_1", f.deps);
    expect(p.results[0]!.err).toBeUndefined();
    expect(f.acquires).toHaveLength(1);
    expect(f.acquires[0]).toMatchObject({ secrets: { API_TOKEN: "s3cret" }, containerKey: "prc_a/grp_1/env_main", owner_id: "prc_a", workspaceId: "ws_main" });
    expect(f.sandboxes[0]!.files.size).toBe(2);
  });

  it("a rejected acquire is retried on the next call", async () => {
    const f = fakeDeps({ events: [userMsg("go")], replies: [call("c1", "bash", { command: "ls" }), call("c2", "bash", { command: "ls" }), text("done")] });
    const acq = f.sandboxService.acquire;
    let n = 0;
    f.sandboxService.acquire = async (req) => { if (n++ === 0) throw new Error("no capacity"); return acq(req); };
    await runSession("sess_1", f.deps);
    expect(f.payloads("agent.tool_result").map((p) => p.is_error)).toEqual([true, false]);
    expect(n).toBe(2);
  });

  it("an unknown env key throws listing the available keys", async () => {
    const p = probing((caps) => caps.sandboxExec("ls", { env: "nope" }));
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")], host: p.host });
    await runSession("sess_1", f.deps);
    expect(p.results[0]!.err).toMatch(/no environment "nope".*have: main/);
    expect(f.acquires).toHaveLength(0);
  });
});

describe("runSession compaction", () => {
  const big = (c: string) => c.repeat(8000); // ~2000 tokens
  /** n user/assistant pairs of ~2000 tokens each plus a final user; only the first assistant carries usage. */
  function history(pairs: number, firstUsage?: number): SessionEventPayload[] {
    const out: SessionEventPayload[] = [];
    for (let i = 0; i < pairs; i++) {
      out.push(userMsg(big(String.fromCharCode(97 + i))));
      const a = text(big(String.fromCharCode(65 + i)));
      if (i === 0 && firstUsage) a.usage = { ...a.usage, input: firstUsage, totalTokens: firstUsage };
      else delete (a as { usage?: unknown }).usage;
      out.push({ type: "agent.message", content: [], pi: a });
    }
    out.push(userMsg("latest question"));
    return out;
  }
  const compactEnv = () => { env.COMPACTION_ENABLED = true; env.COMPACTION_RESERVE_TOKENS = 1000; env.COMPACTION_KEEP_RECENT_TOKENS = 3000; };

  it("compacts an over-budget resumed history before the first request with a correct first_kept_seq", async () => {
    compactEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fakeDeps({ events: history(6, 25_000), replies: [text("BUILTIN SUMMARY"), text("answer")], models: [model(20_000)] });
    const folded = foldEvents([...f.log]);
    const cut = findCut(folded.messages, 3000);
    const expectedSeq = folded.seqOf.get(folded.messages[cut]!);
    await runSession("sess_1", f.deps);
    const [c] = f.payloads("agent.thread_context_compacted");
    expect(c).toBeDefined();
    expect(c!.summary).toBe("BUILTIN SUMMARY");
    expect(c!.first_kept_seq).toBe(expectedSeq);
    expect(c!.tokens_after).toBeLessThan(c!.tokens_before);
    const req = f.requests[1]!;
    expect((req.context.messages[0] as any).content[0].text).toContain("BUILTIN SUMMARY");
    expect(req.context.messages).toHaveLength(1 + folded.messages.length - cut);
    // the compaction event sits before the run's own messages, so a later fold reproduces the same context
    const refold = foldEvents([...f.log]);
    expect((refold.messages[0] as any).content[0].text).toContain("BUILTIN SUMMARY");
  });

  it("a failing summarizer leaves the messages unchanged and persists nothing", async () => {
    compactEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeDeps({ events: history(6, 25_000), replies: [assistantMsg([], { stopReason: "error", errorMessage: "boom" }), text("answer")], models: [model(20_000)] });
    const out = await runSession("sess_1", f.deps);
    expect(f.payloads("agent.thread_context_compacted")).toEqual([]);
    expect(f.requests[1]!.context.messages).toHaveLength(13);
    expect(out).toMatchObject({ stopReason: "end_turn" });
  });

  it("skips a compaction that would not shrink the context (keep budget too close to the window)", async () => {
    // keeping 25k of a 20k-window model: the summary is added and nothing is really dropped, so the
    // next turn would be just as full — compacting every turn forever for one model call each time.
    env.COMPACTION_ENABLED = true; env.COMPACTION_RESERVE_TOKENS = 1000; env.COMPACTION_KEEP_RECENT_TOKENS = 20_000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // a summary bigger than the history it replaces: the "compacted" context ends up larger
    const h = fakeHost({ hooks: { before_compact: () => ({ summary: "summary ".repeat(20_000) }) } });
    const f = fakeDeps({ events: history(6, 25_000), replies: [text("answer")], models: [model(20_000)], host: h.host });
    await runSession("sess_1", f.deps);
    expect(f.payloads("agent.thread_context_compacted")).toEqual([]); // nothing recorded, history intact
    expect(warn.mock.calls.flat().join(" ")).toMatch(/would not shrink the context/);
  });

  it("honors a before_compact cancel on the resume-time compaction (regression: hooks not attached yet)", async () => {
    compactEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = fakeHost({ hooks: { before_compact: () => ({ cancel: true }) } });
    const f = fakeDeps({ events: history(6, 25_000), replies: [text("answer")], models: [model(20_000)], host: h.host });
    await runSession("sess_1", f.deps);
    expect(f.payloads("agent.thread_context_compacted")).toEqual([]);
  });

  it("honors a before_compact summary override on the resume-time compaction (regression: hooks not attached yet)", async () => {
    compactEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const h = fakeHost({ hooks: { before_compact: () => ({ summary: "X" }) } });
    const f = fakeDeps({ events: history(6, 25_000), replies: [text("answer")], models: [model(20_000)], host: h.host });
    await runSession("sess_1", f.deps);
    expect(f.payloads("agent.thread_context_compacted")[0]?.summary).toBe("X");
  });

  it("mid-run compaction runs before_compact/after_compact hooks and feeds the compacted context to the next request", async () => {
    compactEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const after: unknown[] = [];
    const h = fakeHost({ hooks: { before_compact: () => ({ summary: "PLUGIN" }), after_compact: (e) => { after.push(e); } } });
    const first = call("c1", "bash", { command: "ls" });
    first.usage = { ...first.usage, input: 25_000, totalTokens: 25_000 };
    const hist = history(3).slice(0, -1).map((p) => (p.type === "agent.message" ? { ...p, pi: { ...(p.pi as object), usage: undefined } } : p)) as SessionEventPayload[];
    const f = fakeDeps({ events: [...hist, userMsg("go")], replies: [first, text("done")], models: [model(20_000)], host: h.host });
    await runSession("sess_1", f.deps);
    expect(f.requests).toHaveLength(2);
    const [c] = f.payloads("agent.thread_context_compacted");
    expect(c!.summary).toBe("PLUGIN");
    expect(after).toEqual([expect.objectContaining({ type: "after_compact", summary: "PLUGIN" })]);
    expect((f.requests[1]!.context.messages[0] as any).content[0].text).toContain("PLUGIN");
    const firstKept = f.log.find((e) => e.seq === c!.first_kept_seq)!;
    expect(["user.message", "agent.message"]).toContain(firstKept.type);
  });
});

describe("runSession MCP and client tools", () => {
  function mcpFetch(servers: Record<string, { tools?: any[]; call?: any; fail?: boolean }>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push(url);
      const s = servers[url];
      if (!s || s.fail) throw new Error("connect ECONNREFUSED");
      const body = JSON.parse(init.body);
      const result = body.method === "tools/list" ? { tools: s.tools ?? [] } : body.method === "tools/call" ? s.call : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    return calls;
  }
  const schema = { type: "object", properties: {} };

  it("blocks servers outside the fetch allowlist, fails soft on connect errors, filters and namespaces tools", async () => {
    const calls = mcpFetch({ "https://down.example.com/mcp": { fail: true }, "https://gh.example.com/mcp": { tools: [{ name: "list", inputSchema: schema }, { name: "secret", inputSchema: schema }] } });
    const f = fakeDeps({
      session: sessionFixture({}, { mcp_servers: [
        { label: "evil", url: "https://evil.io/mcp" },
        { label: "down", url: "https://down.example.com/mcp" },
        { label: "gh", url: "https://gh.example.com/mcp", allowed_tools: ["list"] },
      ] }),
      events: [userMsg("hi")], replies: [text("ok")],
    });
    f.deps.principalFetchAllow = async () => "example.com";
    await runSession("sess_1", f.deps);
    const notes = f.payloads("plugin.message").map((p) => [p.plugin, eventText(p)]);
    expect(notes[0]![0]).toBe("mcp:evil");
    expect(notes[0]![1]).toMatch(/blocked/);
    expect(notes[1]![0]).toBe("mcp:down");
    expect(notes[1]![1]).toMatch(/unavailable/);
    expect(calls.some((u) => u.includes("evil.io"))).toBe(false);
    const names = toolNames(f.requests[0]!);
    expect(names).toContain("gh__list");
    expect(names).not.toContain("gh__secret");
  });

  it("connects MCP servers concurrently while keeping tool and note order by declaration", async () => {
    let inFlight = 0, maxInFlight = 0;
    const tools = (n: string) => ({ tools: [{ name: n, inputSchema: schema }] });
    const servers: Record<string, any> = { "https://a.example.com/mcp": tools("one"), "https://b.example.com/mcp": { fail: true }, "https://c.example.com/mcp": tools("three") };
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, url.startsWith("https://a.") ? 40 : 5)); // the first server is the slowest
      inFlight--;
      const s = servers[url];
      if (s.fail) throw new Error("connect ECONNREFUSED");
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: s.tools } : {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const f = fakeDeps({
      session: sessionFixture({}, { mcp_servers: [{ label: "a", url: "https://a.example.com/mcp" }, { label: "b", url: "https://b.example.com/mcp" }, { label: "c", url: "https://c.example.com/mcp" }] }),
      events: [userMsg("hi")], replies: [text("ok")],
    });
    f.deps.principalFetchAllow = async () => "example.com";
    await runSession("sess_1", f.deps);
    expect(maxInFlight).toBeGreaterThan(1);
    const names = toolNames(f.requests[0]!).filter((n) => n.includes("__"));
    expect(names).toEqual(["a__one", "c__three"]);
    expect(f.payloads("plugin.message").map((p) => p.plugin)).toEqual(["mcp:b"]);
  });

  it("an MCP result with isError:true is persisted as an error tool result (regression: reported as success)", async () => {
    mcpFetch({ "https://gh.example.com/mcp": { tools: [{ name: "list", inputSchema: schema }], call: { content: [{ type: "text", text: "permission denied" }], isError: true } } });
    const f = fakeDeps({ session: sessionFixture({}, { mcp_servers: [{ label: "gh", url: "https://gh.example.com/mcp" }] }), events: [userMsg("hi")], replies: [call("c1", "gh__list", {}), text("ok")] });
    await runSession("sess_1", f.deps);
    const [tr] = f.payloads("agent.tool_result");
    expect(eventText(tr!)).toContain("permission denied");
    expect(tr!.is_error).toBe(true);
  });

  it("a client tool_result with isError:true is persisted as an error tool result (regression: reported as success)", async () => {
    const f = fakeDeps({ session: sessionFixture({}, { client_tools: [{ type: "function", name: "ask", parameters: schema }] }), events: [userMsg("hi")], replies: [call("c1", "ask", {}), text("ok")] });
    f.deps.awaitToolResult = async () => ({ content: [{ type: "text", text: "user declined" }], isError: true });
    await runSession("sess_1", f.deps);
    expect(f.payloads("agent.tool_result")[0]!.is_error).toBe(true);
  });

  it("a client tool whose result never arrives returns the timed-out text", async () => {
    const f = fakeDeps({ session: sessionFixture({}, { client_tools: [{ type: "function", name: "ask", parameters: schema }] }), events: [userMsg("hi")], replies: [call("c1", "ask", {}), text("ok")] });
    const waits: unknown[] = [];
    f.deps.awaitToolResult = async (sid, id, _sig, ms) => { waits.push([sid, id, ms]); return null; };
    await runSession("sess_1", f.deps);
    expect(waits).toEqual([["sess_1", "c1", env.CLIENT_TOOL_WAIT_MS]]);
    expect(eventText(f.payloads("agent.tool_result")[0]!)).toMatch(/No tool_result received for ask \(call c1\)/);
  });

  it("tool names advertised to the model are unique (regression: a client tool named bash duplicates the builtin)", async () => {
    const f = fakeDeps({ session: sessionFixture({}, { client_tools: [{ type: "function", name: "bash", parameters: schema }] }), events: [userMsg("hi")], replies: [text("ok")] });
    await runSession("sess_1", f.deps).catch(() => {});
    const names = toolNames(f.requests[0]!);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("runSession caps.fetch allowlist", () => {
  it("matches the host or its subdomains only; '*' allows everything; bodies are truncated", async () => {
    vi.stubGlobal("fetch", async () => new Response("y".repeat(300_000), { status: 200 }));
    const urls = ["https://api.example.com/x", "https://example.com/", "https://evilexample.com/", "https://example.com.evil.io/", "not a url"];
    const p = probing(async (caps) => {
      const out: Record<string, string> = {};
      for (const u of urls) out[u] = await caps.fetch(u, {}).then((r) => `ok:${r.body.length}`, (e) => `err:${(e as Error).message}`);
      return out;
    });
    const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")], host: p.host });
    f.deps.principalFetchAllow = async () => "example.com";
    await runSession("sess_1", f.deps);
    const r = p.results[0]!.ok as Record<string, string>;
    expect(r["https://api.example.com/x"]).toMatch(/^ok:/);
    expect(Number(r["https://example.com/"]!.slice(3))).toBeLessThan(300_000);
    expect(r["https://evilexample.com/"]).toMatch(/blocked/);
    expect(r["https://example.com.evil.io/"]).toMatch(/blocked/);
    expect(r["not a url"]).toMatch(/blocked/);

    const star = probing(async (caps) => (await caps.fetch("https://anything.io/", {})).status);
    const g = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")], host: star.host });
    g.deps.principalFetchAllow = async () => "*";
    await runSession("sess_1", g.deps);
    expect(star.results[0]).toEqual({ ok: 200 });
  });

  it("a redirect from an allowed host to a disallowed one is blocked (regression: fetch follows redirects unchecked)", async () => {
    const secret = http.createServer((_q, s) => { s.end("METADATA-SECRET"); });
    await new Promise<void>((r) => secret.listen(0, "localhost", r));
    const secretPort = (secret.address() as AddressInfo).port;
    const allowed = http.createServer((_q, s) => { s.writeHead(302, { location: `http://localhost:${secretPort}/latest/meta-data` }); s.end(); });
    await new Promise<void>((r) => allowed.listen(0, "127.0.0.1", r));
    try {
      const p = probing((caps) => caps.fetch(`http://127.0.0.1:${(allowed.address() as AddressInfo).port}/r`, {}));
      const f = fakeDeps({ events: [userMsg("hi")], replies: [text("ok")], host: p.host });
      f.deps.principalFetchAllow = async () => "127.0.0.1";
      await runSession("sess_1", f.deps);
      expect(JSON.stringify(p.results[0])).not.toContain("METADATA-SECRET");
    } finally {
      secret.close(); allowed.close();
    }
  });
});

describe("runSession plugin capability scoping", () => {
  const withOther = (f: ReturnType<typeof fakeDeps>) => {
    f.sessions.set("sess_other", sessionFixture({ id: "sess_other", owner_id: "prc_b", workspace_id: "ws_other" }));
    f.sessions.set("sess_sibling", sessionFixture({ id: "sess_sibling", owner_id: "prc_a" }));
    f.appendTo("sess_other", [userMsg("private")]);
  };

  it("eventsGet refuses another owner's session and applies since/limit", async () => {
    const p = probing(async (caps) => ({
      other: await caps.eventsGet({ sessionId: "sess_other" }).catch((e) => (e as Error).message),
      sinceLimit: (await caps.eventsGet({ since: 1, limit: 1 })).map((e) => e.type),
    }));
    const f = fakeDeps({ events: [userMsg("a"), userMsg("b")], replies: [text("ok")], host: p.host });
    withOther(f);
    await runSession("sess_1", f.deps);
    const r = p.results[0]!.ok as any;
    expect(r.other).toMatch(/not found for this owner/);
    expect(r.sinceLimit).toEqual(["session.status_running"]);
  });

  it("eventsGet with limit 0 returns no events (regression: slice(-0) returned all)", async () => {
    const p = probing((caps) => caps.eventsGet({ limit: 0 }));
    const f = fakeDeps({ events: [userMsg("a")], replies: [text("ok")], host: p.host });
    await runSession("sess_1", f.deps);
    expect(p.results[0]).toEqual({ ok: [] });
  });

  const scoped: [string, (caps: Capabilities, id: string) => Promise<unknown>][] = [
    ["agentsStop", (c, id) => c.agentsStop(id)],
    ["agentsSteer", (c, id) => c.agentsSteer(id, "do evil")],
    ["agentsReply", (c, id) => c.agentsReply(id, "q1", "yes")],
    ["agentsStatus", (c, id) => c.agentsStatus(id)],
    ["agentsPatch", (c, id) => c.agentsPatch(id)],
  ];
  for (const [name, invoke] of scoped) {
    for (const target of ["sess_other", "sess_sibling"]) {
      it(`${name} refuses ${target}, which is not a child of this session (regression: no parent/owner check)`, async () => {
        const p = probing((caps) => invoke(caps, target));
        const f = fakeDeps({ events: [userMsg("a")], replies: [text("ok")], host: p.host });
        withOther(f);
        const stop = vi.fn(async () => {}); const message = vi.fn(async () => {});
        f.deps.children.stop = stop; f.deps.children.message = message;
        await runSession("sess_1", f.deps);
        expect(p.results[0]!.err).toBeDefined();
        expect(stop).not.toHaveBeenCalled();
        expect(message).not.toHaveBeenCalled();
      });
    }
  }

  it("storeGet/storeSet map scopes to agent, workspace and principal owners", async () => {
    const sets: unknown[] = [];
    const p = probing(async (caps) => { for (const s of ["agent", "workspace", "principal"] as const) await caps.storeSet("k", s, s); });
    const f = fakeDeps({ events: [userMsg("a")], replies: [text("ok")], host: p.host });
    f.deps.pluginStore.set = async (scope, owner, key, value) => { sets.push([scope, owner, key, value]); };
    await runSession("sess_1", f.deps);
    expect(sets).toEqual([["agent", "agent_1", "k", "agent"], ["workspace", "ws_main", "k", "workspace"], ["principal", "prc_a", "k", "principal"]]);
  });
});

describe("runSession trigger handling", () => {
  it("a slash command without send replies via plugin.message and never calls the model", async () => {
    const seen: string[] = [];
    const h = fakeHost({ commands: { foo: (args) => { seen.push(args); return { reply: "foo done" }; } } });
    const f = fakeDeps({ events: [userMsg("/foo bar baz")], host: h.host });
    const out = await runSession("sess_1", f.deps);
    expect(seen).toEqual(["bar baz"]);
    expect(f.payloads("plugin.message")).toEqual([{ type: "plugin.message", plugin: "/foo", content: [{ type: "text", text: "foo done" }] }]);
    expect(f.requests).toHaveLength(0);
    expect(out).toMatchObject({ stopReason: "end_turn" });
  });

  it("a slash command with send forwards that prompt; unknown commands go to the model verbatim", async () => {
    const h = fakeHost({ commands: { plan: () => ({ send: "PLAN PROMPT" }) } });
    const f = fakeDeps({ events: [userMsg("/plan")], replies: [text("ok")], host: h.host });
    await runSession("sess_1", f.deps);
    expect(lastUserText(f.requests[0]!)).toBe("PLAN PROMPT");
    const g = fakeDeps({ events: [userMsg("/nope x")], replies: [text("ok")], host: fakeHost({ commands: { plan: () => ({}) } }).host });
    await runSession("sess_1", g.deps);
    expect(lastUserText(g.requests[0]!)).toBe("/nope x");
  });

  it("an input hook cancel skips the model", async () => {
    const h = fakeHost({ hooks: { input: () => ({ cancel: true }) } });
    const f = fakeDeps({ events: [userMsg("hi")], host: h.host });
    expect(await runSession("sess_1", f.deps)).toMatchObject({ stopReason: "end_turn" });
    expect(f.requests).toHaveLength(0);
  });

  it("before_agent_start can replace and append to the system prompt and inject a message before the trigger", async () => {
    const h = fakeHost({ hooks: { before_agent_start: (e) => ({ systemPrompt: "CUSTOM", appendSystemPrompt: "APPENDED", injectMessage: `INJECTED for ${e.trigger}` }) } });
    const f = fakeDeps({ events: [userMsg("first"), { type: "agent.message", content: [], pi: text("r") }, userMsg("trigger")], replies: [text("ok")], host: h.host });
    await runSession("sess_1", f.deps);
    const req = f.requests[0]!;
    expect(req.context.systemPrompt).toBe("CUSTOM\n\nAPPENDED");
    expect(f.prompts).toEqual(["CUSTOM\n\nAPPENDED"]);
    expect(req.context.messages.map((m: any) => (m.role === "user" ? m.content[0].text : m.role))).toEqual(["first", "assistant", "INJECTED for trigger", "trigger"]);
  });

  it("an input-hook rewrite keeps the trigger's image block (regression: rewritten message is text-only)", async () => {
    const h = fakeHost({ hooks: { input: (e) => ({ text: e.text.trim() }) } });
    const f = fakeDeps({ events: [{ type: "user.message", content: [{ type: "image", source: { type: "file", file_id: "file_img" } }, { type: "text", text: "  describe  " }] }], replies: [text("ok")], host: h.host });
    f.deps.files = { get: async () => ({ name: "a.png", mime: "image/png", data: new Uint8Array([1]) }) };
    await runSession("sess_1", f.deps);
    const u = f.requests[0]!.context.messages.at(-1) as any;
    expect(u.content.map((c: any) => c.type)).toEqual(["image", "text"]);
  });

  it("a command's `send` rewrite is what the next run's history contains (regression: rewrite is never persisted)", async () => {
    const h = fakeHost({ commands: { plan: () => ({ send: "PLAN PROMPT" }) } });
    const f = fakeDeps({ events: [userMsg("/plan")], replies: [text("answer to plan"), text("second")], host: h.host });
    await runSession("sess_1", f.deps);
    f.appendTo("sess_1", [userMsg("next")]);
    await runSession("sess_1", f.deps);
    const firstUser = f.requests[1]!.context.messages.find((m) => m.role === "user") as any;
    expect(firstUser.content[0].text).toBe("PLAN PROMPT");
  });
});

describe("runSession usage and stop reasons", () => {
  it("records usage with a computed total and emits a span; all-zero usage records nothing", async () => {
    const withUsage = text("hi");
    withUsage.usage = { ...withUsage.usage, input: 100, output: 20 };
    const f = fakeDeps({ events: [userMsg("a")], replies: [withUsage] });
    await runSession("sess_1", f.deps);
    expect(f.usage).toEqual([{ usage: { input: 100, output: 20, cache_read: 0, cache_write: 0, total_tokens: 120 }, context: { tokens: 120, window: 200_000, ratio: 120 / 200_000, model: "fake/m" } }]);
    expect(f.payloads("span.model_request_end")[0]).toMatchObject({ model: "fake/m", stop_reason: "stop", context: { tokens: 120 } });

    const g = fakeDeps({ events: [userMsg("a")], replies: [text("hi")] });
    await runSession("sess_1", g.deps);
    expect(g.usage).toEqual([]);
    expect(g.payloads("span.model_request_end")).toEqual([]);
  });

  it("a model error (not aborted) is a session.error model_error and stopReason error", async () => {
    const f = fakeDeps({ events: [userMsg("a")], replies: [assistantMsg([], { stopReason: "error", errorMessage: "rate limited" })] });
    expect(await runSession("sess_1", f.deps)).toMatchObject({ stopReason: "error" });
    expect(f.payloads("session.error")).toEqual([{ type: "session.error", error: { type: "model_error", message: "rate limited" } }]);
  });

  it("MAX_TURNS stops a tool-calling loop with max_turns", async () => {
    env.MAX_TURNS = 2;
    const f = fakeDeps({ events: [userMsg("loop")], replies: [call("c1", "bash", { command: "a" }), call("c2", "bash", { command: "b" }), call("c3", "bash", { command: "c" })] });
    expect(await runSession("sess_1", f.deps)).toMatchObject({ stopReason: "max_turns" });
    expect(f.requests).toHaveLength(2);
  });

  it("a turn_end hook stop ends the run with a hook:turn_end note", async () => {
    const h = fakeHost({ hooks: { turn_end: () => ({ stop: true, reason: "enough" }) } });
    const f = fakeDeps({ events: [userMsg("go")], replies: [call("c1", "bash", { command: "ls" }), text("never")], host: h.host });
    expect(await runSession("sess_1", f.deps)).toMatchObject({ stopReason: "end_turn" });
    expect(f.requests).toHaveLength(1);
    const note = f.payloads("plugin.message").find((p) => p.plugin === "hook:turn_end");
    expect(eventText(note!)).toBe("run stopped by plugin: enough");
  });
});
