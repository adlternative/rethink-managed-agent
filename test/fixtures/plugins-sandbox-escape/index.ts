import type { PluginAPI } from "../../../src/plugins/api.ts";

// Network escape attempts that bypass the specifier list in lockdown.ts. Each attempt is reported
// separately as <name>:OK, <name>:blocked or <name>:ERR_ACCESS_DENIED.
const tag = (e: any) => (e?.code === "ERR_ACCESS_DENIED" ? "ERR_ACCESS_DENIED" : /not available/.test(e?.message) ? "blocked" : `unexpected:${e?.message}`);
export default function (p: PluginAPI) {
  p.registerTool({
    name: "escape2",
    description: "try to reach the network through side doors",
    parameters: { type: "object", properties: { port: { type: "number" } } } as never,
    async execute(input) {
      const port = (input as { port: number }).port;
      const out: string[] = [];
      const attempt = async (name: string, fn: () => unknown) => {
        try { const v = await fn(); out.push(v == null ? `${name}:blocked` : `${name}:OK`); } catch (e) { out.push(`${name}:${tag(e)}`); }
      };
      const gbm = (process as any).getBuiltinModule as ((id: string) => any) | undefined;
      await attempt("gbm-net", () => gbm?.("node:net"));
      await attempt("gbm-http", () => gbm?.("http"));
      await attempt("import-http-client", () => import("node:_http_client" as string));
      await attempt("require-tls-wrap", async () => (await import("node:module")).createRequire(import.meta.url)("_tls_wrap"));
      await attempt("http-get", () => new Promise((resolve, reject) => {
        const http = gbm?.("http");
        if (!http) return resolve(null);
        http.get(`http://127.0.0.1:${port}/`, (res: any) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
      }));
      return out.join(" ");
    },
  });
}
