import { describe, it, expect, beforeAll } from "vitest";

process.env.PLUGIN_ALLOW = "npm:@acme/,/app/plugins/";
let mod: typeof import("../src/plugins/allow.ts");
beforeAll(async () => { mod = await import("../src/plugins/allow.ts"); });

describe("plugin package allowlist", () => {
  it("allows only sources matching a prefix rule", () => {
    expect(mod.isPackageAllowed("npm:@acme/tools")).toBe(true);
    expect(mod.isPackageAllowed("/app/plugins/memory")).toBe(true);
    expect(mod.isPackageAllowed("npm:evil")).toBe(false);
    expect(mod.isPackageAllowed("git:https://x/y.git")).toBe(false);
  });
  it("reports the disallowed subset", () => {
    expect(mod.disallowedPackages(["npm:@acme/a", "npm:evil", "/app/plugins/team"])).toEqual(["npm:evil"]);
  });
});
