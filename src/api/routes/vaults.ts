import { Hono } from "hono";
import { vaults, vaultCredentials, type VaultCredentialInput } from "../../infra/db.ts";
import { secretsConfigured } from "../../infra/secrets.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";
import type { Scope } from "../../infra/db.ts";
import type { McpServerDecl } from "../../shared/types.ts";

/** Validate a session's `vault_ids`: an array of distinct vault ids the caller owns (unknown/foreign -> 404). */
export async function validateVaultIds(input: unknown, sc: Scope): Promise<string[]> {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((v) => typeof v !== "string" || !v)) throw invalid("vault_ids must be an array of vault ids");
  const ids = [...new Set(input as string[])];
  if (ids.length > 32) throw invalid("at most 32 vault_ids");
  for (const id of ids) if (!(await vaults.get(id, sc))) throw notFound("vault", id);
  return ids;
}

/**
 * Validate the `credential_id` of every declared MCP server: it must name an MCP credential in one of
 * the session's vaults. Checked at create time so a typo fails loudly instead of silently connecting
 * unauthenticated at the first turn.
 */
export async function validateMcpCredentialIds(servers: McpServerDecl[] | undefined, vaultIds: string[]): Promise<void> {
  for (const s of servers ?? []) {
    if (!s.credential_id) continue;
    const cred = await vaultCredentials.byId(s.credential_id, vaultIds);
    if (!cred) throw invalid(`mcp server ${s.label}: credential_id ${s.credential_id} is not a credential of the session's vaults`);
    if (cred.kind === "environment_variable") throw invalid(`mcp server ${s.label}: credential ${s.credential_id} is an environment variable, not an MCP credential`);
  }
}

/** The typed credential body shared by the native route and both compat surfaces. */
export interface CredentialBody {
  name?: string;
  display_name?: string;
  value?: string;
  metadata?: Record<string, string>;
  auth?: {
    type?: string;
    /** MCP credentials */
    mcp_server_url?: string;
    token?: string;
    access_token?: string;
    expires_at?: string;
    refresh?: Record<string, unknown>;
    /** environment variable credentials */
    secret_name?: string;
    secret_value?: string;
    [k: string]: unknown;
  };
}

/**
 * Normalize a credential request into what the store takes. Three shapes are accepted:
 * `{name, value}` (an environment variable, the original short form), `{auth:{type:"static_bearer"|"mcp_oauth",
 * mcp_server_url, ...}}` (an MCP credential the runner sends to that server), and
 * `{auth:{type:"environment_variable", secret_name, secret_value}}`. The name is the key within the vault and
 * defaults to the display name, then to the credential's own key (server URL or secret name).
 */
export function credentialInput(body: CredentialBody): VaultCredentialInput {
  const meta = body.metadata;
  const named = (fallback: string) => body.name ?? body.display_name ?? fallback;
  const auth = body.auth;
  if (auth?.type === "static_bearer" || auth?.type === "mcp_oauth") {
    const url = auth.mcp_server_url;
    if (typeof url !== "string" || !url) throw invalid(`auth.mcp_server_url is required for a ${auth.type} credential`);
    try { new URL(url); } catch { throw invalid(`auth.mcp_server_url ${JSON.stringify(url)} is not a valid URL`); }
    const value = auth.type === "static_bearer" ? auth.token : auth.access_token;
    if (typeof value !== "string" || !value) throw invalid(auth.type === "static_bearer" ? "auth.token is required" : "auth.access_token is required");
    return { name: named(url), value, kind: auth.type, mcp_server_url: url, refresh: auth.refresh ?? null, expires_at: auth.expires_at ?? null, metadata: meta };
  }
  if (auth?.type === "environment_variable") {
    if (typeof auth.secret_name !== "string" || !auth.secret_name) throw invalid("auth.secret_name is required");
    if (typeof auth.secret_value !== "string") throw invalid("auth.secret_value is required");
    return { name: named(auth.secret_name), value: auth.secret_value, kind: "environment_variable", metadata: meta };
  }
  if (auth?.type) throw invalid(`unsupported credential auth type ${JSON.stringify(auth.type)}`);
  if (!body.name || typeof body.name !== "string") throw invalid("name is required");
  if (typeof body.value !== "string") throw invalid("value (a string) is required");
  return { name: body.name, value: body.value, kind: "environment_variable", metadata: meta };
}

/**
 * Vaults: named, per-principal encrypted secrets injected into a session's sandboxes as env vars.
 * Secret values are write-only — the API returns credential metadata (id, name) but never the value.
 * Reuses the BYOK cipher (PMA_SECRET_KEY); storing a secret without a key configured is refused.
 */
export const vaultsRoute = new Hono()
  .post("/", async (c) => {
    const body = await readJson<{ name?: string; metadata?: Record<string, string> }>(c);
    return c.json(await vaults.create({ owner_id: ownerId(c), name: body.name ?? null, metadata: body.metadata }), 201);
  })
  .get("/", async (c) => c.json({ object: "list", data: await vaults.list(scope(c)) }))
  .get("/:id", async (c) => {
    const v = await vaults.get(c.req.param("id"), scope(c));
    if (!v) throw notFound("vault", c.req.param("id"));
    return c.json(v);
  })
  .delete("/:id", async (c) => {
    if (!(await vaults.delete(c.req.param("id"), scope(c)))) throw notFound("vault", c.req.param("id"));
    return c.json({ id: c.req.param("id"), object: "vault.deleted", deleted: true });
  })
  /**
   * Store (or replace) a credential. Either the short form `{name, value}` (an environment variable) or
   * the typed form `{name?, auth}` used by Claude Managed Agents and the OpenAI SDK. Secrets are never returned.
   */
  .post("/:id/credentials", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const v = await vaults.get(c.req.param("id"), scope(c));
    if (!v) throw notFound("vault", c.req.param("id"));
    const body = await readJson<CredentialBody>(c);
    return c.json(await vaultCredentials.put(v.id, credentialInput(body)), 201);
  })
  .get("/:id/credentials", async (c) => {
    const v = await vaults.get(c.req.param("id"), scope(c));
    if (!v) throw notFound("vault", c.req.param("id"));
    return c.json({ object: "list", data: await vaultCredentials.list(v.id) });
  })
  .delete("/:id/credentials/:name", async (c) => {
    const v = await vaults.get(c.req.param("id"), scope(c));
    if (!v) throw notFound("vault", c.req.param("id"));
    if (!(await vaultCredentials.delete(v.id, c.req.param("name")))) throw notFound("credential", c.req.param("name"));
    return c.json({ id: c.req.param("name"), object: "vault.credential.deleted", deleted: true });
  });
