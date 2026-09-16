import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/shared/env.ts";
import { authorizationHeader, normalizeMcpUrl, resolveMcpCredentials, sealMcpServers, type SealedMcpCredential } from "../src/infra/mcp-credentials.ts";
import { seal } from "../src/infra/secrets.ts";
import { runSession } from "../src/harness/run-turn.ts";
import { fakeDeps, sessionFixture, text, userMsg } from "./fixtures/harness-fakes/deps.ts";

const KEY = "a".repeat(64);
const saved = env.PMA_SECRET_KEY;
beforeEach(() => { env.PMA_SECRET_KEY = KEY; });
afterEach(() => { env.PMA_SECRET_KEY = saved; vi.unstubAllGlobals(); });

const cred = (id: string, url: string, token: string): SealedMcpCredential => ({ id, mcp_server_url: url, secret: seal(token) });
const server = { label: "docs", url: "https://docs.example.com/mcp" };

describe("matching a vault credential to a declared MCP server", () => {
  it("ignores host casing, a default port and a trailing slash, but not path, subdomain or a real port", () => {
    const target = normalizeMcpUrl("https://docs.example.com/mcp");
    for (const same of ["https://DOCS.Example.com/mcp", "https://docs.example.com:443/mcp", "https://docs.example.com/mcp/", "https://docs.example.com/mcp//"]) {
      expect(normalizeMcpUrl(same)).toBe(target);
    }
    for (const other of ["https://docs.example.com/mcp/v2", "https://api.docs.example.com/mcp", "https://docs.example.com:8443/mcp", "http://docs.example.com/mcp"]) {
      expect(normalizeMcpUrl(other)).not.toBe(target);
    }
  });

  it("a bare token becomes a bearer; one that already names its scheme is sent unchanged", () => {
    expect(authorizationHeader("lin_api_key")).toBe("Bearer lin_api_key");
    expect(authorizationHeader(" ghp_token \n")).toBe("Bearer ghp_token");
    expect(authorizationHeader("Bearer already")).toBe("Bearer already");
    expect(authorizationHeader("Basic dXNlcjpwdw==")).toBe("Basic dXNlcjpwdw==");
  });
});

describe("resolving which credential an MCP server connects with", () => {
  it("uses the vault credential whose URL matches", () => {
    const creds = [cred("vcrd_other", "https://other.example.com/mcp", "NOPE"), cred("vcrd_docs", "https://DOCS.example.com/mcp/", "TOKEN-A")];
    expect(resolveMcpCredentials(server, creds)).toEqual({ authorization: "Bearer TOKEN-A" });
  });

  it("no match connects unauthenticated instead of failing (a public MCP server still works)", () => {
    expect(resolveMcpCredentials(server, [cred("vcrd_other", "https://other.example.com/mcp", "NOPE")])).toBeNull();
    expect(resolveMcpCredentials(server, [])).toBeNull();
  });

  it("the first vault with a match wins (credentials arrive in vault order)", () => {
    const creds = [cred("vcrd_1", "https://docs.example.com/mcp", "FIRST"), cred("vcrd_2", "https://docs.example.com/mcp", "SECOND")];
    expect(resolveMcpCredentials(server, creds)).toEqual({ authorization: "Bearer FIRST" });
  });

  it("an explicit credential_id wins over the URL match, and a stale one connects unauthenticated", () => {
    const creds = [cred("vcrd_url", "https://docs.example.com/mcp", "BY-URL"), cred("vcrd_pick", "https://other.example.com/mcp", "PICKED")];
    expect(resolveMcpCredentials({ ...server, credential_id: "vcrd_pick" }, creds)).toEqual({ authorization: "Bearer PICKED" });
    expect(resolveMcpCredentials({ ...server, credential_id: "vcrd_archived" }, creds)).toBeNull();
  });

  it("the session's own sealed credentials win over a URL match; declared headers always travel along", () => {
    const [inline] = sealMcpServers([{ ...server, authorization: "Bearer INLINE", headers: { "x-tenant": "t1" } }]);
    const creds = [cred("vcrd_url", "https://docs.example.com/mcp", "BY-URL")];
    expect(resolveMcpCredentials(inline!, creds)).toEqual({ authorization: "Bearer INLINE", headers: { "x-tenant": "t1" } });

    // headers only: the vault still supplies the identity
    const [headersOnly] = sealMcpServers([{ ...server, headers: { "x-tenant": "t1" } }]);
    expect(resolveMcpCredentials(headersOnly!, creds)).toEqual({ authorization: "Bearer BY-URL", headers: { "x-tenant": "t1" } });
  });

  it("a credential sealed with another key throws instead of connecting with garbage", () => {
    const creds = [cred("vcrd_docs", server.url, "TOKEN-A")];
    env.PMA_SECRET_KEY = "b".repeat(64);
    expect(() => resolveMcpCredentials(server, creds)).toThrow();
  });
});

describe("the runner connects with the vault credential", () => {
  function mcpServer(onRequest: (headers: Record<string, string>) => void) {
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      onRequest(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])));
      const body = JSON.parse(init.body);
      const result = body.method === "tools/list" ? { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("a server declared without credentials is authenticated from the session's vault", async () => {
    const seen: Record<string, string>[] = [];
    mcpServer((h) => seen.push(h));
    const f = fakeDeps({ session: sessionFixture({}, { mcp_servers: [server] }), events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.principalFetchAllow = async () => "*";
    f.deps.mcpCredentials = async (s) => resolveMcpCredentials(s, [cred("vcrd_docs", server.url, "VAULT-TOKEN")]);
    await runSession("sess_1", f.deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.authorization === "Bearer VAULT-TOKEN")).toBe(true);
    expect(f.payloads("plugin.message")).toEqual([]); // connected fine, no "unavailable" note
  });

  it("with no matching credential the server is still called, unauthenticated", async () => {
    const seen: Record<string, string>[] = [];
    mcpServer((h) => seen.push(h));
    const f = fakeDeps({ session: sessionFixture({}, { mcp_servers: [server] }), events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.principalFetchAllow = async () => "*";
    f.deps.mcpCredentials = async (s) => resolveMcpCredentials(s, []);
    await runSession("sess_1", f.deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((h) => h.authorization !== undefined)).toBe(false);
  });
});

describe("the OpenAI agent echo never carries a credential", () => {
  it("an inline transport token is stored redacted, while the sealed copy still opens", async () => {
    const { openaiAgentEcho } = await import("../src/api/routes/compat/translate.ts");
    const { sealMcpServers, openMcpCredentials, REDACTED } = await import("../src/infra/mcp-credentials.ts");
    const spec = { model: "qoder/auto", tools: [{ type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://docs.example.com/mcp", authorization: "Bearer ECHO-SECRET", headers: { "x-api-key": "HEADER-SECRET" } } }] };
    const echo = openaiAgentEcho(spec);
    const raw = JSON.stringify(echo);
    expect(raw).not.toContain("ECHO-SECRET");
    expect(raw).not.toContain("HEADER-SECRET");
    expect((echo.tools[0] as any).transport).toEqual({ type: "http", server_url: "https://docs.example.com/mcp", authorization: REDACTED, headers: { "x-api-key": REDACTED } });
    // the credential itself survives where the runner reads it
    const [sealed] = sealMcpServers([{ label: "docs", url: "https://docs.example.com/mcp", authorization: "Bearer ECHO-SECRET" }]);
    expect(openMcpCredentials(sealed!).authorization).toBe("Bearer ECHO-SECRET");
  });
});
