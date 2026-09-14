import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../src/cli/http.ts";
import { runWorker, type WorkerRequest } from "../src/cli/worker.ts";
import { apiError, cli, sendJson, startStub } from "./fixtures/cli-stub.ts";

let stub: Awaited<ReturnType<typeof startStub>> | undefined;
const dirs: string[] = [];
afterEach(async () => { await stub?.close(); stub = undefined; for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("cli worker (BYOC)", () => {
  it("polls with the worker key, runs create / write / exec / read / capture / destroy under the workdir and posts results", async () => {
    const queue: WorkerRequest[] = [
      { req_id: "r1", op: "create", sandbox_id: "sbx_1", workspace_ref: { kind: "empty" } },
      { req_id: "r2", op: "write", sandbox_id: "sbx_1", path: "/workspace/dir/a.txt", content_b64: Buffer.from("hello").toString("base64") },
      { req_id: "r3", op: "exec", sandbox_id: "sbx_1", command: "cat dir/a.txt; echo oops >&2; exit 3" },
      { req_id: "r4", op: "read", sandbox_id: "sbx_1", path: "dir/a.txt" },
      { req_id: "r5", op: "write", sandbox_id: "sbx_1", path: "../../escape.txt", content_b64: "eA==" },
      { req_id: "r6", op: "capture", sandbox_id: "sbx_1", prev: { kind: "empty" } },
      { req_id: "r7", op: "destroy", sandbox_id: "sbx_1" },
    ];
    const polls: any[] = [];
    const results: any[] = [];
    stub = await startStub((r, res) => {
      if (r.headers["x-worker-key"] !== "wk_test") return apiError(res, 401, "bad_worker_key", "invalid worker key");
      if (r.path.endsWith("/worker/poll")) { polls.push(r.json); return sendJson(res, 200, { request: queue.shift() ?? null }); }
      results.push(r.json);
      sendJson(res, 200, { ok: true });
    });
    const workdir = await mkdtemp(path.join(tmpdir(), "pma-worker-"));
    dirs.push(workdir);
    const logs: string[] = [];
    await runWorker({ client: new Client({ base: stub.url }), envId: "env_b", key: "wk_test", workdir, workerId: "w1", log: (s) => logs.push(s), stopped: () => queue.length === 0 && results.some((x) => x.req_id === "r7") });
    expect(stub.requests[0]!.path).toBe("/v1/environments/env_b/worker/poll");
    expect(polls[0]).toEqual({ worker_id: "w1", sandbox_ids: [] });
    expect(polls[2]).toEqual({ worker_id: "w1", sandbox_ids: ["sbx_1"] });
    const done = (id: string) => results.find((x) => x.req_id === id && x.type === "done");
    expect(done("r1")).toEqual({ req_id: "r1", type: "done", ok: true, result: { worker: "w1" } });
    expect(await readFile(path.join(workdir, "sbx_1", "dir", "a.txt"), "utf8")).toBe("hello");
    const chunks = results.filter((x) => x.req_id === "r3" && x.type === "chunk");
    expect(chunks.filter((c) => c.stream === "stdout").map((c) => c.data).join("")).toBe("hello");
    expect(chunks.filter((c) => c.stream === "stderr").map((c) => c.data).join("")).toBe("oops\n");
    expect(done("r3").result).toEqual({ code: 3 });
    expect(done("r4").result).toEqual({ content_b64: Buffer.from("hello").toString("base64") });
    expect(done("r5")).toMatchObject({ ok: false, error: "path escapes sandbox: ../../escape.txt" });
    expect(done("r6").result).toEqual({ kind: "byoc", worker: "w1", path: path.join(workdir, "sbx_1") });
    expect(done("r7")).toMatchObject({ ok: true });
  });

  it("captures a git workspace as a patch against HEAD", async () => {
    const run = promisify(execFile);
    const workdir = await mkdtemp(path.join(tmpdir(), "pma-worker-"));
    const origin = await mkdtemp(path.join(tmpdir(), "pma-origin-"));
    dirs.push(workdir, origin);
    const git = (...a: string[]) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: origin });
    await git("init", "-q"); await run("sh", ["-c", "echo one > f.txt"], { cwd: origin }); await git("add", "."); await git("commit", "-qm", "init");
    const queue: WorkerRequest[] = [
      // the API only lets network remotes through; a file path is fine for the worker itself
      { req_id: "g1", op: "create", sandbox_id: "sbx_g", workspace_ref: { kind: "git", remote: origin } },
      { req_id: "g2", op: "exec", sandbox_id: "sbx_g", command: "echo two >> f.txt" },
      { req_id: "g3", op: "capture", sandbox_id: "sbx_g", prev: { kind: "git", remote: origin } },
    ];
    const results: any[] = [];
    stub = await startStub((r, res) => (r.path.endsWith("/poll") ? sendJson(res, 200, { request: queue.shift() ?? null }) : (results.push(r.json), sendJson(res, 200, { ok: true }))));
    await runWorker({ client: new Client({ base: stub.url }), envId: "env_b", key: "k", workdir, workerId: "w1", log: () => {}, stopped: () => results.some((x) => x.req_id === "g3") });
    const cap = results.find((x) => x.req_id === "g3").result;
    expect(cap).toMatchObject({ kind: "git", remote: origin, base: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(cap.patch).toContain("+two");
  });

  it("a rejected worker key stops the worker with exit 1; missing flags are a usage error", async () => {
    stub = await startStub((_r, res) => apiError(res, 401, "bad_worker_key", "invalid worker key"));
    const workdir = await mkdtemp(path.join(tmpdir(), "pma-worker-"));
    dirs.push(workdir);
    expect(await cli(stub.url, ["worker", "--env", "env_b", "--key", "wrong", "--workdir", workdir])).toMatchObject({ code: 1, stderr: expect.stringContaining("HTTP 401 bad_worker_key: invalid worker key") });
    expect((await cli(stub.url, ["worker", "--env", "env_b"])).code).toBe(2);
  });
});
