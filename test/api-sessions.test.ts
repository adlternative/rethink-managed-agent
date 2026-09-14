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
const { store, reset, seed } = await import("./fixtures/api-harness/fake-db.ts");
const { queue, headerResolver } = await import("./fixtures/api-harness/fakes.ts");
const { setResolver } = await import("../src/api/principal-resolver.ts");

const A = "prc_a", B = "prc_b";
beforeEach(() => { reset(); queue.jobs.length = 0; setResolver(headerResolver); });
afterEach(() => { setResolver(undefined); vi.restoreAllMocks(); });

const call = (method: string, path: string, body?: unknown, as = A) =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-as": as }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const writes = () => store.ops.filter((o) => /^(sessions\.create|workspaces\.create|events\.append|sessionConfig|sessions\.attach)/.test(o));
const text = (t: string) => ({ type: "user.message", content: [{ type: "text", text: t }] });
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("POST /v1/sessions", () => {
  it("creates a session with a main environment and a fresh workspace from the environment spec", async () => {
    const agent = seed.agent(A); const env = seed.environment(A, { workspace: { kind: "git", remote: "https://x/y.git" } });
    const r = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id });
    expect(r.status).toBe(201);
    const s = await r.json() as any;
    expect(s.owner_id).toBe(A);
    expect(s.environments).toHaveLength(1);
    expect(s.environments[0]).toMatchObject({ key: "main", environment_id: env.id });
    expect(store.workspaces.get(s.workspace_id)).toMatchObject({ owner_id: A, ref: { kind: "git", remote: "https://x/y.git", base: "HEAD" } });
  });

  it("initial_events are appended and trigger a run", async () => {
    const agent = seed.agent(A); const env = seed.environment(A);
    const r = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id, initial_events: [text("go")] });
    expect(r.status).toBe(201);
    const s = await r.json() as any;
    expect(queue.jobs).toEqual([{ session_id: s.id, trigger_seq: 1, owner_id: A }]);
  });

  it("agent_with_overrides replaces model/system/tools in the snapshot only", async () => {
    const agent = seed.agent(A, { system: "base" }); const env = seed.environment(A);
    const r = await call("POST", "/v1/sessions", { agent: { type: "agent_with_overrides", id: agent.id, system: "over", tools: ["read"] }, environment_id: env.id });
    const s = await r.json() as any;
    expect(s.agent).toMatchObject({ id: agent.id, system: "over", tools: ["read"] });
    expect(store.agents.get(agent.id)!.system).toBe("base");
  });

  it("foreign agent, environment, or workspace -> 404", async () => {
    const mine = seed.agent(A); const myEnv = seed.environment(A);
    const theirs = seed.agent(B); const theirEnv = seed.environment(B); const theirWs = seed.workspace(B);
    expect((await call("POST", "/v1/sessions", { agent: theirs.id, environment_id: myEnv.id })).status).toBe(404);
    expect((await call("POST", "/v1/sessions", { agent: mine.id, environment_id: theirEnv.id })).status).toBe(404);
    expect((await call("POST", "/v1/sessions", { agent: mine.id, environment_id: myEnv.id, workspace_id: theirWs.id })).status).toBe(404);
    expect((await call("POST", "/v1/sessions", { agent: mine.id, environment_id: myEnv.id, parent_id: seed.session(B).id })).status).toBe(404);
  });

  it("missing agent or environment_id -> 400", async () => {
    const agent = seed.agent(A);
    expect((await call("POST", "/v1/sessions", { environment_id: "env_x" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { agent: { id: agent.id } })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { agent: agent.id })).status).toBe(400);
  });

  describe("atomicity: nothing is written when validation fails", () => {
    // Regression: initial_events are validated after the workspace and session rows are inserted.
    it("invalid initial_events -> 400 with no session/workspace rows", async () => {
      const agent = seed.agent(A); const env = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id, initial_events: [{ type: "bogus" }] });
      expect(r.status).toBe(400);
      expect(writes()).toEqual([]);
    });

    // Regression: memory_stores are validated after the workspace row is inserted.
    it("unknown memory store -> 404 with no workspace rows", async () => {
      const agent = seed.agent(A); const env = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id, memory_stores: ["mem_missing"] });
      expect(r.status).toBe(404);
      expect(writes()).toEqual([]);
    });

    // Regression: parent_id is checked after the workspace row is inserted.
    it("unknown parent_id -> 404 with no workspace rows", async () => {
      const agent = seed.agent(A); const env = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id, parent_id: "sess_missing" });
      expect(r.status).toBe(404);
      expect(writes()).toEqual([]);
    });
  });

  describe("multi-environment input shapes", () => {
    it("environments[0] with a non-main key -> 400", async () => {
      const agent = seed.agent(A); const env = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ key: "x", environment_id: env.id }] });
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: { message: "environments[0] must be the main environment" } });
    });

    it("attaches several keyed environments, main first", async () => {
      const agent = seed.agent(A); const e1 = seed.environment(A); const e2 = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id }, { key: "tools", environment_id: e2.id }] });
      expect(r.status).toBe(201);
      expect((await r.json() as any).environments.map((e: any) => e.key)).toEqual(["main", "tools"]);
    });

    it("a second entry without a key, duplicate keys, or a bad key -> 400", async () => {
      const agent = seed.agent(A); const e1 = seed.environment(A); const e2 = seed.environment(A);
      expect((await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id }, { environment_id: e2.id }] })).status).toBe(400);
      expect((await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id }, { key: "b", environment_id: e2.id }, { key: "b", environment_id: e2.id }] })).status).toBe(400);
      expect((await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id }, { key: "Bad Key", environment_id: e2.id }] })).status).toBe(400);
    });

    it("fork_from a key that is not attached -> 400", async () => {
      const agent = seed.agent(A); const e1 = seed.environment(A);
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id }, { key: "f", environment_id: e1.id, fork_from: "nope" }] });
      expect(r.status).toBe(400);
    });

    it("fork_from a metadata ref copies the parent workspace spec/ref", async () => {
      const agent = seed.agent(A); const e1 = seed.environment(A);
      const ws = seed.workspace(A, { kind: "git", remote: "https://x/y.git", base: "abc" }, { kind: "git", remote: "https://x/y.git" });
      const r = await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id, workspace_id: ws.id }, { key: "f", environment_id: e1.id, fork_from: "main" }] });
      expect(r.status).toBe(201);
      const s = await r.json() as any;
      const forked = store.workspaces.get(s.environments[1].workspace_id)!;
      expect(forked.id).not.toBe(ws.id);
      expect(forked.ref).toEqual({ kind: "git", remote: "https://x/y.git", base: "abc" });
    });

    for (const kind of ["dir", "local"]) {
      it(`fork_from a '${kind}' ref -> 400 (runner-only fork)`, async () => {
        const agent = seed.agent(A); const e1 = seed.environment(A);
        const ws = seed.workspace(A, { kind, path: "/tmp/x" });
        const r = await call("POST", "/v1/sessions", { agent: agent.id, environments: [{ environment_id: e1.id, workspace_id: ws.id }, { key: "f", environment_id: e1.id, fork_from: "main" }] });
        expect(r.status).toBe(400);
      });
    }

    // Regression: `{...null, key: null.key}` throws a TypeError -> 500.
    it("environments:[null] -> 400", async () => {
      quiet();
      const agent = seed.agent(A);
      expect((await call("POST", "/v1/sessions", { agent: agent.id, environments: [null] })).status).toBe(400);
    });
  });
});

describe("GET /v1/sessions pagination", () => {
  it("pages newest first with next_cursor and only lists the caller's sessions", async () => {
    const ids = [seed.session(A).id, seed.session(A).id, seed.session(A).id];
    seed.session(B);
    const p1 = await (await call("GET", "/v1/sessions?limit=2")).json() as any;
    expect(p1.data.map((s: any) => s.id)).toEqual([ids[2], ids[1]]);
    expect(p1.has_more).toBe(true);
    const p2 = await (await call("GET", `/v1/sessions?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`)).json() as any;
    expect(p2.data.map((s: any) => s.id)).toEqual([ids[0]]);
    expect(p2.has_more).toBe(false);
    expect(p2.next_cursor).toBeNull();
  });

  it("limit=500 is clamped to 200; limit=0 is not a server error", async () => {
    for (let i = 0; i < 205; i++) seed.session(A);
    const big = await (await call("GET", "/v1/sessions?limit=500")).json() as any;
    expect(big.data).toHaveLength(200);
    expect(big.has_more).toBe(true);
    const zero = await call("GET", "/v1/sessions?limit=0");
    expect(zero.status).toBeLessThan(500);
  });

  // Regression: Number("abc") is interpolated into `LIMIT NaN` and a bad cursor fails the ::timestamptz cast -> 500.
  for (const q of ["limit=abc", "cursor=not-a-date"]) {
    it(`?${q} -> 400`, async () => {
      quiet();
      seed.session(A);
      expect((await call("GET", `/v1/sessions?${q}`)).status).toBe(400);
    });
  }
});

describe("session reads, archive and delete", () => {
  it("GET /:id, DELETE /:id and /archive are owner-scoped", async () => {
    const theirs = seed.session(B);
    expect((await call("GET", `/v1/sessions/${theirs.id}`)).status).toBe(404);
    expect((await call("DELETE", `/v1/sessions/${theirs.id}`)).status).toBe(404);
    expect((await call("POST", `/v1/sessions/${theirs.id}/archive`)).status).toBe(404);
    expect((await call("GET", `/v1/sessions/${theirs.id}/tool-outputs/tu_1`)).status).toBe(404);
    expect(store.sessions.has(theirs.id)).toBe(true);
  });

  it("archive appends one terminated event and is idempotent", async () => {
    const s = seed.session(A);
    expect((await (await call("POST", `/v1/sessions/${s.id}/archive`)).json() as any).status).toBe("terminated");
    await call("POST", `/v1/sessions/${s.id}/archive`);
    expect(store.events.get(s.id)!.map((e) => e.type)).toEqual(["session.status_terminated"]);
  });

  it("PATCH /:id requires system and records a session.updated event", async () => {
    const s = seed.session(A);
    expect((await call("PATCH", `/v1/sessions/${s.id}`, {})).status).toBe(400);
    const r = await call("PATCH", `/v1/sessions/${s.id}`, { system: "new" });
    expect(r.status).toBe(200);
    expect(store.sessions.get(s.id)!.agent.system).toBe("new");
    expect(store.events.get(s.id)!.map((e) => e.type)).toEqual(["session.updated"]);
  });
});

describe("mid-session configuration routes", () => {
  it("memory_stores and skills on a terminated session -> 400", async () => {
    const s = seed.session(A, { status: "terminated" });
    const mem = seed.memoryStore(A, "notes"); const sk = seed.skill(A);
    expect((await call("POST", `/v1/sessions/${s.id}/memory_stores`, { memory_store_id: mem.id })).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: sk.id })).status).toBe(400);
    expect((await call("DELETE", `/v1/sessions/${s.id}/skills/${sk.id}`)).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${s.id}/environments`, { key: "b", environment_id: s.environment_id })).status).toBe(400);
  });

  it("mounting the same store twice -> 400; unmounting an unmounted store -> 404", async () => {
    const s = seed.session(A); const mem = seed.memoryStore(A, "notes");
    const r = await call("POST", `/v1/sessions/${s.id}/memory_stores`, { memory_store_id: mem.id });
    expect(r.status).toBe(201);
    expect((await r.json() as any).memory_stores).toEqual([{ memory_store_id: mem.id, mount_path: "memories/notes" }]);
    expect((await call("POST", `/v1/sessions/${s.id}/memory_stores`, { memory_store_id: mem.id, mount_path: "other" })).status).toBe(400);
    expect((await call("DELETE", `/v1/sessions/${s.id}/memory_stores/mem_nope`)).status).toBe(404);
    expect((await call("DELETE", `/v1/sessions/${s.id}/memory_stores/${mem.id}`)).status).toBe(200);
    expect(store.sessions.get(s.id)!.memory_stores).toEqual([]);
  });

  it("attaching the same skill twice -> 400; removing an unattached skill -> 404", async () => {
    const s = seed.session(A); const sk = seed.skill(A);
    expect((await call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: sk.id })).status).toBe(201);
    expect((await call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: sk.id })).status).toBe(400);
    expect((await call("DELETE", `/v1/sessions/${s.id}/skills/skill_nope`)).status).toBe(404);
  });

  // Regression: read-modify-write without a lock; the second writer overwrites the first.
  it("two concurrent POST /:id/skills both end up attached", async () => {
    const s = seed.session(A); const k1 = seed.skill(A); const k2 = seed.skill(A);
    let n = 0; let open!: () => void; const barrier = new Promise<void>((r) => { open = r; });
    store.hooks.sessionGet = async () => { if (++n === 2) open(); await barrier; };
    const [r1, r2] = await Promise.all([
      call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: k1.id }),
      call("POST", `/v1/sessions/${s.id}/skills`, { type: "custom", skill_id: k2.id }),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(store.sessions.get(s.id)!.agent.skills.map((r: any) => r.skill_id).sort()).toEqual([k1.id, k2.id].sort());
  });

  it("POST /:id/environments with key 'main', no key, or an already attached key -> 400", async () => {
    const s = seed.session(A);
    expect((await call("POST", `/v1/sessions/${s.id}/environments`, { key: "main", environment_id: s.environment_id })).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${s.id}/environments`, { environment_id: s.environment_id })).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${s.id}/environments`, { key: "b", environment_id: s.environment_id })).status).toBe(201);
    expect((await call("POST", `/v1/sessions/${s.id}/environments`, { key: "b", environment_id: s.environment_id })).status).toBe(400);
  });

  // Regression: both requests pass the in-memory duplicate check; the PK violation surfaces as a 500.
  it("two concurrent POST /:id/environments with the same key -> one 201, one 4xx (never 500)", async () => {
    quiet();
    const s = seed.session(A);
    let n = 0; let open!: () => void; const barrier = new Promise<void>((r) => { open = r; });
    store.hooks.sessionGet = async () => { if (++n === 2) open(); await barrier; };
    const rs = await Promise.all([1, 2].map(() => call("POST", `/v1/sessions/${s.id}/environments`, { key: "dup", environment_id: s.environment_id })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, expect.any(Number)]);
    expect(rs.every((r) => r.status < 500)).toBe(true);
  });

  it("GET /:id/system_prompt renders a preview from owned skills and mounts", async () => {
    const sk = seed.skill(A, { name: "lint", description: "lint things" });
    const s = seed.session(A);
    store.sessions.get(s.id)!.agent.skills = [{ type: "custom", skill_id: sk.id }];
    const r = await (await call("GET", `/v1/sessions/${s.id}/system_prompt`)).json() as any;
    expect(r.source).toBe("preview");
    expect(r.rendered).toContain("lint");
  });
});
