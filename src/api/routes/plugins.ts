import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../shared/env.ts";
import { isPackageAllowed } from "../../plugins/allow.ts";

/**
 * The plugins a caller can actually attach, so nobody has to know a package source by heart.
 *
 * Only the deployment's bundled plugins can be enumerated: an npm scope or a git host is not a list
 * anyone can read. So this is a catalogue of what ships with this deployment, each entry carrying the
 * source string to attach and whether the allowlist lets it run on the shared runner, in a sandbox
 * host, or neither. `PLUGIN_CATALOG_DIR` points at that directory; the default is the repo's own
 * `plugins/`, which is the same path on the api and the runner in the standard deployment.
 */
export interface PluginCatalogEntry {
  name: string;
  /** the package source to attach (an absolute path on the runner) */
  source: string;
  description: string;
  /** where this package may run, given PLUGIN_ALLOW / PLUGIN_ALLOW_SANDBOX */
  allowed: { runner: boolean; sandbox: boolean };
}

/** Read the bundled catalogue. A directory without a package.json is not a plugin and is skipped. */
export async function pluginCatalog(): Promise<PluginCatalogEntry[]> {
  const dir = env.PLUGIN_CATALOG_DIR;
  let names: string[];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); }
  catch { return []; }
  const out: PluginCatalogEntry[] = [];
  for (const name of names.sort()) {
    const source = path.join(dir, name);
    try {
      const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as { description?: string; pma?: unknown; pi?: unknown };
      if (!pkg.pma && !pkg.pi) continue; // a plain npm package in the tree, not a plugin
      out.push({ name, source, description: pkg.description ?? "", allowed: { runner: isPackageAllowed(source, "runner"), sandbox: isPackageAllowed(source, "sandbox") } });
    } catch { /* not a plugin */ }
  }
  return out;
}

export const plugins = new Hono()
  .get("/", async (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase();
    const data = (await pluginCatalog()).filter((p) => !q || p.name.includes(q) || p.description.toLowerCase().includes(q));
    return c.json({ data, has_more: false });
  });
