/**
 * Best-effort adapter that lets a pi extension (`(pi: ExtensionAPI) => void`) run on the pma
 * plugin API. Supported: registerTool, on(tool_call | tool_result | context | turn_start | turn_end
 * | session_start | session_shutdown | session_before_compact). A pi compaction extension's
 * `{ compaction: CompactionResult }` maps to our before_compact `summary` override (pi's
 * `firstKeptEntryId` is a session-tree id with no meaning in our event log, so the cut stays ours).
 * Everything UI-, command-, keybinding- or cwd-related is a recorded no-op so the package loads and
 * its tools/hooks still work; calls into `ctx.ui.*` reject.
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
        session_before_compact: "before_compact",
      };
      const ours = map[event];
      if (!ours) { unsupported(`on("${event}")`)(); return; }
      api.on(ours, async (ev: Any, ctx) => {
        if (ours === "before_compact") {
          const r = await handler({ type: "session_before_compact", contextTokens: ev.contextTokens, contextWindow: ev.contextWindow, messageCount: ev.messageCount, reason: "threshold", willRetry: false }, piCtx(ctx));
          if (!r) return undefined;
          // pi returns { cancel?, compaction?: CompactionResult }; carry the portable summary over.
          return { cancel: r.cancel, summary: r.compaction?.summary, instructions: r.customInstructions };
        }
        if (ours === "tool_call") {
          const r = await handler({ type: "tool_call", toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.input, args: ev.input }, piCtx(ctx));
          return r?.block ? { block: true, reason: r.reason } : undefined;
        }
        if (ours === "tool_result") {
          // pma and pi both use (TextContent | ImageContent)[] here, so the content passes through as-is.
          const r = await handler({ type: "tool_result", toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.input, content: ev.content, isError: ev.isError }, piCtx(ctx));
          if (r && (r.content !== undefined || r.isError !== undefined)) return { content: r.content, isError: r.isError };
          return undefined;
        }
        if (ours === "context") {
          // pi's context hook rewrites messages; we cannot hand those out, only the prompt. Give an empty message list.
          const r = await handler({ type: "context", systemPrompt: ev.systemPrompt, messages: [] }, piCtx(ctx));
          if (!r?.systemPrompt || r.systemPrompt === ev.systemPrompt) return undefined;
          // pi returns the whole rewritten prompt; the runner appends, so pass only what was added to the base
          const added = r.systemPrompt.startsWith(ev.systemPrompt) ? r.systemPrompt.slice(ev.systemPrompt.length).trim() : r.systemPrompt;
          return added ? { appendSystemPrompt: added } : undefined;
        }
        await handler({ ...ev, type: event }, piCtx(ctx)); // handlers see pi's event name (session_shutdown), not ours
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
