/**
 * `pma worker --env <id> --key <worker key> [--workdir DIR] [--id NAME]`
 *
 * A self-hosted (BYOC) sandbox worker. It only makes outbound HTTPS calls to the pma API: long-polls
 * for requests belonging to its environment, executes them on this machine under --workdir
 * (one sub-directory per sandbox, file access confined to it), and posts results back.
 * Nothing on the server ever reaches into this machine.
 */
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveConfig, buildHeaders } from "../lib/config.ts";
import { die, parseArgs, str } from "../lib/args.ts";

const run = promisify(execFile);

type Req =
  | { req_id: string; op: "create"; sandbox_id: string; workspace_ref: any }
  | { req_id: string; op: "exec"; sandbox_id: string; command: string; cwd?: string; timeout_ms?: number }
  | { req_id: string; op: "read"; sandbox_id: string; path: string }
  | { req_id: string; op: "write"; sandbox_id: string; path: string; content_b64: string }
  | { req_id: string; op: "capture"; sandbox_id: string; prev: any }
  | { req_id: string; op: "destroy"; sandbox_id: string };

export async function cmdWorker(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const envId = str(flags, "env");
  const key = str(flags, "key") ?? process.env.PMA_WORKER_KEY;
  if (!envId || !key) die("usage: pma worker --env <environment_id> --key <worker_key> [--workdir DIR] [--id NAME]   (key also via PMA_WORKER_KEY)");
  const workdir = path.resolve(str(flags, "workdir") ?? path.join(process.cwd(), "pma-worker"));
  const workerId = (str(flags, "id") ?? `${hostname()}-${process.pid}`).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  await mkdir(workdir, { recursive: true });
  const cfg = resolveConfig();
  const base = `${cfg.host}/v1/environments/${envId}/worker`;
  const headers = { ...buildHeaders(cfg), "content-type": "application/json", "x-worker-key": key };
  const post = async (p: string, body: unknown) => {
    const r = await fetch(`${base}/${p}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const sandboxes = new Set<string>();
  const dirOf = (id: string) => path.join(workdir, id.replace(/[^A-Za-z0-9_-]/g, "_"));
  /** Resolve a sandbox-relative path and refuse anything that escapes the sandbox dir (symlinks included). */
  const inside = async (id: string, p: string) => {
    const root = await realpath(dirOf(id));
    const abs = path.resolve(root, p.replace(/^\/workspace\/?/, ""));
    const real = await realpath(abs).catch(async () => realpath(path.dirname(abs)).then((d) => path.join(d, path.basename(abs))));
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path escapes sandbox: ${p}`);
    return abs;
  };

  console.log(`[worker ${workerId}] env=${envId} workdir=${workdir} host=${cfg.host}`);
  let backoff = 1000;
  for (;;) {
    let req: Req | null = null;
    try {
      req = (await post("poll", { worker_id: workerId, sandbox_ids: [...sandboxes] })).request;
      backoff = 1000;
    } catch (e: any) {
      console.error(`[worker] poll failed: ${e.message}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    if (!req) continue;
    const done = (result?: unknown) => post("result", { req_id: req!.req_id, type: "done", ok: true, result });
    const fail = (error: string) => post("result", { req_id: req!.req_id, type: "done", ok: false, error });
    try {
      switch (req.op) {
        case "create": {
          const dir = dirOf(req.sandbox_id);
          await mkdir(dir, { recursive: true });
          const ref = req.workspace_ref;
          if (ref?.kind === "git") {
            await run("git", ["clone", "--quiet", "--", ref.remote, "."], { cwd: dir });
            if (ref.base) await run("git", ["checkout", "--quiet", "--detach", ref.base], { cwd: dir });
            if (ref.patch) { await writeFile(path.join(dir, ".pma.patch"), ref.patch); await run("git", ["apply", "--whitespace=nowarn", ".pma.patch"], { cwd: dir }); await rm(path.join(dir, ".pma.patch")); }
          } else if (ref?.kind === "byoc") {
            if (ref.worker !== workerId) throw new Error(`workspace lives on worker ${ref.worker}, this is ${workerId}`);
            // same worker: reuse the directory left by the previous sandbox
            if (path.resolve(ref.path) !== dir && (await stat(ref.path).catch(() => null))) await run("cp", ["-R", `${ref.path}/.`, dir]);
          }
          sandboxes.add(req.sandbox_id);
          console.log(`[worker] created ${req.sandbox_id} (${ref?.kind ?? "empty"})`);
          await done({ worker: workerId });
          break;
        }
        case "exec": {
          const dir = dirOf(req.sandbox_id);
          const cwd = req.cwd ? await inside(req.sandbox_id, req.cwd) : dir;
          const child = spawn("bash", ["-lc", req.command], { cwd, env: { PATH: process.env.PATH ?? "", HOME: dir, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
          const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, req.timeout_ms ?? 600_000);
          const send = (stream: "stdout" | "stderr", data: string) => post("result", { req_id: req!.req_id, type: "chunk", stream, data }).catch(() => {});
          let pending: Promise<unknown> = Promise.resolve();
          child.stdout.on("data", (d: Buffer) => { pending = pending.then(() => send("stdout", d.toString())); });
          child.stderr.on("data", (d: Buffer) => { pending = pending.then(() => send("stderr", d.toString())); });
          const code = await new Promise<number>((resolve) => child.on("close", (c, sig) => resolve(c ?? (sig ? 137 : 1))));
          clearTimeout(timer);
          await pending;
          await done({ code });
          break;
        }
        case "read": {
          const abs = await inside(req.sandbox_id, req.path);
          await done({ content_b64: (await readFile(abs)).toString("base64") });
          break;
        }
        case "write": {
          const abs = await inside(req.sandbox_id, req.path);
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, Buffer.from(req.content_b64, "base64"));
          await done(null);
          break;
        }
        case "capture": {
          const dir = dirOf(req.sandbox_id);
          if (req.prev?.kind === "git") {
            const head = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
            await run("git", ["add", "-N", "--all"], { cwd: dir });
            const patch = (await run("git", ["diff", "HEAD", "--binary"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
            await done({ kind: "git", remote: req.prev.remote, base: head, ...(patch.trim() ? { patch } : {}) });
          } else {
            // non-git: the files stay here; only this worker can bring them back
            await done({ kind: "byoc", worker: workerId, path: dir });
          }
          break;
        }
        case "destroy": {
          sandboxes.delete(req.sandbox_id);
          // keep the directory: a later sandbox on this worker may reuse it via a byoc ref; only prune empties
          console.log(`[worker] released ${req.sandbox_id}`);
          await done(null);
          break;
        }
      }
    } catch (e: any) {
      console.error(`[worker] ${req.op} ${req.sandbox_id} failed: ${e.message}`);
      await fail(e.message ?? String(e)).catch(() => {});
    }
  }
}
