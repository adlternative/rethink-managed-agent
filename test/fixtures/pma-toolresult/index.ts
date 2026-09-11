import type { PluginAPI, ToolResultContent } from "../../../src/plugins/api.ts";

// Two tool_result handlers to exercise the structured-content middleware chain:
// (A) redacts SECRET in text blocks and leaves non-text blocks (images) untouched;
// (B) appends a block echoing the text it *sees* — which must be A's already-redacted output.
export default function (p: PluginAPI) {
  p.on("tool_result", (ev) => ({
    content: ev.content.map((b): ToolResultContent => (b.type === "text" ? { type: "text", text: b.text.replaceAll("SECRET", "[redacted]") } : b)),
  }));
  p.on("tool_result", (ev) => {
    const seen = ev.content.filter((b): b is Extract<ToolResultContent, { type: "text" }> => b.type === "text").map((b) => b.text).join("|");
    return { content: [...ev.content, { type: "text", text: `seen:${seen}` }] };
  });
}
