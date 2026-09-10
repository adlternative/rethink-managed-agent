/**
 * At-rest encryption for user-supplied credentials (BYOK). AES-256-GCM with a key from
 * PMA_SECRET_KEY (32 bytes, base64 or hex). Without it, storing keys is refused; env-var
 * references still work.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../shared/env.ts";

export interface Sealed { type: "encrypted"; v: 1; iv: string; ct: string; tag: string }

function masterKey(): Buffer {
  const raw = env.PMA_SECRET_KEY;
  if (!raw) throw new Error("PMA_SECRET_KEY is not set: cannot store credentials (use auth {type:'env'} or set a 32-byte key)");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("PMA_SECRET_KEY must be 32 bytes (base64 or hex)");
  return buf;
}
export const secretsConfigured = () => !!env.PMA_SECRET_KEY;

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { type: "encrypted", v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function open(s: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
}
