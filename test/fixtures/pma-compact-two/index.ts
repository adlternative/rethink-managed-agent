import type { PluginAPI } from "../../../src/plugins/api.ts";

// A second before_compact plugin that also claims the summary — used to test the single-owner rule:
// whichever plugin is registered first wins, and this one's summary is dropped with a warning.
export default function (p: PluginAPI) {
  p.on("before_compact", () => ({ summary: "SECOND-PLUGIN-SUMMARY" }));
}
