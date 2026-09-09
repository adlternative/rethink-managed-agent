import { describe, expect, it } from "vitest";
import { redactRef } from "../src/harness/run-turn.ts";
import { validateImage, validateWorkspaceSpec } from "../src/api/routes/environments.ts";

describe("validateWorkspaceSpec", () => {
  it("accepts network git remotes and sane refs", () => {
    expect(validateWorkspaceSpec({ kind: "git", remote: "https://github.com/o/r.git", ref: "feature/x" })).toEqual({ kind: "git", remote: "https://github.com/o/r.git", ref: "feature/x" });
    expect(validateWorkspaceSpec({ kind: "git", remote: "git@github.com:o/r.git" })).toEqual({ kind: "git", remote: "git@github.com:o/r.git" });
  });
  it("rejects option-looking and host-path remotes/refs (git argv injection)", () => {
    for (const remote of ["--upload-pack=sh -c id", "-c core.sshCommand=x", "/app", "file:///etc", "https://x y"]) {
      expect(() => validateWorkspaceSpec({ kind: "git", remote })).toThrow();
    }
    for (const ref of ["--output=/tmp/x", "-b", "a b", "a..b", "x.lock"]) {
      expect(() => validateWorkspaceSpec({ kind: "git", remote: "https://h/r", ref })).toThrow();
    }
  });
  it("rejects local paths unless an allow root is configured", () => {
    expect(() => validateWorkspaceSpec({ kind: "local", path: "/" })).toThrow(/disabled/);
  });
});

describe("validateImage", () => {
  it("accepts references and rejects flags", () => {
    expect(validateImage("node:22-alpine")).toBe("node:22-alpine");
    expect(validateImage("ghcr.io/org/img:1.2@sha256:" + "a".repeat(64))).toContain("ghcr.io");
    expect(validateImage(undefined)).toBeNull();
    for (const bad of ["--privileged", "-v", "node:22 --pid=host", "Node"]) expect(() => validateImage(bad)).toThrow();
  });
});

describe("redactRef", () => {
  it("strips userinfo from git remotes before they enter the event log", () => {
    expect(redactRef({ kind: "git", remote: "https://x-access-token:ghp_abc@github.com/o/r.git", base: "abc" })).toEqual({ kind: "git", remote: "https://github.com/o/r.git", base: "abc" });
    expect(redactRef({ kind: "git", remote: "git@github.com:o/r.git", base: "abc" })).toEqual({ kind: "git", remote: "git@github.com:o/r.git", base: "abc" });
    expect(redactRef({ kind: "empty" })).toEqual({ kind: "empty" });
  });
});
