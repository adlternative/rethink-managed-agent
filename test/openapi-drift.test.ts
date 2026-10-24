import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { NATIVE_V1_ROUTES } from "../openapi/route-inventory.ts";

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

function pathsFromOpenApi(yaml: string): Set<string> {
  const out = new Set<string>();
  for (const line of yaml.split("\n")) {
    const m = /^  (\/v1\/\S+):/.exec(line);
    if (m) out.add(m[1]!.replace(/\{([^}]+)\}/g, ":$1"));
  }
  return out;
}

function liveV1Paths(): Set<string> {
  const out = new Set<string>();
  for (const r of app.routes) {
    const p = r.path.replace(/\/+$/, "") || "/";
    if (!p.startsWith("/v1")) continue;
    // Middleware registrations (.use) show up without a useful method filter; keep all unique paths.
    out.add(p);
  }
  return out;
}

describe("openapi /v1 drift", () => {
  beforeEach(() => {});
  afterEach(() => { vi.restoreAllMocks(); });

  it("openapi/v1.yaml paths match openapi/route-inventory.ts", () => {
    const yaml = readFileSync(new URL("../openapi/v1.yaml", import.meta.url), "utf8");
    const documented = pathsFromOpenApi(yaml);
    const inventory = new Set(NATIVE_V1_ROUTES);
    expect([...inventory].filter((p) => !documented.has(p))).toEqual([]);
    expect([...documented].filter((p) => !inventory.has(p))).toEqual([]);
  });

  it("every inventory path is registered on the Hono app", () => {
    const live = liveV1Paths();
    const missing = NATIVE_V1_ROUTES.filter((p) => !live.has(p));
    expect(missing).toEqual([]);
  });

  it("serves the checked-in OpenAPI document", async () => {
    const r = await app.request("/openapi/v1.yaml");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("openapi:");
    expect(text).toContain("/v1/sessions");
  });
});
