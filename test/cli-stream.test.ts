import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../src/cli/http.ts";
import { apiError, cli, sendJson, sse, startStub, type Handler, type Recorded } from "./fixtures/cli-stub.ts";

let stub: Awaited<ReturnType<typeof startStub>> | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
const serve = async (h: Handler) => (stub = await startStub(h));

const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({ seq, type, payload: { type, ...extra } });
const openSse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream" });
const tick = () => new Promise((r) => setTimeout(r, 15));

/** POST /events answers with the message at `seq`; GET /stream is delegated to `stream(connection index)`. */
function session(seq: number, stream: (n: number, req: Recorded, res: ServerResponse) => Promise<void>): Handler {
  let n = 0;
  return async (r, res) => {
    if (r.method === "POST" && r.path.endsWith("/events")) return sendJson(res, 200, { events: [ev(seq, "user.message", { content: r.json.events[0].content })] });
    if (r.path.includes("/events/stream")) return stream(n++, r, res);
    res.writeHead(404); res.end();
  };
}

describe("SSE parser", () => {
  it("handles chunks split mid-UTF-8 and mid-boundary, CRLF endings, comments, multi-line data and a final unterminated block", async () => {
    const s = await serve(async (_r, res) => {
      openSse(res);
      const wire = Buffer.from(`: heartbeat\r\n\r\nevent: a\r\ndata: {"t":"héllo wörld"}\r\n\r\nevent: b\ndata: {"x":\ndata: 1}\n\nevent: c\ndata: {"end":true}`);
      for (let i = 0; i < wire.length; i += 3) { res.write(wire.subarray(i, i + 3)); if (i % 12 === 0) await tick(); }
      res.end();
    });
    const got: [string, unknown][] = [];
    const ended = await new Client({ base: s.url }).sse("/x", (t, d) => { got.push([t, d]); });
    expect(ended).toBe(false);
    expect(got).toEqual([["a", { t: "héllo wörld" }], ["b", { x: 1 }], ["c", { end: true }]]);
  });
});

describe("send --wait", () => {
  it("subscribes from the message seq, ignores the idle of the earlier run, and exits 0 on the answering run's idle", async () => {
    const s = await serve(session(5, async (_n, _r, res) => {
      openSse(res);
      res.write(sse("session.usage", ev(6, "session.usage")));
      res.write(sse("session.status_idle", ev(7, "session.status_idle", { stop_reason: "end_turn", consumed_seq: 4 })));
      await tick();
      res.write(": heartbeat\n\n");
      res.write(sse("session.status_running", ev(8, "session.status_running")));
      res.write(sse("agent.message_delta", { type: "agent.message_delta", stream_id: "st", text: "po" }));
      res.write(sse("agent.message_delta", { type: "agent.message_delta", stream_id: "st", text: "ng" }));
      res.write(sse("agent.message", ev(9, "agent.message", { stream_id: "st", content: [{ type: "text", text: "pong" }] })));
      res.write(sse("session.status_idle", ev(10, "session.status_idle", { stop_reason: "end_turn", consumed_seq: 5 })));
      await tick();
      res.write(sse("agent.message", ev(11, "agent.message", { content: [{ type: "text", text: "must not be read" }] })));
    }));
    const r = await cli(s.url, ["send", "--wait", "sess_1", "reply", "pong"], { PMA_API_KEY: "k" });
    expect(r.code).toBe(0);
    expect(s.requests[0]).toMatchObject({ method: "POST", path: "/v1/sessions/sess_1/events", json: { events: [{ type: "user.message", content: [{ type: "text", text: "reply pong" }] }] } });
    expect(s.requests[1]!.path).toBe("/v1/sessions/sess_1/events/stream?since=5");
    expect(s.requests[1]!.headers.authorization).toBe("Bearer k");
    expect(r.stdout).toContain("pong\n");
    expect(r.stdout.match(/pong/g)).toHaveLength(1);
    expect(r.stdout).not.toContain("must not be read");
  });

  it("reconnects from the last seen seq when the connection drops", async () => {
    const s = await serve(session(3, async (n, _r, res) => {
      openSse(res);
      if (n === 0) { res.write(sse("session.status_running", ev(4, "session.status_running"))); await tick(); return void res.end(); }
      res.write(sse("session.status_idle", ev(6, "session.status_idle", { stop_reason: "end_turn", consumed_seq: 3 })));
    }));
    const r = await cli(s.url, ["send", "sess_1", "hi", "--wait"]);
    expect(r.code).toBe(0);
    expect(s.requests.slice(1).map((x) => x.path)).toEqual(["/v1/sessions/sess_1/events/stream?since=3", "/v1/sessions/sess_1/events/stream?since=4"]);
    expect(r.stderr).toContain("reconnecting from seq 4");
  });

  it("a run error, a terminated session, a rejected POST and a timeout all exit 1", async () => {
    let mode = "error";
    const s = await serve(async (r, res) => {
      if (r.method === "POST") return mode === "reject" ? apiError(res, 400, "invalid_request_error", "session sess_1 is terminated") : sendJson(res, 200, { events: [ev(2, "user.message")] });
      openSse(res);
      if (mode === "error") { res.write(sse("session.error", ev(3, "session.error", { error: { type: "model_error", message: "boom" } }))); res.write(sse("session.status_idle", ev(4, "session.status_idle", { stop_reason: "error", consumed_seq: 2 }))); }
      if (mode === "terminated") res.write(sse("session.status_terminated", ev(3, "session.status_terminated", { reason: "archived" })));
      if (mode === "timeout") res.write(": heartbeat\n\n");
    });
    expect(await cli(s.url, ["send", "sess_1", "x", "--wait"])).toMatchObject({ code: 1, stderr: expect.stringContaining("run ended with an error") });
    mode = "terminated";
    expect(await cli(s.url, ["send", "sess_1", "x", "--wait"])).toMatchObject({ code: 1, stderr: "session terminated (archived)\n" });
    mode = "reject";
    expect(await cli(s.url, ["send", "sess_1", "x", "--wait"])).toMatchObject({ code: 1, stderr: "HTTP 400 invalid_request_error: session sess_1 is terminated\n" });
    mode = "timeout";
    const t0 = Date.now();
    expect(await cli(s.url, ["send", "sess_1", "x", "--wait", "--timeout", "1"])).toMatchObject({ code: 1, stderr: "timed out after 1s waiting on session sess_1\n" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("gives up when the stream keeps closing without progress", async () => {
    const s = await serve(async (_r, res) => { openSse(res); res.end(); });
    const reconnects: number[] = [];
    await expect(new Client({ base: s.url }).follow("sess_1", 1, () => false, { retries: 3, backoffMs: 1, onReconnect: (last) => reconnects.push(last) }))
      .rejects.toThrow("event stream lost (the server closed the stream); gave up after 3 reconnects");
    expect(reconnects).toEqual([1, 1, 1]);
    expect(s.requests).toHaveLength(4);
  });

  it("without --wait prints the appended events; --file uploads and attaches", async () => {
    const s = await serve(async (r, res) => {
      if (r.path === "/v1/files") return sendJson(res, 201, { id: "file_img", filename: "a.png" });
      return sendJson(res, 200, { events: [ev(1, "user.message", { content: r.json.events[0].content })] });
    });
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const dir = await mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "pma-cli-"));
    try {
      await writeFile(`${dir}/a.png`, "png");
      const r = await cli(s.url, ["send", "sess_1", "look", "--file", `${dir}/a.png`]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)[0].seq).toBe(1);
      expect(s.requests[0]!.headers["content-type"]).toBe("image/png");
      expect(s.requests[1]!.json).toEqual({ events: [{ type: "user.message", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "file", file_id: "file_img" } }] }] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("stream and events", () => {
  it("stream starts at --since, hides tool/thinking deltas and ends on status_terminated", async () => {
    const s = await serve(async (_r, res) => {
      openSse(res);
      res.write(sse("agent.thinking_delta", { type: "agent.thinking_delta", text: "hmm" }));
      res.write(sse("agent.tool_use", ev(8, "agent.tool_use", { name: "bash", input: { command: "ls" } })));
      res.write(sse("agent.tool_result", ev(9, "agent.tool_result", { content: [{ type: "image" }] })));
      res.write(sse("session.status_terminated", ev(10, "session.status_terminated")));
    });
    const r = await cli(s.url, ["stream", "sess_1", "--since", "7"]);
    expect(r.code).toBe(0);
    expect(s.requests[0]!.path).toBe("/v1/sessions/sess_1/events/stream?since=7");
    expect(r.stdout).toContain('[tool_use bash] {"command":"ls"}');
    expect(r.stdout).toContain("[tool_result] [image]");
    expect(r.stdout).not.toContain("hmm");
  });

  it("events follows has_more pages past 1000 and prints a table; --json prints every event", async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ev(i + 1, i === 1499 ? "session.status_idle" : "agent.message", i === 1499 ? { stop_reason: "end_turn" } : { content: [{ type: "text", text: `m${i + 1}` }] }));
    const s = await serve((r, res) => {
      const u = new URL(r.path, "http://x");
      const since = Number(u.searchParams.get("since")); const limit = Number(u.searchParams.get("limit"));
      const page = all.filter((e) => e.seq > since);
      sendJson(res, 200, { data: page.slice(0, limit), has_more: page.length > limit });
    });
    const table = await cli(s.url, ["events", "sess_1"]);
    expect(table.stdout.split("\n")[0]).toMatch(/^SEQ\s+TYPE\s+SUMMARY$/);
    expect(table.stdout).toMatch(/1500\s+session\.status_idle\s+end_turn/);
    expect(s.requests.map((r) => r.path)).toEqual(["/v1/sessions/sess_1/events?limit=1000&since=0", "/v1/sessions/sess_1/events?limit=1000&since=1000"]);
    const json = await cli(s.url, ["events", "sess_1", "--json", "--since", "1400", "--limit", "50"]);
    expect(JSON.parse(json.stdout).data.map((e: any) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 1401 + i));
  });
});
