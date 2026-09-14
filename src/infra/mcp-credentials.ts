/**
 * MCP server credentials at rest. A server declared with `authorization` / `headers` (the OpenAI
 * `{type:"mcp", transport:{authorization}}` shape) would otherwise sit in plaintext inside the session's
 * agent snapshot, and every endpoint returning the session would echo it. So credentials are sealed with
 * PMA_SECRET_KEY when the session is created, only the runner opens them to call the server, and API
 * output shows that a credential exists but never its value.
 */
import type { McpServerDecl } from "../shared/types.ts";
import { open, seal, secretsConfigured } from "./secrets.ts";

export const REDACTED = "[redacted]";

const hasPlain = (s: McpServerDecl) => !!s.authorization || !!(s.headers && Object.keys(s.headers).length);

/** True when any server carries plaintext credentials (sealing them requires PMA_SECRET_KEY). */
export const hasMcpCredentials = (servers: McpServerDecl[] | undefined) => (servers ?? []).some(hasPlain);
export { secretsConfigured };

/** Seal plaintext credentials into `secret`, dropping the plaintext fields. Servers without credentials are unchanged. */
export function sealMcpServers(servers: McpServerDecl[] | undefined): McpServerDecl[] {
  return (servers ?? []).map((s) => {
    if (!hasPlain(s)) return s;
    const { authorization, headers, ...rest } = s;
    return { ...rest, secret: seal(JSON.stringify({ authorization, headers })), has_authorization: !!authorization || undefined, header_names: headers && Object.keys(headers).length ? Object.keys(headers) : undefined };
  });
}

/** The credentials to call a server with: opened from `secret`, or legacy plaintext from before sealing. */
export function openMcpCredentials(s: McpServerDecl): { authorization?: string; headers?: Record<string, string> } {
  if (s.secret) return JSON.parse(open(s.secret)) as { authorization?: string; headers?: Record<string, string> };
  return { authorization: s.authorization, headers: s.headers };
}

/** API-safe view: no plaintext and no ciphertext, only which credentials are set. */
export function redactMcpServers(servers: McpServerDecl[] | undefined): McpServerDecl[] | undefined {
  if (!servers) return servers;
  return servers.map(({ authorization, headers, secret, header_names, has_authorization, ...rest }) => {
    const names = header_names ?? (headers ? Object.keys(headers) : []);
    return {
      ...rest,
      ...(authorization || (secret && has_authorization) ? { authorization: REDACTED } : {}),
      ...(names.length ? { headers: Object.fromEntries(names.map((n) => [n, REDACTED])) } : {}),
    };
  });
}
