import type { Context, MiddlewareHandler } from "hono";
import { apiKeys, principals, type Scope } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import { ApiError } from "./errors.ts";
import type { Principal } from "../shared/types.ts";

/**
 * Resolves the request's actor (the authenticated principal) and owner scope, and stashes them on
 * the context. Phase 1: owner == actor (no orgs yet). A bearer token is resolved via api_keys;
 * with AUTH_REQUIRED=false an unauthenticated request acts as the default (dev) principal so the
 * single-machine flow needs no tokens.
 */
export function auth(): MiddlewareHandler {
  return async (c, next) => {
    // BYOC worker endpoints authenticate machine-to-machine with x-worker-key, not a principal token.
    if (/\/worker(\/|$)/.test(c.req.path)) return next();
    const header = c.req.header("authorization");
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;

    let actor: Principal | null = null;
    if (token) {
      actor = await apiKeys.resolve(token);
      if (!actor) throw new ApiError(401, "authentication_error", "invalid or expired API key");
    } else if (env.AUTH_REQUIRED) {
      throw new ApiError(401, "authentication_error", "missing Authorization: Bearer <token>");
    } else {
      actor = (await principals.get(env.PMA_DEFAULT_PRINCIPAL)) ?? (await principals.upsert({ id: env.PMA_DEFAULT_PRINCIPAL, handle: "local", display_name: "Local User" }));
    }
    c.set("actor", actor);
    c.set("owner", actor.id); // phase 1: the owning scope is the actor itself; an X-Org header will select an org later
    await next();
  };
}

/** The authenticated principal for this request. */
export function actor(c: Context): Principal {
  const a = c.get("actor") as Principal | undefined;
  if (!a) throw new ApiError(500, "api_error", "no actor on request (auth middleware missing)");
  return a;
}

/** The ownership scope to pass to repo reads/writes so they stay within the caller's tenant. */
export function scope(c: Context): Scope {
  return { owner: c.get("owner") as string };
}

/** Just the owner principal id (for stamping owner_id on new rows). */
export function ownerId(c: Context): string {
  return c.get("owner") as string;
}
