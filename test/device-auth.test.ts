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
const { env } = await import("../src/shared/env.ts");
const { reset, seed, apiKeys } = await import("./fixtures/api-harness/fake-db.ts");
const { resetDeviceAuthStore } = await import("../src/api/device-auth.ts");

const saved = { ...env };
beforeEach(() => { reset(); resetDeviceAuthStore(); Object.assign(env, saved); });
afterEach(() => { Object.assign(env, saved); vi.restoreAllMocks(); });

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("device authorization", () => {
  it("device endpoints stay public when AUTH_REQUIRED=true", async () => {
    env.AUTH_REQUIRED = true;
    const code = await json("POST", "/v1/auth/device/code");
    expect(code.status).toBe(200);
    const body = await code.json() as { device_code: string; user_code: string; verification_uri: string };
    expect(body.device_code).toMatch(/^dev_/);
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.verification_uri).toContain("/login/device");

    const page = await app.request(`/login/device?user_code=${encodeURIComponent(body.user_code)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Authorize CLI");
  });

  it("happy path: approve without key when AUTH_REQUIRED=false, then poll token", async () => {
    env.AUTH_REQUIRED = false;
    env.PMA_DEFAULT_PRINCIPAL = "prc_local";
    seed.principal("prc_local");
    const issued = await (await json("POST", "/v1/auth/device/code")).json() as { device_code: string; user_code: string };

    const pending = await json("POST", "/v1/auth/device/token", {
      device_code: issued.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    const approve = await json("POST", "/v1/auth/device/approve", { user_code: issued.user_code });
    expect(approve.status).toBe(200);

    const tok = await json("POST", "/v1/auth/device/token", { device_code: issued.device_code });
    expect(tok.status).toBe(200);
    const granted = await tok.json() as { access_token: string; principal_id: string };
    expect(granted.access_token).toMatch(/^pma_/);
    expect(granted.principal_id).toBe("prc_local");

    env.AUTH_REQUIRED = true;
    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${granted.access_token}` } });
    expect(me.status).toBe(200);
    expect((await me.json() as { id: string }).id).toBe("prc_local");
  });

  it("AUTH_REQUIRED=true + signup creates a new principal on approve", async () => {
    env.AUTH_REQUIRED = true;
    env.DEVICE_LOGIN_SIGNUP = true;
    const issued = await (await json("POST", "/v1/auth/device/code")).json() as { device_code: string; user_code: string };
    const approve = await json("POST", "/v1/auth/device/approve", { user_code: issued.user_code, display_name: "Ada" });
    expect(approve.status).toBe(200);
    const { principal_id } = await approve.json() as { principal_id: string };
    expect(principal_id).toMatch(/^prc_/);

    const tok = await (await json("POST", "/v1/auth/device/token", { device_code: issued.device_code })).json() as { access_token: string };
    const me = await (await app.request("/v1/me", { headers: { authorization: `Bearer ${tok.access_token}` } })).json() as { id: string; display_name: string };
    expect(me.id).toBe(principal_id);
    expect(me.display_name).toBe("Ada");
  });

  it("approve with pasted api_key mints for that principal", async () => {
    env.AUTH_REQUIRED = true;
    env.DEVICE_LOGIN_SIGNUP = false;
    seed.principal("prc_ada");
    const { token } = await apiKeys.create("prc_ada");
    const issued = await (await json("POST", "/v1/auth/device/code")).json() as { device_code: string; user_code: string };

    const denied = await json("POST", "/v1/auth/device/approve", { user_code: issued.user_code });
    expect(denied.status).toBe(401);

    const approve = await json("POST", "/v1/auth/device/approve", { user_code: issued.user_code, api_key: token });
    expect(approve.status).toBe(200);
    const tok = await (await json("POST", "/v1/auth/device/token", { device_code: issued.device_code })).json() as { access_token: string; principal_id: string };
    expect(tok.principal_id).toBe("prc_ada");
    expect(tok.access_token).not.toBe(token);
  });
});
