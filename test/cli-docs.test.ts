import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALIASES, HELP } from "../src/cli/commands.ts";
import { apiError, cli, sendJson, sse, startStub } from "./fixtures/cli-stub.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const COMMANDS = new Set([...HELP.matchAll(/^ {2}([a-z-]+) /gm)].map((m) => m[1]!));

/** Minimal shell word splitting for documentation lines: quotes, `# comments`, `$VARS` -> placeholder ids. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur = (cur ?? "") + ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur = cur ?? ""; continue; }
    if (ch === "#" && cur === null) break;
    if (/\s/.test(ch)) { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out.map((w) => w.replace(/\$[A-Z_]+/g, "env_x"));
}

/** Every CLI invocation inside fenced code blocks of the READMEs and docs/*.md, as argv. */
async function documentedInvocations(): Promise<{ file: string; line: string; argv: string[] }[]> {
  const files = ["README.md", "README.zh.md", ...(await readdir(path.join(ROOT, "docs"))).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  const found: { file: string; line: string; argv: string[] }[] = [];
  for (const file of files) {
    let fenced = false;
    for (const raw of (await readFile(path.join(ROOT, file), "utf8")).split("\n")) {
      if (raw.trim().startsWith("```")) { fenced = !fenced; continue; }
      if (!fenced) continue;
      for (const part of raw.split("&&")) {
        const w = words(part.trim());
        const argv = w[0] === "npm" && w[1] === "run" && w[2] === "cli" && w[3] === "--" ? w.slice(4) : w[0] === "pma" ? w.slice(1) : null;
        if (argv?.[0] && COMMANDS.has(ALIASES[argv[0]] ?? argv[0])) found.push({ file, line: part.trim(), argv });
      }
    }
  }
  return found;
}

describe("documented CLI lines run against the bundled CLI", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let workdir: string;
  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "pma-docs-"));
    stub = await startStub((r, res) => {
      if (r.path.includes("/worker/")) return apiError(res, 401, "bad_worker_key", "invalid worker key");
      if (r.path.includes("/events/stream")) { res.writeHead(200, { "content-type": "text/event-stream" }); return void res.end(sse("session.status_idle", { seq: 3, type: "session.status_idle", payload: { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: 1 } })); }
      if (r.method === "POST" && r.path.endsWith("/events")) return sendJson(res, 200, { events: [{ seq: 1, type: "user.message", payload: {} }] });
      if (r.method === "GET" && (!/\/v1\/[a-z_]+\/[^/?]+/.test(r.path) || r.path.includes("/events?"))) return sendJson(res, 200, { data: [], has_more: false });
      sendJson(res, r.method === "POST" ? 201 : 200, { id: "x_1" });
    });
  });
  afterAll(async () => { await stub.close(); await rm(workdir, { recursive: true, force: true }); });

  it("every `npm run cli -- ...` and `pma <command> ...` line is accepted and reaches the API", async () => {
    const lines = await documentedInvocations();
    expect(lines.length).toBeGreaterThanOrEqual(15);
    for (const { file, line, argv } of lines) {
      const args = argv.map((a, i) => (argv[i - 1] === "--workdir" ? workdir : a));
      const before = stub.requests.length;
      const r = await cli(stub.url, args, { GITHUB_TOKEN: "ghp_doc" }); // env vars the docs read secrets from
      const why = `${file}: ${line}\n${r.stderr}`;
      if (argv[0] === "worker") expect(r.stderr, why).toContain("bad_worker_key"); // flags accepted, the stub rejects the key
      else expect(r.code, why).toBe(0);
      if (!argv.includes("--help")) expect(stub.requests.length, why).toBeGreaterThan(before);
    }
    expect(lines.map((l) => l.argv[0])).toEqual(expect.arrayContaining(["agents", "envs", "sessions", "send", "events", "worker", "vaults"]));
  });
});

describe("cli process", () => {
  const run = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], { cwd: ROOT, env: { ...process.env, PMA_API: "http://127.0.0.1:1", ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

  it("exits 0 for help, 2 for misuse and 1 when the API is unreachable", async () => {
    const [help, bad, down] = await Promise.all([run(["--help"]), run(["agents", "frobnicate"]), run(["agents", "list"])]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("vaults");
    expect(bad.code).toBe(2);
    expect(down).toMatchObject({ code: 1, stderr: expect.stringContaining("cannot reach the API at http://127.0.0.1:1") });
  }, 30_000);
});
