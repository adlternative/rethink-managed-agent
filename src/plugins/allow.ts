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

export function isPackageAllowed(pkg: string, placement: Placement): boolean {
  const rs = rules(placement);
  return rs.includes("*") || rs.some((r) => pkg === r || pkg.startsWith(r));
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
