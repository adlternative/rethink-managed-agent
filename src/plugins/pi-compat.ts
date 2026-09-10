/**
 * Best-effort adapter that lets a pi extension (`(pi: ExtensionAPI) => void`) run on the pma
 * plugin API. Supported: registerTool, on(tool_call | tool_result | context | turn_start | turn_end
 * | session_start | session_shutdown). Everything UI-, command-, keybinding- or cwd-related is a
 * recorded no-op so the package loads and its tools/hooks still work; calls into `ctx.ui.*` reject.
 */
import type { HookEvent, PluginAPI, PluginContext } from "./api.ts";

type Any = any;

export async function piCompatFactory(factory: (pi: Any) => unknown, api: PluginAPI, source: string, warnings: string[]): Promise<void> {
  const unsupported = (name: string) => () => { warnings.push(`${source}: pi ${name} is not supported in pma (ignored)`); };
  const piCtx = (ctx: PluginContext) => ({
    hasUI: false,
    mode: "rpc",
    cwd: undefined,
    ui: new Proxy({}, { get: (_t, k) => () => Promise.reject(new Error(`pi ctx.ui.${String(k)} is unavailable: pma plugins are headless`)) }),
    sessionManager: undefined,
    model: undefined,
    isIdle: () => false,
    // pma-only extras are still reachable for hybrid packages
    pma: ctx,
  });

  const pi = {
    registerTool(def: Any) {
      api.registerTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        async execute(input, ctx) {
          const r = await def.execute("tc", input, undefined, undefined, piCtx(ctx));
          return { content: (r?.content ?? []).filter((c: Any) => c.type === "text"), isError: !!r?.isError };
        },
      });
    },
    on(event: string, handler: (ev: Any, ctx: Any) => Any) {
      const map: Record<string, HookEvent["type"]> = {
        tool_call: "tool_call", tool_result: "tool_result", context: "context",
        turn_start: "turn_start", turn_end: "turn_end", session_start: "session_start", session_shutdown: "session_end",
      };
      const ours = map[event];
      if (!ours) { unsupported(`on("${event}")`)(); return; }
      api.on(ours, async (ev: Any, ctx) => {
        if (ours === "tool_call") {
          const r = await handler({ type: "tool_call", toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.input, args: ev.input }, piCtx(ctx));
          return r?.block ? { block: true, reason: r.reason } : undefined;
        }
        if (ours === "tool_result") {
          const r = await handler({ type: "tool_result", toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.input, content: [{ type: "text", text: ev.content }], isError: ev.isError }, piCtx(ctx));
          if (r?.content) return { content: r.content.filter((c: Any) => c.type === "text").map((c: Any) => c.text).join(""), isError: r.isError };
          return undefined;
        }
        if (ours === "context") {
          // pi's context hook rewrites messages; we cannot hand those out, only the prompt. Give an empty message list.
          const r = await handler({ type: "context", systemPrompt: ev.systemPrompt, messages: [] }, piCtx(ctx));
          return r?.systemPrompt && r.systemPrompt !== ev.systemPrompt ? { appendSystemPrompt: r.systemPrompt } : undefined;
        }
        await handler({ type: event, ...ev }, piCtx(ctx));
        return undefined;
      });
    },
    registerCommand: unsupported("registerCommand"),
    registerShortcut: unsupported("registerShortcut"),
    registerFlag: unsupported("registerFlag"),
    registerMessageRenderer: unsupported("registerMessageRenderer"),
    registerEntryRenderer: unsupported("registerEntryRenderer"),
    registerMarkdownTransformer: unsupported("registerMarkdownTransformer"),
    registerProvider: unsupported("registerProvider"),
    sendMessage: unsupported("sendMessage"),
    appendEntry: unsupported("appendEntry"),
    getSessionManager: () => undefined,
  };
  await factory(pi);
}
