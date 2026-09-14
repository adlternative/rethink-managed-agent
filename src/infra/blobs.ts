/**
 * Blob storage behind a pluggable backend, selected by env (mirrors the SandboxProvider pattern):
 *   - "s3":  the S3 protocol (MinIO in compose, any S3 in prod) via a minimal SigV4 client on fetch.
 *   - "fs":  a local directory (zero external dependency; good for single-node / dev / air-gapped).
 *   - none:  unconfigured; callers fall back to Postgres (files.data) so the stack still works.
 * Add a backend by implementing BlobStore and wiring it into `select()`.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../shared/env.ts";

export interface BlobStore {
  readonly configured: boolean;
  put(key: string, data: Buffer, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  ensure(): Promise<void>;
}

// ---- backend: none (no object store; files.ts inlines bytes in Postgres) ----
const noneStore: BlobStore = {
  configured: false,
  async put() { throw new Error("no blob store configured"); },
  async get() { return null; },
  async delete() {},
  async ensure() {},
};

// ---- backend: fs (a local directory) ----
function fsStore(dir: string): BlobStore {
  const root = path.resolve(dir);
  const loc = (key: string) => {
    if (!key) throw new Error("blob key must be non-empty");
    const p = path.resolve(root, key);
    if (p === root || !p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error(`blob key escapes BLOB_DIR: ${key}`);
    return p;
  };
  return {
    configured: true,
    async put(key, data) { const f = loc(key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, data); },
    async get(key) { return readFile(loc(key)).catch((e) => (e?.code === "ENOENT" ? null : Promise.reject(e))); },
    async delete(key) { await rm(loc(key), { force: true }); },
    async ensure() { await mkdir(root, { recursive: true }); },
  };
}

// ---- backend: s3 (SigV4 over fetch) ----
const sha256 = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
function s3Store(): BlobStore {
  function sign(method: string, key: string, body: Buffer, headers: Record<string, string>): { url: string; headers: Record<string, string> } {
    const u = new URL(env.BLOB_ENDPOINT);
    const host = u.host;
    const p = key ? `/${env.BLOB_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}` : `/${env.BLOB_BUCKET}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const h: Record<string, string> = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const signedHeaders = Object.keys(h).map((k) => k.toLowerCase()).sort().join(";");
    const canonicalHeaders = Object.keys(h).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((k) => `${k.toLowerCase()}:${h[k]!.trim()}\n`).join("");
    const canonical = [method, p, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${env.BLOB_REGION}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${env.BLOB_SECRET_KEY}`, date), env.BLOB_REGION), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    h.authorization = `AWS4-HMAC-SHA256 Credential=${env.BLOB_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete h.host;
    return { url: `${u.origin}${p}`, headers: h };
  }
  async function req(method: string, key: string, body: Buffer = Buffer.alloc(0), extra: Record<string, string> = {}): Promise<Response> {
    const { url, headers } = sign(method, key, body, extra);
    try { return await fetch(url, { method, headers, body: method === "PUT" ? body : undefined }); }
    catch (e) { const c = (e as { cause?: { message?: string; code?: string } }).cause; throw new Error(`blob ${method} ${key}: ${(e as Error).message}${c ? ` (${c.code ?? ""} ${c.message ?? ""})` : ""} [${url}]`); }
  }
  return {
    configured: true,
    async put(key, data, mime = "application/octet-stream") { const r = await req("PUT", key, data, { "content-type": mime }); if (!r.ok) throw new Error(`blob put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`); },
    async get(key) { const r = await req("GET", key); if (r.status === 404) return null; if (!r.ok) throw new Error(`blob get ${key}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    async delete(key) { const r = await req("DELETE", key); if (!r.ok && r.status !== 404) throw new Error(`blob delete ${key}: ${r.status}`); },
    async ensure() { const { url, headers } = sign("PUT", "", Buffer.alloc(0), {}); const r = await fetch(url, { method: "PUT", headers }); if (!r.ok && r.status !== 409) { const t = await r.text(); if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(t)) throw new Error(`ensureBucket: ${r.status} ${t.slice(0, 200)}`); } },
  };
}

function select(): BlobStore {
  const backend = env.BLOB_BACKEND || (env.BLOB_DIR ? "fs" : env.BLOB_ENDPOINT ? "s3" : "none");
  if (backend === "fs") return fsStore(env.BLOB_DIR || "./data/blobs");
  if (backend === "s3") return s3Store();
  return noneStore;
}

let store: BlobStore | null = null;
export function blobStore(): BlobStore { return (store ??= select()); }

// Stable module API (callers unchanged): delegate to the selected backend.
export const blobsConfigured = () => blobStore().configured;
export const putBlob = (key: string, data: Buffer, mime?: string) => blobStore().put(key, data, mime);
export const getBlob = (key: string) => blobStore().get(key);
export const deleteBlob = (key: string) => blobStore().delete(key);
export const ensureBucket = () => blobStore().ensure();
