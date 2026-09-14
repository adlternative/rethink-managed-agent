import { describe, it, expect } from "vitest";
import { Rpc, encode } from "../src/plugins/protocol.ts";

// A pure in-memory Rpc: every written line is captured, handler calls are recorded.
function mk(handle: (method: string, params: unknown) => Promise<unknown> = async (m, p) => ({ m, p })) {
  const out: string[] = [];
  const rpc = new Rpc((line) => out.push(line), handle);
  return { rpc, out, frames: () => out.map((l) => JSON.parse(l)) };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("Rpc.feed framing", () => {
  it("assembles a frame split across several chunks", async () => {
    const { rpc, frames } = mk();
    const line = encode({ id: 7, method: "ping", params: { a: 1 } });
    rpc.feed(line.slice(0, 5)); rpc.feed(line.slice(5, 12)); rpc.feed(line.slice(12));
    await tick();
    expect(frames()).toEqual([{ id: 7, result: { m: "ping", p: { a: 1 } } }]);
  });

  it("any chunking of a frame stream (splits on and around newlines, multi-byte text, a large frame) yields the same frames", async () => {
    const stream = [
      encode({ id: 1, method: "big", params: { s: "é中".repeat(50_000) } }),
      "noise line\n", "\n", "  \n",
      encode({ id: 2, method: "small", params: null }),
      encode({ id: 3, method: "tail", params: [1, 2, 3] }),
    ].join("");
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (const pattern of ["whole", "bytes", "random", "at-newlines"]) {
      const { rpc, frames } = mk(async (m) => m);
      if (pattern === "whole") rpc.feed(stream);
      else if (pattern === "bytes") for (let i = 0; i < stream.length; i += 3) rpc.feed(stream.slice(i, i + 3));
      else if (pattern === "at-newlines") { let from = 0; for (let i = stream.indexOf("\n"); i >= 0; i = stream.indexOf("\n", i + 1)) { rpc.feed(stream.slice(from, i)); rpc.feed("\n"); from = i + 1; } rpc.feed(stream.slice(from)); }
      else for (let i = 0; i < stream.length;) { const n = 1 + rand(70_000); rpc.feed(stream.slice(i, i + n)); i += n; }
      await tick();
      expect(frames().sort((a, b) => a.id - b.id), pattern).toEqual([{ id: 1, result: "big" }, { id: 2, result: "small" }, { id: 3, result: "tail" }]);
    }
  });

  it("handles two frames in one chunk and skips blank lines", async () => {
    const { rpc, frames } = mk();
    rpc.feed(encode({ id: 1, method: "a", params: null }) + "\n   \n" + encode({ id: 2, method: "b", params: null }));
    await tick();
    expect(frames().map((f) => f.id).sort()).toEqual([1, 2]);
  });

  // Regression: Rpc.feed JSON.parses every line with no try/catch (protocol.ts feed).
  it("does not throw on a non-JSON line (a plugin's console.log) and still handles good frames in the same chunk", async () => {
    const { rpc, frames } = mk();
    expect(() => rpc.feed("debug output\n" + encode({ id: 3, method: "x", params: null }))).not.toThrow();
    await tick();
    expect(frames()).toEqual([{ id: 3, result: { m: "x", p: null } }]);
  });

  it("does not throw on a non-JSON line that precedes a pending call's response", async () => {
    const { rpc } = mk();
    const p = rpc.call("m", {});
    expect(() => rpc.feed("hi\n" + encode({ id: 1, result: "ok" }))).not.toThrow();
    await expect(p).resolves.toBe("ok");
  });
});

describe("Rpc calls", () => {
  it("resolves a pending call, ignores a response for an unknown id, and maps null results", async () => {
    const { rpc, frames } = mk(async () => undefined);
    const p = rpc.call<string>("hello", { x: 1 });
    expect(frames()[0]).toEqual({ id: 1, method: "hello", params: { x: 1 } });
    rpc.feed(encode({ id: 999, result: "stray" }));
    rpc.feed(encode({ id: 1, result: "world" }));
    await expect(p).resolves.toBe("world");
    // a second response for the same id is ignored too
    expect(() => rpc.feed(encode({ id: 1, result: "again" }))).not.toThrow();
    // handler returning undefined is sent as result null
    rpc.feed(encode({ id: 5, method: "noop", params: null }));
    await tick();
    expect(frames().at(-1)).toEqual({ id: 5, result: null });
  });

  it("rejects with the remote message and carries remoteStack", async () => {
    const { rpc } = mk();
    const p = rpc.call("boom", {});
    rpc.feed(encode({ id: 1, error: { message: "remote failed", stack: "Error: remote failed\n    at x" } }));
    const e = await p.catch((err) => err) as Error & { remoteStack?: string };
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("remote failed");
    expect(e.remoteStack).toContain("at x");
  });

  it("sends handler errors (and non-Error throws) as error frames", async () => {
    const { rpc, frames } = mk(async (m) => { if (m === "a") throw new Error("bad a"); throw "plain"; });
    rpc.feed(encode({ id: 1, method: "a", params: null }) + encode({ id: 2, method: "b", params: null }));
    await tick();
    const byId = Object.fromEntries(frames().map((f) => [f.id, f]));
    expect(byId[1].error.message).toBe("bad a");
    expect(byId[1].error.stack).toContain("bad a");
    expect(byId[2].error.message).toBe("plain");
  });

  it("abortAll rejects every pending call and clears them", async () => {
    const { rpc } = mk();
    const a = rpc.call("a", {}); const b = rpc.call("b", {});
    rpc.abortAll("host died");
    await expect(a).rejects.toThrow("host died");
    await expect(b).rejects.toThrow("host died");
    // late responses after abort are ignored
    expect(() => rpc.feed(encode({ id: 1, result: 1 }))).not.toThrow();
  });
});
