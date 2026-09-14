import { describe, it, expect, vi } from "vitest";

// Separate file: the pg bus memoizes its LISTEN connection per process, so the failed-first-connect
// scenario needs a fresh module instance with the failure armed before the first subscribe.
process.env.MESSAGING_BACKEND = "postgres";

let failNext = 1;
let released = 0;
vi.mock("pg", () => {
  class Pool {
    query = async () => ({ rows: [], rowCount: 0 });
    connect = async () => {
      if (failNext > 0) { failNext--; throw new Error("ECONNREFUSED"); }
      const client = { on: () => client, query: async () => ({ rows: [], rowCount: 0 }), release: () => { released++; } };
      return client;
    };
  }
  return { default: { Pool }, Pool };
});

const bus = await import("../src/infra/pubsub.ts");

describe("pg bus listener recovery", () => {
  // Regression: ensure() caches the rejected connect promise, so after Postgres comes back every later
  // subscribe still rejects with the original error until the process restarts.
  it("a later subscribe retries the LISTEN connection after a failed first connect", async () => {
    await expect(bus.subscribe("s1", () => {})).rejects.toThrow(/ECONNREFUSED/);
    const u = await bus.subscribe("s1", () => {});
    expect(typeof u).toBe("function");
  });

  // Regression: close() releases the client but leaves the memoized listener, so a subscribe after close
  // resolves against a released connection and never receives notifications.
  it("subscribe after closeBus re-establishes the LISTEN connection", async () => {
    failNext = 0;
    vi.resetModules(); // a fresh bus, independent of the failed-connect case above
    const fresh = await import("../src/infra/pubsub.ts");
    await fresh.subscribe("s2", () => {});
    await fresh.closeBus();
    const before = released;
    await fresh.subscribe("s3", () => {});
    await fresh.closeBus();
    expect(released).toBeGreaterThan(before);
  });
});
