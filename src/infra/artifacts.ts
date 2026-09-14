import { readdir, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRef } from "../shared/types.ts";

/**
 * Read a session's produced files ("artifacts") straight from its captured workspace — no sandbox
 * lease. `dir` (the local provider's captured workspace) and `local` refs are directories on disk;
 * `git` refs are a commit + patch (listing would need a git checkout — not done here), and
 * `empty`/`blob`/`byoc` have no host-readable tree. All paths are confined to the workspace root.
 */

export interface ArtifactEntry { path: string; size: number; mtimeSec: number }

/** The on-disk root for a ref, or null if the ref has no host-readable file tree. */
function rootOf(ref: WorkspaceRef | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === "dir" || ref.kind === "local") return path.resolve(ref.path);
  return null; // git / empty / blob / byoc: no direct tree here
}

/** Resolve a relative artifact path inside the root, refusing any escape. */
function resolveInRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes the workspace: ${rel}`);
  return abs;
}

const SKIP = new Set([".git", "node_modules", ".pi-workspace.patch"]);

async function walk(root: string, dir: string, out: ArtifactEntry[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile()) {
      const st = await stat(abs).catch(() => null);
      if (st) out.push({ path: path.relative(root, abs), size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
    }
  }
}

/** List the files in a session's captured workspace (empty for refs with no host tree). */
export async function listArtifacts(ref: WorkspaceRef | undefined): Promise<ArtifactEntry[]> {
  const root = rootOf(ref);
  if (!root) return [];
  const out: ArtifactEntry[] = [];
  await walk(root, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Read one artifact's bytes + metadata, or null if it is missing / the ref has no tree. */
export async function readArtifact(ref: WorkspaceRef | undefined, rel: string): Promise<{ bytes: Uint8Array; size: number; mtimeSec: number } | null> {
  const root = rootOf(ref);
  if (!root) return null;
  const abs = resolveInRoot(root, rel);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) return null;
  return { bytes: new Uint8Array(await readFile(abs)), size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) };
}

/** Delete one artifact from the captured workspace. Returns true if a file was removed. */
export async function deleteArtifact(ref: WorkspaceRef | undefined, rel: string): Promise<boolean> {
  const root = rootOf(ref);
  if (!root) return false;
  const abs = resolveInRoot(root, rel);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) return false;
  await rm(abs, { force: true });
  return true;
}
