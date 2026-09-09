import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HOST = "http://localhost:8080";

export interface Config {
  host: string;
  /** Optional bearer token (the reference server has no auth; kept for deployments behind a gateway). */
  token?: string;
  default_agent_id?: string;
  default_env_id?: string;
  /** Custom HTTP headers injected into every request. */
  headers?: Record<string, string>;
}

const defaultPath = join(homedir(), ".pma", "config.json");
export const getConfigPath = () => process.env.PMA_CONFIG || defaultPath;

export function loadConfig(): Config {
  try {
    return { host: DEFAULT_HOST, ...JSON.parse(readFileSync(getConfigPath(), "utf8")) };
  } catch {
    return { host: DEFAULT_HOST };
  }
}

export function saveConfig(cfg: Config): void {
  mkdirSync(dirname(getConfigPath()), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + "\n");
}

/** File config overlaid with env vars: PMA_HOST, PMA_TOKEN, PMA_HEADERS (JSON object). */
export function resolveConfig(): Config {
  const cfg = loadConfig();
  if (process.env.PMA_HOST) cfg.host = process.env.PMA_HOST;
  if (process.env.PMA_TOKEN) cfg.token = process.env.PMA_TOKEN;
  if (process.env.PMA_HEADERS) {
    try { cfg.headers = { ...cfg.headers, ...JSON.parse(process.env.PMA_HEADERS) }; } catch { /* ignore */ }
  }
  return cfg;
}

export function buildHeaders(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { ...cfg.headers };
  if (cfg.token) h.authorization = `Bearer ${cfg.token}`;
  return h;
}
