import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Backend selection is memoized per module instance and env is read at import, so every case resets
// modules, sets process.env, and re-imports blobs.ts (hermetic: fetch is stubbed for s3).
const KEYS = ["BLOB_BACKEND", "BLOB_DIR", "BLOB_ENDPOINT", "BLOB_BUCKET", "BLOB_REGION", "BLOB_ACCESS_KEY", "BLOB_SECRET_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
async function load(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  vi.resetModules();
  return import("../src/infra/blobs.ts");
}
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.unstubAllGlobals(); vi.useRealTimers(); });

type Req = { url: string; method: string; headers: Record<string, string>; body?: unknown };
let reqs: Req[] = [];
let respond: (r: Req) => Response = () => new Response("", { status: 200 });
beforeEach(() => {
  reqs = [];
  respond = () => new Response("", { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => { const r = { url, ...init }; reqs.push(r); return respond(r); });
});

describe("backend selection", () => {
  it("BLOB_BACKEND wins over BLOB_DIR / BLOB_ENDPOINT", async () => {
    const b = await load({ BLOB_BACKEND: "s3", BLOB_DIR: "/tmp/nope", BLOB_ENDPOINT: "http://minio:9000" });
    await b.putBlob("k", Buffer.from("x"));
    expect(reqs[0]!.url).toBe("http://minio:9000/pma/k");
  });

  it("BLOB_DIR alone -> fs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "infra-blobs-sel-"));
    const b = await load({ BLOB_DIR: dir });
    await b.putBlob("a/b", Buffer.from("fs"));
    expect((await stat(path.join(dir, "a", "b"))).size).toBe(2);
    expect(reqs).toHaveLength(0);
  });

  it("BLOB_ENDPOINT alone -> s3", async () => {
    const b = await load({ BLOB_ENDPOINT: "http://minio:9000" });
    expect(b.blobsConfigured()).toBe(true);
    await b.getBlob("k");
    expect(reqs[0]!.method).toBe("GET");
  });

  it("neither -> the none store: not configured, put throws, get null, delete/ensure no-op", async () => {
    const b = await load({});
    expect(b.blobsConfigured()).toBe(false);
    await expect(b.putBlob("k", Buffer.from("x"))).rejects.toThrow(/no blob store configured/);
    expect(await b.getBlob("k")).toBeNull();
    await expect(b.deleteBlob("k")).resolves.toBeUndefined();
    await expect(b.ensureBucket()).resolves.toBeUndefined();
    expect(reqs).toHaveLength(0);
  });

  it("the store is memoized per module instance", async () => {
    const b = await load({});
    expect(b.blobStore()).toBe(b.blobStore());
  });
});

describe("s3 backend (SigV4 over fetch)", () => {
  const vars = { BLOB_ENDPOINT: "http://minio:9000", BLOB_BUCKET: "bucket", BLOB_REGION: "us-east-1", BLOB_ACCESS_KEY: "AKID", BLOB_SECRET_KEY: "SECRET" };
  const hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
  const h = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

  it("encodes key segments and signs content-type;host;x-amz-content-sha256;x-amz-date deterministically", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T05:06:07.890Z"));
    const b = await load(vars);
    const body = Buffer.from("hello");
    await b.putBlob("files/a b", body, "text/plain");
    const r = reqs[0]!;
    expect(r.url).toBe("http://minio:9000/bucket/files/a%20b");
    expect(r.method).toBe("PUT");
    expect(r.headers["x-amz-date"]).toBe("20260304T050607Z");
    expect(r.headers["x-amz-content-sha256"]).toBe(hex(body));
    expect(r.headers).not.toHaveProperty("host");
    // Independent SigV4 computation over the same canonical request.
    const canonical = ["PUT", "/bucket/files/a%20b", "", `content-type:text/plain\nhost:minio:9000\nx-amz-content-sha256:${hex(body)}\nx-amz-date:20260304T050607Z\n`, "content-type;host;x-amz-content-sha256;x-amz-date", hex(body)].join("\n");
    const scope = "20260304/us-east-1/s3/aws4_request";
    const toSign = ["AWS4-HMAC-SHA256", "20260304T050607Z", scope, hex(canonical)].join("\n");
    const sig = createHmac("sha256", h(h(h(h("AWS4SECRET", "20260304"), "us-east-1"), "s3"), "aws4_request")).update(toSign).digest("hex");
    expect(r.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKID/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${sig}`);
  });

  it("GET 404 -> null; GET 500 throws; GET 200 returns bytes", async () => {
    const b = await load(vars);
    respond = () => new Response("", { status: 404 });
    expect(await b.getBlob("k")).toBeNull();
    respond = () => new Response("boom", { status: 500 });
    await expect(b.getBlob("k")).rejects.toThrow(/blob get k: 500/);
    respond = () => new Response("data", { status: 200 });
    expect((await b.getBlob("k"))?.toString()).toBe("data");
    expect(reqs.every((r) => r.body === undefined)).toBe(true);
  });

  it("PUT non-2xx throws with the status; DELETE 404 is ok, 500 throws", async () => {
    const b = await load(vars);
    respond = () => new Response("denied", { status: 403 });
    await expect(b.putBlob("k", Buffer.from("x"))).rejects.toThrow(/blob put k: 403 denied/);
    respond = () => new Response("", { status: 404 });
    await expect(b.deleteBlob("k")).resolves.toBeUndefined();
    respond = () => new Response("", { status: 500 });
    await expect(b.deleteBlob("k")).rejects.toThrow(/blob delete k: 500/);
  });

  it("ensure accepts 409 and a BucketAlreadyOwnedByYou body, rejects other errors", async () => {
    const b = await load(vars);
    respond = () => new Response("", { status: 409 });
    await expect(b.ensureBucket()).resolves.toBeUndefined();
    expect(reqs[0]!.url).toBe("http://minio:9000/bucket");
    respond = () => new Response("<Code>BucketAlreadyOwnedByYou</Code>", { status: 400 });
    await expect(b.ensureBucket()).resolves.toBeUndefined();
    respond = () => new Response("<Code>AccessDenied</Code>", { status: 403 });
    await expect(b.ensureBucket()).rejects.toThrow(/ensureBucket: 403/);
  });

  it("network errors are wrapped with method, key and url", async () => {
    const b = await load(vars);
    vi.stubGlobal("fetch", async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED", message: "refused" } }); });
    await expect(b.getBlob("k")).rejects.toThrow(/blob GET k: fetch failed \(ECONNREFUSED refused\) \[http:\/\/minio:9000\/bucket\/k\]/);
  });
});

describe("fs backend edge keys", () => {
  // Regression: loc("") resolves to the root itself and is accepted; before ensure() the put writes a regular
  // file at the BLOB_DIR path, so the directory can never be created afterwards.
  it("put('') is rejected as an invalid key and does not create a file at the root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "infra-blobs-root-"));
    const root = path.join(parent, "store");
    const b = await load({ BLOB_BACKEND: "fs", BLOB_DIR: root });
    await expect(b.putBlob("", Buffer.from("x"))).rejects.toThrow(/key/i);
    await expect(stat(root)).rejects.toThrow(/ENOENT/);
  });

  it("absolute keys outside the dir are rejected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "infra-blobs-abs-"));
    const b = await load({ BLOB_BACKEND: "fs", BLOB_DIR: dir });
    await expect(b.putBlob("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/escapes/);
    await expect(b.getBlob("../x")).rejects.toThrow(/escapes/);
  });
});
