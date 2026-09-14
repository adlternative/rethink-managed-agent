import type { PluginAPI } from "../../../src/plugins/api.ts";

// Third plugin: a late claimant of the before_compact single-owner fields.
export default function (p: PluginAPI) {
  p.on("before_compact", () => ({ summary: "C-summary", keepRecentTokens: 5 }));
}
