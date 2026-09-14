import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PluginHost, type Capabilities } from "../src/plugins/client.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const session = { sessionId: "sess_l", agentId: "agent_l", workspaceId: "ws_l" };
const caps = new Proxy({} as Capabilities, { get: () => async () => null });

let host: PluginHost;
let server: http.Server;
let hits = 0;
let text = "";
beforeAll(async () => {
  server = http.createServer((_req, res) => { hits++; res.end("reached"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = path.join(ROOT, "test/fixtures/plugins-sandbox-escape");
  host = await PluginHost.start([{ dir, source: dir, name: "esc", kind: "pma", plugins: ["index.ts"], skills: [], prompts: [] }], { agentId: "agent_l", repoRoot: ROOT });
  host.attach(session, caps);
  const t = host.agentTools(session).find((x) => x.name === "escape2")!;
  const r = (await t.execute("1", { port: (server.address() as AddressInfo).port })) as { content: { type: string; text: string }[] };
  text = r.content[0]!.text;
}, 30_000);
afterAll(() => { host?.stop(); server?.close(); });

const blocked = (name: string) => new RegExp(`${name}:(blocked|ERR_ACCESS_DENIED)`);

// Regression: lockdown.ts only hooks module resolution for a fixed specifier list; process.getBuiltinModule
// skips resolve hooks and the internal "_" builtins are not listed.
describe("runner-mode network lockdown side doors", () => {
  it("process.getBuiltinModule('node:net') is blocked", () => { expect(text).toMatch(blocked("gbm-net")); });
  it("process.getBuiltinModule('http') is blocked", () => { expect(text).toMatch(blocked("gbm-http")); });
  it("import('node:_http_client') is blocked", () => { expect(text).toMatch(blocked("import-http-client")); });
  it("createRequire(...)('_tls_wrap') is blocked", () => { expect(text).toMatch(blocked("require-tls-wrap")); });
  it("a real http.get to a local listener never reaches it", () => {
    expect(text).toMatch(blocked("http-get"));
    expect(hits).toBe(0);
  });
  it("every attempt was reported (the fixture ran)", () => {
    for (const n of ["gbm-net", "gbm-http", "import-http-client", "require-tls-wrap", "http-get"]) expect(text).toContain(`${n}:`);
  });
});
