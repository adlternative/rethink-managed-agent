/**
 * Reproducible micro/macro benchmarks for the hot paths.
 *
 *   npx tsx scripts/bench.ts                 # every group (pure, pg, redis, pgbus)
 *   npx tsx scripts/bench.ts --only pure,pg  # a subset
 *   npx tsx scripts/bench.ts --out bench.json
 *
 * Groups:
 *   pure   no services: fold, compat projections, projectDelta, memory queue, plugin host hook RPC,
 *          artifact listing, Rpc framing.
 *   pg     the running Postgres (DATABASE_URL, default postgres://pi:pi@localhost:5432/pi). Seeds rows
 *          under a unique throwaway prefix and deletes exactly those rows at the end.
 *   redis  the running Redis (REDIS_URL, default redis://localhost:6380): bus subscribers, BYOC liveness.
 *   pgbus  the Postgres event bus fan-out (runs in a child process with MESSAGING_BACKEND=postgres).
 *
 * The main process runs with MESSAGING_BACKEND=memory, so nothing is ever enqueued onto the live stack's
 * run stream. Where a code path gained a new export, the harness uses it when present, so the same file
 * measures the code before and after a change.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

process.env.MESSAGING_BACKEND ??= "memory";
process.env.REDIS_URL ??= "redis://localhost:6380";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const only = new Set((argOf("--only") ?? "pure,pg,redis,pgbus").split(","));
const out = argOf("--out");

type Result = { group: string; name: string; median_ms: number; p95_ms: number; runs: number; note?: string };
const results: Result[] = [];
const mod = <T>(m: T) => m as T & Record<string, any>;

/** Median/p95 wall time of `fn` over `runs` iterations after `warmup` untimed ones. */
async function bench(group: string, name: string, fn: () => unknown, opts: { runs?: number; warmup?: number; note?: () => string | undefined } = {}): Promise<void> {
  const runs = opts.runs ?? 10;
  for (let i = 0; i < (opts.warmup ?? 2); i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  const r: Result = { group, name, median_ms: +times[Math.floor(times.length / 2)]!.toFixed(3), p95_ms: +times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!.toFixed(3), runs, note: opts.note?.() };
  results.push(r);
  console.log(`${group.padEnd(6)} ${name.padEnd(64)} median ${String(r.median_ms).padStart(10)} ms   p95 ${String(r.p95_ms).padStart(10)} ms${r.note ? `   ${r.note}` : ""}`);
}

// ---------------------------------------------------------------------------------------------------
// Synthetic event logs: turns of user.message, status_running, tool_use, tool_result (~2KB), agent.message,
// span, usage, status_idle. A compaction sits near the end when `compactAt` is given.
// ---------------------------------------------------------------------------------------------------
const filler = (n: number) => "x".repeat(n);
function makePayloads(n: number, opts: { compactAt?: number; clientTool?: boolean } = {}): any[] {
  const out: any[] = [];
  let t = 0;
  while (out.length < n) {
    const base = out.length;
    const callId = `call_${t}`;
    out.push({ type: "user.message", content: [{ type: "text", text: `turn ${t} please do the thing ${filler(200)}` }] });
    out.push({ type: "session.status_running" });
    out.push({ type: "agent.tool_use", tool_use_id: callId, name: opts.clientTool && t % 50 === 0 ? "client_fn" : "bash", input: { command: `ls -la ${t}` } });
    out.push({ type: "agent.tool_result", tool_use_id: callId, content: [{ type: "text", text: filler(1000) }], is_error: false, pi: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: filler(1000) }], isError: false, timestamp: 1 } });
    out.push({ type: "agent.message", content: [{ type: "text", text: `done ${t}` }], pi: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], api: "openai-completions", provider: "x", model: "y", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 } });
    out.push({ type: "span.model_request_end", model: "y", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2 }, context: { tokens: 100, window: 1000 } });
    out.push({ type: "session.usage", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, requests: 1 }, context: null });
    out.push({ type: "session.status_idle", stop_reason: "end_turn", consumed_seq: base + 1 });
    t++;
  }
  out.length = n;
  if (opts.compactAt && opts.compactAt < n) out[opts.compactAt - 1] = { type: "agent.thread_context_compacted", summary: "summary so far", first_kept_seq: opts.compactAt - 400, tokens_before: 100000, tokens_after: 20000 };
  // the log ends settled: a user message answered by an idle that consumed it
  out[n - 2] = { type: "user.message", content: [{ type: "text", text: "last" }] };
  out[n - 1] = { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: n - 1 };
  return out;
}
const toEvents = (sid: string, payloads: any[]) => payloads.map((p, i) => ({ id: `evt_${i}`, session_id: sid, seq: i + 1, type: p.type, payload: p, created_at: new Date(1_700_000_000_000 + i).toISOString() }));

// ---------------------------------------------------------------------------------------------------
async function pureGroup(): Promise<void> {
  const { foldEvents } = await import("../src/harness/fold.ts");
  const compat = await import("../src/api/routes/compat/openai-agents.ts");
  const { projectDelta, newTurnCtx } = await import("../src/api/routes/compat/openai-stream.ts");
  const { enqueueRun, consumeRuns } = await import("../src/infra/queue.ts");
  const { Rpc, encode } = await import("../src/plugins/protocol.ts");
  const { listArtifacts } = await import("../src/infra/artifacts.ts");

  const ev5k = toEvents("sess_b", makePayloads(5000));
  const ev20k = toEvents("sess_b", makePayloads(20000));
  await bench("pure", "foldEvents 5k events", () => foldEvents(ev5k as any));
  await bench("pure", "foldEvents 20k events", () => foldEvents(ev20k as any));

  const session: any = { id: "sess_b", owner_id: "o", status: "idle", environment_id: "env", workspace_id: "ws", vault_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), agent: { id: "agent_b", name: "a", model: { provider: "x", id: "y" }, system: "s", tools: [], client_tools: [{ name: "client_fn" }] } };
  await bench("pure", "compat toAgentSession 20k events", () => compat.toAgentSession(session, ev20k as any, "env"));
  await bench("pure", "compat toItems 20k events", () => compat.toItems(session, ev20k as any));
  await bench("pure", "compat toTurns 20k events", () => compat.toTurns(session, ev20k as any));

  const deltas: any[] = [];
  for (let i = 0; i < 100_000; i++) deltas.push(i % 10 === 0 ? { type: "event", event: ev5k[i % ev5k.length] } : { type: "agent.message_delta", session_id: "sess_b", stream_id: "s1", text: "tok " });
  await bench("pure", "projectDelta 100k deltas", () => { const ctx = newTurnCtx(); let n = 0; for (const d of deltas) n += projectDelta(d, session, ctx).length; return n; }, { runs: 5 });

  await bench("pure", "memory queue enqueue+consume 20k jobs", async () => {
    const ac = new AbortController(); const N = 20_000; let seen = 0;
    const consumer = consumeRuns(async () => { if (++seen === N) setTimeout(() => ac.abort(), 0); return "done"; }, { signal: ac.signal, concurrency: 8 });
    for (let i = 0; i < N; i++) await enqueueRun({ session_id: "s", trigger_seq: i });
    await consumer;
  }, { runs: 5 });

  // Rpc framing: one 10MB frame arriving in 64KB chunks.
  const big = encode({ id: 1, result: { text: filler(10 * 1024 * 1024) } } as any);
  const chunks: string[] = []; for (let i = 0; i < big.length; i += 65536) chunks.push(big.slice(i, i + 65536));
  await bench("pure", "Rpc.feed 10MB frame in 64KB chunks", () => { const rpc = new Rpc(() => {}, async () => null); for (const c of chunks) rpc.feed(c); }, { runs: 5, warmup: 1 });
  // many small frames in one chunk stream (the common case must not regress)
  const small = Array.from({ length: 20000 }, (_, i) => encode({ id: i + 1000, result: { ok: i } } as any)).join("");
  const smallChunks: string[] = []; for (let i = 0; i < small.length; i += 4096) smallChunks.push(small.slice(i, i + 4096));
  await bench("pure", "Rpc.feed 20k small frames in 4KB chunks", () => { const rpc = new Rpc(() => {}, async () => null); for (const c of smallChunks) rpc.feed(c); }, { runs: 5 });

  const dir = await mkdtemp(path.join(tmpdir(), "pma-bench-art-"));
  try {
    for (let d = 0; d < 40; d++) { await mkdir(path.join(dir, `d${d}`, "sub"), { recursive: true }); for (let f = 0; f < 25; f++) { await writeFile(path.join(dir, `d${d}`, `f${f}.txt`), "x"); await writeFile(path.join(dir, `d${d}`, "sub", `g${f}.txt`), "y"); } }
    await bench("pure", "listArtifacts 2000 files / 80 dirs", () => listArtifacts({ kind: "dir", path: dir } as any));
  } finally { await rm(dir, { recursive: true, force: true }); }

  // Plugin host: hook.emit round trip through the child process.
  const { PluginHost } = await import("../src/plugins/client.ts");
  const host = await PluginHost.start([{ dir: path.join(ROOT, "plugins/safety-net"), source: "bench", name: "safety-net", kind: "pma", plugins: ["index.ts"], skills: [], prompts: [] } as any], { agentId: "agent_bench", repoRoot: ROOT });
  try {
    const info = { sessionId: "sess_b", agentId: "agent_bench", workspaceId: "ws" };
    host.attach(info, {} as any);
    await bench("pure", "plugin host hook.emit(tool_call) x200 sequential", async () => { for (let i = 0; i < 200; i++) await host.emit(info, { type: "tool_call", toolName: "bash", toolCallId: `c${i}`, input: { command: "ls" } } as any); }, { runs: 5 });
  } finally { host.stop(); }
}

// ---------------------------------------------------------------------------------------------------
async function pgGroup(): Promise<void> {
  const db = mod(await import("../src/infra/db.ts"));
  const events = mod(await import("../src/infra/events.ts"));
  const { findStrandedSessions } = await import("../src/infra/runs.ts");
  const { pool, repos, apiKeys } = db;
  const P = `bench${randomBytes(4).toString("hex")}`;
  const BIG_OWNER = `prc_${P}_big`, SMALL_OWNER = `prc_${P}_small`;
  const agentSnap = (id: string) => JSON.stringify({ id, name: "bench", model: { provider: "x", id: "y" }, system: filler(800), tools: ["bash"], packages: [], skills: [], client_tools: [{ name: "client_fn" }] });
  console.log(`[pg] seeding under prefix ${P} ...`);
  const t0 = performance.now();
  try {
    await pool.query(`INSERT INTO principals (id, handle, display_name) VALUES ($1, NULL, 'bench'), ($2, NULL, 'bench')`, [BIG_OWNER, SMALL_OWNER]);
    for (const o of [BIG_OWNER, SMALL_OWNER]) {
      await pool.query(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'bench','{"provider":"x","id":"y"}')`, [`agent_${P}_${o.endsWith("big") ? "big" : "small"}`, o]);
      await pool.query(`INSERT INTO environments (id, owner_id, name, provider, workspace, worker_key) VALUES ($1,$2,'bench','byoc','{"kind":"empty"}','wk')`, [`env_${P}_${o.endsWith("big") ? "big" : "small"}`, o]);
      await pool.query(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{"kind":"empty"}','{"kind":"empty"}')`, [`ws_${P}_${o.endsWith("big") ? "big" : "small"}`, o]);
    }
    const mkSessions = async (owner: string, tag: string, n: number, extra: { parent?: string; env?: string } = {}) => {
      const side = owner.endsWith("big") ? "big" : "small";
      await pool.query(
        `INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, agent, parent_id, created_at)
         SELECT $1 || g, $2, $3, $4, $5, $6::jsonb, $7, now() - g * interval '1 second' FROM generate_series(1, $8::int) g`,
        [`sess_${P}_${tag}_`, owner, `agent_${P}_${side}`, extra.env ?? `env_${P}_${side}`, `ws_${P}_${side}`, agentSnap(`agent_${P}_${side}`), extra.parent ?? null, n]);
      await pool.query(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) SELECT id, 'main', environment_id, workspace_id FROM sessions WHERE id LIKE $1`, [`sess_${P}_${tag}_%`]);
    };
    await mkSessions(BIG_OWNER, "many", 8000);
    await mkSessions(SMALL_OWNER, "few", 40);
    const PARENT = `sess_${P}_few_1`;
    await mkSessions(SMALL_OWNER, "kid", 30, { parent: PARENT });
    const insertEvents = async (sid: string, payloads: any[]) => {
      for (let i = 0; i < payloads.length; i += 2000) {
        const slice = payloads.slice(i, i + 2000);
        await pool.query(`INSERT INTO events (id, session_id, seq, type, payload) SELECT 'evt_' || $1 || '_' || s, $1, s, t, p::jsonb FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(s, t, p)`,
          [sid, slice.map((_, j) => i + j + 1), slice.map((p) => p.type), slice.map((p) => JSON.stringify(p))]);
      }
    };
    // the big log: 20k events with a compaction near the end
    const BIG = `sess_${P}_few_2`;
    await insertEvents(BIG, makePayloads(20000, { compactAt: 19000, clientTool: true }));
    // a running child blocked on a question to its parent (children.wait untilQuestion)
    const ASKING = `sess_${P}_kid_3`;
    await insertEvents(ASKING, [...makePayloads(20000), { type: "session.status_running" }, { type: "agent.thread_message_sent", to_session_id: PARENT, kind: "question", question_id: "q1", content: [{ type: "text", text: "which?" }] }]);
    await pool.query(`UPDATE sessions SET status='running' WHERE id=$1`, [ASKING]);
    // byoc environment with 300 idle sessions x 300 events; every 10th is paused on reconnection
    await mkSessions(SMALL_OWNER, "byoc", 300, { env: `env_${P}_small` });
    for (let i = 1; i <= 300; i++) {
      const p = makePayloads(300);
      if (i % 10 === 0) p.push({ type: "session.environment_disconnected", environment_id: `env_${P}_small` });
      await insertEvents(`sess_${P}_byoc_${i}`, p);
    }
    const { token } = await apiKeys.create(SMALL_OWNER, "bench");
    await pool.query("ANALYZE sessions; ANALYZE events; ANALYZE session_environments;");
    console.log(`[pg] seeded in ${Math.round(performance.now() - t0)} ms`);

    const small = { owner: SMALL_OWNER };
    await bench("pg", "sessions.list(scope) small tenant (70 sessions, 8k others)", () => repos.sessions.list(small));
    await bench("pg", "sessions.listPage big tenant (8k), limit 200", () => repos.sessions.listPage({ owner: BIG_OWNER }, { limit: 200 }));
    const page1 = await repos.sessions.listPage({ owner: BIG_OWNER }, { limit: 200 });
    await bench("pg", "sessions.listPage big tenant, 2nd page via cursor", () => repos.sessions.listPage({ owner: BIG_OWNER }, { limit: 200, cursor: page1.next_cursor }));
    await bench("pg", "sessions.childrenOf(parent with 30 kids)", () => repos.sessions.childrenOf(PARENT));

    const { children } = mod(await import("../src/runner/children.ts"));
    await bench("pg", "runner children.list(parent)", () => children.list(PARENT));
    const ac = new AbortController();
    await bench("pg", "runner children.wait probe (settled child, 20k events)", () => children.wait(BIG, ac.signal));
    await bench("pg", "runner children.wait untilQuestion probe (20k events)", () => children.wait(ASKING, ac.signal, { untilQuestion: true }));

    // run start: the events fed to the fold (full log, or from the compaction cut when supported)
    const { foldEvents } = await import("../src/harness/fold.ts");
    await bench("pg", "run start: read + fold 20k-event log (compacted at 19k)", async () => {
      const since = events.foldSince ? await events.foldSince(BIG) : 0;
      const evs = since ? await events.listAllEvents(BIG, 5000, since) : await events.listAllEvents(BIG);
      return foldEvents(evs);
    }, { runs: 5 });
    await bench("pg", "plugin eventsGet(limit 20) on 20k-event log", async () => {
      if (events.listEventsWindow) return events.listEventsWindow(BIG, { limit: 20 });
      return (await events.listAllEvents(BIG)).slice(-20);
    }, { runs: 5 });

    const { resumeEnvironment } = mod(await import("../src/api/routes/worker.ts"));
    await bench("pg", "resumeEnvironment (300 idle sessions x 300 events)", () => resumeEnvironment(`env_${P}_small`), { runs: 5, warmup: 1 });
    await bench("pg", "findStrandedSessions (whole DB, ~8.4k idle sessions)", () => findStrandedSessions(30_000), { runs: 5 });
    await bench("pg", "apiKeys.resolve x200 sequential", async () => { for (let i = 0; i < 200; i++) await apiKeys.resolve(token); }, { runs: 5 });

    // compat retrieve/turns through the real router
    const { Hono } = await import("hono");
    const { openaiAgents } = await import("../src/api/routes/compat/openai-agents.ts");
    const { errorResponse } = await import("../src/api/errors.ts");
    const app = new Hono().onError((e, c) => errorResponse(c, e)).use("*", async (c, next) => { c.set("owner" as never, SMALL_OWNER as never); await next(); }).route("/", openaiAgents);
    const get = async (p: string) => { const r = await app.request(p); if (r.status !== 200) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.text(); };
    await bench("pg", "compat GET /agents/sessions/:id (20k events)", () => get(`/agents/sessions/${BIG}`), { runs: 5 });
    await bench("pg", "compat GET /agents/sessions/:id/turns (20k events)", () => get(`/agents/sessions/${BIG}/turns`), { runs: 5 });
    await bench("pg", "compat GET /agents/sessions/:id/turns/:turnId (20k events)", () => get(`/agents/sessions/${BIG}/turns/turn_10`), { runs: 5 });
    await bench("pg", "compat GET /agents/sessions/:id/items (20k events)", () => get(`/agents/sessions/${BIG}/items`), { runs: 5 });
    await bench("pg", "compat GET subagents/:subId (parent with 30 kids)", () => get(`/agents/sessions/${PARENT}/subagents/sess_${P}_kid_7`), { runs: 10 });

    const plans: Record<string, string> = {
      listPage: `EXPLAIN (ANALYZE, BUFFERS OFF, TIMING OFF) SELECT * FROM sessions WHERE owner_id='${BIG_OWNER}' ORDER BY created_at DESC, id DESC LIMIT 201`,
      childrenOf: `EXPLAIN (ANALYZE, TIMING OFF) SELECT * FROM sessions WHERE parent_id='${PARENT}' ORDER BY created_at`,
    };
    for (const [k, sql] of Object.entries(plans)) { const r = await pool.query(sql); console.log(`[plan ${k}] ${r.rows.map((x: any) => x["QUERY PLAN"]).filter((l: string) => /Scan|Sort|rows=/.test(l)).slice(0, 3).join(" | ")}`); }
  } finally {
    await pool.query(`DELETE FROM sessions WHERE owner_id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    await pool.query(`DELETE FROM workspaces WHERE owner_id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    await pool.query(`DELETE FROM environments WHERE owner_id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    await pool.query(`DELETE FROM agents WHERE owner_id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    await pool.query(`DELETE FROM api_keys WHERE principal_id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    await pool.query(`DELETE FROM principals WHERE id = ANY($1::text[])`, [[BIG_OWNER, SMALL_OWNER]]);
    console.log(`[pg] cleaned up prefix ${P}`);
    await pool.end();
  }
}

// ---------------------------------------------------------------------------------------------------
async function redisGroup(): Promise<void> {
  const { redis, subscribe, publish, closeBus } = await import("../src/infra/pubsub.ts");
  const byoc = mod(await import("../src/infra/byoc.ts"));
  const P = `bench${randomBytes(4).toString("hex")}`;
  await redis.connect().catch(() => {});
  const clients = async () => String(await redis.client("LIST")).split("\n").filter(Boolean).length;
  try {
    const before = await clients();
    const N = 300;
    let received = 0;
    const offs: (() => void | Promise<void>)[] = [];
    const t = performance.now();
    for (let i = 0; i < N; i++) offs.push(await subscribe(`sess_${P}_${i}`, () => { received++; }));
    const subMs = performance.now() - t;
    const during = await clients();
    const t2 = performance.now();
    for (let i = 0; i < N; i++) await publish({ type: "agent.message_delta", session_id: `sess_${P}_${i}`, stream_id: "s", text: "x" } as any);
    while (received < N && performance.now() - t2 < 10_000) await new Promise((r) => setTimeout(r, 5));
    const fanMs = performance.now() - t2;
    for (const off of offs) await off();
    await new Promise((r) => setTimeout(r, 300));
    const after = await clients();
    const r1 = { group: "redis", name: `bus: ${N} SSE-style subscribers (subscribe all)`, median_ms: +subMs.toFixed(1), p95_ms: +subMs.toFixed(1), runs: 1, note: `redis connections +${during - before} while subscribed, +${after - before} after unsubscribe` };
    const r2 = { group: "redis", name: `bus: publish 1 delta to each of ${N} subscribers`, median_ms: +fanMs.toFixed(1), p95_ms: +fanMs.toFixed(1), runs: 1, note: `delivered ${received}/${N}` };
    for (const r of [r1, r2]) { results.push(r); console.log(`redis  ${r.name.padEnd(64)} ${r.median_ms} ms   ${r.note}`); }

    // BYOC liveness with a large unrelated keyspace
    const KEYS = 100_000;
    for (let i = 0; i < KEYS; i += 5000) { const m = redis.multi(); for (let j = i; j < Math.min(KEYS, i + 5000); j++) m.set(`${P}:filler:${j}`, "1", "EX", 600); await m.exec(); }
    await byoc.markWorkerAlive(`env_${P}`, "w1");
    await bench("redis", `byoc anyWorkerAlive (live env, ${KEYS / 1000}k-key keyspace)`, () => byoc.anyWorkerAlive(`env_${P}`), { runs: 20 });
    await bench("redis", `byoc anyWorkerAlive (no worker, ${KEYS / 1000}k-key keyspace)`, () => byoc.anyWorkerAlive(`env_${P}_none`), { runs: 20 });
  } finally {
    let cursor = "0";
    do { const [next, keys] = await redis.scan(cursor, "MATCH", `*${P}*`, "COUNT", 5000); cursor = next; if (keys.length) await redis.del(...keys); } while (cursor !== "0");
    await closeBus();
  }
}

// ---------------------------------------------------------------------------------------------------
async function pgbusGroup(): Promise<void> {
  const db = await import("../src/infra/db.ts");
  const { subscribe, publish, closeBus } = await import("../src/infra/pubsub.ts");
  const { pool } = db;
  const P = `bench${randomBytes(4).toString("hex")}`;
  const OWNER = `prc_${P}`, SID = `sess_${P}`;
  let queries = 0;
  const orig = pool.query.bind(pool);
  (pool as any).query = (...a: any[]) => { if (typeof a[0] === "string" && a[0].includes("FROM events WHERE session_id=$1 AND seq=$2")) queries++; return (orig as any)(...a); };
  try {
    await orig(`INSERT INTO principals (id, display_name) VALUES ($1, 'bench')`, [OWNER]);
    await orig(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'bench','{"provider":"x","id":"y"}')`, [`agent_${P}`, OWNER]);
    await orig(`INSERT INTO environments (id, owner_id, name, provider, workspace) VALUES ($1,$2,'bench','local','{"kind":"empty"}')`, [`env_${P}`, OWNER]);
    await orig(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{"kind":"empty"}','{"kind":"empty"}')`, [`ws_${P}`, OWNER]);
    await orig(`INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, agent) VALUES ($1,$2,$3,$4,$5,'{}')`, [SID, OWNER, `agent_${P}`, `env_${P}`, `ws_${P}`]);
    const SUBS = 50, EVENTS = 200;
    await orig(`INSERT INTO events (id, session_id, seq, type, payload) SELECT 'evt_' || g, $1, g, 'plugin.message', '{"type":"plugin.message","plugin":"b","content":[]}'::jsonb FROM generate_series(1, $2::int) g`, [SID, EVENTS]);
    let got = 0;
    const offs = [] as (() => void)[];
    for (let i = 0; i < SUBS; i++) offs.push(await subscribe(SID, () => { got++; }));
    const t = performance.now();
    for (let s = 1; s <= EVENTS; s++) await publish({ type: "event", event: { session_id: SID, seq: s } as any });
    while (got < SUBS * EVENTS && performance.now() - t < 30_000) await new Promise((r) => setTimeout(r, 5));
    const ms = performance.now() - t;
    for (const off of offs) off();
    const r = { group: "pgbus", name: `pg bus: ${EVENTS} events to ${SUBS} subscribers of one session`, median_ms: +ms.toFixed(1), p95_ms: +ms.toFixed(1), runs: 1, note: `delivered ${got}/${SUBS * EVENTS}, event-row SELECTs ${queries}` };
    results.push(r); console.log(`pgbus  ${r.name.padEnd(64)} ${r.median_ms} ms   ${r.note}`);
  } finally {
    await orig(`DELETE FROM sessions WHERE owner_id=$1`, [OWNER]);
    await orig(`DELETE FROM workspaces WHERE owner_id=$1`, [OWNER]);
    await orig(`DELETE FROM environments WHERE owner_id=$1`, [OWNER]);
    await orig(`DELETE FROM agents WHERE owner_id=$1`, [OWNER]);
    await orig(`DELETE FROM principals WHERE id=$1`, [OWNER]);
    await closeBus();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------------------------------
/** Run a group in a child process with its own messaging backend (the bus/queue module is a per-process singleton). */
function inChild(group: string, backend: string): void {
  const tmp = path.join(tmpdir(), `pma-bench-${group}-${process.pid}.json`);
  const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", group, "--out", tmp], { stdio: "inherit", env: { ...process.env, MESSAGING_BACKEND: backend } });
  if (r.status !== 0) { console.error(`[bench] group ${group} failed (exit ${r.status})`); return; }
  try { results.push(...(JSON.parse(readFileSync(tmp, "utf8")) as Result[])); rmSync(tmp); } catch { /* no results */ }
}

const child = argOf("--child");
if (child) {
  if (child === "redis") await redisGroup();
  if (child === "pgbus") await pgbusGroup();
} else {
  if (only.has("pure")) await pureGroup();
  if (only.has("pg")) await pgGroup();
  if (only.has("redis")) inChild("redis", "redis");
  if (only.has("pgbus")) inChild("pgbus", "postgres");
}
if (out) await writeFile(out, JSON.stringify(results, null, 2));
process.exit(0);
