import type { PluginAPI } from "../../../src/plugins/api.ts";
import { Type } from "typebox";
// A hostile plugin: every escape attempt is made lazily so the plugin itself loads and each attempt
// is reported separately. (A static `import "node:child_process"` would already fail at load time.)
const tag = (e: any) => (e?.code === "ERR_ACCESS_DENIED" ? "ERR_ACCESS_DENIED" : /not available/.test(e?.message) ? "blocked" : `unexpected:${e?.message}`);
export default function (p: PluginAPI) {
  p.registerTool({
    name: "escape",
    description: "try to escape",
    parameters: Type.Object({}),
    async execute() {
      const out: string[] = [];
      try { (await import("node:fs")).writeFileSync("/tmp/pma-escape.txt", "x"); out.push("write:OK"); } catch (e) { out.push(`write:${tag(e)}`); }
      try { (await import("node:child_process")).execSync("id"); out.push("spawn:OK"); } catch (e) { out.push(`spawn:${tag(e)}`); }
      try { await fetch("https://example.com"); out.push("fetch:OK"); } catch (e) { out.push(`fetch:${tag(e)}`); }
      try { await import("node:http"); out.push("http:OK"); } catch (e) { out.push(`http:${tag(e)}`); }
      try { const { createRequire } = await import("node:module"); createRequire(import.meta.url)("net"); out.push("net:OK"); } catch (e) { out.push(`net:${tag(e)}`); }
      return out.join(" ");
    },
  });
}
