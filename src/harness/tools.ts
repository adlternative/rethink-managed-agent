import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { posix } from "node:path";
import { env } from "../shared/env.ts";
import type { BuiltinToolName, Sandbox } from "../shared/types.ts";

export interface ToolContext {
  /** Lazily acquires the sandbox of an attached environment (default "main"); pure-chat turns never call this. */
  sandbox(env?: string): Promise<Sandbox>;
  /** Keys of the environments attached to the session; the `env` tool parameter is offered when there are several. */
  envKeys?: string[];
  signal?: AbortSignal;
  /** Spill-to-store: keep the full text of an oversized tool result, keyed by tool call id. */
  spill?: {
    put(toolUseId: string, toolName: string, content: string): Promise<void>;
    get(toolUseId: string): Promise<{ tool_name: string; content: string; bytes: number } | null>;
  };
}

/** Adds the optional `env` parameter when a session has more than one environment attached. */
function withEnv<S extends TSchema>(ctx: ToolContext, schema: S): TSchema {
  if (!ctx.envKeys || ctx.envKeys.length <= 1) return schema;
  return Type.Object({
    ...(schema as unknown as { properties: Record<string, TSchema> }).properties,
    env: Type.Optional(Type.String({ description: `Which attached environment to run in: ${ctx.envKeys.join(" | ")} (default main)` })),
  }, { required: (schema as unknown as { required?: string[] }).required });
}

const MAX_OUTPUT_CHARS = 30_000;

/** Keep head and tail of oversized output so both the start and the final error remain visible. */
export function truncateOutput(s: string, max = MAX_OUTPUT_CHARS, note = ""): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[... ${s.length - max} chars truncated ...${note}]\n\n${s.slice(-half)}`;
}

/**
 * Truncate for the model, but keep the whole thing: the full text goes to the spill store under
 * the tool call id and the note tells the model how to get at it with `tool_output`.
 */
async function truncateWithSpill(ctx: ToolContext, toolUseId: string, toolName: string, s: string): Promise<string> {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  if (!ctx.spill) return truncateOutput(s);
  // the spill is a convenience: failing to store it must not turn a successful tool call into an error
  try { await ctx.spill.put(toolUseId, toolName, s); } catch { return truncateOutput(s); }
  return truncateOutput(s, MAX_OUTPUT_CHARS, ` full ${s.length} chars kept: call tool_output with tool_use_id "${toolUseId}" and a grep pattern or offset/limit to read the rest`);
}

function tool(
  name: BuiltinToolName,
  description: string,
  parameters: TSchema,
  run: (params: any, signal: AbortSignal | undefined, toolCallId: string) => Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters,
    async execute(id, params, signal): Promise<AgentToolResult<undefined>> {
      const text = await run(params, signal, id);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

const resolvePath = (sb: Sandbox, p: string) => posix.resolve(sb.workdir, p);
const readText = async (sb: Sandbox, abs: string) => Buffer.from(await sb.readFile(abs)).toString("utf8");

const factories: Record<BuiltinToolName, (ctx: ToolContext) => AgentTool> = {
  bash: (ctx) =>
    tool(
      "bash",
      "Execute a bash command in the workspace root. Returns combined stdout/stderr; fails on non-zero exit.",
      withEnv(ctx, Type.Object({
        command: Type.String({ description: "Bash command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
      })),
      async ({ command, timeout, env: envKey }, signal, toolCallId) => {
        const sb = await ctx.sandbox(envKey);
        let out = "";
        let code: number | undefined;
        // Always bounded: a runaway `sleep infinity` must not hold the runner and the lease forever.
        const timeoutMs = Math.min(typeof timeout === "number" && timeout > 0 ? timeout * 1000 : env.BASH_TIMEOUT_MS, env.BASH_MAX_TIMEOUT_MS);
        const opts = { cwd: sb.workdir, timeoutMs, signal: signal ?? ctx.signal };
        for await (const chunk of sb.exec(command, opts)) {
          if (chunk.type === "exit") code = chunk.code;
          else out += chunk.data ?? "";
        }
        const body = await truncateWithSpill(ctx, toolCallId, "bash", out);
        if (code !== 0) throw new Error(`${body}\n\nCommand exited with code ${code ?? "unknown"}${code === 137 ? ` (killed: timeout ${timeoutMs}ms or interrupt)` : ""}`);
        return body || "(no output)";
      },
    ),

  read: (ctx) =>
    tool(
      "read",
      "Read a text file with line numbers. Use offset (1-indexed) and limit for large files.",
      withEnv(ctx, Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        offset: Type.Optional(Type.Number({ description: "First line to read (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      })),
      async ({ path, offset, limit, env: envKey }, _signal, toolCallId) => {
        const sb = await ctx.sandbox(envKey);
        const lines = (await readText(sb, resolvePath(sb, path))).split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines)`);
        const end = limit === undefined || limit < 0 ? lines.length : Math.min(start + limit, lines.length);
        let out = lines
          .slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
          .join("\n");
        if (end < lines.length) out += `\n\n[${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
        return truncateWithSpill(ctx, toolCallId, "read", out);
      },
    ),

  write: (ctx) =>
    tool(
      "write",
      "Write content to a file, creating or overwriting it.",
      withEnv(ctx, Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        content: Type.String({ description: "Full file content" }),
      })),
      async ({ path, content, env: envKey }) => {
        const sb = await ctx.sandbox(envKey);
        const data = Buffer.from(content, "utf8");
        await sb.writeFile(resolvePath(sb, path), data);
        return `Wrote ${data.length} bytes to ${path}`;
      },
    ),

  edit: (ctx) =>
    tool(
      "edit",
      "Replace exactly one occurrence of oldText with newText in a file. oldText must match exactly and be unique.",
      withEnv(ctx, Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        oldText: Type.String({ description: "Exact text to replace (must be unique in the file)" }),
        newText: Type.String({ description: "Replacement text" }),
      })),
      async ({ path, oldText, newText, env: envKey }) => {
        const sb = await ctx.sandbox(envKey);
        const abs = resolvePath(sb, path);
        if (oldText === "") throw new Error("oldText must not be empty; use write to create or replace a whole file");
        const src = await readText(sb, abs);
        const at = src.indexOf(oldText);
        if (at === -1) throw new Error(`oldText not found in ${path}`);
        if (src.indexOf(oldText, at + oldText.length) !== -1) {
          throw new Error(`oldText occurs more than once in ${path}; add surrounding context to make it unique`);
        }
        await sb.writeFile(abs, Buffer.from(src.slice(0, at) + newText + src.slice(at + oldText.length), "utf8"));
        return `Edited ${path}`;
      },
    ),
};

/** Reads back a spilled tool output: grep for lines, or a line window. */
function toolOutputTool(ctx: ToolContext): AgentTool {
  return {
    name: "tool_output",
    label: "tool_output",
    description: "Read the full output of an earlier tool call whose result was truncated. Give the tool_use_id from the truncation note plus either `grep` (regex; returns matching lines with line numbers, max 200) or `offset`/`limit` (1-indexed line window, default 200 lines).",
    parameters: Type.Object({
      tool_use_id: Type.String(),
      grep: Type.Optional(Type.String({ description: "regex; case-insensitive" })),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const { tool_use_id, grep, offset, limit } = params as { tool_use_id: string; grep?: string; offset?: number; limit?: number };
      const rec = await ctx.spill?.get(tool_use_id);
      if (!rec) throw new Error(`no stored output for tool call ${tool_use_id}`);
      const lines = rec.content.split("\n");
      let out: string;
      if (grep) {
        let re: RegExp;
        try { re = new RegExp(grep, "i"); } catch (e) { throw new Error(`bad grep regex: ${(e as Error).message}`); }
        const hits = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => re.test(l));
        out = hits.slice(0, 200).map(([n, l]) => `${String(n).padStart(6)}\t${l}`).join("\n") + (hits.length > 200 ? `\n\n[${hits.length - 200} more matches]` : "") || "(no matches)";
      } else {
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = Math.min(lines.length, start + (limit ?? 200));
        out = lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join("\n");
        if (end < lines.length) out += `\n\n[${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
      }
      return { content: [{ type: "text", text: `(${rec.tool_name} output, ${lines.length} lines, ${rec.bytes} bytes)\n${truncateOutput(out)}` }], details: undefined };
    },
  };
}

export function createTools(names: BuiltinToolName[], ctx: ToolContext): AgentTool[] {
  const tools = names.map((name) => {
    const make = factories[name];
    if (!make) throw new Error(`Unknown builtin tool: ${name}`);
    return make(ctx);
  });
  if (ctx.spill) tools.push(toolOutputTool(ctx));
  return tools;
}
