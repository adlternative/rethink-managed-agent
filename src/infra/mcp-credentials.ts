/**
 * MCP server credentials at rest. A server declared with `authorization` / `headers` (the OpenAI
 * `{type:"mcp", transport:{authorization}}` shape) would otherwise sit in plaintext inside the session's
 * agent snapshot, and every endpoint returning the session would echo it. So credentials are sealed with
 * PMA_SECRET_KEY when the session is created, only the runner opens them to call the server, and API
 * output shows that a credential exists but never its value.
 */
import type { McpServerDecl } from "../shared/types.ts";
import { open, seal, secretsConfigured, type Sealed } from "./secrets.ts";

export const REDACTED = "[redacted]";
/** What an MCP connection is authenticated with. */
export interface McpCredentials { authorization?: string; headers?: Record<string, string> }

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

/**
 * Match key for an MCP credential: scheme and host lowercased, a default port and a trailing slash
 * dropped. So host casing, `:443`, or a trailing `/` never stop a credential from matching, while a
 * different path, subdomain or non-default port still does (the Claude Managed Agents rule).
 */
export function normalizeMcpUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.trim().toLowerCase(); }
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
}

/** An Authorization header value: a token stored bare becomes a bearer, a scheme-prefixed one is sent as is. */
export const authorizationHeader = (token: string) => (/^\S+\s+\S/.test(token.trim()) ? token.trim() : `Bearer ${token.trim()}`);

/** A credential the runner can use: still sealed, so it is opened only when a server actually needs it. */
export interface SealedMcpCredential {
  id: string;
  mcp_server_url: string;
  secret: Sealed;
}

/**
 * The credentials to call `server` with, or null to connect unauthenticated (what Claude Managed Agents
 * does when nothing matches). Precedence: an explicit `credential_id`, then the server's own sealed
 * credentials (the OpenAI inline `transport.authorization` shape), then a vault credential matching the
 * server URL — `credentials` is already in vault order, so the first vault with a match wins.
 *
 * Throws when a credential exists but cannot be opened: the caller reports it instead of silently
 * connecting with none.
 */
export function resolveMcpCredentials(server: McpServerDecl, credentials: SealedMcpCredential[] = []): McpCredentials | null {
  // Declared headers travel with the server itself (they are transport, not identity) and always apply.
  const inline = server.secret || server.authorization || server.headers ? openMcpCredentials(server) : null;
  const vault = server.credential_id
    ? credentials.find((c) => c.id === server.credential_id) // gone: the credential was archived, or its vault detached
    : inline?.authorization ? undefined
    : credentials.find((c) => normalizeMcpUrl(c.mcp_server_url) === normalizeMcpUrl(server.url));
  const authorization = vault ? authorizationHeader(open(vault.secret)) : inline?.authorization;
  if (!authorization && !inline?.headers) return null;
  return { ...(authorization ? { authorization } : {}), ...(inline?.headers ? { headers: inline.headers } : {}) };
}

/**
 * API-safe view: no plaintext and no ciphertext, only which credentials are set. Header *values* are
 * always masked, even on the secret-free agent path where they are validated not to be credentials: the
 * stored decl does not say where it came from, and a header is where the OpenAI inline path puts a token.
 */
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
