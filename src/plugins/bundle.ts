/**
 * Builds the tarball that runs a plugin host *inside* a sandbox: the host sources, typebox, and the
 * agent's packages (remapped under packages/<n>). Cached per agent + source list.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PackageManifest } from "./api.ts";

const run = promisify(execFile);
export const SANDBOX_HOST_DIR = "/tmp/pma-host";

export interface HostBundle { tgz: Uint8Array; manifests: PackageManifest[]; key: string }

/** Where a bundle is unpacked in a sandbox: one dir per bundle, so hosts of different agents sharing a container never replace each other's packages. */
export const bundleDir = (key: string) => path.posix.join(SANDBOX_HOST_DIR, key.replace(/[^A-Za-z0-9_-]/g, "_"));

/**
 * A cp filter for copying `root` into the bundle: skips .git, and any symlink that resolves outside
 * `root` (the bundle is shipped into the user's sandbox, so a link to a runner-host file must never
 * be dereferenced into it).
 */
function confinedTo(root: string) {
  const realRoot = realpath(root).catch(() => path.resolve(root));
  return async (src: string): Promise<boolean> => {
    if (/\/\.git(\/|$)/.test(src)) return false;
    if (!(await lstat(src).catch(() => null))?.isSymbolicLink()) return true;
    const [r, target] = await Promise.all([realRoot, realpath(src).catch(() => null)]);
    return !!target && (target === r || target.startsWith(r + path.sep));
  };
}

/** For an npm-installed package (<root>/node_modules/[@scope/]name), the node_modules dir holding its hoisted dependencies. */
function hoistRoot(dir: string): string | null {
  const parent = path.dirname(dir);
  if (path.basename(parent) === "node_modules") return parent;
  if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") return path.dirname(parent);
  return null;
}

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
          await cp(m.dir, path.join(stage, rel), { recursive: true, dereference: true, filter: confinedTo(m.dir) });
          // npm hoists a package's dependencies next to it: ship them as the package's own node_modules
          const nm = hoistRoot(m.dir);
          if (nm) {
            const self = path.resolve(m.dir);
            const skip = confinedTo(nm);
            await cp(nm, path.join(stage, rel, "node_modules"), { recursive: true, dereference: true, filter: async (src) => path.resolve(src) !== self && !path.resolve(src).startsWith(self + path.sep) && (await skip(src)) });
          }
          remapped.push({ ...m, dir: path.posix.join(bundleDir(key), rel) });
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
