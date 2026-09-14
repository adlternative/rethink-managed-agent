import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/shared/env.ts";
import { hasMcpCredentials, openMcpCredentials, REDACTED, redactMcpServers, sealMcpServers } from "../src/infra/mcp-credentials.ts";
import { runSession } from "../src/harness/run-turn.ts";
import { fakeDeps, sessionFixture, text, userMsg } from "./fixtures/harness-fakes/deps.ts";

const KEY = "a".repeat(64);
const saved = env.PMA_SECRET_KEY;
beforeEach(() => { env.PMA_SECRET_KEY = KEY; });
afterEach(() => { env.PMA_SECRET_KEY = saved; vi.unstubAllGlobals(); });

const TOKEN = "Bearer SUPER-SECRET-MCP-TOKEN";
const decl = { label: "docs", url: "https://docs.example.com/mcp", authorization: TOKEN, headers: { "x-api-key": "HEADER-SECRET", "x-tenant": "t1" }, allowed_tools: ["search"] };

describe("MCP credentials at rest", () => {
  it("sealing drops the plaintext, keeps only which credentials exist, and opens back to the original", () => {
    const [sealed] = sealMcpServers([decl]);
    const raw = JSON.stringify(sealed);
    expect(raw).not.toContain("SUPER-SECRET-MCP-TOKEN");
    expect(raw).not.toContain("HEADER-SECRET");
    expect(sealed).toMatchObject({ label: "docs", url: decl.url, allowed_tools: ["search"], has_authorization: true, header_names: ["x-api-key", "x-tenant"], secret: { type: "encrypted" } });
    expect(sealed!.authorization).toBeUndefined();
    expect(sealed!.headers).toBeUndefined();
    expect(openMcpCredentials(sealed!)).toEqual({ authorization: TOKEN, headers: decl.headers });
  });

  it("servers without credentials pass through unchanged; hasMcpCredentials tells them apart", () => {
    const plain = { label: "open", url: "https://open.example.com/mcp" };
    expect(sealMcpServers([plain])).toEqual([plain]);
    expect(hasMcpCredentials([plain])).toBe(false);
    expect(hasMcpCredentials([plain, decl])).toBe(true);
    expect(hasMcpCredentials([{ ...plain, headers: {} }])).toBe(false);
  });

  it("redaction shows neither plaintext nor ciphertext, for sealed and for legacy plaintext servers", () => {
    const [sealed] = sealMcpServers([decl]);
    for (const view of [redactMcpServers([sealed!])!, redactMcpServers([decl])!]) {
      const raw = JSON.stringify(view);
      expect(raw).not.toContain("SUPER-SECRET-MCP-TOKEN");
      expect(raw).not.toContain("HEADER-SECRET");
      expect(raw).not.toContain(sealed!.secret!.ct);
      expect(view[0]).toEqual({ label: "docs", url: decl.url, allowed_tools: ["search"], authorization: REDACTED, headers: { "x-api-key": REDACTED, "x-tenant": REDACTED } });
    }
    // headers only: no authorization marker
    const [headersOnly] = sealMcpServers([{ label: "h", url: "https://h.example.com/mcp", headers: { "x-key": "v" } }]);
    expect(redactMcpServers([headersOnly!])![0]).toEqual({ label: "h", url: "https://h.example.com/mcp", headers: { "x-key": REDACTED } });
  });

  it("legacy plaintext servers still open (the runner can call them until they are resealed)", () => {
    expect(openMcpCredentials(decl)).toEqual({ authorization: TOKEN, headers: decl.headers });
  });

  it("opening with a different key fails loudly instead of sending garbage", () => {
    const [sealed] = sealMcpServers([decl]);
    env.PMA_SECRET_KEY = "b".repeat(64);
    expect(() => openMcpCredentials(sealed!)).toThrow();
  });
});

describe("runner calls a sealed MCP server with the decrypted credentials", () => {
  function mcpServer(onRequest: (headers: Record<string, string>) => void) {
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      onRequest(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])));
      const body = JSON.parse(init.body);
      const result = body.method === "tools/list" ? { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("the MCP server receives the real Authorization and headers; the model sees the tool", async () => {
    const seen: Record<string, string>[] = [];
    mcpServer((h) => seen.push(h));
    const f = fakeDeps({ session: sessionFixture({}, { mcp_servers: sealMcpServers([decl]) }), events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.principalFetchAllow = async () => "*";
    f.deps.mcpCredentials = (s) => openMcpCredentials(s);
    await runSession("sess_1", f.deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.authorization === TOKEN && h["x-api-key"] === "HEADER-SECRET")).toBe(true);
    expect(f.payloads("plugin.message")).toEqual([]); // connected fine, no "unavailable" note
  });

  it("undecryptable credentials skip the server with a note instead of failing the run", async () => {
    const seen: Record<string, string>[] = [];
    mcpServer((h) => seen.push(h));
    const f = fakeDeps({ session: sessionFixture({}, { mcp_servers: sealMcpServers([decl]) }), events: [userMsg("hi")], replies: [text("ok")] });
    f.deps.principalFetchAllow = async () => "*";
    env.PMA_SECRET_KEY = "c".repeat(64); // the runner has a different key than the one that sealed
    f.deps.mcpCredentials = (s) => openMcpCredentials(s);
    await runSession("sess_1", f.deps);
    expect(seen).toEqual([]); // never called the server with wrong credentials
    const notes = f.payloads("plugin.message").map((p: any) => p.content.map((c: any) => c.text).join(""));
    expect(notes.join("\n")).toMatch(/could not be decrypted/);
  });
});
