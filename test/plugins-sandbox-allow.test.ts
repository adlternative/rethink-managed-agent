import { describe, it, expect, vi, afterAll } from "vitest";

const saved = { runner: process.env.PLUGIN_ALLOW, sandbox: process.env.PLUGIN_ALLOW_SANDBOX };
afterAll(() => {
  if (saved.runner === undefined) delete process.env.PLUGIN_ALLOW; else process.env.PLUGIN_ALLOW = saved.runner;
  if (saved.sandbox === undefined) delete process.env.PLUGIN_ALLOW_SANDBOX; else process.env.PLUGIN_ALLOW_SANDBOX = saved.sandbox;
});

/** env.ts snapshots process.env at import, so each rule set gets a fresh module graph. */
async function withRules(runner: string, sandbox = "") {
  process.env.PLUGIN_ALLOW = runner;
  process.env.PLUGIN_ALLOW_SANDBOX = sandbox;
  vi.resetModules();
  return import("../src/plugins/allow.ts");
}

describe("allowlist rule parsing", () => {
  it("an empty list denies everything in that placement", async () => {
    const m = await withRules("", "");
    expect(m.isPackageAllowed("npm:x", "runner")).toBe(false);
    expect(m.isPackageAllowed("/app/plugins/x", "sandbox")).toBe(false);
    expect(m.disallowedEverywhere(["npm:x"])).toEqual(["npm:x"]);
  });

  it("trims whitespace and ignores empty entries", async () => {
    const m = await withRules("  npm:@acme/ , ,  /app/plugins/  ");
    expect(m.isPackageAllowed("npm:@acme/tool", "runner")).toBe(true);
    expect(m.isPackageAllowed("/app/plugins/team", "runner")).toBe(true);
    expect(m.isPackageAllowed("npm:other", "runner")).toBe(false);
    // an empty entry must not become a match-everything "" prefix
    expect(m.isPackageAllowed("", "runner")).toBe(false);
  });

  it("'*' mixed with other entries allows everything", async () => {
    const m = await withRules("npm:@acme/,*");
    expect(m.isPackageAllowed("git:https://anything/x.git", "runner")).toBe(true);
  });

  it("an exact entry matches itself", async () => {
    const m = await withRules("npm:left-pad");
    expect(m.isPackageAllowed("npm:left-pad", "runner")).toBe(true);
  });
});

// Regression: allow.ts is a raw startsWith on the source string, so these sneak past the prefix.
describe("allowlist prefix bypasses", () => {
  it("rejects an npm alias spec hiding another package behind an allowed scope", async () => {
    const m = await withRules("npm:@acme/,/app/plugins/");
    expect(m.isPackageAllowed("npm:@acme/x@npm:evil-pkg", "runner")).toBe(false);
  });
  it("rejects an npm spec that resolves to a git url", async () => {
    const m = await withRules("npm:@acme/,/app/plugins/");
    expect(m.isPackageAllowed("npm:@acme/x@git+https://evil/x.git", "runner")).toBe(false);
  });
  it("rejects a '..' path that leaves the allowed dir", async () => {
    const m = await withRules("npm:@acme/,/app/plugins/");
    expect(m.isPackageAllowed("/app/plugins/../../tmp/evil", "runner")).toBe(false);
  });
  it("a rule without a trailing slash does not allow sibling dirs", async () => {
    const m = await withRules("/app/plugins");
    expect(m.isPackageAllowed("/app/plugins/team", "runner")).toBe(true);
    expect(m.isPackageAllowed("/app/pluginsX", "runner")).toBe(false);
  });
});
