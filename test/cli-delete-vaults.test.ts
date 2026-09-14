import { afterEach, describe, expect, it } from "vitest";
import { cli, sendJson, startStub, type Handler } from "./fixtures/cli-stub.ts";

let stub: Awaited<ReturnType<typeof startStub>> | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
const serve = async (h: Handler) => (stub = await startStub(h));

describe("cli: agents/envs delete and sessions create --vaults", () => {
  it("agents delete / envs delete hit DELETE and report removed vs archived", async () => {
    const s = await serve((r, res) => sendJson(res, 200, { id: r.path.split("/").pop(), deleted: true, archived: r.path.includes("environments") }));
    const a = await cli(s.url, ["agents", "delete", "agent_1"]);
    expect(a).toMatchObject({ code: 0, stdout: "deleted agent_1\n" });
    const e = await cli(s.url, ["envs", "rm", "env_1"]);
    expect(e.code).toBe(0);
    expect(e.stdout).toMatch(/^archived env_1 /);
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /v1/agents/agent_1", "DELETE /v1/environments/env_1"]);
    const j = await cli(s.url, ["agents", "delete", "agent_2", "--json"]);
    expect(JSON.parse(j.stdout)).toEqual({ id: "agent_2", deleted: true, archived: false });
  });

  it("delete without an id is a usage error (exit 2) and sends nothing", async () => {
    const s = await serve((_r, res) => sendJson(res, 200, {}));
    expect((await cli(s.url, ["agents", "delete"])).code).toBe(2);
    expect((await cli(s.url, ["envs", "delete"])).code).toBe(2);
    expect(s.requests).toHaveLength(0);
  });

  it("sessions create --vaults sends vault_ids", async () => {
    const s = await serve((r, res) => sendJson(res, 201, { id: "sess_1", ...(r.json ?? {}) }));
    const r = await cli(s.url, ["sessions", "create", "--agent", "agent_1", "--env", "env_1", "--vaults", "vault_a,vault_b", "--json"]);
    expect(r.code).toBe(0);
    expect(s.requests[0]).toMatchObject({ method: "POST", path: "/v1/sessions" });
    expect(s.requests[0]!.json).toMatchObject({ agent: "agent_1", environment_id: "env_1", vault_ids: ["vault_a", "vault_b"] });
  });
});

describe("cli: stale keep-alive socket", () => {
  it("retries an idempotent GET once when the server drops the connection before responding; never retries a POST", async () => {
    let gets = 0, posts = 0;
    const s = await serve((r, res) => {
      if (r.method === "GET" && gets++ === 0) return void res.socket?.destroy(); // first GET: connection dropped with no response
      if (r.method === "POST") { posts++; return void res.socket?.destroy(); }
      sendJson(res, 200, { data: [] });
    });
    expect((await cli(s.url, ["agents", "list", "--json"])).code).toBe(0);
    expect(gets).toBe(2);
    const w = await cli(s.url, ["agents", "create", "x", "qoder/auto"]);
    expect(w.code).toBe(1);
    expect(posts).toBe(1);
  });
});
