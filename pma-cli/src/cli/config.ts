import { getConfigPath, loadConfig, saveConfig } from "../lib/config.ts";
import { parseArgs, str } from "../lib/args.ts";

/** `pma config [--host URL] [--agent ID] [--env ID] [--header k:v] [--header-del k]`; prints the effective config. */
export function cmdConfig(args: string[]): void {
  const { flags } = parseArgs(args);
  const cfg = loadConfig();
  if (str(flags, "host")) cfg.host = str(flags, "host")!.replace(/\/+$/, "");
  if (str(flags, "agent")) cfg.default_agent_id = str(flags, "agent");
  if (str(flags, "env")) cfg.default_env_id = str(flags, "env");
  const hdr = str(flags, "header");
  if (hdr) { const i = hdr.indexOf(":"); if (i > 0) cfg.headers = { ...cfg.headers, [hdr.slice(0, i).trim()]: hdr.slice(i + 1).trim() }; }
  if (str(flags, "header-del") && cfg.headers) delete cfg.headers[str(flags, "header-del")!];
  saveConfig(cfg);
  console.log(`${getConfigPath()}\n${JSON.stringify({ ...cfg, token: cfg.token ? "<set>" : undefined }, null, 2)}`);
}
