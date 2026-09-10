/**
 * Blob storage over the S3 protocol (MinIO in compose, any S3 in production). A minimal SigV4
 * client on top of fetch: put / get / delete / head. When BLOB_ENDPOINT is unset, callers fall
 * back to Postgres (files.data) so the stack still works without an object store.
 */
import { createHash, createHmac } from "node:crypto";
import { env } from "../shared/env.ts";

const sha256 = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

export const blobsConfigured = () => !!env.BLOB_ENDPOINT;

function sign(method: string, key: string, body: Buffer, headers: Record<string, string>): { url: string; headers: Record<string, string> } {
  const u = new URL(env.BLOB_ENDPOINT);
  const host = u.host;
  const path = key ? `/${env.BLOB_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}` : `/${env.BLOB_BUCKET}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const h: Record<string, string> = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signedHeaders = Object.keys(h).map((k) => k.toLowerCase()).sort().join(";");
  const canonicalHeaders = Object.keys(h).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((k) => `${k.toLowerCase()}:${h[k]!.trim()}\n`).join("");
  const canonical = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${env.BLOB_REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${env.BLOB_SECRET_KEY}`, date);
  const kRegion = hmac(kDate, env.BLOB_REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${env.BLOB_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete h.host;
  return { url: `${u.origin}${path}`, headers: h };
}

async function s3(method: string, key: string, body: Buffer = Buffer.alloc(0), extra: Record<string, string> = {}): Promise<Response> {
  const { url, headers } = sign(method, key, body, extra);
  try {
    return await fetch(url, { method, headers, body: method === "PUT" ? body : undefined });
  } catch (e) {
    const cause = (e as { cause?: { message?: string; code?: string } }).cause;
    throw new Error(`blob ${method} ${key}: ${(e as Error).message}${cause ? ` (${cause.code ?? ""} ${cause.message ?? ""})` : ""} [${url}]`);
  }
}

export async function putBlob(key: string, data: Buffer, mime = "application/octet-stream"): Promise<void> {
  const r = await s3("PUT", key, data, { "content-type": mime }); // undici sets content-length itself and rejects a manual one
  if (!r.ok) throw new Error(`blob put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function getBlob(key: string): Promise<Buffer | null> {
  const r = await s3("GET", key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`blob get ${key}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function deleteBlob(key: string): Promise<void> {
  const r = await s3("DELETE", key);
  if (!r.ok && r.status !== 404) throw new Error(`blob delete ${key}: ${r.status}`);
}

/** Create the bucket if it does not exist (MinIO / S3 both return 409 or 200 when it does). */
export async function ensureBucket(): Promise<void> {
  if (!blobsConfigured()) return;
  const { url, headers } = sign("PUT", "", Buffer.alloc(0), {});
  const r = await fetch(url, { method: "PUT", headers });
  if (!r.ok && r.status !== 409) {
    const t = await r.text();
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(t)) throw new Error(`ensureBucket: ${r.status} ${t.slice(0, 200)}`);
  }
}
