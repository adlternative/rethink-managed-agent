import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.MESSAGING_BACKEND = "memory"; process.env.LOG_LEVEL = "error"; });
vi.mock("@hono/node-server", () => ({ serve: () => {} }));
vi.mock("../src/infra/migrate.ts", () => ({ migrate: async () => {} }));
vi.mock("../src/infra/db.ts", () => import("./fixtures/api-harness/fake-db.ts"));
vi.mock("../src/infra/events.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).events);
vi.mock("../src/infra/queue.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).queue);
vi.mock("../src/infra/byoc.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).byoc);
vi.mock("../src/infra/blobs.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).blobs);
vi.mock("../src/sandbox/lease-store.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).leaseStore);

const { store, reset, seed, schedules } = await import("./fixtures/api-harness/fake-db.ts");
const { queue } = await import("./fixtures/api-harness/fakes.ts");
const { tickSchedules } = await import("../src/infra/schedules.ts");

const A = "prc_a";

beforeEach(() => { reset(); queue.jobs.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe("tickSchedules", () => {
  it("session.create appends a user.message and advances next_run_at", async () => {
    const agent = seed.agent(A);
    const envRow = seed.environment(A);
    const past = new Date(Date.now() - 60_000).toISOString();
    const sched = seed.schedule(A, {
      cron: "0 * * * *",
      next_run_at: past,
      action: { type: "session.create", agent_id: agent.id, environment_id: envRow.id, message: "scheduled hello" },
    });

    expect(await tickSchedules()).toBe(1);
    const updated = store.schedules.get(sched.id)!;
    expect(updated.last_run_status).toBe("ok");
    expect(updated.last_run_session_id).toMatch(/^sess_/);
    expect(updated.next_run_at > past).toBe(true);
    expect(updated.claim_until).toBeNull();
    expect(store.ops.some((o) => o.startsWith(`schedules.complete:${sched.id}:ok`))).toBe(true);

    const sessionId = updated.last_run_session_id as string;
    expect(store.sessions.get(sessionId)?.owner_id).toBe(A);
    const evs = store.events.get(sessionId) ?? [];
    expect(evs.some((e) => e.type === "user.message")).toBe(true);
    expect(queue.jobs.some((j) => j.session_id === sessionId)).toBe(true);
  });

  it("session.message fires against an existing session", async () => {
    const session = seed.session(A);
    const past = new Date(Date.now() - 60_000).toISOString();
    seed.schedule(A, {
      cron: "* * * * *",
      next_run_at: past,
      action: { type: "session.message", session_id: session.id, message: "ping" },
    });
    expect(await tickSchedules()).toBe(1);
    expect(queue.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: session.id, owner_id: A })]));
  });

  it("disabled schedules are not claimed; overlapping claim skips already-leased rows", async () => {
    const agent = seed.agent(A);
    const envRow = seed.environment(A);
    const past = new Date(Date.now() - 60_000).toISOString();
    const futureLease = new Date(Date.now() + 120_000).toISOString();
    seed.schedule(A, {
      enabled: false, next_run_at: past,
      action: { type: "session.create", agent_id: agent.id, environment_id: envRow.id, message: "nope" },
    });
    seed.schedule(A, {
      next_run_at: past, claim_until: futureLease, claimed_by: "other",
      action: { type: "session.create", agent_id: agent.id, environment_id: envRow.id, message: "leased" },
    });
    expect(await tickSchedules()).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it("records last_run_status=error when the target session is missing, and still advances", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const sched = seed.schedule(A, {
      next_run_at: past,
      action: { type: "session.message", session_id: "sess_missing", message: "x" },
    });
    expect(await tickSchedules()).toBe(1);
    const updated = store.schedules.get(sched.id)!;
    expect(updated.last_run_status).toBe("error");
    expect(updated.last_run_error).toMatch(/not found/);
    expect(updated.next_run_at > past).toBe(true);
  });

  it("claimDue is idempotent for the same tick until complete releases the lease", async () => {
    const agent = seed.agent(A);
    const envRow = seed.environment(A);
    const past = new Date(Date.now() - 60_000).toISOString();
    seed.schedule(A, {
      next_run_at: past,
      action: { type: "session.create", agent_id: agent.id, environment_id: envRow.id, message: "once" },
    });
    const first = await schedules.claimDue("r1", 60_000);
    expect(first).toHaveLength(1);
    const second = await schedules.claimDue("r2", 60_000);
    expect(second).toHaveLength(0);
  });
});
