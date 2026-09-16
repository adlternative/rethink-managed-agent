import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hermetic: the real app from src/api/main.ts over in-memory fakes (see test/fixtures/api-harness).
vi.hoisted(() => { process.env.MESSAGING_BACKEND = "memory"; process.env.LOG_LEVEL = "error"; });
vi.mock("@hono/node-server", () => ({ serve: () => {} }));
vi.mock("../src/infra/migrate.ts", () => ({ migrate: async () => {} }));
vi.mock("../src/infra/db.ts", () => import("./fixtures/api-harness/fake-db.ts"));
vi.mock("../src/infra/events.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).events);
vi.mock("../src/infra/queue.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).queue);
vi.mock("../src/infra/byoc.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).byoc);
vi.mock("../src/infra/blobs.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).blobs);
vi.mock("../src/sandbox/lease-store.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).leaseStore);

const { app } = await import("../src/api/main.ts");
const { env } = await import("../src/shared/env.ts");
const { store, reset, seed } = await import("./fixtures/api-harness/fake-db.ts");
const { queue, headerResolver } = await import("./fixtures/api-harness/fakes.ts");
const { setResolver } = await import("../src/api/principal-resolver.ts");
const { parseSkillMarkdown, validateSkillRefs } = await import("../src/api/routes/skills.ts");
const { validateMounts } = await import("../src/api/routes/memories.ts");
const { validateWorkspaceSpec } = await import("../src/api/routes/environments.ts");

const A = "prc_a", B = "prc_b";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const saved = { ...env };
beforeEach(() => { reset(); queue.jobs.length = 0; setResolver(headerResolver); });
afterEach(() => { Object.assign(env, saved); setResolver(undefined); vi.restoreAllMocks(); });

const call = (method: string, path: string, body?: unknown, as = A, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-as": as, ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("agents", () => {
  it("validates name, model, tools, packages and skills", async () => {
    const m = { provider: "qoder", id: "auto" };
    expect((await call("POST", "/v1/agents", { model: m })).status).toBe(400);
    expect((await call("POST", "/v1/agents", { name: "x" })).status).toBe(400);
    expect((await call("POST", "/v1/agents", { name: "x", model: { provider: 1, id: "a" } })).status).toBe(400);
    expect((await call("POST", "/v1/agents", { name: "x", model: m, tools: ["rm"] })).status).toBe(400);
    expect((await call("POST", "/v1/agents", { name: "x", model: m, packages: ["has space"] })).status).toBe(400);
    expect((await call("POST", "/v1/agents", { name: "x", model: m, skills: ["nope"] })).status).toBe(400);
    const ok = await call("POST", "/v1/agents", { name: "x", model: m });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ owner_id: A, tools: ["bash", "read", "write", "edit"], packages: [], skills: [] });
  });

  it("mcp_servers are stored on the agent, secret-free, and snapshotted into a session", async () => {
    const m = { provider: "qoder", id: "auto" };
    const server = { label: "docs", url: "https://docs.example.com/mcp", allowed_tools: ["search"], headers: { "x-tenant": "t1" } };
    const bad = [
      [{ url: "https://x.example.com/mcp" }, /label/],
      [{ label: "docs", url: "not-a-url" }, /valid URL/],
      [{ label: "docs", url: "https://x.example.com/mcp", authorization: "Bearer t" }, /credential_id/], // a reusable agent stores no secrets
      [{ label: "docs", url: "https://x.example.com/mcp", headers: { n: 1 } }, /headers/],
    ] as const;
    for (const [s, re] of bad) {
      const res = await call("POST", "/v1/agents", { name: "x", model: m, mcp_servers: [s] });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(re);
    }
    expect((await call("POST", "/v1/agents", { name: "x", model: m, mcp_servers: [server, server] })).status).toBe(400); // duplicate label

    const agent = await (await call("POST", "/v1/agents", { name: "x", model: m, mcp_servers: [server] })).json();
    expect(agent.mcp_servers).toEqual([server]);
    const patched = await (await call("PATCH", `/v1/agents/${agent.id}`, { mcp_servers: [] })).json();
    expect(patched.mcp_servers).toEqual([]);
    await call("PATCH", `/v1/agents/${agent.id}`, { mcp_servers: [server] });

    const env = seed.environment(A);
    const session = await (await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id })).json();
    // header values are masked on the way out even here, where they are validated not to be credentials
    expect(session.agent.mcp_servers).toEqual([{ ...server, headers: { "x-tenant": "[redacted]" } }]);
    // an override may replace them for this session only
    const overridden = await (await call("POST", "/v1/sessions", { agent: { type: "agent_with_overrides", id: agent.id, mcp_servers: [] }, environment_id: env.id })).json();
    expect(overridden.agent.mcp_servers).toEqual([]);
  });

  it("PATCH and GET are owner-scoped", async () => {
    const theirs = seed.agent(B);
    expect((await call("PATCH", `/v1/agents/${theirs.id}`, { name: "hijack" })).status).toBe(404);
    expect((await call("GET", `/v1/agents/${theirs.id}`)).status).toBe(404);
    expect(store.agents.get(theirs.id)!.name).toBe("a");
  });

  // Regression: provider ids are not ownership-checked; the runner resolves providers unscoped (tenant uses another's BYOK key).
  it("POST /v1/agents with a provider owned by another tenant -> 400/404", async () => {
    seed.provider(A, "acme");
    const r = await call("POST", "/v1/agents", { name: "x", model: { provider: "acme", id: "m1" } }, B);
    expect([400, 404]).toContain(r.status);
  });

  // Regression: skill ids are not ownership-checked; the runner loads skills unscoped (prompt injection of another tenant's SKILL.md).
  it("POST /v1/agents with a skill owned by another tenant -> 400/404", async () => {
    const sk = seed.skill(A);
    const r = await call("POST", "/v1/agents", { name: "x", model: { provider: "qoder", id: "auto" }, skills: [sk.id] }, B);
    expect([400, 404]).toContain(r.status);
  });

  it("PATCH /v1/agents/:id with another tenant's skill -> 400/404", async () => {
    const sk = seed.skill(A); const mine = seed.agent(B);
    const r = await call("PATCH", `/v1/agents/${mine.id}`, { skills: [sk.id] }, B);
    expect([400, 404]).toContain(r.status);
  });

  it("POST /v1/sessions agent_with_overrides with another tenant's provider -> 400/404", async () => {
    seed.provider(A, "acme");
    const agent = seed.agent(B); const e = seed.environment(B);
    const r = await call("POST", "/v1/sessions", { agent: { type: "agent_with_overrides", id: agent.id, model: { provider: "acme", id: "m1" } }, environment_id: e.id }, B);
    expect([400, 404]).toContain(r.status);
  });

  it("POST /v1/sessions agent_with_overrides with another tenant's skill -> 400/404", async () => {
    const sk = seed.skill(A); const agent = seed.agent(B); const e = seed.environment(B);
    const r = await call("POST", "/v1/sessions", { agent: { type: "agent_with_overrides", id: agent.id, skills: [sk.id] }, environment_id: e.id }, B);
    expect([400, 404]).toContain(r.status);
  });

  it("POST /v1/sessions/:id/skills with another tenant's skill -> 400/404", async () => {
    const sk = seed.skill(A); const s = seed.session(B);
    const r = await call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: sk.id }, B);
    expect([400, 404]).toContain(r.status);
  });
});

describe("providers", () => {
  const base = { api: "openai-completions", base_url: "https://p.example/v1", models: [{ id: "m1", context_window: 1000 }] };

  it("auth.type 'key' without PMA_SECRET_KEY -> 400 and nothing stored", async () => {
    env.PMA_SECRET_KEY = "";
    const r = await call("POST", "/v1/providers", { id: "p1", ...base, auth: { type: "key", key: "sk-1" } });
    expect(r.status).toBe(400);
    expect(store.providers.has("p1")).toBe(false);
  });

  it("seals a BYOK key; GET/list never return iv/ct/tag", async () => {
    env.PMA_SECRET_KEY = SECRET;
    const r = await call("POST", "/v1/providers", { id: "p1", ...base, auth: { type: "key", key: "sk-secret" } });
    expect(r.status).toBe(201);
    const stored = store.providers.get("p1")!.auth;
    expect(stored.type).toBe("encrypted");
    expect(stored.ct).not.toBe("");
    for (const res of [await r.json(), await (await call("GET", "/v1/providers/p1")).json(), (await (await call("GET", "/v1/providers")).json() as any).data[0]] as any[]) {
      expect(res.auth).toEqual({ type: "encrypted", v: 1, iv: "", ct: "", tag: "" });
      expect(JSON.stringify(res)).not.toContain("sk-secret");
    }
  });

  it("validates id, api, base_url, env name, models and headers", async () => {
    expect((await call("POST", "/v1/providers", { ...base, id: "Bad" })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", api: "grpc" })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", base_url: "file:///etc" })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", auth: { type: "env", name: "lower" } })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", models: [{ id: "m" }] })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", headers: { a: 1 } })).status).toBe(400);
    expect((await call("POST", "/v1/providers", { ...base, id: "p", auth: { type: "magic" } })).status).toBe(400);
  });

  it("POST with an id owned by another principal -> 409; PATCH/DELETE of another owner's provider -> 404", async () => {
    seed.provider(B, "theirs");
    expect((await call("POST", "/v1/providers", { ...base, id: "theirs" })).status).toBe(409);
    expect((await call("PATCH", "/v1/providers/theirs", { base_url: "https://evil" })).status).toBe(404);
    expect((await call("DELETE", "/v1/providers/theirs")).status).toBe(404);
    expect(store.providers.get("theirs")!.base_url).toBe("http://x");
  });

  it("PATCH merges over the existing definition and cannot change the id", async () => {
    seed.provider(A, "mine");
    const r = await call("PATCH", "/v1/providers/mine", { id: "other", name: "Renamed" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: "mine", name: "Renamed", base_url: "http://x" });
    expect(store.providers.has("other")).toBe(false);
  });

  // Regression: the masked auth from GET is accepted verbatim on PATCH, overwriting the sealed key with empty ciphertext.
  it("a GET-modify-PATCH round trip keeps the stored sealed key", async () => {
    env.PMA_SECRET_KEY = SECRET;
    await call("POST", "/v1/providers", { id: "p1", ...base, auth: { type: "key", key: "sk-secret" } });
    const sealed = structuredClone(store.providers.get("p1")!.auth);
    const got = await (await call("GET", "/v1/providers/p1")).json() as any;
    expect((await call("PATCH", "/v1/providers/p1", { ...got, enabled: false })).status).toBe(200);
    expect(store.providers.get("p1")!.auth).toEqual(sealed);
  });

  // Regression: a client can store arbitrary {type:'encrypted'} material directly.
  it("POST with a client-supplied auth.type 'encrypted' -> 400", async () => {
    const r = await call("POST", "/v1/providers", { id: "p2", ...base, auth: { type: "encrypted", v: 1, iv: "a", ct: "b", tag: "c" } });
    expect(r.status).toBe(400);
  });

  // Regression: enabled is cast, not validated.
  it("enabled: 'false' (a string) -> 400", async () => {
    const r = await call("POST", "/v1/providers", { id: "p3", ...base, enabled: "false" });
    expect(r.status).toBe(400);
  });

  // Regression: the existence check and the ON CONFLICT (id) DO UPDATE upsert are not atomic.
  it("concurrent POSTs of the same id by two owners: one 409, and the stored row is the owner's own definition", async () => {
    let n = 0; let open!: () => void; const barrier = new Promise<void>((r) => { open = r; });
    store.hooks.providerGet = async () => { if (++n === 2) open(); await barrier; };
    const [ra, rb] = await Promise.all([
      call("POST", "/v1/providers", { id: "shared", ...base, base_url: "https://a.example" }, A),
      call("POST", "/v1/providers", { id: "shared", ...base, base_url: "https://evil.example" }, B),
    ]);
    const row = store.providers.get("shared")!;
    expect(row.base_url).toBe(row.owner_id === A ? "https://a.example" : "https://evil.example");
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
  });
});

describe("models", () => {
  it("lists the caller's enabled providers' models", async () => {
    seed.provider(A, "mine", { models: [{ id: "m-own", context_window: 1 }] });
    seed.provider(A, "off", { enabled: false });
    const data = (await (await call("GET", "/v1/models")).json() as any).data;
    expect(data).toContainEqual(expect.objectContaining({ provider: "mine", id: "m-own", name: "mine/m-own" }));
    expect(data.some((m: any) => m.provider === "off")).toBe(false);
  });

  // Regression: GET /v1/models lists enabled providers of all owners.
  it("does not list another tenant's providers", async () => {
    seed.provider(A, "acme-internal", { models: [{ id: "secret-model", context_window: 1 }] });
    const data = (await (await call("GET", "/v1/models", undefined, B)).json() as any).data;
    expect(data.some((m: any) => m.provider === "acme-internal")).toBe(false);
  });
});

describe("files", () => {
  const upload = (body: BodyInit, headers: Record<string, string>, as = A) => app.request("/v1/files", { method: "POST", headers: { "x-as": as, ...headers }, body });

  it("multipart upload stores the file; missing 'file' field -> 400", async () => {
    const fd = new FormData(); fd.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
    const r = await upload(fd, {});
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ type: "file", filename: "a.txt", mime_type: "text/plain", size_bytes: 5 });
    const empty = new FormData(); empty.append("other", "x");
    expect((await upload(empty, {})).status).toBe(400);
  });

  it("raw body: empty -> 400; x-file-name is sanitized", async () => {
    expect((await upload("", { "content-type": "application/octet-stream" })).status).toBe(400);
    const r = await upload("data", { "content-type": "text/plain; charset=utf-8", "x-file-name": `../../x"y` });
    const f = await r.json() as any;
    expect(f.filename).not.toMatch(/[\/"]/);
    expect(f.mime_type).toBe("text/plain");
  });

  it("get/content/delete are owner-scoped; DELETE returns file_deleted", async () => {
    const f = await (await upload("abc", { "content-type": "text/plain" })).json() as any;
    for (const [m, p] of [["GET", `/v1/files/${f.id}`], ["GET", `/v1/files/${f.id}/content`], ["DELETE", `/v1/files/${f.id}`]] as const) {
      expect((await call(m, p, undefined, B)).status).toBe(404);
    }
    expect(await (await call("GET", `/v1/files/${f.id}/content`)).text()).toBe("abc");
    expect((await (await call("GET", "/v1/files", undefined, B)).json() as any).data).toEqual([]);
    const d = await call("DELETE", `/v1/files/${f.id}`);
    expect(await d.json()).toEqual({ id: f.id, type: "file_deleted" });
    expect((await call("GET", `/v1/files/${f.id}`)).status).toBe(404);
  });

  // Regression: attacker-chosen content types are served inline on the API origin (stored XSS).
  it("GET /:id/content for a text/html upload is not rendered inline (nosniff + attachment or a safe type)", async () => {
    const f = await (await upload("<script>alert(1)</script>", { "content-type": "text/html" })).json() as any;
    const r = await call("GET", `/v1/files/${f.id}/content`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const inlineHtml = /text\/html/.test(r.headers.get("content-type") ?? "") && !/^attachment/.test(r.headers.get("content-disposition") ?? "");
    expect(inlineHtml).toBe(false);
  });
});

describe("skills", () => {
  it("parseSkillMarkdown reads LF frontmatter and strips quotes", () => {
    expect(parseSkillMarkdown(`---\nname: "foo"\ndescription: 'does x: y'\n---\n\nbody here\n`)).toEqual({ name: "foo", description: "does x: y", body: "body here" });
    expect(parseSkillMarkdown("just a body")).toEqual({ body: "just a body" });
  });

  // Regression: only LF frontmatter matches; a Windows-authored SKILL.md loses its name/description.
  it("parseSkillMarkdown reads CRLF frontmatter", () => {
    expect(parseSkillMarkdown("---\r\nname: foo\r\ndescription: d\r\n---\r\nbody")).toEqual({ name: "foo", description: "d", body: "body" });
  });

  it("validateSkillRefs normalizes ids and refs", () => {
    expect(validateSkillRefs(["skill_a", { type: "custom", skill_id: "skill_b", version: "2" }])).toEqual([{ type: "custom", skill_id: "skill_a" }, { type: "custom", skill_id: "skill_b", version: "2" }]);
    expect(() => validateSkillRefs("skill_a")).toThrow();
    expect(() => validateSkillRefs([{ type: "anthropic", skill_id: "x" }])).toThrow();
  });

  it("multipart upload with SKILL.md; missing SKILL.md -> 400", async () => {
    const fd = new FormData(); fd.append("files[]", new File(["---\nname: lint\ndescription: lints\n---\nrun eslint"], "lint/SKILL.md"));
    const r = await app.request("/v1/skills", { method: "POST", headers: { "x-as": A }, body: fd });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: "lint", description: "lints", body: "run eslint", owner_id: A, latest_version: "1" });
    const none = new FormData(); none.append("files[]", new File(["x"], "README.md"));
    expect((await app.request("/v1/skills", { method: "POST", headers: { "x-as": A }, body: none })).status).toBe(400);
  });

  it("POST /:id/versions with only a new body keeps name/description and increments latest_version; foreign -> 404", async () => {
    const created = await (await call("POST", "/v1/skills", { name: "lint", description: "lints", body: "v1" })).json() as any;
    const r = await call("POST", `/v1/skills/${created.id}/versions`, { body: "v2" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: created.id, name: "lint", description: "lints", body: "v2", latest_version: "2" });
    expect((await call("POST", `/v1/skills/${created.id}/versions`, { body: "v3" }, B)).status).toBe(404);
    expect((await call("DELETE", `/v1/skills/${created.id}`, undefined, B)).status).toBe(404);
  });

  it("invalid JSON, bad name, missing description -> 400", async () => {
    expect((await call("POST", "/v1/skills", "{nope")).status).toBe(400);
    expect((await call("POST", "/v1/skills", { name: "Bad Name", description: "d", body: "b" })).status).toBe(400);
    expect((await call("POST", "/v1/skills", { name: "ok", body: "b" })).status).toBe(400);
  });

  // Regression: `null` JSON reaches `body.display_title` -> TypeError 500.
  it("JSON body null -> 400", async () => {
    quiet();
    expect((await call("POST", "/v1/skills", "null")).status).toBe(400);
  });

  // Regression: NAME_RE.test(123) coerces the number to "123" and accepts it.
  it("name as a number -> 400", async () => {
    expect((await call("POST", "/v1/skills", { name: 123, description: "d", body: "b" })).status).toBe(400);
  });
});

describe("memory stores and validateMounts", () => {
  it("rejects unsafe mount paths", async () => {
    const m = seed.memoryStore(A, "notes");
    for (const mount_path of ["../x", "/a/../b", "a//b", "a b", ".."]) {
      await expect(validateMounts([{ memory_store_id: m.id, mount_path }], { owner: A })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("bare ids get the default mount; leading slash is normalized; duplicates rejected", async () => {
    const m1 = seed.memoryStore(A, "notes"); const m2 = seed.memoryStore(A, "more");
    expect(await validateMounts([m1.id, { memory_store_id: m2.id, mount_path: "/data/m" }], { owner: A })).toEqual([{ memory_store_id: m1.id, mount_path: "memories/notes" }, { memory_store_id: m2.id, mount_path: "data/m" }]);
    await expect(validateMounts([{ memory_store_id: m1.id, mount_path: "/same" }, { memory_store_id: m2.id, mount_path: "same" }], { owner: A })).rejects.toMatchObject({ status: 400 });
  });

  it("foreign store -> 404; non-array or non-mem id -> 400; null -> []", async () => {
    const theirs = seed.memoryStore(B, "x");
    await expect(validateMounts([theirs.id], { owner: A })).rejects.toMatchObject({ status: 404 });
    await expect(validateMounts("mem_x", { owner: A })).rejects.toMatchObject({ status: 400 });
    await expect(validateMounts(["file_x"], { owner: A })).rejects.toMatchObject({ status: 400 });
    expect(await validateMounts(null)).toEqual([]);
  });

  it("routes: name validation and owner scoping", async () => {
    expect((await call("POST", "/v1/memory_stores", { name: "Bad" })).status).toBe(400);
    const m = await (await call("POST", "/v1/memory_stores", { name: "good" })).json() as any;
    expect((await call("GET", `/v1/memory_stores/${m.id}`, undefined, B)).status).toBe(404);
    expect((await call("DELETE", `/v1/memory_stores/${m.id}`, undefined, B)).status).toBe(404);
    expect(await (await call("DELETE", `/v1/memory_stores/${m.id}`)).json()).toEqual({ id: m.id, type: "memory_store_deleted" });
  });
});

describe("vaults", () => {
  it("POST /:id/credentials without PMA_SECRET_KEY -> 400 before any DB write", async () => {
    env.PMA_SECRET_KEY = "";
    const v = seed.vault(A);
    const r = await call("POST", `/v1/vaults/${v.id}/credentials`, { name: "TOKEN", value: "s3cr3t" });
    expect(r.status).toBe(400);
    expect(store.ops.filter((o) => o.startsWith("vaultCredentials"))).toEqual([]);
  });

  it("the secret value never appears in POST or GET responses", async () => {
    env.PMA_SECRET_KEY = SECRET;
    const v = seed.vault(A);
    const r = await call("POST", `/v1/vaults/${v.id}/credentials`, { name: "TOKEN", value: "s3cr3t-value" });
    expect(r.status).toBe(201);
    const bodies = [await r.text(), await (await call("GET", `/v1/vaults/${v.id}/credentials`)).text(), await (await call("GET", `/v1/vaults/${v.id}`)).text()];
    for (const b of bodies) expect(b).not.toContain("s3cr3t-value");
    expect(JSON.parse(bodies[1]!).data.map((c: any) => c.name)).toEqual(["TOKEN"]);
  });

  it("validates name/value", async () => {
    env.PMA_SECRET_KEY = SECRET;
    const v = seed.vault(A);
    expect((await call("POST", `/v1/vaults/${v.id}/credentials`, { value: "x" })).status).toBe(400);
    expect((await call("POST", `/v1/vaults/${v.id}/credentials`, { name: "X", value: 5 })).status).toBe(400);
  });

  it("a foreign owner's vault -> 404 for get/delete and credentials list/put/delete", async () => {
    env.PMA_SECRET_KEY = SECRET;
    const v = seed.vault(B);
    expect((await call("GET", `/v1/vaults/${v.id}`)).status).toBe(404);
    expect((await call("GET", `/v1/vaults/${v.id}/credentials`)).status).toBe(404);
    expect((await call("POST", `/v1/vaults/${v.id}/credentials`, { name: "X", value: "y" })).status).toBe(404);
    expect((await call("DELETE", `/v1/vaults/${v.id}/credentials/X`)).status).toBe(404);
    expect((await call("DELETE", `/v1/vaults/${v.id}`)).status).toBe(404);
    expect(store.ops.filter((o) => o.startsWith("vaultCredentials"))).toEqual([]);
    expect(store.vaults.has(v.id)).toBe(true);
  });
});

describe("sandboxes", () => {
  it("DELETE: busy -> 409, destroyed -> 200 idempotent, ready -> 202 destroying", async () => {
    const busy = seed.sandbox(A, "busy"); const gone = seed.sandbox(A, "destroyed"); const ready = seed.sandbox(A, "ready");
    expect((await call("DELETE", `/v1/sandboxes/${busy.id}`)).status).toBe(409);
    const d = await call("DELETE", `/v1/sandboxes/${gone.id}`);
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ id: gone.id, status: "destroyed" });
    const r = await call("DELETE", `/v1/sandboxes/${ready.id}`);
    expect(r.status).toBe(202);
    expect(store.sandboxes.get(ready.id)!.status).toBe("destroying");
  });

  it("POST /pause: paused -> 200, busy -> 409, ready -> 202", async () => {
    const paused = seed.sandbox(A, "paused"); const busy = seed.sandbox(A, "busy"); const ready = seed.sandbox(A, "ready");
    expect((await call("POST", `/v1/sandboxes/${paused.id}/pause`)).status).toBe(200);
    expect((await call("POST", `/v1/sandboxes/${busy.id}/pause`)).status).toBe(409);
    expect((await call("POST", `/v1/sandboxes/${ready.id}/pause`)).status).toBe(202);
  });

  it("list passes include_destroyed and the owner through; foreign sandbox -> 404", async () => {
    seed.sandbox(A, "destroyed"); seed.sandbox(A, "ready"); const theirs = seed.sandbox(B, "ready");
    expect((await (await call("GET", "/v1/sandboxes")).json() as any).data).toHaveLength(1);
    expect((await (await call("GET", "/v1/sandboxes?include_destroyed=true")).json() as any).data).toHaveLength(2);
    expect(store.ops).toContain(`sandboxes.list:${JSON.stringify({ includeDestroyed: true, owner: A })}`);
    for (const [m, p] of [["GET", `/v1/sandboxes/${theirs.id}`], ["DELETE", `/v1/sandboxes/${theirs.id}`], ["POST", `/v1/sandboxes/${theirs.id}/pause`]] as const) {
      expect((await call(m, p)).status).toBe(404);
    }
    expect(store.sandboxes.get(theirs.id)!.status).toBe("ready");
  });

  // Regression: the markForDestroy/markForPause result is ignored, so a sandbox leased in between is reported as destroying/pausing.
  it("DELETE when the sandbox became busy between read and update does not report 202 destroying", async () => {
    const s = seed.sandbox(A, "ready");
    store.hooks.beforeMark = (id) => { store.sandboxes.get(id)!.status = "busy"; };
    const r = await call("DELETE", `/v1/sandboxes/${s.id}`);
    expect(r.status).not.toBe(202);
  });

  it("POST /pause when the sandbox became busy between read and update does not report 202 pausing", async () => {
    const s = seed.sandbox(A, "ready");
    store.hooks.beforeMark = (id) => { store.sandboxes.get(id)!.status = "busy"; };
    const r = await call("POST", `/v1/sandboxes/${s.id}/pause`);
    expect(r.status).not.toBe(202);
  });
});

describe("BYOC worker routes", () => {
  const poll = (envId: string, body: unknown, key?: string) => app.request(`/v1/environments/${envId}/worker/poll`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-worker-key": key } : {}) }, body: JSON.stringify(body) });
  const result = (envId: string, body: unknown, key?: string) => app.request(`/v1/environments/${envId}/worker/result`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-worker-key": key } : {}) }, body: JSON.stringify(body) });

  it("non-byoc env -> 403 no_worker_key; missing or wrong key -> 401; unknown env -> 404", async () => {
    const local = seed.environment(A);
    const r = await poll(local.id, { worker_id: "w1" }, "anything");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { type: "no_worker_key" } });
    const byoc = seed.environment(A, { provider: "byoc", worker_key: "wk_right" });
    expect((await poll(byoc.id, { worker_id: "w1" })).status).toBe(401);
    expect((await poll(byoc.id, { worker_id: "w1" }, "wk_wrong")).status).toBe(401);
    expect((await result(byoc.id, { req_id: "r", type: "done" }, "wk_wrong")).status).toBe(401);
    expect((await poll("env_missing", { worker_id: "w1" }, "wk_right")).status).toBe(404);
  });

  it("invalid worker_id -> 400; sandbox_ids are filtered to strings and capped at 64", async () => {
    const e = seed.environment(A, { provider: "byoc", worker_key: "wk" });
    expect((await poll(e.id, { worker_id: "bad id!" }, "wk")).status).toBe(400);
    expect((await poll(e.id, {}, "wk")).status).toBe(400);
    const ids = [1, null, ...Array.from({ length: 100 }, (_, i) => `sbx_${i}`)];
    const r = await poll(e.id, { worker_id: "w1", sandbox_ids: ids }, "wk");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ request: null });
    expect(store.pollCalls[0]!.ids).toEqual(Array.from({ length: 64 }, (_, i) => `sbx_${i}`));
  });

  it("result: type other than chunk|done or no req_id -> 400; valid result is pushed", async () => {
    const e = seed.environment(A, { provider: "byoc", worker_key: "wk" });
    expect((await result(e.id, { req_id: "r1", type: "exit" }, "wk")).status).toBe(400);
    expect((await result(e.id, { type: "done" }, "wk")).status).toBe(400);
    expect((await result(e.id, { req_id: "r1", type: "chunk", stream: "stdout", data: "x" }, "wk")).status).toBe(200);
    expect(store.results).toHaveLength(1);
  });

  it("a new worker_id resumes once, re-enqueuing only idle sessions paused on environment reconnection", async () => {
    const e = seed.environment(A, { provider: "byoc", worker_key: "wk" });
    const paused = seed.session(A, { environment_id: e.id });
    seed.events(paused.id, [{ type: "session.status_running" }, { type: "session.environment_disconnected", environment_id: e.id }]);
    const resumedAlready = seed.session(A, { environment_id: e.id });
    seed.events(resumedAlready.id, [{ type: "session.environment_disconnected", environment_id: e.id }, { type: "session.status_running" }]);
    const running = seed.session(A, { environment_id: e.id, status: "running" });
    seed.events(running.id, [{ type: "session.environment_disconnected", environment_id: e.id }]);
    await poll(e.id, { worker_id: "w1" }, "wk");
    await tick();
    expect(queue.jobs).toEqual([{ session_id: paused.id, trigger_seq: 2, owner_id: A }]);
    await poll(e.id, { worker_id: "w1" }, "wk"); // same worker, already alive: no second resume
    await tick();
    expect(queue.jobs).toHaveLength(1);
    expect(store.ops.filter((o) => o.includes("status='idle'"))).toHaveLength(1);
  });

  // Regression: resumeEnvironment reads only the first 10000 events, missing a disconnect at the tail of a long log.
  it("resumes a long session (12000 events) whose pending reconnection is at the tail", async () => {
    const e = seed.environment(A, { provider: "byoc", worker_key: "wk" });
    const s = seed.session(A, { environment_id: e.id });
    seed.events(s.id, [...Array.from({ length: 11999 }, () => ({ type: "session.status_running" })), { type: "session.environment_disconnected", environment_id: e.id }]);
    await poll(e.id, { worker_id: "w-long" }, "wk");
    await tick();
    expect(queue.jobs).toEqual([{ session_id: s.id, trigger_seq: 12000, owner_id: A }]);
  });
});

describe("environments", () => {
  it("validates provider, name, network and plugin_host", async () => {
    expect((await call("POST", "/v1/environments", { name: "e" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "k8s" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { provider: "docker" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "docker", network: "host" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "local", plugin_host: "sandbox" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "byoc", plugin_host: "sandbox" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "docker", image: "Not An Image" })).status).toBe(400);
    expect((await call("POST", "/v1/environments", { name: "e", provider: "docker", plugin_host: "sandbox", image: "node:22-alpine" })).status).toBe(201);
  });

  it("worker_key is generated only for byoc, shown once, and masked on GET/list", async () => {
    const byoc = await (await call("POST", "/v1/environments", { name: "b", provider: "byoc" })).json() as any;
    expect(byoc.worker_key).toMatch(/^wk_/);
    const docker = await (await call("POST", "/v1/environments", { name: "d", provider: "docker" })).json() as any;
    expect(docker.worker_key).toBeNull();
    const got = await (await call("GET", `/v1/environments/${byoc.id}`)).json() as any;
    expect(got.worker_key).toBeUndefined();
    expect(got.worker_key_set).toBe(true);
    const list = (await (await call("GET", "/v1/environments")).json() as any).data;
    expect(list.map((e: any) => [e.worker_key, e.worker_key_set])).toEqual([[undefined, true], [undefined, false]]);
    expect((await call("GET", `/v1/environments/${byoc.id}`, undefined, B)).status).toBe(404);
  });

  it("local workspaces are disabled without LOCAL_WORKSPACE_ALLOW_ROOT and confined under it", () => {
    env.LOCAL_WORKSPACE_ALLOW_ROOT = "";
    expect(() => validateWorkspaceSpec({ kind: "local", path: "/srv/x" })).toThrow(/disabled/);
    env.LOCAL_WORKSPACE_ALLOW_ROOT = "/srv";
    expect(validateWorkspaceSpec({ kind: "local", path: "repo" })).toEqual({ kind: "local", path: "/srv/repo" });
    expect(validateWorkspaceSpec({ kind: "local", path: "/srv" })).toEqual({ kind: "local", path: "/srv" });
    expect(() => validateWorkspaceSpec({ kind: "local", path: "../etc" })).toThrow(/must be under/);
    expect(() => validateWorkspaceSpec({ kind: "local", path: "/srvx" })).toThrow(/must be under/);
  });

  // Regression: with root '/', the check requires startsWith('//') and rejects every real path.
  it("LOCAL_WORKSPACE_ALLOW_ROOT='/' accepts '/srv/x'", () => {
    env.LOCAL_WORKSPACE_ALLOW_ROOT = "/";
    expect(validateWorkspaceSpec({ kind: "local", path: "/srv/x" })).toEqual({ kind: "local", path: "/srv/x" });
  });

  it("POST with a workspace spec stores the validated spec", async () => {
    const r = await call("POST", "/v1/environments", { name: "g", provider: "docker", workspace: { kind: "git", remote: "https://github.com/a/b.git", ref: "main" } });
    expect((await r.json() as any).workspace).toEqual({ kind: "git", remote: "https://github.com/a/b.git", ref: "main" });
    expect((await call("POST", "/v1/environments", { name: "g", provider: "docker", workspace: { kind: "git", remote: "/etc/passwd" } })).status).toBe(400);
  });
});
