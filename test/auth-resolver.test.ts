import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable pg mock: each query shifts the next canned result (default: one generic row).
let queue: unknown[][] = [];
const calls: { sql: string; params: unknown[] }[] = [];
function respond() { const rows = queue.shift() ?? [{ id: "row", owner_id: "prc_x" }]; return { rows, rowCount: rows.length }; }
vi.mock("pg", () => {
  class Pool { query = async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return respond(); }; connect = async () => ({ query: this.query, release() {} }); }
  return { default: { Pool }, Pool };
});

const { bearerApiKeyResolver } = await import("../src/api/principal-resolver.ts");
const trustedHeader = (await import("../src/api/resolvers/trusted-header.ts")).default;

const req = (headers: Record<string, string>, path = "/v1/agents", method = "GET") => ({
  header: (n: string) => headers[n.toLowerCase()],
  method,
  path,
});

beforeEach(() => { queue = []; calls.length = 0; });

describe("bearerApiKeyResolver", () => {
  it("returns null when no bearer token is present (middleware then applies AUTH_REQUIRED/default)", async () => {
    expect(await bearerApiKeyResolver.resolve(req({}))).toBeNull();
  });
  it("resolves a valid token to its principal", async () => {
    queue = [[{ principal_id: "prc_a" }], [{ id: "prc_a", kind: "user", handle: "a", display_name: "A" }]];
    const id = await bearerApiKeyResolver.resolve(req({ authorization: "Bearer pma_secret" }));
    expect(id?.actor.id).toBe("prc_a");
    expect(id?.owner).toBeUndefined(); // owner defaults to actor in the middleware
  });
  it("throws 401 for an unknown token", async () => {
    queue = [[]]; // UPDATE ... RETURNING finds no key
    await expect(bearerApiKeyResolver.resolve(req({ authorization: "Bearer nope" }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("trusted-header resolver (example)", () => {
  it("returns null when the trusted header is absent", async () => {
    expect(await trustedHeader.resolve(req({}))).toBeNull();
  });
  it("provisions and returns the asserted principal, and honors x-org-id as the owner", async () => {
    queue = [[], [{ id: "user-42", kind: "user", handle: null, display_name: "user-42" }]]; // get miss -> upsert
    const r = await trustedHeader.resolve(req({ "x-principal-id": "user-42", "x-org-id": "org-7" }));
    expect(r?.actor.id).toBe("user-42");
    expect(r?.owner).toBe("org-7");
  });
  it("rejects a malformed principal id", async () => {
    await expect(trustedHeader.resolve(req({ "x-principal-id": "bad id!" }))).rejects.toMatchObject({ status: 401 });
  });
});
