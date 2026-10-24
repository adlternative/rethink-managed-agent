/**
 * OAuth-style device authorization for CLI login (`pma login`).
 * Codes are short-lived and held in process memory (single API process / sticky session).
 * The API key is minted only when the CLI polls after browser approval.
 */
import { randomBytes } from "node:crypto";
import { apiKeys, principals } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import { ApiError, invalid } from "./errors.ts";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const DEVICE_TTL_S = 600;
const POLL_INTERVAL_S = 3;

type Entry = {
  device_code: string;
  user_code: string;
  expires_at: number;
  interval: number;
  status: "pending" | "approved" | "exchanged" | "denied" | "expired";
  principal_id?: string;
};

const byDevice = new Map<string, Entry>();
const byUser = new Map<string, string>(); // normalized user_code -> device_code

export interface DeviceCodeBag {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Test / process reset. */
export function resetDeviceAuthStore(): void {
  byDevice.clear();
  byUser.clear();
}

function randomUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function normUser(code: string): string {
  return code.trim().toUpperCase().replace(/[-\s]/g, "");
}

function publicBase(reqUrl: string): string {
  if (env.PMA_PUBLIC_URL) return env.PMA_PUBLIC_URL.replace(/\/+$/, "");
  try {
    const u = new URL(reqUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return `http://localhost:${env.API_PORT}`;
  }
}

function getLive(deviceCode: string): Entry | null {
  const e = byDevice.get(deviceCode);
  if (!e) return null;
  if (e.expires_at < Date.now() && e.status === "pending") {
    e.status = "expired";
  }
  return e;
}

export async function createDeviceCode(reqUrl: string): Promise<DeviceCodeBag> {
  const device_code = `dev_${randomBytes(24).toString("base64url")}`;
  let user_code = randomUserCode();
  for (let i = 0; i < 8 && byUser.has(normUser(user_code)); i++) user_code = randomUserCode();
  const entry: Entry = {
    device_code,
    user_code,
    expires_at: Date.now() + DEVICE_TTL_S * 1000,
    interval: POLL_INTERVAL_S,
    status: "pending",
  };
  byDevice.set(device_code, entry);
  byUser.set(normUser(user_code), device_code);
  const base = publicBase(reqUrl);
  const verification_uri = `${base}/login/device`;
  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete: `${verification_uri}?user_code=${encodeURIComponent(user_code)}`,
    expires_in: DEVICE_TTL_S,
    interval: POLL_INTERVAL_S,
  };
}

export function lookupUserCode(userCode: string): { user_code: string; status: string; expires_at: string } | null {
  const device = byUser.get(normUser(userCode));
  if (!device) return null;
  const e = getLive(device);
  if (!e) return null;
  return { user_code: e.user_code, status: e.status, expires_at: new Date(e.expires_at).toISOString() };
}

/**
 * Approve a pending device code. Caller may be authenticated (mint for that principal) or anonymous:
 * - AUTH_REQUIRED=false → PMA_DEFAULT_PRINCIPAL
 * - AUTH_REQUIRED=true + DEVICE_LOGIN_SIGNUP → new user principal (CLI bootstrap without raw HTTP)
 * - AUTH_REQUIRED=true without signup → 401 (authorize with an existing key, or `pma login --token`)
 */
export async function approveDeviceCode(opts: {
  userCode: string;
  actorId?: string;
  displayName?: string;
}): Promise<{ principal_id: string; user_code: string }> {
  const meta = lookupUserCode(opts.userCode);
  if (!meta) throw invalid("unknown or expired user code");
  const device = byUser.get(normUser(opts.userCode))!;
  const e = getLive(device)!;
  if (e.status === "expired" || e.expires_at < Date.now()) {
    e.status = "expired";
    throw invalid("user code expired");
  }
  if (e.status === "exchanged" || e.status === "approved") throw invalid("user code already used");
  if (e.status !== "pending") throw invalid(`user code is ${e.status}`);

  let principalId = opts.actorId;
  if (!principalId) {
    if (!env.AUTH_REQUIRED) {
      principalId = env.PMA_DEFAULT_PRINCIPAL;
      if (!(await principals.get(principalId))) {
        await principals.upsert({ id: principalId, handle: "local", display_name: "Local User" });
      }
    } else if (env.DEVICE_LOGIN_SIGNUP) {
      const p = await principals.upsert({
        kind: "user",
        display_name: opts.displayName?.trim() || "CLI user",
      });
      principalId = p.id;
    } else {
      throw new ApiError(401, "authentication_error", "sign in with an existing API key to authorize this device (or set DEVICE_LOGIN_SIGNUP=true)");
    }
  } else if (!(await principals.get(principalId))) {
    throw invalid("principal not found");
  }

  e.status = "approved";
  e.principal_id = principalId;
  return { principal_id: principalId, user_code: e.user_code };
}

export type DeviceTokenResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "authorized"; access_token: string; token_type: "bearer"; principal_id: string };

export async function exchangeDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  if (!deviceCode || typeof deviceCode !== "string") throw invalid("device_code is required");
  const e = getLive(deviceCode);
  if (!e) throw invalid("unknown device_code");
  if (e.status === "exchanged") throw invalid("device_code already exchanged");
  if (e.status === "denied") return { status: "denied" };
  if (e.status === "expired" || e.expires_at < Date.now()) {
    e.status = "expired";
    return { status: "expired" };
  }
  if (e.status === "pending") return { status: "pending" };
  if (e.status !== "approved" || !e.principal_id) throw invalid(`device_code is ${e.status}`);

  const key = await apiKeys.create(e.principal_id, "pma login");
  e.status = "exchanged";
  return {
    status: "authorized",
    access_token: key.token,
    token_type: "bearer",
    principal_id: e.principal_id,
  };
}
