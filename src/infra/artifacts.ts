import { readdir, readFile, realpath, stat, rm } from "node:fs/promises";
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

const inside = (root: string, abs: string) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Resolve a relative artifact path inside the root. A lexical escape ('..', absolute) throws; a path
 * that leaves the root through a symlink resolves to null (the agent controls the workspace, so a link
 * to a host file must never be followed).
 */
async function resolveInRoot(root: string, rel: string): Promise<string | null> {
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) throw new Error(`path escapes the workspace: ${rel}`);
  const [realRoot, real] = await Promise.all([realpath(root).catch(() => null), realpath(abs).catch(() => null)]);
  if (!realRoot || !real || !inside(realRoot, real)) return null;
  return abs;
}

const SKIP = new Set([".git", "node_modules", ".pi-workspace.patch"]);

/** Run async fs operations with at most `n` in flight (a wide tree must not exhaust file descriptors). */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r)); // a finishing op hands its slot over directly
    try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

/** Walk the tree with directory reads and stats running concurrently (bounded); the caller sorts the result. */
async function walk(root: string, dir: string, out: ArtifactEntry[], fs: ReturnType<typeof limiter>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs(() => readdir(dir, { withFileTypes: true })); } catch { return; }
  await Promise.all(entries.map(async (e) => {
    if (SKIP.has(e.name)) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out, fs);
    else if (e.isFile()) {
      const st = await fs(() => stat(abs)).catch(() => null);
      if (st) out.push({ path: path.relative(root, abs), size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
    }
  }));
}

/** List the files in a session's captured workspace (empty for refs with no host tree). */
export async function listArtifacts(ref: WorkspaceRef | undefined): Promise<ArtifactEntry[]> {
  const root = rootOf(ref);
  if (!root) return [];
  const out: ArtifactEntry[] = [];
  await walk(root, root, out, limiter(64));
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Read one artifact's bytes + metadata, or null if it is missing / the ref has no tree. */
export async function readArtifact(ref: WorkspaceRef | undefined, rel: string): Promise<{ bytes: Uint8Array; size: number; mtimeSec: number } | null> {
  const root = rootOf(ref);
  if (!root) return null;
  const abs = await resolveInRoot(root, rel);
  const st = abs ? await stat(abs).catch(() => null) : null;
  if (!abs || !st || !st.isFile()) return null;
  return { bytes: new Uint8Array(await readFile(abs)), size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) };
}

/** Delete one artifact from the captured workspace. Returns true if a file was removed. */
export async function deleteArtifact(ref: WorkspaceRef | undefined, rel: string): Promise<boolean> {
  const root = rootOf(ref);
  if (!root) return false;
  const abs = await resolveInRoot(root, rel);
  const st = abs ? await stat(abs).catch(() => null) : null;
  if (!abs || !st || !st.isFile()) return false;
  await rm(abs, { force: true });
  return true;
}
