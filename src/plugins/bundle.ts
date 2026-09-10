/**
 * Builds the tarball that runs a plugin host *inside* a sandbox: the host sources, typebox, and the
 * agent's packages (remapped under packages/<n>). Cached per agent + source list.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PackageManifest } from "./api.ts";

const run = promisify(execFile);
export const SANDBOX_HOST_DIR = "/tmp/pma-host";

export interface HostBundle { tgz: Uint8Array; manifests: PackageManifest[]; key: string }

const cache = new Map<string, Promise<HostBundle>>();

export function buildHostBundle(manifests: PackageManifest[], repoRoot: string): Promise<HostBundle> {
  const key = createHash("sha256").update(JSON.stringify(manifests.map((m) => m.dir))).digest("hex").slice(0, 16);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const stage = await mkdtemp(path.join(tmpdir(), "pma-host-"));
      try {
        await mkdir(path.join(stage, "src/plugins"), { recursive: true });
        await mkdir(path.join(stage, "node_modules"), { recursive: true });
        await cp(path.join(repoRoot, "src/plugins"), path.join(stage, "src/plugins"), { recursive: true });
        await cp(path.join(repoRoot, "node_modules/typebox"), path.join(stage, "node_modules/typebox"), { recursive: true, dereference: true });
        const remapped: PackageManifest[] = [];
        for (const [i, m] of manifests.entries()) {
          const rel = `packages/${i}-${path.basename(m.dir).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
          await cp(m.dir, path.join(stage, rel), { recursive: true, dereference: true, filter: (src) => !/\/\.git(\/|$)/.test(src) });
          remapped.push({ ...m, dir: path.posix.join(SANDBOX_HOST_DIR, rel) });
        }
        const out = path.join(stage, "bundle.tgz");
        await run("tar", ["czf", out, "-C", stage, "src", "node_modules", "packages"]);
        await writeFile(out + ".key", key);
        return { tgz: new Uint8Array(await readFile(out)), manifests: remapped, key };
      } finally {
        // keep the tgz bytes in memory; drop the staging dir
        await rm(stage, { recursive: true, force: true });
      }
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
