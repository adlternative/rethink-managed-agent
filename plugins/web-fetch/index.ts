import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

export default function (p: PluginAPI) {
  p.registerTool({
    name: "web_fetch",
    description: "Fetch a URL over HTTP(S) and return the response body as text (HTML tags stripped). Respects the deployment's domain allowlist.",
    parameters: Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Integer({ minimum: 100, maximum: 50000 })) }),
    async execute({ url, max_chars }, ctx) {
      const r = await ctx.fetch(url, { headers: { "user-agent": "pma-plugin-web-fetch/0.1" } });
      const text = r.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `HTTP ${r.status}\n${text.slice(0, max_chars ?? 8000)}`;
    },
  });
}
