import { createHmac, timingSafeEqual } from "node:crypto";

/** Max age of a Slack request timestamp (seconds). Slack recommends 5 minutes. */
export const SLACK_MAX_SKEW_SEC = 60 * 5;

/**
 * Verify a Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack).
 * `body` must be the raw request body string (not re-serialized JSON).
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  /** Wall clock for tests; defaults to Date.now()/1000. */
  nowSec?: number;
  maxSkewSec?: number;
}): boolean {
  const { signingSecret, signature, timestamp, body } = opts;
  if (!signingSecret || !signature || !timestamp) return false;
  if (!/^v0=[0-9a-f]{64}$/i.test(signature)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = opts.maxSkewSec ?? SLACK_MAX_SKEW_SEC;
  if (Math.abs(now - ts) > skew) return false;

  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Build a valid `X-Slack-Signature` for tests / fixtures. */
export function signSlackRequest(signingSecret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}
