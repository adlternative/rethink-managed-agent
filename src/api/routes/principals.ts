import { Hono } from "hono";
import { apiKeys, principals } from "../../infra/db.ts";
import type { Context } from "hono";
import { ApiError, invalid, notFound, readJson } from "../errors.ts";
import { actor, ownerId } from "../auth.ts";
import { env } from "../../shared/env.ts";

const visible = (c: Context, id: string) => !env.AUTH_REQUIRED || id === actor(c).id || id === ownerId(c);

/**
 * Minimal identity surface. `POST /v1/principals` mints a principal (a user today; kind='org'
 * becomes an organization later). `POST /v1/api_keys` mints a bearer token for one — the plaintext
 * is returned exactly once. `GET /v1/me` echoes the caller. With AUTH_REQUIRED=false these are open
 * for local bootstrapping; a real deployment gates them behind admin.
 */
export const principalsRoute = new Hono()
  .get("/me", (c) => c.json(actor(c)))
  .post("/principals", async (c) => {
    const body = await readJson<{ kind?: string; handle?: string; display_name?: string }>(c);
    const kind = body.kind ?? "user";
    if (!["user", "org", "service"].includes(kind)) throw invalid("kind must be user|org|service");
    const p = await principals.upsert({ kind: kind as "user" | "org" | "service", handle: body.handle ?? null, display_name: body.display_name ?? "" });
    return c.json(p, 201);
  })
  // With AUTH_REQUIRED, a caller only sees itself and its owner scope (no tenant enumeration).
  .get("/principals", async (c) => c.json({ data: env.AUTH_REQUIRED ? (await principals.list()).filter((p) => visible(c, p.id)) : await principals.list() }))
  .get("/principals/:id", async (c) => {
    const p = visible(c, c.req.param("id")) ? await principals.get(c.req.param("id")) : null;
    if (!p) throw notFound("principal", c.req.param("id"));
    return c.json(p);
  })
  .post("/api_keys", async (c) => {
    const body = await readJson<{ principal_id?: string; name?: string }>(c);
    const principalId = body.principal_id ?? actor(c).id;
    // minting a token for someone else is account takeover; only the open dev mode allows it (bootstrapping)
    if (env.AUTH_REQUIRED && principalId !== actor(c).id) throw new ApiError(403, "permission_error", "api keys can only be minted for the calling principal");
    if (!(await principals.get(principalId))) throw notFound("principal", principalId);
    const key = await apiKeys.create(principalId, body.name ?? "");
    return c.json({ id: key.id, principal_id: principalId, token: key.token, note: "store this token now; it is not shown again" }, 201);
  });
