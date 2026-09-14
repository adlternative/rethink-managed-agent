import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * translate.ts branches that depend on COMPAT_* env. `env` is read once at import, so each case sets
 * process.env, resets the module registry and imports a fresh copy.
 */

const KEYS = ["COMPAT_MODEL_MAP", "COMPAT_DEFAULT_PROVIDER", "COMPAT_TEAM_PACKAGE", "COMPAT_WEBSEARCH_PACKAGE", "COMPAT_DEFAULT_ENVIRONMENT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function load(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  vi.resetModules();
  return import("../src/api/routes/compat/translate.ts");
}

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.resetModules();
});

describe("translate with COMPAT_* env", () => {
  it("invalid COMPAT_MODEL_MAP JSON falls back without throwing", async () => {
    const t = await load({ COMPAT_MODEL_MAP: "{not json", COMPAT_DEFAULT_PROVIDER: "prov" });
    expect(t.mapModel("gpt-x")).toEqual({ provider: "prov", id: "gpt-x" });
    expect(t.mapModel("a/b/c")).toEqual({ provider: "a", id: "b/c" });
  });

  it("a map target without '/' uses the default provider", async () => {
    const t = await load({ COMPAT_MODEL_MAP: JSON.stringify({ "gpt-x": "ultimate" }), COMPAT_DEFAULT_PROVIDER: "qoder" });
    expect(t.mapModel("gpt-x")).toEqual({ provider: "qoder", id: "ultimate" });
  });

  it("multi_agent.enabled with COMPAT_TEAM_PACKAGE adds the package; disabled does not", async () => {
    const t = await load({ COMPAT_TEAM_PACKAGE: "@pma/team" });
    expect(t.openaiAgentToRethink({ model: "m", multi_agent: { enabled: true } }).packages).toEqual(["@pma/team"]);
    expect(t.openaiAgentToRethink({ model: "m", multi_agent: { enabled: false } }).packages).toEqual([]);
  });

  it("multi_agent.enabled without COMPAT_TEAM_PACKAGE adds nothing", async () => {
    const t = await load({});
    expect(t.openaiAgentToRethink({ model: "m", multi_agent: { enabled: true } }).packages).toEqual([]);
  });

  it("web_search with COMPAT_WEBSEARCH_PACKAGE adds it and does not list it as ignored", async () => {
    const t = await load({ COMPAT_WEBSEARCH_PACKAGE: "@pma/web", COMPAT_TEAM_PACKAGE: "@pma/team" });
    const d = t.openaiAgentToRethink({ model: "m", multi_agent: { enabled: true }, tools: [{ type: "web_search" }, { type: "programmatic_tool_calling" }] });
    expect(d.packages).toEqual(["@pma/team", "@pma/web"]);
    expect(d.ignored).toEqual([{ type: "programmatic_tool_calling" }]);
  });

  it("an agent spec without a string model throws invalid", async () => {
    const t = await load({});
    expect(() => t.openaiAgentToRethink({} as never)).toThrow(/agent.model/);
    expect(() => t.openaiAgentToRethink(undefined as never)).toThrow(/agent.model/);
    expect(() => t.openaiAgentToRethink({ model: 5 } as never)).toThrow(/agent.model/);
  });

  it("COMPAT_DEFAULT_ENVIRONMENT is used when environment or its id is omitted; an explicit id wins", async () => {
    const t = await load({ COMPAT_DEFAULT_ENVIRONMENT: "env_default" });
    expect(t.openaiEnvToEnvironmentId(undefined)).toBe("env_default");
    expect(t.openaiEnvToEnvironmentId({ type: "cloud" })).toBe("env_default");
    expect(t.openaiEnvToEnvironmentId({ environment_id: "env_x" })).toBe("env_x");
  });

  it("an mcp tool without server_label gets label 'mcp'", async () => {
    const t = await load({});
    const s = t.splitTools([{ type: "mcp", transport: { type: "http", server_url: "https://a/mcp" } }]);
    expect(s.mcpServers.map((m) => m.label)).toEqual(["mcp"]);
    expect(() => t.splitTools([{ type: "mcp", transport: {} }])).toThrow(/mcp tool mcp requires transport.server_url/);
  });

  // Regression: two unlabeled mcp tools both get label 'mcp' and collide silently.
  it("two mcp tools without server_label do not silently share one label", async () => {
    const t = await load({});
    let labels: string[] = [];
    try {
      labels = t.splitTools([{ type: "mcp", transport: { server_url: "https://a/mcp" } }, { type: "mcp", transport: { server_url: "https://b/mcp" } }]).mcpServers.map((m) => m.label);
    } catch { return; } // rejecting the collision is also acceptable
    expect(new Set(labels).size).toBe(2);
  });

  it("a function tool without parameters gets an empty object schema", async () => {
    const t = await load({});
    expect(t.splitTools([{ type: "function", name: "f" }]).clientTools).toEqual([{ type: "function", name: "f", description: undefined, parameters: { type: "object", properties: {} } }]);
  });
});
