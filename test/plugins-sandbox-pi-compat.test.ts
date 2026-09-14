import { describe, it, expect } from "vitest";
import { piCompatFactory } from "../src/plugins/pi-compat.ts";
import type { PluginAPI, PluginContext, ToolSpec } from "../src/plugins/api.ts";

type Handler = (ev: any, ctx: PluginContext) => any;
/** Loads a pi extension factory through the adapter and exposes what it registered on the pma API. */
async function load(factory: (pi: any) => unknown) {
  const tools = new Map<string, ToolSpec>();
  const hooks = new Map<string, Handler[]>();
  const commands: string[] = [];
  const api: PluginAPI = {
    registerTool: (spec) => { tools.set(spec.name, spec as unknown as ToolSpec); },
    registerCommand: (spec) => { commands.push(spec.name); },
    on: (event, handler) => { hooks.set(event, [...(hooks.get(event) ?? []), handler as Handler]); },
  };
  const warnings: string[] = [];
  await piCompatFactory(factory, api, "pi-pkg", warnings);
  const emit = (ev: any) => hooks.get(ev.type)![0]!(ev, ctx);
  return { tools, hooks, commands, warnings, emit };
}
const ctx = { sessionId: "s", agentId: "a", workspaceId: "w", plugin: "pi-pkg" } as PluginContext;

describe("pi-compat adapter", () => {
  const BASE = "BASE PROMPT";

  // Regression: pi-compat returns the whole rewritten prompt as appendSystemPrompt, so the base is duplicated.
  it("a context handler returning base + EXTRA does not duplicate the base prompt", async () => {
    const m = await load((pi) => pi.on("context", (ev: any) => ({ systemPrompt: `${ev.systemPrompt} EXTRA` })));
    const r = await m.emit({ type: "context", systemPrompt: BASE, messageCount: 1, contextTokens: 1, contextWindow: 10 });
    // what the runner builds: the base plus any appendix (or a full replacement)
    const final = r?.systemPrompt ?? (r?.appendSystemPrompt ? `${BASE}\n${r.appendSystemPrompt}` : BASE);
    expect(final.split(BASE).length - 1).toBe(1);
    expect(final).toContain("EXTRA");
  });

  it("a context handler that returns the prompt unchanged contributes nothing", async () => {
    const m = await load((pi) => pi.on("context", (ev: any) => ({ systemPrompt: ev.systemPrompt })));
    expect(await m.emit({ type: "context", systemPrompt: BASE, messageCount: 1, contextTokens: 1, contextWindow: 10 })).toBeUndefined();
  });

  // Regression: `{ type: event, ...ev }` lets our event type overwrite the pi event name.
  it("a session_shutdown handler receives event.type === 'session_shutdown'", async () => {
    let seen: string | undefined;
    const m = await load((pi) => pi.on("session_shutdown", (e: any) => { seen = e.type; }));
    expect([...m.hooks.keys()]).toEqual(["session_end"]);
    await m.emit({ type: "session_end", sessionId: "s" });
    expect(seen).toBe("session_shutdown");
  });

  it("maps session_shutdown to our session_end hook and calls the handler", async () => {
    let called = 0;
    const m = await load((pi) => pi.on("session_shutdown", () => { called++; }));
    expect(await m.emit({ type: "session_end", sessionId: "s" })).toBeUndefined();
    expect(called).toBe(1);
  });

  it("tool results keep only text blocks and map isError; execute gets pi's argument order", async () => {
    let args: unknown[] = [];
    const m = await load((pi) => {
      pi.registerTool({ name: "img", description: "d", parameters: {}, execute: async (...a: unknown[]) => { args = a; return { content: [{ type: "image", data: "AA", mimeType: "image/png" }, { type: "text", text: "caption" }], isError: 1 }; } });
      pi.registerTool({ name: "empty", description: "d", parameters: {}, execute: async () => undefined });
    });
    expect(await m.tools.get("img")!.execute({ q: 1 } as never, ctx)).toEqual({ content: [{ type: "text", text: "caption" }], isError: true });
    expect(args[0]).toBe("tc");
    expect(args[1]).toEqual({ q: 1 });
    expect((args[4] as { pma: unknown }).pma).toBe(ctx);
    expect(await m.tools.get("empty")!.execute({} as never, ctx)).toEqual({ content: [], isError: false });
  });

  it("ctx.ui.* rejects as headless", async () => {
    let p: Promise<unknown> | undefined;
    const m = await load((pi) => pi.registerTool({ name: "ui", description: "d", parameters: {}, execute: async (_id: string, _i: unknown, _s: unknown, _u: unknown, c: any) => { p = c.ui.notify("hi"); return { content: [] }; } }));
    await m.tools.get("ui")!.execute({} as never, ctx);
    await expect(p!).rejects.toThrow(/headless/);
  });

  it("registerCommand and unknown events push warnings and register nothing", async () => {
    const m = await load((pi) => { pi.registerCommand("x", {}); pi.on("foo", () => {}); pi.registerShortcut("k", {}); });
    expect(m.commands).toEqual([]);
    expect(m.hooks.size).toBe(0);
    expect(m.warnings).toEqual([
      "pi-pkg: pi registerCommand is not supported in pma (ignored)",
      'pi-pkg: pi on("foo") is not supported in pma (ignored)',
      "pi-pkg: pi registerShortcut is not supported in pma (ignored)",
    ]);
  });

  it("session_before_compact maps compaction.summary to summary and customInstructions to instructions", async () => {
    let seen: any;
    const m = await load((pi) => pi.on("session_before_compact", (e: any) => { seen = e; return { compaction: { summary: "S", firstKeptEntryId: "x" }, customInstructions: "focus" }; }));
    const r = await m.emit({ type: "before_compact", contextTokens: 9, contextWindow: 10, messageCount: 3 });
    expect(r).toEqual({ cancel: undefined, summary: "S", instructions: "focus" });
    expect(seen).toMatchObject({ type: "session_before_compact", contextTokens: 9, contextWindow: 10, messageCount: 3 });
    const none = await load((pi) => pi.on("session_before_compact", () => undefined));
    expect(await none.emit({ type: "before_compact", contextTokens: 9, contextWindow: 10, messageCount: 3 })).toBeUndefined();
  });

  it("tool_call only forwards block decisions; tool_result forwards content/isError", async () => {
    const m = await load((pi) => {
      pi.on("tool_call", (e: any) => (e.args.x ? { block: true, reason: "no" } : { input: { rewritten: true } }));
      pi.on("tool_result", (e: any) => (e.isError ? { isError: false } : undefined));
    });
    expect(await m.emit({ type: "tool_call", toolName: "t", toolCallId: "1", input: { x: 1 } })).toEqual({ block: true, reason: "no" });
    expect(await m.emit({ type: "tool_call", toolName: "t", toolCallId: "1", input: {} })).toBeUndefined();
    expect(await m.emit({ type: "tool_result", toolName: "t", toolCallId: "1", input: {}, content: [], isError: true })).toEqual({ content: undefined, isError: false });
    expect(await m.emit({ type: "tool_result", toolName: "t", toolCallId: "1", input: {}, content: [], isError: false })).toBeUndefined();
  });
});
