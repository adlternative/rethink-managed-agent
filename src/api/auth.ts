import type { Context, MiddlewareHandler } from "hono";
import { principals, type Scope } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import { ApiError } from "./errors.ts";
import type { Principal } from "../shared/types.ts";
import { loadResolver } from "./principal-resolver.ts";

/**
 * Turns a request into `{actor, owner}` on the context. *How* a credential becomes a principal is a
 * pluggable resolver (PRINCIPAL_RESOLVER; built-in default is Bearer -> api_keys) — that is the seam
 * a consuming business uses to bring its own identity (JWT/OIDC, a trusted gateway header, mTLS, a
 * per-tenant key). This middleware only owns the *policy* around a missing credential and the owner
 * scoping the rest of the system depends on. Everything downstream sees just `owner`.
 */
export function auth(): MiddlewareHandler {
  return async (c, next) => {
    // BYOC worker endpoints authenticate machine-to-machine with x-worker-key, not a principal.
    if (/^\/v1\/environments\/[^/]+\/worker(\/|$)/.test(c.req.path)) return next();
    // Slack Events / Interactions authenticate with the Slack signing secret (verified in-route).
    if (/^\/v1\/integrations\/[^/]+\/(events|interactions)(\/|$)/.test(c.req.path)) return next();

    const resolver = await loadResolver();
    const identity = await resolver.resolve({ header: (n) => c.req.header(n), method: c.req.method, path: c.req.path });

    let actor: Principal;
    let owner: string;
    if (identity) {
      actor = identity.actor;
      owner = identity.owner ?? identity.actor.id; // a resolver that supports orgs sets owner to the org principal
    } else if (env.AUTH_REQUIRED) {
      throw new ApiError(401, "authentication_error", "authentication required");
    } else {
      // dev / single-tenant: act as the default principal so the local flow needs no credentials
      actor = (await principals.get(env.PMA_DEFAULT_PRINCIPAL)) ?? (await principals.upsert({ id: env.PMA_DEFAULT_PRINCIPAL, handle: "local", display_name: "Local User" }));
      owner = actor.id;
    }
    c.set("actor", actor);
    c.set("owner", owner);
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
