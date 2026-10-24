import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiError, cli, sendJson, startStub, type Handler } from "./fixtures/cli-stub.ts";

let stub: Awaited<ReturnType<typeof startStub>> | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
const serve = async (h: Handler) => (stub = await startStub(h));
const echo: Handler = (r, res) => sendJson(res, r.method === "POST" ? 201 : 200, { id: "x_1", ...(r.json ?? {}) });

describe("cli config and errors", () => {
  it("sends the bearer key from PMA_API_KEY, strips a trailing slash from PMA_API and falls back to PI_API", async () => {
    const s = await serve((_r, res) => sendJson(res, 200, { data: [] }));
    expect((await cli(`${s.url}/`, ["agents", "list"], { PMA_API_KEY: "pma_k" })).code).toBe(0);
    expect(s.requests[0]).toMatchObject({ method: "GET", path: "/v1/agents" });
    expect(s.requests[0]!.headers.authorization).toBe("Bearer pma_k");
    expect((await cli("", ["agents", "list"], { PMA_API: "", PI_API: s.url })).code).toBe(0);
    expect(s.requests[1]!.headers.authorization).toBeUndefined();
  });

  it("an API error prints status, type and message and exits 1; a proxy HTML page keeps its status", async () => {
    let n = 0;
    const s = await serve((_r, res) => {
      if (n++ === 0) return apiError(res, 404, "not_found_error", "agent agent_nope not found");
      res.writeHead(502, { "content-type": "text/html" }); res.end("<html>\n<body>bad gateway</body></html>");
    });
    expect(await cli(s.url, ["agents", "get", "agent_nope"])).toEqual({ code: 1, stdout: "", stderr: "HTTP 404 not_found_error: agent agent_nope not found\n" });
    const r = await cli(s.url, ["models"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("HTTP 502: <html> <body>bad gateway</body></html>\n");
  });

  it("an unreachable API names the base URL (exit 1); misuse exits 2", async () => {
    const r = await cli("http://127.0.0.1:1", ["agents", "list"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot reach the API at http:\/\/127\.0\.0\.1:1/);
    expect((await cli("http://127.0.0.1:1", ["bogus"])).code).toBe(2);
    expect((await cli("http://127.0.0.1:1", ["agent", "foo"])).code).toBe(2);
    expect((await cli("http://127.0.0.1:1", ["events"])).code).toBe(2);
    expect((await cli("http://127.0.0.1:1", ["send", "sess_x", "hi", "--timeout", "5"])).code).toBe(2);
    expect((await cli("http://127.0.0.1:1", [])).code).toBe(2);
  });

  it("help is printed per command with exit 0", async () => {
    const top = await cli("http://127.0.0.1:1", ["--help"]);
    expect(top.code).toBe(0);
    for (const cmd of ["agents", "envs", "sessions", "vaults", "schedules", "memory-stores", "files", "skills", "providers", "models", "sandboxes", "send", "stream", "events", "interrupt", "worker"]) expect(top.stdout).toContain(`  ${cmd} `);
    const vault = await cli("http://127.0.0.1:1", ["vault", "--help"]);
    expect(vault.code).toBe(0);
    expect(vault.stdout).toContain("vaults credentials put <vault> <name>");
    expect((await cli("http://127.0.0.1:1", ["help", "send"])).stdout).toContain("--timeout SEC");
  });

  it("ids are URL-encoded so a pasted value cannot reach another route", async () => {
    const s = await serve((_r, res) => sendJson(res, 200, { data: [], has_more: false }));
    await cli(s.url, ["events", "../agents"]);
    expect(s.requests[0]!.path).toBe("/v1/sessions/..%2Fagents/events?limit=1000&since=0");
  });
});

describe("cli resource commands", () => {
  it("agents create: the documented positional form and the legacy flag form build the same body", async () => {
    const s = await serve(echo);
    expect((await cli(s.url, ["agents", "create", "coder", "qoder/kmodel", "--packages", "/app/plugins/goal,npm:x", "--tools", "bash,read", "--skills", "skill_a", "--system", "be careful"])).code).toBe(0);
    expect((await cli(s.url, ["agent", "create", "--name=dev", "--provider", "qoder", "--model", "ultimate"])).code).toBe(0);
    expect(s.requests.map((r) => [r.method, r.path, r.json])).toEqual([
      ["POST", "/v1/agents", { name: "coder", model: { provider: "qoder", id: "kmodel" }, system: "be careful", tools: ["bash", "read"], packages: ["/app/plugins/goal", "npm:x"], skills: ["skill_a"] }],
      ["POST", "/v1/agents", { name: "dev", model: { provider: "qoder", id: "ultimate" } }],
    ]);
  });

  it("agents update --no-system sends null; a disallowed package 400 surfaces its message", async () => {
    const s = await serve((r, res) => (r.method === "POST" ? apiError(res, 400, "invalid_request_error", "these plugin packages are not allowed in any placement: npm:evil") : echo(r, res)));
    expect((await cli(s.url, ["agents", "update", "agent_1", "--no-system", "--model", "anthropic/claude-sonnet-4-6"])).code).toBe(0);
    expect(s.requests[0]).toMatchObject({ method: "PATCH", path: "/v1/agents/agent_1", json: { system: null, model: { provider: "anthropic", id: "claude-sonnet-4-6" } } });
    const r = await cli(s.url, ["agents", "create", "x", "qoder/kmodel", "--packages", "npm:evil"]);
    expect(r).toMatchObject({ code: 1, stderr: "HTTP 400 invalid_request_error: these plugin packages are not allowed in any placement: npm:evil\n" });
  });

  it("envs create maps network / plugin-host / git ref, and a byoc worker_key gets a start hint", async () => {
    const s = await serve((r, res) => sendJson(res, 201, { id: "env_b", worker_key: r.json.provider === "byoc" ? "wk_secret" : null, ...r.json }));
    expect((await cli(s.url, ["envs", "create", "web", "--provider", "docker", "--image", "node:22-alpine", "--network", "bridge", "--plugin-host", "sandbox", "--git", "https://github.com/x/y", "--ref", "main"])).code).toBe(0);
    expect(s.requests[0]!.json).toEqual({ name: "web", provider: "docker", image: "node:22-alpine", network: "bridge", plugin_host: "sandbox", workspace: { kind: "git", remote: "https://github.com/x/y", ref: "main" } });
    const byoc = await cli(s.url, ["env", "create", "--name", "laptop", "--provider", "byoc"]);
    expect(byoc.code).toBe(0);
    expect(JSON.parse(byoc.stdout).worker_key).toBe("wk_secret");
    expect(byoc.stderr).toContain("worker --env env_b --key wk_secret");
    expect(s.requests[1]!.json).toEqual({ name: "laptop", provider: "byoc", workspace: { kind: "empty" } });
  });

  it("sessions create maps --model, --message, --memory-stores, --environments and --parent", async () => {
    const s = await serve(echo);
    expect((await cli(s.url, ["sessions", "create", "--agent", "agent_a", "--env", "env_e", "--model", "qoder/auto", "--message", "hello", "--memory-stores", "mem_a:memories/notes,mem_b", "--parent", "sess_p", "--workspace-id", "ws_1"])).code).toBe(0);
    expect(s.requests[0]!.json).toEqual({
      agent: { type: "agent_with_overrides", id: "agent_a", model: { provider: "qoder", id: "auto" } }, environment_id: "env_e", workspace_id: "ws_1", parent_id: "sess_p",
      memory_stores: [{ memory_store_id: "mem_a", mount_path: "memories/notes" }, "mem_b"],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
    });
    expect((await cli(s.url, ["session", "create", "--agent", "agent_a", "--environments", "main=env_l,dk=env_d:fork"])).code).toBe(0);
    expect(s.requests[1]!.json).toEqual({ agent: "agent_a", environments: [{ key: "main", environment_id: "env_l" }, { key: "dk", environment_id: "env_d", fork_from: "main" }] });
    expect((await cli(s.url, ["sessions", "create", "--agent", "agent_a"])).code).toBe(2);
  });

  it("schedules create/enable/disable map to /v1/schedules", async () => {
    const s = await serve(echo);
    expect((await cli(s.url, ["schedules", "create", "--cron", "0 9 * * *", "--timezone", "UTC", "--name", "digest", "--action", "create", "--agent", "agent_a", "--env", "env_e", "--message", "hi"])).code).toBe(0);
    expect(s.requests[0]).toMatchObject({
      method: "POST", path: "/v1/schedules",
      json: { cron: "0 9 * * *", timezone: "UTC", name: "digest", action: { type: "session.create", agent_id: "agent_a", environment_id: "env_e", message: "hi" } },
    });
    expect((await cli(s.url, ["schedule", "disable", "sched_1"])).code).toBe(0);
    expect((await cli(s.url, ["schedules", "enable", "sched_1"])).code).toBe(0);
    expect(s.requests.slice(1).map((r) => [r.method, r.path, r.json])).toEqual([
      ["PATCH", "/v1/schedules/sched_1", { enabled: false }],
      ["PATCH", "/v1/schedules/sched_1", { enabled: true }],
    ]);
    expect((await cli(s.url, ["schedules", "create", "--cron", "0 * * * *"])).code).toBe(2);
  });

  it("plugins list shows the catalogue and passes a search query", async () => {
    const s = await serve((r, res) => sendJson(res, 200, { data: [
      { name: "outcome", source: "/app/plugins/outcome", description: "grade the run against a rubric", allowed: { runner: true, sandbox: true } },
      { name: "team", source: "/app/plugins/team", description: "agent teams", allowed: { runner: false, sandbox: true } },
    ] }));
    const all = await cli(s.url, ["plugins"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("/app/plugins/outcome");
    expect(all.stdout).toContain("runner+sandbox");
    expect(all.stdout).toContain("sandbox"); // team runs only there
    expect((await cli(s.url, ["plugins", "outcome"])).code).toBe(0);
    expect((await cli(s.url, ["plugins", "search", "outcome"])).code).toBe(0);
    // a bare word is taken as the search query, the same as `plugins search <word>`
    expect(s.requests.map((r) => r.path)).toEqual(["/v1/plugins", "/v1/plugins?q=outcome", "/v1/plugins?q=outcome"]);
  });

  it("plugins can be brought to one session: --packages at create, add/remove/list while it runs", async () => {
    const s = await serve((r, res) => {
      if (r.method === "GET" && r.path === "/v1/agents/agent_a") return sendJson(res, 200, { id: "agent_a", packages: ["/app/plugins/team"] });
      if (r.method === "GET" && r.path.startsWith("/v1/sessions/sess_1")) return sendJson(res, 200, { id: "sess_1", agent: { packages: ["npm:pma-plugin-outcome"] } });
      return sendJson(res, r.method === "POST" ? 201 : 200, { id: "sess_1", agent: { packages: [] } });
    });
    expect((await cli(s.url, ["sessions", "create", "--agent", "agent_a", "--env", "env_e", "--packages", "npm:pma-plugin-outcome,/app/plugins/verify"])).code).toBe(0);
    // the agent's own plugin survives: an override replaces the field, so the client unions it
    expect(s.requests[1]!.json.agent).toEqual({ type: "agent_with_overrides", id: "agent_a", packages: ["/app/plugins/team", "npm:pma-plugin-outcome", "/app/plugins/verify"] });

    expect((await cli(s.url, ["sessions", "packages", "add", "sess_1", "npm:pma-plugin-outcome"])).code).toBe(0);
    expect((await cli(s.url, ["sessions", "packages", "remove", "sess_1", "/app/plugins/verify"])).code).toBe(0);
    const listed = await cli(s.url, ["sessions", "packages", "list", "sess_1"]);
    expect(listed.stdout).toContain("npm:pma-plugin-outcome");
    expect(s.requests.slice(2).map((r) => [r.method, r.path])).toEqual([
      ["POST", "/v1/sessions/sess_1/packages"],
      ["DELETE", `/v1/sessions/sess_1/packages/${encodeURIComponent("/app/plugins/verify")}`],
      ["GET", "/v1/sessions/sess_1"],
    ]);
    expect((await cli(s.url, ["sessions", "packages", "add", "sess_1"])).code).toBe(2); // no source
  });

  it("sessions list prints a table, --all follows next_cursor, --json prints the data", async () => {
    const sess = (id: string) => ({ id, status: "idle", agent: { name: "dev", model: { provider: "qoder", id: "auto" } }, context: null, updated_at: "2026-01-01T00:00:00Z" });
    const s = await serve((r, res) => sendJson(res, 200, r.path.includes("cursor=c1") ? { data: [sess("sess_2")], has_more: false, next_cursor: null } : { data: [sess("sess_1")], has_more: true, next_cursor: "c1" }));
    const one = await cli(s.url, ["sessions", "list"]);
    expect(one.stdout).toMatch(/^ID\s+STATUS\s+AGENT\s+MODEL\s+CTX\s+UPDATED\nsess_1\s+idle\s+dev\s+qoder\/auto/);
    expect(one.stdout).toContain("pass --all");
    const all = await cli(s.url, ["sessions", "list", "--all", "--json"]);
    expect(JSON.parse(all.stdout).data.map((x: any) => x.id)).toEqual(["sess_1", "sess_2"]);
    expect(s.requests.map((r) => r.path)).toEqual(["/v1/sessions?limit=50", "/v1/sessions?limit=50", "/v1/sessions?limit=50&cursor=c1"]);
  });

  it("session sub-resources: archive, prompt, set-system, attach, mount, unmount, skill, delete, interrupt", async () => {
    const s = await serve((r, res) => sendJson(res, 200, r.path.endsWith("/system_prompt") ? { source: "preview", rendered: "You are pi" } : { id: "sess_1", events: [] }));
    const calls: string[][] = [
      ["sessions", "archive", "sess_1"], ["sessions", "prompt", "sess_1"], ["sessions", "set-system", "sess_1", "--system", "terse"],
      ["sessions", "attach", "sess_1", "browser=env_e:fork"], ["sessions", "mount", "sess_1", "mem_a:memories/a"], ["sessions", "unmount", "sess_1", "mem_a"],
      ["sessions", "skill", "sess_1", "add", "skill_s"], ["sessions", "skill", "sess_1", "remove", "skill_s"], ["sessions", "delete", "sess_1"], ["interrupt", "sess_1"],
    ];
    for (const c of calls) expect((await cli(s.url, c)).code, c.join(" ")).toBe(0);
    expect(s.requests.map((r) => [r.method, r.path, r.json])).toEqual([
      ["POST", "/v1/sessions/sess_1/archive", {}], ["GET", "/v1/sessions/sess_1/system_prompt", undefined], ["PATCH", "/v1/sessions/sess_1", { system: "terse" }],
      ["POST", "/v1/sessions/sess_1/environments", { key: "browser", environment_id: "env_e", fork_from: "main" }], ["POST", "/v1/sessions/sess_1/memory_stores", { memory_store_id: "mem_a", mount_path: "memories/a" }],
      ["DELETE", "/v1/sessions/sess_1/memory_stores/mem_a", undefined], ["POST", "/v1/sessions/sess_1/skills", { type: "custom", skill_id: "skill_s" }],
      ["DELETE", "/v1/sessions/sess_1/skills/skill_s", undefined], ["DELETE", "/v1/sessions/sess_1", undefined], ["POST", "/v1/sessions/sess_1/events", { events: [{ type: "user.interrupt" }] }],
    ]);
  });

  it("vault credentials: the secret goes in the request body only, never to stdout", async () => {
    const s = await serve((r, res) => {
      if (r.method === "POST" && r.path.endsWith("/credentials")) return sendJson(res, 201, { id: "cred_1", vault_id: "vlt_1", name: r.json.name, metadata: {}, created_at: "t" });
      if (r.path.endsWith("/credentials")) return sendJson(res, 200, { object: "list", data: [{ id: "cred_1", name: "GITHUB_TOKEN", created_at: "t" }] });
      return sendJson(res, 200, { id: "vlt_1", name: "ci", object: "vault" });
    });
    expect((await cli(s.url, ["vaults", "create", "ci", "--metadata", "team=infra"])).code).toBe(0);
    const put = await cli(s.url, ["vault", "credential", "put", "vlt_1", "GITHUB_TOKEN", "--value-env", "TOKEN_SRC"], { TOKEN_SRC: "ghp_supersecret" });
    expect(put.code).toBe(0);
    const stdin = await cli(s.url, ["vaults", "credentials", "put", "vlt_1", "NPM", "--value-stdin"], {}, "npm_secret\n");
    const listed = await cli(s.url, ["vaults", "credentials", "list", "vlt_1"]);
    await cli(s.url, ["vaults", "credentials", "put", "vlt_1", "docs", "--value", "lin_key", "--mcp-url", "https://docs.example.com/mcp"]);
    expect(listed.stdout).toMatch(/cred_1\s+GITHUB_TOKEN/);
    expect((await cli(s.url, ["vaults", "credentials", "delete", "vlt_1", "GITHUB_TOKEN"])).code).toBe(0);
    expect((await cli(s.url, ["vaults", "credentials", "put", "vlt_1", "X"])).code).toBe(2);
    expect((await cli(s.url, ["vaults", "credentials", "put", "vlt_1", "X", "--value-env", "UNSET_VAR"])).code).toBe(2);
    expect(s.requests.map((r) => [r.method, r.path, r.json])).toEqual([
      ["POST", "/v1/vaults", { name: "ci", metadata: { team: "infra" } }],
      ["POST", "/v1/vaults/vlt_1/credentials", { name: "GITHUB_TOKEN", value: "ghp_supersecret" }],
      ["POST", "/v1/vaults/vlt_1/credentials", { name: "NPM", value: "npm_secret" }],
      ["GET", "/v1/vaults/vlt_1/credentials", undefined],
      ["POST", "/v1/vaults/vlt_1/credentials", { name: "docs", auth: { type: "static_bearer", mcp_server_url: "https://docs.example.com/mcp", token: "lin_key" } }],
      ["DELETE", "/v1/vaults/vlt_1/credentials/GITHUB_TOKEN", undefined],
    ]);
    for (const out of [put, stdin, listed]) expect(out.stdout + out.stderr).not.toMatch(/supersecret|npm_secret/);
  });

  it("memory stores, skills, providers, sandboxes, models, me", async () => {
    const s = await serve((r, res) => sendJson(res, 200, r.method === "GET" && !/\/(mem|skill|prov|sbx)_/.test(r.path) && r.path !== "/v1/me" ? { data: [] } : { id: "ok" }));
    const dir = await mkdtemp(path.join(tmpdir(), "pma-cli-"));
    try {
      await writeFile(path.join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\nbody");
      const calls: string[][] = [
        ["memory-stores", "create", "notes", "--description", "d"], ["memory-stores", "list"], ["memory-stores", "delete", "mem_1"],
        ["skills", "create", "--file", path.join(dir, "SKILL.md")], ["skills", "version", "skill_1", "--name", "x"], ["skills", "delete", "skill_1"],
        ["providers", "create", "my-gw", "--api", "openai-completions", "--base-url", "https://gw/v1", "--auth-env", "GW_KEY", "--models", "gpt-4.1:1000000,o4-mini"],
        ["providers", "update", "my-gw", "--enabled", "false"], ["providers", "delete", "my-gw"],
        ["sandboxes", "list", "--all"], ["sandboxes", "pause", "sbx_1"], ["sandboxes", "delete", "sbx_1"], ["models", "list"], ["me"],
      ];
      for (const c of calls) expect((await cli(s.url, c)).code, c.join(" ")).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
    expect(s.requests.map((r) => [r.method, r.path, r.json])).toEqual([
      ["POST", "/v1/memory_stores", { name: "notes", description: "d" }], ["GET", "/v1/memory_stores", undefined], ["DELETE", "/v1/memory_stores/mem_1", undefined],
      ["POST", "/v1/skills", { markdown: "---\nname: x\ndescription: y\n---\nbody" }], ["POST", "/v1/skills/skill_1/versions", { name: "x" }], ["DELETE", "/v1/skills/skill_1", undefined],
      ["POST", "/v1/providers", { id: "my-gw", api: "openai-completions", base_url: "https://gw/v1", auth: { type: "env", name: "GW_KEY" }, models: [{ id: "gpt-4.1", context_window: 1000000 }, { id: "o4-mini", context_window: 200000 }] }],
      ["PATCH", "/v1/providers/my-gw", { enabled: false }], ["DELETE", "/v1/providers/my-gw", undefined],
      ["GET", "/v1/sandboxes?include_destroyed=true", undefined], ["POST", "/v1/sandboxes/sbx_1/pause", {}], ["DELETE", "/v1/sandboxes/sbx_1", undefined],
      ["GET", "/v1/models", undefined], ["GET", "/v1/me", undefined],
    ]);
  });

  it("files upload sends the raw bytes with x-file-name; download writes the content", async () => {
    const s = await serve((r, res) => {
      if (r.method === "POST") return sendJson(res, 201, { id: "file_1", filename: r.headers["x-file-name"], mime_type: r.headers["content-type"], size_bytes: r.body.length });
      res.writeHead(200, { "content-type": "text/plain" }); res.end("file body");
    });
    const dir = await mkdtemp(path.join(tmpdir(), "pma-cli-"));
    try {
      await writeFile(path.join(dir, "notes.txt"), "hello file");
      const up = await cli(s.url, ["files", "upload", path.join(dir, "notes.txt")]);
      expect(JSON.parse(up.stdout)).toEqual({ id: "file_1", filename: "notes.txt", mime_type: "text/plain", size_bytes: 10 });
      expect(s.requests[0]!.body).toBe("hello file");
      expect((await cli(s.url, ["files", "download", "file_1"])).stdout).toBe("file body");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
