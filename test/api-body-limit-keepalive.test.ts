import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Agent, fetch as ufetch } from "undici";
import { ApiError, errorResponse } from "../src/api/errors.ts";
import { bodyLimit, discardRest } from "../src/api/body-limit.ts";
import { env } from "../src/shared/env.ts";

const MAX = 1024 * 1024;
let server: ReturnType<typeof serve>;
let url: string;

beforeAll(async () => {
  const app = new Hono().onError((e, c) => errorResponse(c, e))
    .use("*", bodyLimit(() => MAX))
    .use("/auth/*", (c) => errorResponse(c, new ApiError(401, "authentication_error", "authentication required"))) // never reads the body
    .post("/upload", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }))
    .get("/ping", (c) => c.json({ ok: true }));
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { (server as http.Server).closeAllConnections?.(); server.close(); });

const saved = { bytes: env.API_DRAIN_MAX_BYTES, ms: env.API_DRAIN_MAX_MS };
afterEach(() => { env.API_DRAIN_MAX_BYTES = saved.bytes; env.API_DRAIN_MAX_MS = saved.ms; });

/** One keep-alive socket: a later request must reuse the connection of the rejected upload (or fail if it is broken). */
function client() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const send = (method: string, path: string, body?: Buffer | { chunkedMB: number }) => new Promise<{ status: number; json: any; reused: boolean }>((resolve, reject) => {
    const headers: Record<string, string | number> = body && "chunkedMB" in body ? { "transfer-encoding": "chunked" } : body ? { "content-length": body.length } : {};
    const r = http.request(`${url}${path}`, { method, agent, headers }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json; try { json = JSON.parse(text); } catch { json = text; } resolve({ status: res.statusCode!, json, reused: r.reusedSocket }); });
    });
    r.on("error", reject);
    r.on("socket", (sock) => sock.on("error", () => { /* a closed connection surfaces as the request error */ }));
    r.setTimeout(10_000, () => r.destroy(new Error("client timeout")));
    if (body && "chunkedMB" in body) { for (let i = 0; i < body.chunkedMB; i++) r.write(Buffer.alloc(MAX)); r.end(); } else if (body) r.end(body); else r.end();
  });
  return { send, close: () => agent.destroy() };
}

describe("body limit keeps keep-alive connections usable", () => {
  it("an early 413 on Content-Length reaches the uploading client, and the connection keeps serving requests", async () => {
    const c = client();
    const up = await c.send("POST", "/upload", Buffer.alloc(33 * 1024 * 1024));
    expect(up).toMatchObject({ status: 413, json: { error: { type: "payload_too_large" } } }); // not EPIPE / ECONNRESET
    const next = [await c.send("GET", "/ping"), await c.send("GET", "/ping")];
    expect(next.map((n) => n.status)).toEqual([200, 200]);
    expect(next.some((n) => n.reused)).toBe(true);
    c.close();
  });

  it("a chunked body that overflows while streaming gets a 413 and the connection stays usable", async () => {
    const c = client();
    expect((await c.send("POST", "/upload", { chunkedMB: 5 })).status).toBe(413);
    const next = [await c.send("GET", "/ping"), await c.send("GET", "/ping")];
    expect(next.map((n) => n.status)).toEqual([200, 200]);
    expect(next.some((n) => n.reused)).toBe(true);
    c.close();
  });

  it("a route that rejects without reading the body (401) leaves a usable connection", async () => {
    const c = client();
    expect((await c.send("POST", "/auth/x", Buffer.alloc(900 * 1024))).status).toBe(401);
    const next = [await c.send("GET", "/ping"), await c.send("GET", "/ping")];
    expect(next.map((n) => n.status)).toEqual([200, 200]);
    expect(next.some((n) => n.reused)).toBe(true);
    c.close();
  });

  it("a body under the limit still reaches the handler intact", async () => {
    const c = client();
    expect(await c.send("POST", "/upload", Buffer.alloc(MAX - 1))).toMatchObject({ status: 200, json: { bytes: MAX - 1 } });
    expect(await c.send("POST", "/upload", { chunkedMB: 1 })).toMatchObject({ status: 200, json: { bytes: MAX } });
    c.close();
  });

  it("undici (Node's fetch) with one connection: 413 then the next request succeeds", async () => {
    const d = new Agent({ connections: 1 });
    const up = await ufetch(`${url}/upload`, { method: "POST", body: new Uint8Array(33 * 1024 * 1024), dispatcher: d });
    expect(up.status).toBe(413); await up.text();
    const ping = await ufetch(`${url}/ping`, { dispatcher: d, signal: AbortSignal.timeout(5000) });
    expect(ping.status).toBe(200); await ping.text();
    await d.close();
  });

  it("past the drain byte cap the server closes the connection instead of reading forever, and a fresh one works", async () => {
    env.API_DRAIN_MAX_BYTES = 256 * 1024;
    const c = client();
    const up = await c.send("POST", "/upload", Buffer.alloc(33 * 1024 * 1024)).then((r) => r.status, (e) => `error:${(e as NodeJS.ErrnoException).code ?? e.message}`);
    expect([413, "error:EPIPE", "error:ECONNRESET"]).toContain(up); // the client may or may not see the 413 before the close
    const next = await c.send("GET", "/ping");
    expect(next.status).toBe(200);
    expect(next.reused).toBe(false); // the capped connection was closed, not reused half-drained
    c.close();
  });
});

describe("discardRest", () => {
  const readerOf = (chunks: number[], opts: { stallAfter?: number } = {}) => {
    let i = 0, cancelled = false, wake: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (opts.stallAfter !== undefined && i >= opts.stallAfter) { await new Promise<void>((r) => (wake = r)); return ctrl.close(); }
        if (i >= chunks.length) return ctrl.close();
        ctrl.enqueue(new Uint8Array(chunks[i++]!));
      },
      cancel() { cancelled = true; wake?.(); },
    });
    return { reader: stream.getReader(), get cancelled() { return cancelled; } };
  };

  it("drains to the end", async () => {
    const r = readerOf([1000, 1000, 1000]);
    expect(await discardRest(r.reader, { maxBytes: 10_000, maxMs: 5000 })).toBe("drained");
    expect(r.cancelled).toBe(false);
  });

  it("gives up (cancels) past the byte cap", async () => {
    const r = readerOf([4000, 4000, 4000, 4000]);
    expect(await discardRest(r.reader, { maxBytes: 5000, maxMs: 5000 })).toBe("gave_up");
    expect(r.cancelled).toBe(true);
  });

  it("gives up (cancels) when the client stalls past the time cap", async () => {
    const r = readerOf([100], { stallAfter: 1 });
    const t = Date.now();
    expect(await discardRest(r.reader, { maxBytes: 10_000, maxMs: 150 })).toBe("gave_up");
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.cancelled).toBe(true);
  });
});
