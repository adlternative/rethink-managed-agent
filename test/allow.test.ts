import { describe, it, expect, beforeAll } from "vitest";

process.env.PLUGIN_ALLOW = "/app/plugins/";        // shared runner: only bundled plugins
process.env.PLUGIN_ALLOW_SANDBOX = "*";            // isolated sandbox: anything (runs in the user's own box)
let mod: typeof import("../src/plugins/allow.ts");
beforeAll(async () => { mod = await import("../src/plugins/allow.ts"); });

describe("placement-aware plugin governance", () => {
  it("shared runner allows only curated packages", () => {
    expect(mod.isPackageAllowed("/app/plugins/memory", "runner")).toBe(true);
    expect(mod.isPackageAllowed("npm:user-brain", "runner")).toBe(false);
  });
  it("isolated sandbox lets users bring their own brain plugins", () => {
    expect(mod.isPackageAllowed("npm:user-brain", "sandbox")).toBe(true);
  });
  it("create-time check passes if runnable in ANY placement; blocks only never-runnable", () => {
    // npm:user-brain is fine for sandbox placement, so it is not rejected at create
    expect(mod.disallowedEverywhere(["/app/plugins/team", "npm:user-brain"])).toEqual([]);
  });
  it("per-placement disallowed lists differ", () => {
    expect(mod.disallowedFor(["/app/plugins/team", "npm:user-brain"], "runner")).toEqual(["npm:user-brain"]);
    expect(mod.disallowedFor(["/app/plugins/team", "npm:user-brain"], "sandbox")).toEqual([]);
  });
});
