import { loadConfig, saveConfig, getConfigPath, DEFAULT_HOST } from "../lib/config.ts";
import { parseArgs, str } from "../lib/args.ts";

/** `pma login [--host URL] [--token T]`: writes ~/.pma/config.json. */
export function cmdLogin(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const cfg = loadConfig();
  const host = str(flags, "host") ?? positional[0];
  if (host) cfg.host = host.replace(/\/+$/, "");
  const token = str(flags, "token");
  if (token !== undefined) cfg.token = token || undefined;
  if (!cfg.host) cfg.host = DEFAULT_HOST;
  saveConfig(cfg);
  console.log(`✓ host=${cfg.host}${cfg.token ? " token=set" : ""} (${getConfigPath()})`);
}

export function cmdLogout(): void {
  const cfg = loadConfig();
  delete cfg.token;
  saveConfig(cfg);
  console.log("✓ token cleared");
}
