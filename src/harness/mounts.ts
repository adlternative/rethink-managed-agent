/**
 * Things that must exist inside the main sandbox before the model runs: uploaded document
 * attachments and memory stores. Both use only exec/readFile/writeFile, so they work on every
 * provider (local, docker, e2b, byoc). Memory stores round-trip as tarballs: in the blob store
 * (`blob` refs, portable across runners) when one is configured, else under
 * WORKSPACE_ROOT/memories/<id> on this runner (`dir` refs).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { workspaceRoot } from "../sandbox/workspace.ts";
import type { MemoryStoreResource, Sandbox, WorkspaceRef } from "../shared/types.ts";
import { blobsConfigured, getBlob, putBlob } from "../infra/blobs.ts";
import type { Attachment, FoldFiles } from "./fold.ts";

const run = promisify(execFile);
const MEMORY_MAX_BYTES = 20 * 1024 * 1024;

async function sh(sb: Sandbox, cmd: string): Promise<string> {
  let out = "";
  let code = 0;
  for await (const c of sb.exec(cmd, { timeoutMs: 120_000 })) {
    if (c.type === "exit") code = c.code ?? 0;
    else out += c.data ?? "";
  }
  if (code !== 0) throw new Error(`${cmd}: exit ${code}: ${out.slice(-500)}`);
  return out;
}

/** Write referenced documents into .attachments/ (idempotent: skips files already present). */
export async function writeAttachments(sb: Sandbox, attachments: Attachment[], files: FoldFiles): Promise<void> {
  const seen = new Set<string>();
  for (const a of attachments) {
    if (seen.has(a.path)) continue;
    seen.add(a.path);
    const f = await files.get(a.file_id);
    if (!f) continue;
    await sb.writeFile(a.path, f.data);
  }
}

export interface Mounted { store: MemoryStoreResource; mount_path: string }
const memoryDir = (id: string) => path.join(workspaceRoot(), "memories", id);

/** The store's current snapshot as a tarball (null when empty). */
async function snapshot(m: MemoryStoreResource): Promise<Buffer | null> {
  if (m.ref.kind === "blob") return getBlob(m.ref.key);
  const dir = m.ref.kind === "dir" ? m.ref.path : memoryDir(m.id);
  if (!(await stat(dir).catch(() => null))) return null;
  const tmp = await mkdtemp(path.join(tmpdir(), "mem-"));
  try {
    const tgz = path.join(tmp, "m.tgz");
    await run("tar", ["czf", tgz, "-C", dir, "."]);
    return await readFile(tgz);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Copy each memory store into its mount path in the sandbox (tar over writeFile + exec). */
export async function mountMemories(sb: Sandbox, mounts: Mounted[]): Promise<void> {
  for (const { store, mount_path } of mounts) {
    const tgz = await snapshot(store);
    if (!tgz) { await sh(sb, `mkdir -p ${q(mount_path)}`); continue; }
    await sb.writeFile(`${mount_path}.tgz`, new Uint8Array(tgz));
    await sh(sb, `mkdir -p ${q(mount_path)} && tar xzf ${q(mount_path + ".tgz")} -C ${q(mount_path)} && rm -f ${q(mount_path + ".tgz")}`);
  }
}

/** Pull each mount back out of the sandbox into the store (blob or runner dir); returns updated refs. */
export async function syncMemoriesBack(sb: Sandbox, mounts: Mounted[]): Promise<{ id: string; ref: WorkspaceRef }[]> {
  const out: { id: string; ref: WorkspaceRef }[] = [];
  for (const { store: m, mount_path } of mounts) {
    const exists = (await sh(sb, `test -d ${q(mount_path)} && echo yes || echo no`)).trim() === "yes";
    if (!exists) continue;
    const size = Number((await sh(sb, `du -sk ${q(mount_path)} | cut -f1`)).trim()) * 1024;
    if (size > MEMORY_MAX_BYTES) throw new Error(`memory ${m.name} is ${size} bytes; limit ${MEMORY_MAX_BYTES}`);
    await sh(sb, `tar czf ${q(mount_path + ".tgz")} -C ${q(mount_path)} .`);
    const bytes = Buffer.from(await sb.readFile(`${mount_path}.tgz`));
    await sh(sb, `rm -f ${q(mount_path + ".tgz")}`);
    if (blobsConfigured()) {
      const key = `memories/${m.id}/${Date.now().toString(36)}.tgz`;
      await putBlob(key, bytes, "application/gzip");
      out.push({ id: m.id, ref: { kind: "blob", key, bytes: bytes.length } });
      continue;
    }
    const dest = memoryDir(m.id);
    const tmp = `${dest}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const tgz = path.join(path.dirname(tmp), `${m.id}.tgz`);
    await mkdir(path.dirname(tgz), { recursive: true });
    await writeFile(tgz, bytes);
    await run("tar", ["xzf", tgz, "-C", tmp]);
    await rm(tgz, { force: true });
    await rm(dest, { recursive: true, force: true });
    await run("mv", [tmp, dest]);
    out.push({ id: m.id, ref: { kind: "dir", path: dest } });
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
