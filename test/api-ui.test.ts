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

const { app } = await import("../src/api/main.ts");
const { reset } = await import("./fixtures/api-harness/fake-db.ts");
const { derivePendingActions } = await import("../src/api/routes/ui-pending.ts");

beforeEach(() => reset());
afterEach(() => vi.restoreAllMocks());

describe("GET / operator console", () => {
  it("serves an interactive console (not a read-only timeline)", async () => {
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain("rethink · console");
    expect(html).toContain("New session");
    expect(html).toContain("API key");
    expect(html).toContain("localStorage");
    expect(html).toContain("user.tool_confirmation");
    expect(html).toContain("tool_result");
    expect(html).toContain("btnSend");
    expect(html).toContain("/v1/sessions");
    expect(html).toContain("text/event-stream");
    expect(html).toMatch(/@media\(max-width:720px\)/);
  });
});

describe("derivePendingActions", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ payload: { type, ...extra } });

  it("surfaces unanswered tool confirmations", () => {
    const pending = derivePendingActions([
      ev("agent.tool_confirmation_required", { tool_use_id: "t1", name: "delete_repo", mcp_server: "github" }),
      ev("agent.message", { content: [{ type: "text", text: "waiting" }] }),
    ]);
    expect(pending).toEqual([{ kind: "confirmation", tool_use_id: "t1", name: "delete_repo", mcp_server: "github" }]);
  });

  it("drops confirmations once the user answers", () => {
    const pending = derivePendingActions([
      ev("agent.tool_confirmation_required", { tool_use_id: "t1", name: "delete_repo" }),
      ev("user.tool_confirmation", { tool_use_id: "t1", result: "allow" }),
    ]);
    expect(pending).toEqual([]);
  });

  it("surfaces client/function tool calls without a tool_result", () => {
    const pending = derivePendingActions([
      ev("agent.tool_use", { tool_use_id: "c1", name: "propose_rollback", input: { plan: "x" } }),
      ev("agent.tool_use", { tool_use_id: "c2", name: "bash", input: { cmd: "ls" } }),
    ], ["propose_rollback"]);
    expect(pending).toEqual([{ kind: "client_tool", tool_use_id: "c1", name: "propose_rollback", input: { plan: "x" } }]);
  });

  it("clears client tools after a tool_result", () => {
    const pending = derivePendingActions([
      ev("agent.tool_use", { tool_use_id: "c1", name: "propose", input: {} }),
      ev("agent.tool_result", { tool_use_id: "c1", content: [{ type: "text", text: "ok" }] }),
    ], ["propose"]);
    expect(pending).toEqual([]);
  });
});
