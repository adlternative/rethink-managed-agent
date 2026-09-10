import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * This plugin deliberately uses the global fetch and node:fs instead of ctx.*: it only works when the
 * host runs inside the sandbox (environment.plugin_host = "sandbox", network = "bridge"). In runner
 * mode the lockdown makes both calls throw, which is the intended, visible failure.
 */
const UA = "Mozilla/5.0 (compatible; pma-plugin-web-search/0.1)";
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

export default function (p: PluginAPI) {
  p.registerTool({
    name: "web_search",
    description: "Search the web (Bing) from inside the sandbox; returns the top results as title, url and snippet.",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    async execute({ query, limit }) {
      const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, { headers: { "user-agent": UA, "accept-language": "en" } });
      const html = await res.text();
      const out: string[] = [];
      // Bing wraps result links in /ck/a?...&u=a1<base64url of the real URL>; decode when present.
      const realUrl = (href: string) => {
        const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href.replace(/&amp;/g, "&"));
        return m ? Buffer.from(m[1]!, "base64url").toString("utf8") : href;
      };
      const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < (limit ?? 5)) {
        const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]!)?.[1] ?? "";
        out.push(`- ${strip(m[2]!)}\n  ${realUrl(m[1]!)}\n  ${strip(snippet).slice(0, 300)}`);
      }
      return out.length ? `HTTP ${res.status}\n${out.join("\n")}` : `HTTP ${res.status}: no results parsed (${html.length} bytes)`;
    },
  });
  p.registerTool({
    name: "fetch_to_file",
    description: "Download a URL straight into a file in the workspace (relative path) using the sandbox's own network and filesystem.",
    parameters: Type.Object({ url: Type.String(), path: Type.String() }),
    async execute({ url, path: rel }) {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const res = await fetch(url, { headers: { "user-agent": UA } });
      const buf = new Uint8Array(await res.arrayBuffer());
      const abs = nodePath.resolve(process.cwd(), rel);
      if (!abs.startsWith(process.cwd())) throw new Error("path escapes workspace");
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      return `HTTP ${res.status}: wrote ${buf.length} bytes to ${rel} (cwd ${process.cwd()})`;
    },
  });
}
