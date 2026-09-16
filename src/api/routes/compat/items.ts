import type { ContentBlock, SessionResource } from "../../../shared/types.ts";

/**
 * How a rethink tool call is projected into the OpenAI Agents API item union. Shared by the item list
 * and the SSE stream so both describe the same call the same way.
 *
 * The distinction matters beyond cosmetics: the SDK treats a `function_call` item as a call IT must
 * answer (its toolHandlers run and post a tool_result back). Only a tool the caller actually declared
 * is one of those. A server-side tool must never be projected as `function_call`, or the SDK answers a
 * call that was already executed here.
 */
export type ItemKind = "function_call" | "mcp_call" | "command_execution" | "none";

export function itemKindOf(name: string, clientTools: Set<string>): ItemKind {
  if (clientTools.has(name)) return "function_call";
  if (name.includes("__")) return "mcp_call"; // MCP tools are namespaced `serverLabel__tool`
  if (name === "bash") return "command_execution";
  return "none"; // sandbox file tools and harness tools have no item type in this dialect
}

export const clientToolSet = (session: SessionResource) => new Set((session.agent.client_tools ?? []).map((t) => t.name));

export const textOf = (content: { type: string; text?: string }[] | ContentBlock[]) =>
  (content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");

export interface ToolUse { name: string; tool_use_id: string; input?: unknown }
export interface ToolResult { content: { type: string; text?: string }[]; is_error?: boolean }

/**
 * One tool call as its SDK item. An `mcp_call` and a `command_execution` carry their own result, so the
 * result event folds into the same item instead of becoming a separate output item.
 */
export function toolUseItem(p: ToolUse, kind: Exclude<ItemKind, "none">, result?: ToolResult): Record<string, unknown> | null {
  const status = result ? (result.is_error ? "failed" : "completed") : "in_progress";
  const output = result ? textOf(result.content) : null;
  if (kind === "mcp_call") {
    const [server_label, ...rest] = p.name.split("__");
    return { type: "mcp_call", call_id: p.tool_use_id, server_label, name: rest.join("__"), arguments: p.input, output: result?.is_error ? null : output, error: result?.is_error ? output : null, status };
  }
  if (kind === "command_execution") {
    const input = (p.input ?? {}) as { command?: string; cwd?: string };
    return { type: "command_execution", command: input.command ?? "", cwd: input.cwd ?? "", output, exit_code: result ? (result.is_error ? 1 : 0) : null, duration_ms: null, status };
  }
  return { type: "function_call", call_id: p.tool_use_id, name: p.name, arguments: p.input, status: result ? "completed" : "in_progress" };
}
