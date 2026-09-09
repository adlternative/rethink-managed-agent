import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { posix } from "node:path";
import type { BuiltinToolName, Sandbox } from "../shared/types.ts";

export interface ToolContext {
  /** Lazily acquires the sandbox; pure-chat turns never call this. */
  sandbox(): Promise<Sandbox>;
  signal?: AbortSignal;
}

const MAX_OUTPUT_CHARS = 30_000;

/** Keep head and tail of oversized output so both the start and the final error remain visible. */
export function truncateOutput(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[... ${s.length - max} chars truncated ...]\n\n${s.slice(-half)}`;
}

function tool<S extends TSchema>(
  name: BuiltinToolName,
  description: string,
  parameters: S,
  run: (params: Static<S>, signal?: AbortSignal) => Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters,
    async execute(_id, params, signal): Promise<AgentToolResult<undefined>> {
      const text = await run(params as Static<S>, signal);
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
      Type.Object({
        command: Type.String({ description: "Bash command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
      }),
      async ({ command, timeout }, signal) => {
        const sb = await ctx.sandbox();
        let out = "";
        let code: number | undefined;
        const opts = { cwd: sb.workdir, timeoutMs: timeout ? timeout * 1000 : undefined, signal: signal ?? ctx.signal };
        for await (const chunk of sb.exec(command, opts)) {
          if (chunk.type === "exit") code = chunk.code;
          else out += chunk.data ?? "";
        }
        const body = truncateOutput(out);
        if (code !== 0) throw new Error(`${body}\n\nCommand exited with code ${code ?? "unknown"}`);
        return body || "(no output)";
      },
    ),

  read: (ctx) =>
    tool(
      "read",
      "Read a text file with line numbers. Use offset (1-indexed) and limit for large files.",
      Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        offset: Type.Optional(Type.Number({ description: "First line to read (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      }),
      async ({ path, offset, limit }) => {
        const sb = await ctx.sandbox();
        const lines = (await readText(sb, resolvePath(sb, path))).split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines)`);
        const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
        let out = lines
          .slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
          .join("\n");
        if (end < lines.length) out += `\n\n[${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
        return truncateOutput(out);
      },
    ),

  write: (ctx) =>
    tool(
      "write",
      "Write content to a file, creating or overwriting it.",
      Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        content: Type.String({ description: "Full file content" }),
      }),
      async ({ path, content }) => {
        const sb = await ctx.sandbox();
        const data = Buffer.from(content, "utf8");
        await sb.writeFile(resolvePath(sb, path), data);
        return `Wrote ${data.length} bytes to ${path}`;
      },
    ),

  edit: (ctx) =>
    tool(
      "edit",
      "Replace exactly one occurrence of oldText with newText in a file. oldText must match exactly and be unique.",
      Type.Object({
        path: Type.String({ description: "Path relative to the workspace root" }),
        oldText: Type.String({ description: "Exact text to replace (must be unique in the file)" }),
        newText: Type.String({ description: "Replacement text" }),
      }),
      async ({ path, oldText, newText }) => {
        const sb = await ctx.sandbox();
        const abs = resolvePath(sb, path);
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

export function createTools(names: BuiltinToolName[], ctx: ToolContext): AgentTool[] {
  return names.map((name) => {
    const make = factories[name];
    if (!make) throw new Error(`Unknown builtin tool: ${name}`);
    return make(ctx);
  });
}
