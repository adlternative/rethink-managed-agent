import { loadConfig, saveConfig, getConfigPath, DEFAULT_HOST } from "../lib/config.ts";
import { parseArgs, str } from "../lib/args.ts";
import { spawn } from "node:child_process";
import { platform } from "node:os";

/** Open a URL in the user's default browser (best-effort; never throws). */
function openBrowser(url: string): void {
  try {
    const p = platform();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
    const args = p === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch { /* headless / no desktop */ }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Device-authorization login against the API:
 *   POST /v1/auth/device/code → open /login/device → poll /v1/auth/device/token
 */
async function deviceLogin(host: string, opts: { open: boolean; timeoutMs: number }): Promise<{ token: string; principal_id: string }> {
  const base = host.replace(/\/+$/, "");
  const issuedRes = await fetch(`${base}/v1/auth/device/code`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const issuedText = await issuedRes.text();
  if (!issuedRes.ok) throw new Error(`device code failed ${issuedRes.status}: ${issuedText.slice(0, 200)}`);
  const issued = JSON.parse(issuedText) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval?: number;
    expires_in?: number;
  };

  console.log(`Open ${issued.verification_uri_complete}`);
  console.log(`User code: ${issued.user_code}`);
  if (opts.open) openBrowser(issued.verification_uri_complete);
  else console.log("(browser not opened; pass --open or visit the URL)");

  const intervalMs = Math.max(1, issued.interval ?? 3) * 1000;
  const deadline = Date.now() + (opts.timeoutMs || (issued.expires_in ?? 600) * 1000);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await fetch(`${base}/v1/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: issued.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = {}; }
    if (res.ok && body.access_token) {
      return { token: body.access_token as string, principal_id: body.principal_id as string };
    }
    if (body.error === "authorization_pending" || body.error === "slow_down") continue;
    throw new Error(body.error_description || body.error || `token poll failed ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error("timed out waiting for browser authorization");
}

/**
 * `pma login [--host URL] [--token T] [--no-browser] [--timeout SEC]`
 *
 * Without `--token`, starts a device-authorization flow (browser approve → stores bearer in ~/.pma/config.json).
 * With `--token`, just writes the pasted key (previous behaviour).
 */
export async function cmdLogin(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const cfg = loadConfig();
  const host = str(flags, "host") ?? positional[0];
  if (host) cfg.host = host.replace(/\/+$/, "");
  if (!cfg.host) cfg.host = DEFAULT_HOST;

  const tokenFlag = str(flags, "token");
  if (tokenFlag !== undefined) {
    cfg.token = tokenFlag || undefined;
    saveConfig(cfg);
    console.log(`✓ host=${cfg.host}${cfg.token ? " token=set" : ""} (${getConfigPath()})`);
    return;
  }

  // Device flow (happy path when AUTH_REQUIRED=true — no raw HTTP minting).
  const open = flags["no-browser"] !== true && flags["no-open"] !== true;
  const timeoutSec = Number(str(flags, "timeout") ?? "600");
  try {
    const { token, principal_id } = await deviceLogin(cfg.host, { open, timeoutMs: timeoutSec * 1000 });
    cfg.token = token;
    saveConfig(cfg);
    console.log(`✓ logged in as ${principal_id}`);
    console.log(`✓ host=${cfg.host} token=set (${getConfigPath()})`);
  } catch (e: any) {
    // Fall back to host-only save so local AUTH_REQUIRED=false still benefits from `pma login --host`.
    saveConfig(cfg);
    console.error(`login failed: ${e?.message ?? e}`);
    console.error(`Tip: paste a key with  pma login --host ${cfg.host} --token pma_…`);
    console.error(`     or ensure the API is up and /login/device is reachable.`);
    process.exit(1);
  }
}

export function cmdLogout(): void {
  const cfg = loadConfig();
  delete cfg.token;
  saveConfig(cfg);
  console.log("✓ token cleared");
}
