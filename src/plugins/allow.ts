import { env } from "../shared/env.ts";

/**
 * Operator governance for which plugin package sources may be installed. Plugin code runs on the
 * runner with capabilities, so the operator — not an arbitrary tenant — decides what is allowed.
 * PLUGIN_ALLOW is "*" (any, the default), empty (deny all), or a comma list of prefixes a package
 * source must start with (e.g. "npm:@acme/,/app/plugins/"). Enforced both when an agent is created
 * (API 400) and at load time in the runner (defense in depth).
 */
export function pluginAllowRules(): string[] {
  return env.PLUGIN_ALLOW.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isPackageAllowed(pkg: string): boolean {
  const rules = pluginAllowRules();
  if (rules.includes("*")) return true;
  return rules.some((r) => pkg === r || pkg.startsWith(r));
}

/** Returns the disallowed entries in `packages` (empty = all allowed). */
export function disallowedPackages(packages: string[]): string[] {
  return packages.filter((p) => !isPackageAllowed(p));
}
