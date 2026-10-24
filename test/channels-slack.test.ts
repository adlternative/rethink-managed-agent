import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifySlackSignature, signSlackRequest, SLACK_MAX_SKEW_SEC } from "../src/channels/slack/verify.ts";
import { stripSlackMentions, textOfBlocks } from "../src/channels/slack/client.ts";

describe("verifySlackSignature", () => {
  const secret = "signing_secret_test";
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev1" });
  const ts = "1700000000";

  it("accepts a valid v0 signature within the skew window", () => {
    const signature = signSlackRequest(secret, ts, body);
    expect(verifySlackSignature({ signingSecret: secret, signature, timestamp: ts, body, nowSec: 1700000000 })).toBe(true);
  });

  it("rejects a wrong secret, tampered body, or bad header shape", () => {
    const signature = signSlackRequest(secret, ts, body);
    expect(verifySlackSignature({ signingSecret: "other", signature, timestamp: ts, body, nowSec: 1700000000 })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, signature, timestamp: ts, body: body + "x", nowSec: 1700000000 })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, signature: "v0=dead", timestamp: ts, body, nowSec: 1700000000 })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, signature: undefined, timestamp: ts, body, nowSec: 1700000000 })).toBe(false);
  });

  it("rejects timestamps outside the max skew", () => {
    const signature = signSlackRequest(secret, ts, body);
    expect(verifySlackSignature({
      signingSecret: secret, signature, timestamp: ts, body,
      nowSec: 1700000000 + SLACK_MAX_SKEW_SEC + 1,
    })).toBe(false);
  });

  it("uses timing-safe compare (same length hex only)", () => {
    // Craft an equal-length wrong digest so timingSafeEqual runs.
    const wrong = `v0=${createHmac("sha256", "nope").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackSignature({ signingSecret: secret, signature: wrong, timestamp: ts, body, nowSec: 1700000000 })).toBe(false);
  });
});

describe("slack text helpers", () => {
  it("strips mention markup", () => {
    expect(stripSlackMentions("<@U123> please fix <#C9|general> see <https://x|link>")).toBe("please fix #general see link");
  });
  it("joins text content blocks", () => {
    expect(textOfBlocks([{ type: "text", text: "hi" }, { type: "text", text: " there" }])).toBe("hi there");
  });
});

// Hermetic API tests: same harness as api-resources.
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
const { resetSlackBridges } = await import("../src/channels/slack/bridge.ts");

const A = "prc_a";
const SECRET = Buffer.alloc(32, 9).toString("base64");
const SIGNING = "slack_signing_secret_xyz";
const BOT = "xoxb-test-token";
const saved = { ...env };

beforeEach(() => {
  reset();
  queue.jobs.length = 0;
  setResolver(headerResolver);
  env.PMA_SECRET_KEY = SECRET;
  resetSlackBridges();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 })));
});
afterEach(() => {
  Object.assign(env, saved);
  setResolver(undefined);
  resetSlackBridges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (method: string, path: string, body?: unknown, as = A, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-as": as, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

async function seedIntegration(opts: { channel_ids?: string[] } = {}) {
  seed.principal(A);
  const agent = seed.agent(A);
  const environment = seed.environment(A);
  const vault = seed.vault(A);
  await (await import("./fixtures/api-harness/fake-db.ts")).vaultCredentials.put(vault.id, { name: "SLACK_BOT_TOKEN", value: BOT });
  await (await import("./fixtures/api-harness/fake-db.ts")).vaultCredentials.put(vault.id, { name: "SLACK_SIGNING_SECRET", value: SIGNING });
  const res = await call("POST", "/v1/integrations", {
    kind: "slack",
    name: "coding",
    agent_id: agent.id,
    environment_id: environment.id,
    vault_id: vault.id,
    config: opts.channel_ids ? { channel_ids: opts.channel_ids } : {},
  });
  expect(res.status).toBe(201);
  return { integration: await res.json(), agent, environment, vault };
}

function signed(body: string, ts = String(Math.floor(Date.now() / 1000))) {
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signSlackRequest(SIGNING, ts, body),
    },
  };
}

describe("Slack channel integration API", () => {
  it("CRUD is owner-scoped and never echoes secrets", async () => {
    const { integration } = await seedIntegration();
    expect(integration).toMatchObject({ kind: "slack", name: "coding", enabled: true, owner_id: A });
    expect(JSON.stringify(integration)).not.toMatch(/xoxb|signing_secret|SLACK_/);

    expect((await call("GET", "/v1/integrations", undefined, "prc_b")).status).toBe(200);
    expect((await (await call("GET", "/v1/integrations", undefined, "prc_b")).json()).data).toEqual([]);
    expect((await call("GET", `/v1/integrations/${integration.id}`, undefined, "prc_b")).status).toBe(404);

    const patched = await (await call("PATCH", `/v1/integrations/${integration.id}`, { enabled: false })).json();
    expect(patched.enabled).toBe(false);
    expect((await call("DELETE", `/v1/integrations/${integration.id}`)).status).toBe(200);
    expect((await call("GET", `/v1/integrations/${integration.id}`)).status).toBe(404);
  });

  it("rejects create when agent/env/vault are missing or foreign", async () => {
    seed.principal(A);
    const agent = seed.agent(A);
    const environment = seed.environment(A);
    const vault = seed.vault(A);
    const foreign = seed.vault("prc_b");
    expect((await call("POST", "/v1/integrations", { kind: "slack", agent_id: "nope", environment_id: environment.id, vault_id: vault.id })).status).toBe(404);
    expect((await call("POST", "/v1/integrations", { kind: "slack", agent_id: agent.id, environment_id: environment.id, vault_id: foreign.id })).status).toBe(404);
  });

  it("url_verification echoes the challenge after signature check", async () => {
    const { integration } = await seedIntegration();
    const body = JSON.stringify({ type: "url_verification", challenge: "ch_abc" });
    const { headers } = signed(body);
    const res = await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch_abc" });
  });

  it("rejects events with a bad signature", async () => {
    const { integration } = await seedIntegration();
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await app.request(`/v1/integrations/${integration.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=" + "ab".repeat(32) },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("app_mention starts a session, maps the thread, and enqueues a run", async () => {
    const { integration } = await seedIntegration();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev_mention_1",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> fix the flaky test", channel: "C1", ts: "111.001" },
    });
    const { headers } = signed(body);
    const res = await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers, body });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.created).toBe(true);
    expect(json.session_id).toMatch(/^sess_/);
    expect(store.channelThreads.size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.session_id).toBe(json.session_id);
    const evs = store.events.get(json.session_id)!;
    expect(evs.some((e) => e.type === "user.message" && JSON.stringify(e.payload).includes("fix the flaky test"))).toBe(true);
    // secrets never land in the event log
    expect(JSON.stringify(evs)).not.toMatch(/xoxb|signing_secret/);
  });

  it("duplicate event_id is idempotent (no second session / job)", async () => {
    const { integration } = await seedIntegration();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev_dup",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> hello", channel: "C1", ts: "222.001" },
    });
    const { headers } = signed(body);
    const first = await (await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers, body })).json();
    const second = await (await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers, body })).json();
    expect(first.created).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(store.sessions.size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it("thread reply resumes the mapped session", async () => {
    const { integration } = await seedIntegration();
    const mention = JSON.stringify({
      type: "event_callback", team_id: "T1", event_id: "Ev_a",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> start", channel: "C1", ts: "333.001" },
    });
    const { headers: h1 } = signed(mention);
    const first = await (await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers: h1, body: mention })).json();

    const reply = JSON.stringify({
      type: "event_callback", team_id: "T1", event_id: "Ev_b",
      event: { type: "message", user: "U1", text: "and also lint", channel: "C1", ts: "333.002", thread_ts: "333.001" },
    });
    const { headers: h2 } = signed(reply);
    const second = await (await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers: h2, body: reply })).json();
    expect(second.session_id).toBe(first.session_id);
    expect(second.created).toBe(false);
    expect(store.events.get(first.session_id)!.filter((e) => e.type === "user.message")).toHaveLength(2);
  });

  it("interaction Allow posts user.tool_confirmation", async () => {
    const { integration } = await seedIntegration();
    const mention = JSON.stringify({
      type: "event_callback", team_id: "T1", event_id: "Ev_c",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> go", channel: "C1", ts: "444.001" },
    });
    const { headers: h1 } = signed(mention);
    const { session_id } = await (await app.request(`/v1/integrations/${integration.id}/events`, { method: "POST", headers: h1, body: mention })).json();

    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T1" },
      channel: { id: "C1" },
      message: { thread_ts: "444.001", ts: "444.010" },
      actions: [{ action_id: "tool_confirm_allow", value: "toolu_1" }],
    });
    const form = `payload=${encodeURIComponent(payload)}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.request(`/v1/integrations/${integration.id}/interactions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signSlackRequest(SIGNING, ts, form),
      },
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, session_id, result: "allow" });
    const evs = store.events.get(session_id)!;
    expect(evs.some((e) => e.type === "user.tool_confirmation" && e.payload.result === "allow" && e.payload.tool_use_id === "toolu_1")).toBe(true);
  });
});
