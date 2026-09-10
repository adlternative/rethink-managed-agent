import type { UiAPI } from "../src/ui-api.ts";
import { execFile } from "node:child_process";

/** Rings the bell (and, on macOS, posts a notification) when a run finishes; shows a 🔔 status segment. */
export default function (ui: UiAPI) {
  let enabled = true;
  ui.registerStatus("bell", () => (enabled ? "🔔" : "🔕"));
  ui.registerCommand({ name: "notify", description: "toggle end-of-run notifications", handler: (_a, ctx) => { enabled = !enabled; ctx.note(`notifications ${enabled ? "on" : "off"}`); } });
  ui.on("session.status_idle", (ev, ctx) => {
    if (!enabled) return;
    process.stdout.write("\x07");
    if (process.platform === "darwin") {
      const msg = `session ${ctx.session?.id ?? ""} finished (${ev.payload.stop_reason})`;
      execFile("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "pma"`], () => {});
    }
  });
}
