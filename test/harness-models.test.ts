import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelRegistry, resolveModel } from "../src/harness/models.ts";
import type { ProviderResource } from "../src/shared/types.ts";

const T = "2026-01-01T00:00:00.000Z";
const row = (id: string, over: Partial<ProviderResource> = {}): ProviderResource => ({
  id, owner_id: "prc_local", name: id, api: "openai-completions", base_url: `https://${id}.example/v1`, headers: {}, auth: { type: "none" },
  models: [{ id: "m1", context_window: 1000 }], enabled: true, created_at: T, updated_at: T, ...over,
});
const resolveKey = async (models: ReturnType<typeof buildModelRegistry>, provider: string) => {
  const r = await (models.getProvider(provider)!.auth.apiKey as any).resolve({});
  return r.auth.apiKey as string;
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("buildModelRegistry", () => {
  it("maps provider rows to models with defaults and skips disabled providers", () => {
    const models = buildModelRegistry([
      row("gw", { headers: { "x-org": "o1" }, models: [{ id: "big", context_window: 500_000, input: ["text", "image"], reasoning: true, cost: { input: 1, output: 2 } }, { id: "m1", context_window: 1000 }] }),
      row("plain"),
      row("off", { enabled: false }),
    ]);
    const big = resolveModel(models, { provider: "gw", id: "big" });
    expect(big).toMatchObject({ provider: "gw", api: "openai-completions", baseUrl: "https://gw.example/v1", contextWindow: 500_000, maxTokens: 32_000, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, headers: { "x-org": "o1" }, name: "gw/big" });
    expect(resolveModel(models, { provider: "plain", id: "m1" }).headers).toBeUndefined();
    expect(models.getModel("off", "m1")).toBeUndefined();
  });

  it("skips an unsupported api with a warning and keeps the other providers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = buildModelRegistry([row("weird", { api: "gemini" as never }), row("ok")]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider weird: unsupported api gemini"));
    expect(models.getModel("weird", "m1")).toBeUndefined();
    expect(models.getModel("ok", "m1")).toBeDefined();
  });

  it("a malformed row (headers null) is skipped instead of failing the whole registry", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = buildModelRegistry([row("broken", { headers: null as never }), row("ok")]);
    expect(models.getModel("ok", "m1")).toBeDefined();
  });

  it("resolveModel lists the known models for an unknown ref", () => {
    const models = buildModelRegistry([row("a"), row("b")]);
    expect(() => resolveModel(models, { provider: "a", id: "nope" })).toThrow("Unknown model a/nope. Known models: a/m1, b/m1");
    expect(() => resolveModel(buildModelRegistry([]), { provider: "a", id: "m" })).toThrow(/Known models: \(none\)/);
  });
});

describe("provider credentials", () => {
  it("auth none resolves to a placeholder key; env auth reads the runner env", async () => {
    vi.stubEnv("HARNESS_TEST_PROVIDER_KEY", "sk-test");
    const models = buildModelRegistry([row("none"), row("env", { auth: { type: "env", name: "HARNESS_TEST_PROVIDER_KEY" } })]);
    expect(await resolveKey(models, "none")).toBe("none");
    expect(await resolveKey(models, "env")).toBe("sk-test");
  });

  it("an unset env var is an error naming the variable", async () => {
    const models = buildModelRegistry([row("env", { auth: { type: "env", name: "HARNESS_TEST_DEFINITELY_UNSET" } })]);
    await expect(resolveKey(models, "env")).rejects.toThrow(/HARNESS_TEST_DEFINITELY_UNSET is not set on the runner/);
  });

  it("a tenant-owned provider row cannot resolve arbitrary runner env vars (regression: any env name is readable)", async () => {
    vi.stubEnv("PMA_SECRET_KEY", "runner-master-key");
    const models = buildModelRegistry([row("attacker", { owner_id: "prc_tenant", base_url: "https://attacker.example", auth: { type: "env", name: "PMA_SECRET_KEY" } })]);
    const key = await resolveKey(models, "attacker").catch(() => null);
    expect(key).not.toBe("runner-master-key");
  });
});
