import path from "node:path";
import { env } from "../shared/env.ts";

/**
 * Plugin governance is about *where the plugin runs*, not who owns it. A plugin host has a placement:
 *   - "runner":  the operator's shared runner process (curated) — gated by PLUGIN_ALLOW.
 *   - "sandbox": the user's own isolated sandbox (plugin_host=sandbox) — gated by PLUGIN_ALLOW_SANDBOX
 *                (default "*"): the code runs in the user's environment, so users may bring their own
 *                "brain" plugins here safely.
 * Each list is "*" (any), empty (deny all), or a comma list of prefixes a package source must start
 * with (e.g. "npm:@acme/,/app/plugins/"). Enforced at host start by placement, plus a create-time
 * check that a package is runnable in *at least one* placement.
 */
export type Placement = "runner" | "sandbox";

function rules(placement: Placement): string[] {
  const raw = placement === "sandbox" ? env.PLUGIN_ALLOW_SANDBOX : env.PLUGIN_ALLOW;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The form a source is matched in, or null when it cannot be matched safely against a prefix:
 * npm specs whose version part is an alias / git / url / file spec (npm:@acme/x@npm:evil installs
 * "evil"), and paths are normalized first (so '..' cannot climb out of an allowed dir).
 */
function canonical(pkg: string): string | null {
  if (!pkg || /\s/.test(pkg)) return null;
  if (pkg.startsWith("npm:")) {
    const m = /^(@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)(?:@(.*))?$/i.exec(pkg.slice(4));
    if (!m || m[1]!.split("/").some((seg) => seg === "." || seg === ".." || seg === "@." || seg === "@..")) return null;
    if (m[2] !== undefined && /[:/\\]/.test(m[2])) return null;
    return pkg;
  }
  if (path.isAbsolute(pkg)) return path.posix.normalize(pkg);
  return pkg;
}

export function isPackageAllowed(pkg: string, placement: Placement): boolean {
  const rs = rules(placement);
  if (rs.includes("*")) return true;
  const c = canonical(pkg);
  if (c === null) return false;
  // A rule ending in "/" is a directory/scope prefix; otherwise it names one package or dir exactly
  // (plus its version / ref, or anything below it) and never a sibling that merely shares the prefix.
  return rs.some((r) => (r.endsWith("/") ? c.startsWith(r) : c === r || c.startsWith(`${r}/`) || c.startsWith(`${r}@`)));
}

/** Disallowed entries for a specific placement (empty = all allowed there). */
export function disallowedFor(packages: string[], placement: Placement): string[] {
  return packages.filter((p) => !isPackageAllowed(p, placement));
}

/** Runnable in at least one placement (runner or sandbox). */
export function isPackageEverAllowed(pkg: string): boolean {
  return isPackageAllowed(pkg, "runner") || isPackageAllowed(pkg, "sandbox");
}
export function disallowedEverywhere(packages: string[]): string[] {
  return packages.filter((p) => !isPackageEverAllowed(p));
}
