/**
 * `worker --env <id> --key <worker key> [--workdir DIR] [--id NAME]`
 *
 * A self-hosted (BYOC) sandbox worker. It only makes outbound calls to the API: long-polls
 * POST /v1/environments/:id/worker/poll for requests of its environment, executes them on this machine
 * under --workdir (one sub-directory per sandbox, file access confined to it) and posts results to
 * /worker/result. Nothing on the server ever connects into this machine.
 */
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Client } from "./http.ts";
import { HttpError } from "./http.ts";

const run = promisify(execFile);

export type WorkerRequest =
  | { req_id: string; op: "create"; sandbox_id: string; workspace_ref: any }
  | { req_id: string; op: "exec"; sandbox_id: string; command: string; cwd?: string; timeout_ms?: number }
  | { req_id: string; op: "read"; sandbox_id: string; path: string }
  | { req_id: string; op: "write"; sandbox_id: string; path: string; content_b64: string }
  | { req_id: string; op: "capture"; sandbox_id: string; prev: any }
  | { req_id: string; op: "destroy"; sandbox_id: string };

export interface WorkerOptions {
  client: Client;
  envId: string;
  key: string;
  workdir: string;
  workerId: string;
  log?: (s: string) => void;
  /** Checked before every poll; the loop returns once it is true (tests, signal handlers). */
  stopped?: () => boolean;
}

export async function runWorker(o: WorkerOptions): Promise<void> {
  const log = o.log ?? ((s) => console.error(s));
  const workdir = path.resolve(o.workdir);
  await mkdir(workdir, { recursive: true });
  const base = `/v1/environments/${encodeURIComponent(o.envId)}/worker`;
  const post = async (p: string, body: unknown) => o.client.read(await o.client.fetch("POST", `${base}/${p}`, { body: JSON.stringify(body), headers: { "content-type": "application/json", "x-worker-key": o.key } }));
  const sandboxes = new Set<string>();
  const dirOf = (id: string) => path.join(workdir, id.replace(/[^A-Za-z0-9_-]/g, "_"));
  /** Resolve a sandbox-relative path and refuse anything that escapes the sandbox dir (symlinks included). */
  const inside = async (id: string, p: string) => {
    const root = await realpath(dirOf(id));
    const abs = path.resolve(root, p.replace(/^\/workspace\/?/, ""));
    // resolve symlinks on the nearest existing ancestor (a write may create several new directories)
    let existing = abs;
    const missing: string[] = [];
    let real: string | undefined;
    while (real === undefined) {
      try { real = path.join(await realpath(existing), ...missing); } catch { if (existing === path.dirname(existing)) throw new Error(`bad path: ${p}`); missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path escapes sandbox: ${p}`);
    return abs;
  };

  log(`[worker ${o.workerId}] env=${o.envId} workdir=${workdir} api=${o.client.cfg.base}`);
  let backoff = 1000;
  while (!o.stopped?.()) {
    let req: WorkerRequest | null = null;
    try {
      req = (await post("poll", { worker_id: o.workerId, sandbox_ids: [...sandboxes] }))?.request ?? null;
      backoff = 1000;
    } catch (e) {
      // a wrong key or environment never heals by retrying
      if (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
      log(`[worker] poll failed: ${(e as Error).message}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    if (!req) continue;
    const r = req;
    const done = (result?: unknown) => post("result", { req_id: r.req_id, type: "done", ok: true, result });
    try {
      switch (r.op) {
        case "create": {
          const dir = dirOf(r.sandbox_id);
          await mkdir(dir, { recursive: true });
          const ref = r.workspace_ref;
          if (ref?.kind === "git") {
            await run("git", ["clone", "--quiet", "--", ref.remote, "."], { cwd: dir });
            if (ref.base) await run("git", ["checkout", "--quiet", "--detach", ref.base], { cwd: dir });
            if (ref.patch) { await writeFile(path.join(dir, ".pma.patch"), ref.patch); await run("git", ["apply", "--whitespace=nowarn", ".pma.patch"], { cwd: dir }); await rm(path.join(dir, ".pma.patch")); }
          } else if (ref?.kind === "byoc") {
            if (ref.worker !== o.workerId) throw new Error(`workspace lives on worker ${ref.worker}, this is ${o.workerId}`);
            // same worker: reuse the directory left by the previous sandbox (only from inside the workdir)
            const src = path.resolve(String(ref.path));
            if (src !== dir && src.startsWith(workdir + path.sep) && (await stat(src).catch(() => null))) await cp(src, dir, { recursive: true });
          }
          sandboxes.add(r.sandbox_id);
          log(`[worker] created ${r.sandbox_id} (${ref?.kind ?? "empty"})`);
          await done({ worker: o.workerId });
          break;
        }
        case "exec": {
          const dir = dirOf(r.sandbox_id);
          const cwd = r.cwd ? await inside(r.sandbox_id, r.cwd) : dir;
          const child = spawn("bash", ["-lc", r.command], { cwd, env: { PATH: process.env.PATH ?? "", HOME: dir, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
          const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, r.timeout_ms ?? 600_000);
          const send = (stream: "stdout" | "stderr", data: string) => post("result", { req_id: r.req_id, type: "chunk", stream, data }).catch(() => {});
          let pending: Promise<unknown> = Promise.resolve();
          child.stdout.on("data", (d: Buffer) => { pending = pending.then(() => send("stdout", d.toString())); });
          child.stderr.on("data", (d: Buffer) => { pending = pending.then(() => send("stderr", d.toString())); });
          const code = await new Promise<number>((resolve) => { child.on("error", () => resolve(127)); child.on("close", (c, sig) => resolve(c ?? (sig ? 137 : 1))); });
          clearTimeout(timer);
          await pending;
          await done({ code });
          break;
        }
        case "read":
          await done({ content_b64: (await readFile(await inside(r.sandbox_id, r.path))).toString("base64") });
          break;
        case "write": {
          const abs = await inside(r.sandbox_id, r.path);
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, Buffer.from(r.content_b64, "base64"));
          await done(null);
          break;
        }
        case "capture": {
          const dir = dirOf(r.sandbox_id);
          if (r.prev?.kind === "git") {
            const head = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
            await run("git", ["add", "-N", "--all"], { cwd: dir });
            const patch = (await run("git", ["diff", "HEAD", "--binary"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
            await done({ kind: "git", remote: r.prev.remote, base: head, ...(patch.trim() ? { patch } : {}) });
          } else await done({ kind: "byoc", worker: o.workerId, path: dir }); // non-git: the files stay on this worker
          break;
        }
        case "destroy":
          sandboxes.delete(r.sandbox_id); // keep the directory: a later sandbox on this worker may reuse it
          log(`[worker] released ${r.sandbox_id}`);
          await done(null);
          break;
        default:
          throw new Error(`unknown op ${(r as { op?: string }).op}`);
      }
    } catch (e) {
      log(`[worker] ${r.op} ${r.sandbox_id} failed: ${(e as Error).message}`);
      await post("result", { req_id: r.req_id, type: "done", ok: false, error: (e as Error).message ?? String(e) }).catch(() => {});
    }
  }
}
