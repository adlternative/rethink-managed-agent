import { Hono } from "hono";
import { vaults, vaultCredentials } from "../../infra/db.ts";
import { secretsConfigured } from "../../infra/secrets.ts";
import { invalid, notFound, readJson } from "../errors.ts";
import { scope, ownerId } from "../auth.ts";
import type { Scope } from "../../infra/db.ts";

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
  /** Store (or replace) a named secret in the vault. `value` is the plaintext, never returned. */
  .post("/:id/credentials", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const v = await vaults.get(c.req.param("id"), scope(c));
    if (!v) throw notFound("vault", c.req.param("id"));
    const body = await readJson<{ name?: string; value?: string; metadata?: Record<string, string> }>(c);
    if (!body.name || typeof body.name !== "string") throw invalid("name is required");
    if (typeof body.value !== "string") throw invalid("value (a string) is required");
    return c.json(await vaultCredentials.put(v.id, body.name, body.value, body.metadata), 201);
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
