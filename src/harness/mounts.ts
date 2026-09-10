/**
 * Things that must exist inside the main sandbox before the model runs: uploaded document
 * attachments and memory stores. Both use only exec/readFile/writeFile, so they work on every
 * provider (local, docker, e2b, byoc). Memory stores round-trip as tarballs kept under
 * WORKSPACE_ROOT/memories/<id> on the runner; their ref is a `dir` ref like workspaces.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { workspaceRoot } from "../sandbox/workspace.ts";
import type { MemoryResource, Sandbox, WorkspaceRef } from "../shared/types.ts";
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

const memoryDir = (id: string) => path.join(workspaceRoot(), "memories", id);

/** Copy each memory store into .memory/<name> in the sandbox (tar over writeFile + exec). */
export async function mountMemories(sb: Sandbox, stores: MemoryResource[]): Promise<void> {
  for (const m of stores) {
    const dir = m.ref.kind === "dir" ? m.ref.path : memoryDir(m.id);
    const target = `.memory/${m.name}`;
    if (!(await stat(dir).catch(() => null))) { await sh(sb, `mkdir -p ${q(target)}`); continue; }
    const tmp = await mkdtemp(path.join(tmpdir(), "mem-"));
    try {
      const tgz = path.join(tmp, "m.tgz");
      await run("tar", ["czf", tgz, "-C", dir, "."]);
      await sb.writeFile(`${target}.tgz`, new Uint8Array(await readFile(tgz)));
      await sh(sb, `mkdir -p ${q(target)} && tar xzf ${q(target + ".tgz")} -C ${q(target)} && rm -f ${q(target + ".tgz")}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** Pull .memory/<name> back out of the sandbox into the runner-side store dir; returns updated refs. */
export async function syncMemoriesBack(sb: Sandbox, stores: MemoryResource[]): Promise<{ id: string; ref: WorkspaceRef }[]> {
  const out: { id: string; ref: WorkspaceRef }[] = [];
  for (const m of stores) {
    const target = `.memory/${m.name}`;
    const exists = (await sh(sb, `test -d ${q(target)} && echo yes || echo no`)).trim() === "yes";
    if (!exists) continue;
    const size = Number((await sh(sb, `du -sk ${q(target)} | cut -f1`)).trim()) * 1024;
    if (size > MEMORY_MAX_BYTES) throw new Error(`memory ${m.name} is ${size} bytes; limit ${MEMORY_MAX_BYTES}`);
    await sh(sb, `tar czf ${q(target + ".tgz")} -C ${q(target)} .`);
    const bytes = await sb.readFile(`${target}.tgz`);
    await sh(sb, `rm -f ${q(target + ".tgz")}`);
    const dest = memoryDir(m.id);
    const tmp = `${dest}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const tgz = path.join(path.dirname(tmp), `${m.id}.tgz`);
    await writeFile(tgz, bytes);
    await run("tar", ["xzf", tgz, "-C", tmp]);
    await rm(tgz, { force: true });
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await run("mv", [tmp, dest]);
    out.push({ id: m.id, ref: { kind: "dir", path: dest } });
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
